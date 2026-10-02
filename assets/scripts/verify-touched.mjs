#!/usr/bin/env node
// Stop hook: runs the repository's own verification command when a turn
// ends, and blocks Claude once per DISTINCT failure so it gets a chance to
// see and fix the problem — without turning a failure it cannot fix into an
// unbounded loop. There is no documented platform limit on how many times a
// Stop hook may block (exit 2 / stderr, or {"decision":"block"}), so this
// script bounds itself:
//
//   - State is tracked in a marker file under the OS temp directory — NEVER
//     inside the repository, which is not ours to litter — keyed by a
//     SANITIZED session_id. `session_id` is attacker-shaped exactly like
//     `tool_input.file_path` is in lint-touched.mjs: it comes straight off
//     the hook payload and would otherwise go straight into a filesystem
//     path. See safeSessionId below — anything that does not survive a
//     strict allowlisted charset is never used to build a path at all; this
//     script exits 0 rather than guess at an alternative.
//   - A block is keyed to the FAILURE's own signature (a hash of its
//     normalized output), not merely to "has this session blocked before":
//     reporting the identical failure twice does not block a second time,
//     but a genuinely DIFFERENT failure later in the same session still
//     gets its own block.
//   - An absolute cap of 3 blocks per session is the belt-and-braces
//     backstop — if the signature normalization ever misses something
//     volatile (making every run look "different"), the cap still bounds
//     the damage instead of letting unbounded blocking return.
//
// Reads the Stop payload from stdin and takes CLAUDE_PROJECT_DIR as the
// project root, falling back to process.cwd(). Never throws, never writes
// to stdout, never writes inside the repository, and every spawn is
// bounded. The redaction applied to the command's own output is shared
// with lint-touched.mjs via harness-redact.mjs — see that file's comment
// for why a shared chokepoint exists at all.
import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join, delimiter } from 'node:path';
import { dropCommandFragments, maskCredentials } from './harness-redact.mjs';

// Overridable so a test can exercise the timeout path in milliseconds, not
// minutes; defaults to the real 120s bound otherwise. A stop gate that
// hangs is worse than one that misses.
const VERIFY_TIMEOUT_MS = Number(process.env.HK_VERIFY_TIMEOUT_MS) || 120_000;
// Mirrors lint-touched.mjs's own bound on how long reading stdin may block —
// see that file's comment for why this matters even though Stop always
// supplies and closes stdin promptly in practice.
const STDIN_TIMEOUT_MS = Number(process.env.HK_STDIN_TIMEOUT_MS) || 5_000;
// Generous but bounded, same reasoning as lint-touched.mjs's
// HK_LINT_MAX_BUFFER: a verbose `tsc`/full test-suite run must not overflow
// spawnSync's own 1MB default and get silently discarded.
const VERIFY_MAX_BUFFER = Number(process.env.HK_VERIFY_MAX_BUFFER) || 10 * 1024 * 1024;
// Mirrors session-brief.mjs's and lint-touched.mjs's own bound on what is
// printed to a session.
const MAX_REPORT_LINES = 60;
// Belt-and-braces backstop — see this file's header comment.
const MAX_BLOCKS_PER_SESSION = 3;

/** Reads all of stdin, bounded by STDIN_TIMEOUT_MS. Async (not
 * `readFileSync(0)`) specifically so the timer below can actually race it —
 * see lint-touched.mjs's identical function for the full rationale. */
function readStdin(timeoutMs) {
  return new Promise(resolve => {
    let data = '';
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(data), timeoutMs);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { data += chunk; });
      process.stdin.on('end', () => finish(data));
      process.stdin.on('error', () => finish(data));
    } catch {
      finish('');
    }
  });
}

/**
 * `session_id` is attacker-shaped, exactly like `tool_input.file_path` in
 * lint-touched.mjs: it comes straight off the hook payload and this script
 * needs to turn it into a filesystem path. A `../`-laden or absolute value
 * could escape the OS temp directory entirely (the identical containment
 * escape lint-touched.mjs had to close for `file_path`); a NUL byte would
 * make any `fs` call on that path throw outright.
 *
 * Rather than trying to detect and block every way a string can do either
 * of those things, this reduces the value to a strict allowlisted charset
 * and REFUSES anything else outright — there is no path left for a
 * malicious value to take, because a value that does not survive this
 * check is never used to build a path at all. The caller exits 0 rather
 * than invent a fallback filename: tracking is simply skipped for that
 * invocation, which is always safe (worst case, a block that should have
 * been bounded fires once more than ideal — never a filesystem escape).
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

function safeSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 200 && SAFE_SESSION_ID.test(sessionId)
    ? sessionId
    : null;
}

function markerPath(sessionId) {
  return join(tmpdir(), `harness-kit-stop-${sessionId}`);
}

/** Never throws. An absent, unreadable, or malformed marker is treated as
 * "nothing recorded yet" — the safe, permissive default — never as a
 * reason to crash or to skip verification. */
function readMarker(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const count = Number(parsed?.count);
    const lastSignature = typeof parsed?.lastSignature === 'string' ? parsed.lastSignature : null;
    return { count: Number.isFinite(count) && count >= 0 ? count : 0, lastSignature };
  } catch {
    return { count: 0, lastSignature: null };
  }
}

/** Creating the marker must never throw — a stop gate that crashes because
 * it could not write its own bookkeeping is worse than one that
 * occasionally blocks once more than it ideally should. */
function writeMarker(path, state) {
  try {
    writeFileSync(path, JSON.stringify(state), 'utf8');
  } catch {
    // best-effort; see comment above
  }
}

/**
 * Normalizes away what is expected to differ between otherwise-identical
 * runs of the SAME failure, so the signature computed below is stable
 * across repeated runs of an unfixed problem: absolute paths (which embed
 * a machine- or run-specific directory) and elapsed-time figures (which
 * never repeat exactly). Anything this misses falls back on
 * MAX_BLOCKS_PER_SESSION, never on this function alone being perfect.
 */
function normalizeForSignature(text) {
  return text
    .replace(/[A-Za-z]:[\\/][^\s"']+/g, '<path>') // C:\Users\...\x, C:/a/b
    .replace(/(?<=[\s"'(]|^)\/(?:[^\s"']+\/)+[^\s"']*/g, '<path>') // POSIX-absolute /a/b/c
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds?|m|min|mins|minutes?)\b/gi, '<time>')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\b/g, '<time>'); // 0:01:23, 12:34.5
}

function signatureOf(lines) {
  return createHash('sha256').update(normalizeForSignature(lines.join('\n')), 'utf8').digest('hex');
}

/** Reads `package.json`'s `scripts`, or null when there is none to read —
 * absent, unreadable, or unparsable are all "nothing to verify", never a
 * reason to throw. */
function readScripts(root) {
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    return pkg?.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts) ? pkg.scripts : {};
  } catch {
    return null;
  }
}

/** `typecheck` wins when both exist — it is the faster, narrower signal;
 * `test` is the fallback. Neither existing means nothing to check. */
function pickVerifyCommand(scripts) {
  if (typeof scripts?.typecheck === 'string' && scripts.typecheck.trim()) {
    return { kind: 'typecheck', command: scripts.typecheck };
  }
  if (typeof scripts?.test === 'string' && scripts.test.trim()) {
    return { kind: 'test', command: scripts.test };
  }
  return null;
}

/**
 * The single chokepoint every byte reported to Claude passes through —
 * truncated here, and this is the ONLY `process.stderr.write` in this file.
 */
function writeReport(kind, lines) {
  const shown = lines.slice(0, MAX_REPORT_LINES);
  let report = `harness-kit: the repository's "${kind}" script failed:\n` + shown.join('\n');
  if (lines.length > MAX_REPORT_LINES) {
    report += `\n--- truncated: ${lines.length - MAX_REPORT_LINES} more line(s) ---`;
  }
  process.stderr.write(report + '\n');
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin(STDIN_TIMEOUT_MS));
  } catch {
    return 0;
  }
  if (!payload || typeof payload !== 'object') return 0;

  const sessionId = safeSessionId(payload.session_id);
  if (sessionId === null) return 0; // cannot safely track state for this session — see safeSessionId's comment

  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const scripts = readScripts(root);
  if (!scripts) return 0; // no package.json, or unreadable — nothing to verify

  const picked = pickVerifyCommand(scripts);
  if (!picked) return 0; // neither typecheck nor test exists — nothing to verify

  const binDir = join(root, 'node_modules', '.bin');
  const PATH = [binDir, process.env.PATH ?? process.env.Path ?? ''].filter(Boolean).join(delimiter);

  let result;
  try {
    result = spawnSync(picked.command, {
      cwd: root,
      timeout: VERIFY_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      shell: true,
      maxBuffer: VERIFY_MAX_BUFFER,
      env: { ...process.env, PATH },
    });
  } catch {
    return 0;
  }
  if (!result) return 0;

  // ENOBUFS (output exceeded VERIFY_MAX_BUFFER) is not a verification
  // failure in itself — see lint-touched.mjs's identical reasoning. Any
  // OTHER error (spawn failure) or signal (most commonly our own timeout
  // kill) is never reported as a verification failure: a stop gate that
  // hangs, or that cannot even start the command, is worse than one that
  // misses — see this file's header comment.
  const isOverflow = result.error?.code === 'ENOBUFS';
  if ((result.error || result.signal) && !isOverflow) return 0;

  if (result.status === 0) return 0; // verification passed — nothing to say, nothing to track

  const rawLines = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.split(/\r?\n/).filter(l => l.trim());
  // Ruling 3's shared redaction chokepoint — identical layering to
  // lint-touched.mjs's own stderr, because this output reaches stderr too
  // and the command's own body can carry a credential exactly as a
  // `scripts.lint` body has, twice, in this project's own history.
  const redacted = dropCommandFragments(rawLines, [picked.command]).map(maskCredentials);
  const signature = signatureOf(redacted);

  const path = markerPath(sessionId);
  const marker = readMarker(path);

  if (marker.count >= MAX_BLOCKS_PER_SESSION) {
    process.stderr.write(
      `harness-kit: the stop gate's ${MAX_BLOCKS_PER_SESSION}-block cap for this session has been reached — letting the turn end.\n`,
    );
    return 0;
  }

  if (marker.lastSignature === signature) {
    process.stderr.write(
      `harness-kit: this is the same "${picked.kind}" failure already reported this session — letting the turn end.\n`,
    );
    return 0;
  }

  writeMarker(path, { count: marker.count + 1, lastSignature: signature });
  writeReport(picked.kind, redacted);
  return 2;
}

(async () => {
  let code = 0;
  try {
    code = await main();
  } catch {
    code = 0; // never throw — a hook that breaks a session is worse than none
  }
  process.exit(code);
})();
