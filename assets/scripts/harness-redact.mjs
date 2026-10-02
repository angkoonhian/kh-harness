// assets/scripts/harness-redact.mjs
//
// The one module EVERY hook this kit installs imports — lint-touched.mjs's
// PostToolUse sensor, verify-touched.mjs's Stop gate, and session-brief.mjs's
// SessionStart brief — and any future one must import this file rather than
// carry its own copy of anything in it. Two hooks each holding an
// independent copy of this logic is exactly the shape that lets a fix land
// in one and not the other; this project has already shipped four
// secret-exposure defects, and "the fix only ever reached one of the two
// copies" is a failure mode this extraction removes structurally, not by
// convention.
//
// THE NAME DESCRIBES ONE OF FIVE THINGS THIS MODULE NOW CARRIES. It is
// named for the first one it shared, stderr redaction, and the full list is:
//
//   1. REDACTION — `dropCommandFragments` (layer 1, a denylist of command
//      fragments) and `maskCredentials` (layer 2, a credential-shape
//      allowlist). The only part the name covers.
//   2. OUTPUT BOUNDS — `MAX_REPORT_LINES`, `MAX_REPORT_BYTES` and
//      `boundReport`, which keep a hook's output inside Claude Code's
//      10,000-character cap so it actually ARRIVES (see F3 below).
//   3. SESSION-MARKER STATE — `safeSessionId`, `markerPath`,
//      `readJSONMarker`/`writeJSONMarker`, `signatureOf`,
//      `MAX_BLOCKS_PER_SESSION`: the per-session bookkeeping both process
//      hooks bound themselves with.
//   4. THE PROJECT ROOT — `projectRoot`, the one answer all three hooks
//      use (whole-branch review, F4: there were two).
//   5. THE HANDOFF LOCATION — `HANDOFF_CANDIDATES` and `findHandoff`,
//      shared with `scripts/lib/detect-harness.mjs` so detection and the
//      hook cannot disagree about where the file is (F4 again).
//
// Coordinator ruling (post-review, concern 3): the name is KEPT, and the
// mismatch is disclosed here rather than left for the next reader to
// discover. Renaming is not available: `REDACT_PATH`
// (`.claude/scripts/harness-redact.mjs`) is recorded in every manifest this
// tool has ever written, and `uninstall` reads that manifest to decide what
// it may remove — so a rename orphans every existing install's record of
// this file, permanently, with no notice. A name that under-describes its
// module is survivable; one that under-describes it SILENTLY sends the next
// reader looking in the wrong file for `findHandoff` or `boundReport`.
// If this is ever renamed, the manifest needs a migration first, not a
// `git mv`.
//
// Whole-branch review, F3: session-brief.mjs is the reason the bound below
// has a byte limit at all — `MAX_REPORT_LINES`' own comment cited it as the
// model — and it was the one hook that never got that byte limit, because
// it predates this module and could not import it. It imports it now.
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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
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

/** The line bound every hook's output shares, session-brief.mjs included —
 * it used to carry its own copy of this number and nothing else. */
export const MAX_REPORT_LINES = 60;
/**
 * A line-count bound alone cannot stop a single very long line (minified
 * output, a one-line stack trace, a JSON formatter run with no pretty-print)
 * from pushing megabytes into Claude's context at the default 10 MB spawn
 * buffer — measured: a single 50 000-character line reached stderr in full
 * before this existed. 10 000 bytes is generous for a genuine diagnostic
 * and far below anything that would flood a turn.
 *
 * It is also EXACTLY Claude Code's own documented cap, which is the reason
 * the number matters rather than merely being generous. From the hooks
 * reference: a hook's `additionalContext`, `systemMessage` and
 * `initialUserMessage` strings, and its plain stdout, are capped at 10,000
 * characters; over the limit, Claude Code saves the output to a file in the
 * session directory and replaces it with the file path plus a preview of the
 * first 2,000 characters — and "Claude Code doesn't ask Claude to read the
 * file". So exceeding this is not a flooded context, it is the output
 * SILENTLY NOT ARRIVING. That is what F3 cost session-brief.mjs: past the
 * cap, the handoff was replaced by a path Claude is never told to open, and
 * nothing anywhere reported it.
 */
export const MAX_REPORT_BYTES = 10_000;

/**
 * Cuts `str` to at most `maxBytes` UTF-8 bytes, never mid-character: `end`
 * is the first byte NOT kept, so while it is a UTF-8 continuation byte
 * (`10xxxxxx`) the character before it is being split and the cut walks
 * back. Without this, a multi-byte character straddling the boundary decodes
 * to U+FFFD — a corrupted last character in the one place a user is reading
 * for information.
 */
function sliceUtf8(str, maxBytes) {
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return str;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Bounds `lines` first by count, then by total byte size, and returns the
 * final string to write (without a trailing newline). `header` is
 * prepended before either bound is computed, since it counts toward the
 * byte budget too. No hook may write to its output stream through any path
 * but this one plus its own single `write` call site — see each hook's own
 * comment on its chokepoint.
 *
 * Whole-branch review, F3: the byte bound used to cut at exactly
 * `MAX_REPORT_BYTES` and THEN append the truncation notice, so the string
 * this returned was ~10,050 bytes — over Claude Code's 10,000-character cap
 * by the length of its own notice, which is precisely the cap this constant
 * exists to stay under. Two things are fixed here, because a bound that is
 * fifty bytes over is not a bound at all for the failure mode it exists to
 * prevent:
 *
 *   - the notice is now INSIDE the budget, not appended after it; and
 *   - one further byte is reserved for the single trailing newline every
 *     caller adds (all three hooks write `boundReport(...) + '\n'`), so the
 *     bound holds on what is actually WRITTEN rather than on an
 *     intermediate string nothing emits.
 *
 * Contract, therefore: this returns at most `MAX_REPORT_BYTES - 1` bytes,
 * and `boundReport(...) + '\n'` is at most `MAX_REPORT_BYTES`.
 */
export function boundReport(lines, header = '') {
  const shown = lines.slice(0, MAX_REPORT_LINES);
  let report = header + shown.join('\n');
  if (lines.length > MAX_REPORT_LINES) {
    report += `\n--- truncated: ${lines.length - MAX_REPORT_LINES} more line(s) ---`;
  }
  const budget = MAX_REPORT_BYTES - 1; // the caller's trailing newline
  if (Buffer.byteLength(report, 'utf8') > budget) {
    const notice = '\n--- truncated: output exceeded the byte limit ---';
    report = sliceUtf8(report, budget - Buffer.byteLength(notice, 'utf8')) + notice;
  }
  return report;
}

// --- The two facts every hook needs before it can do anything -------------

/**
 * The repository root, as Claude Code reports it, falling back to the
 * process's own working directory.
 *
 * Whole-branch review, F4, secondary: three hooks, two conventions. This is
 * what lint-touched.mjs and verify-touched.mjs both already did inline;
 * session-brief.mjs used a bare `process.cwd()` and DOCUMENTED the
 * assumption ("Assumes cwd is the repository root at SessionStart") rather
 * than removing it — so any SessionStart invocation whose cwd was not the
 * project root printed "no HANDOFF.md in this repository yet" into the
 * model's context, as a false premise, at the start of every session. One
 * function, three callers.
 */
export function projectRoot() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/**
 * The two conventional locations for a repository's handoff file, in
 * precedence order, and the one function that resolves them.
 *
 * Whole-branch review, F4. `detect-harness.mjs` credited `P4.handoff` from
 * `existsAny(root, ['HANDOFF.md', 'docs/HANDOFF.md'])` while the hook it
 * installs read `join(process.cwd(), 'HANDOFF.md')` and nothing else — so a
 * repository whose handoff lives at `docs/HANDOFF.md` was credited
 * `declared` by `detect` and then told, by the artefact that same run
 * installed three lines later, that it had no handoff file at all. Printed
 * into the model's context, not a terminal: a false premise the agent starts
 * from, about a file this very tool had already proved exists.
 *
 * The direction chosen is THE HOOK LOOKS WHERE DETECTION CREDITED, not the
 * reverse, for two reasons. First, `docs/HANDOFF.md` is a real convention —
 * this list is the tool's own admission that repositories put it there — and
 * narrowing detection to the root would make `P4.handoff` propose CREATING a
 * root `HANDOFF.md` in a repository that already has one under `docs/`,
 * which turns a false sentence into a duplicate file and leaves the user
 * with two handoffs that disagree. A wrong write is worse than a wrong read.
 * Second, widening the hook costs one extra `existsSync`.
 *
 * `detect-harness.mjs` imports THIS function rather than keeping its own
 * list, so the two sides cannot drift again. That is the only way they can
 * be shared: the hook is a file copied verbatim into a user's repository,
 * where the only module beside it is this one, so a constant in
 * `scripts/lib/` could never reach it. The dependency runs the other way,
 * at build time, and the installed copy depends on nothing new.
 */
export const HANDOFF_CANDIDATES = ['HANDOFF.md', 'docs/HANDOFF.md'];

export function findHandoff(root) {
  for (const rel of HANDOFF_CANDIDATES) {
    if (existsSync(join(root, rel))) return rel;
  }
  return null;
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
