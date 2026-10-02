// assets/scripts/harness-redact.mjs
//
// Shared stderr redaction chokepoint for every process-output hook this kit
// installs — today that is lint-touched.mjs's PostToolUse sensor and
// verify-touched.mjs's Stop gate, and any future one must import this file
// rather than carry its own copy. Two hooks each holding an independent
// copy of this logic is exactly the shape that lets a redaction fix land in
// one and not the other; this project has already shipped four
// secret-exposure defects, and "the fix only ever reached one of the two
// copies" is a failure mode this extraction removes structurally, not by
// convention.
//
// Two independent layers:
//
//   Layer 1 (dropCommandFragments): a denylist against what is KNOWN to
//   have come from a command the calling hook itself built. A shell or
//   interpreter can echo a FRAGMENT of a failing command line, not
//   necessarily the whole string (confirmed: node's own SyntaxError
//   reporter prints only the text after an unbalanced quote) — so every
//   whitespace-delimited token of length >= 8 drawn from the command(s) is
//   treated as sensitive, and any surviving line containing one is dropped
//   outright. `exemptions` carries whatever the caller appended to its own
//   command (a file path, say) that legitimately belongs in a real
//   diagnostic and must never be treated as a redactable fragment.
//
//   Layer 2 (maskCredentials): a credential-SHAPE allowlist, independent of
//   layer 1 — catches a credential-shaped value arriving from ANYWHERE in
//   the output, including content the hook never built itself (e.g. a
//   linted file's own source, or a verification command's own diagnostic
//   text). Masks the VALUE and never drops the line: a genuine diagnostic
//   that happens to mention a credential should still reach Claude, with
//   the secret starred out, not disappear entirely.
//
// Attribution — deciding what the output is even ABOUT — is each caller's
// own concern and stays in the caller; it has nothing to do with redaction
// and does not belong in a shared chokepoint.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Whitespace-delimited tokens of length >= 8 drawn from `command`, in
 * first-seen order, minus anything in `exemptions`.
 */
export function commandTokens(command, exemptions = new Set()) {
  const seen = new Set();
  const tokens = [];
  for (const raw of command.split(/\s+/)) {
    const t = raw.replace(/^['"]+|['"]+$/g, '');
    if (t.length < 8 || exemptions.has(t) || seen.has(t)) continue;
    seen.add(t);
    tokens.push(t);
  }
  return tokens;
}

/**
 * Layer 1. `commands` is every raw command string the calling hook itself
 * built (e.g. `[lintScript, fullCommand]`, or a single verify command) —
 * each is checked both as a whole-string match (the "shell echoes the
 * entire line" case) and tokenized for the fragment case.
 */
export function dropCommandFragments(lines, commands, exemptions = new Set()) {
  const tokens = [...new Set(commands.flatMap(c => commandTokens(c, exemptions)))];
  return lines.filter(l => {
    if (commands.some(c => l.includes(c))) return false;
    return !tokens.some(t => l.includes(t));
  });
}

/** Layer 2. Credential-shaped values, independent of where they came from. */
export const CREDENTIAL_RULES = [
  [/\bsk-[A-Za-z0-9_-]{6,}/g, '***'],
  [/\bglpat-[A-Za-z0-9_-]{6,}/g, '***'],
  [/\bghp_[A-Za-z0-9]{6,}/g, '***'],
  [/\bgithub_pat_[A-Za-z0-9_]{6,}/g, '***'],
  [/\bAKIA[A-Za-z0-9]{12,}/g, '***'],
  [/\bxox[abprs]-[A-Za-z0-9-]{6,}/g, '***'],
  [/\bBearer\s+\S+/gi, 'Bearer ***'],
  [/(--(?:token|auth-token|api-key)=)\S+/gi, '$1***'],
  [/\b(password|api_key)=\S+/gi, '$1=***'],
];

export function maskCredentials(line) {
  let masked = line;
  for (const [re, replacement] of CREDENTIAL_RULES) masked = masked.replace(re, replacement);
  return masked;
}

// --- Bounding what reaches stderr -----------------------------------------
//
// Shared so neither hook's bound can silently drift out of sync with the
// other's — see MAX_REPORT_LINES/MAX_REPORT_BYTES below.

/** Mirrors session-brief.mjs's own bound on what is printed to a session. */
export const MAX_REPORT_LINES = 60;
/**
 * A line-count bound alone cannot stop a single very long line (minified
 * output, a one-line stack trace, a JSON formatter run with no pretty-print)
 * from pushing megabytes into Claude's context at the default 10 MB spawn
 * buffer — measured: a single 50 000-character line reached stderr in full
 * before this existed. 10 000 bytes is generous for a genuine diagnostic
 * and far below anything that would flood a turn.
 */
export const MAX_REPORT_BYTES = 10_000;

/**
 * Bounds `lines` first by count, then by total byte size, and returns the
 * final string to write (without a trailing newline). `header` is
 * prepended before either bound is computed, since it counts toward the
 * byte budget too. Neither hook may write to stderr through any path but
 * this one plus its own single `process.stderr.write` call site — see each
 * hook's own comment on its chokepoint.
 */
export function boundReport(lines, header = '') {
  const shown = lines.slice(0, MAX_REPORT_LINES);
  let report = header + shown.join('\n');
  if (lines.length > MAX_REPORT_LINES) {
    report += `\n--- truncated: ${lines.length - MAX_REPORT_LINES} more line(s) ---`;
  }
  if (Buffer.byteLength(report, 'utf8') > MAX_REPORT_BYTES) {
    const buf = Buffer.from(report, 'utf8').subarray(0, MAX_REPORT_BYTES);
    report = buf.toString('utf8') + '\n--- truncated: output exceeded the byte limit ---';
  }
  return report;
}

// --- Session-scoped marker state, shared by both hooks' own bounding -----
//
// Both lint-touched.mjs (dedupe a standing lint error per file) and
// verify-touched.mjs (dedupe a standing verification failure, bound how
// many times either ever blocks/reports per session) need the identical
// building blocks: a sanitized session_id, a safe-to-write location under
// the OS temp directory, and a read/write pair that never throws. One copy
// here instead of two, for the same reason the redaction layers are one
// copy instead of two.

/**
 * `session_id` is attacker-shaped: it comes straight off a hook payload and
 * would otherwise go straight into a filesystem path. A `../`-laden or
 * absolute value could escape the marker directory entirely; a NUL byte
 * would make any `fs` call on the resulting path throw outright. Reducing
 * to a strict allowlisted charset and refusing anything else outright means
 * there is no path left for a malicious value to take — a value that does
 * not survive this check is never used to build a path at all. The caller
 * must treat `null` as "skip tracking for this invocation", never invent a
 * fallback filename.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

export function safeSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 200 && SAFE_SESSION_ID.test(sessionId)
    ? sessionId
    : null;
}

/**
 * A stable, filesystem-safe tag for the current OS user. Hashed (not used
 * raw) so an unusual username can never itself become a path-safety
 * concern the way `session_id` already is one. Falls back to a constant
 * rather than throwing — `os.userInfo()` can throw in a minimal/sandboxed
 * environment with no resolvable home directory — which only widens the
 * shared-temp-directory exposure Finding 10 already documents as an
 * accepted residual risk, never a crash.
 */
function userTag() {
  try {
    const id = typeof process.getuid === 'function' ? String(process.getuid()) : userInfo().username;
    return createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 16);
  } catch {
    return 'unknown';
  }
}

/** A stable, filesystem-safe tag for a repository root, so two different
 * repositories (or a repository moved/renamed) never share a marker even
 * if a `session_id` were ever reused across them. */
export function rootTag(root) {
  return createHash('sha256').update(resolve(root), 'utf8').digest('hex').slice(0, 16);
}

/**
 * The directory every marker lives under: per-user (see userTag), under
 * the OS temp directory, created with owner-only permissions on POSIX
 * (`0o700` — a no-op on win32, where ACLs already default to per-user
 * access under `%TEMP%`). This narrows, but does not eliminate, the
 * pre-seeded-marker exposure a shared temp directory allows across
 * DIFFERENT users; within the same user and the same machine the residual
 * risk is accepted and documented (Finding 10) rather than chased further.
 * Creation failure is swallowed — the caller's own marker read/write is
 * already failure-tolerant, and a directory that cannot be created simply
 * means every marker operation beneath it will consistently fail-safe too.
 */
export function markerDir() {
  const dir = join(tmpdir(), `harness-kit-stop-${userTag()}`);
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // best-effort — see comment above
  }
  return dir;
}

/**
 * Builds a marker's full path: per-user directory, then a repo-root tag,
 * a `namespace`, and the sanitized session_id as the filename — so
 * neither a cross-repo nor a cross-session collision is possible, AND two
 * DIFFERENT hooks sharing a (root, session_id) pair never read or write
 * each other's marker. lint-touched.mjs and verify-touched.mjs track
 * differently-shaped state (per-file signatures vs. a single
 * count/lastSignature/timedOut) under the SAME root and session; without
 * `namespace` they would silently corrupt one another's bookkeeping the
 * moment both fired in the same session.
 */
export function markerPath(root, sessionId, namespace) {
  return join(markerDir(), `${rootTag(root)}-${namespace}-${sessionId}`);
}

/**
 * Reads and JSON-parses a marker file. Never throws: an absent, unreadable,
 * or malformed marker all resolve to `fallback` — the safe, permissive
 * default — never a reason to crash or to skip the caller's own logic.
 */
export function readJSONMarker(path, fallback) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Writes a marker file and reports whether it actually landed on disk.
 * Never throws — but, critically, never PRETENDS success either. The
 * marker is the sole thing bounding how many times a caller may block or
 * report per session; a caller that swallows a write failure and proceeds
 * as if the state was recorded loses the bound it exists to provide, which
 * is strictly worse than under-blocking once. Every caller MUST check the
 * return value and fail open (skip the block/report) when it is `false`.
 */
export function writeJSONMarker(path, state) {
  try {
    writeFileSync(path, JSON.stringify(state), 'utf8');
    return true;
  } catch {
    return false;
  }
}

/**
 * Normalizes away what is expected to differ between otherwise-identical
 * runs of the SAME failure, so a signature computed over the result is
 * stable across repeated runs of an unfixed problem: absolute paths (which
 * embed a machine- or run-specific directory) and elapsed-time figures
 * (which never repeat exactly). Anything this misses falls back on each
 * caller's own cap, never on this function alone being perfect.
 */
function normalizeForSignature(text) {
  return text
    .replace(/[A-Za-z]:[\\/][^\s"']+/g, '<path>') // C:\Users\...\x, C:/a/b
    .replace(/(?<=[\s"'(]|^)\/(?:[^\s"']+\/)+[^\s"']*/g, '<path>') // POSIX-absolute /a/b/c
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds?|m|min|mins|minutes?)\b/gi, '<time>')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\b/g, '<time>'); // 0:01:23, 12:34.5
}

export function signatureOf(lines) {
  return createHash('sha256').update(normalizeForSignature(lines.join('\n')), 'utf8').digest('hex');
}

/** A self-imposed defence-in-depth bound, independent of (and stricter
 * than) the platform's own documented 8-consecutive-block Stop-hook cap
 * (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, see verify-touched.mjs's header
 * comment) — shared so both hooks' own bounds move together if this value
 * is ever revisited. */
export const MAX_BLOCKS_PER_SESSION = 3;
