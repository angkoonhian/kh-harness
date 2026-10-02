#!/usr/bin/env node
// Stop hook: runs the repository's own verification command when a turn
// ends, and blocks Claude once per DISTINCT failure so it gets a chance to
// see and fix the problem — without turning a failure it cannot fix into an
// unbounded loop.
//
// The platform DOES document a bound on its own: Claude Code overrides a
// Stop hook after it blocks 8 times in a row and sets `stop_hook_active` on
// the next payload so a hook can get out of the way sooner on its own (see
// the hooks guide, "Stop hook hits the block cap"; raisable via
// `CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`). This script honours that field below
// — ignoring the platform's own documented mechanism in favour of
// reinventing it would be the wrong call — AND keeps its own stricter,
// signature-keyed bound as defence in depth, because it does something the
// platform field alone cannot: a genuinely different failure later in the
// same session still gets its own block, not just a raw blocked-count cutoff.
//
//   - State is tracked in a marker file under the OS temp directory — NEVER
//     inside the repository, which is not ours to litter — keyed by a
//     SANITIZED session_id, a per-user directory, and a hash of the
//     repository root (see harness-redact.mjs's markerPath/safeSessionId).
//     `session_id` is attacker-shaped exactly like `tool_input.file_path`
//     is in lint-touched.mjs: anything that does not survive sanitization
//     is never used to build a path at all; this script exits 0 rather
//     than guess at an alternative.
//   - A block is keyed to the FAILURE's own signature (a hash of its
//     normalized output), not merely to "has this session blocked before":
//     reporting the identical failure twice does not block a second time,
//     but a genuinely DIFFERENT failure later in the same session still
//     gets its own block.
//   - An absolute cap of 3 blocks per session (MAX_BLOCKS_PER_SESSION, in
//     harness-redact.mjs) is the belt-and-braces backstop — if the
//     signature normalization ever misses something volatile, the cap
//     still bounds the damage instead of letting unbounded blocking return.
//   - A verification run that exceeds the timeout bound is its OWN kind of
//     failure: it blocks once (so Claude is actually told), is then
//     recorded for the session so later turns skip running it again rather
//     than silently paying the full bound forever, and the whole process
//     TREE it spawned is killed, not just the immediate shell.
//   - If the marker cannot be written, this script fails OPEN: it does not
//     block. The marker is the only thing bounding how many times this
//     script may block; losing the ability to write it must mean losing
//     the block, never losing the bound (see harness-redact.mjs's
//     writeJSONMarker).
//
// Reads the Stop payload from stdin and takes CLAUDE_PROJECT_DIR as the
// project root, falling back to process.cwd(). Never writes to stdout,
// never writes inside the repository, and every spawn is bounded. The
// redaction applied to the command's own output, and the marker/signature
// machinery above, are shared with lint-touched.mjs via harness-redact.mjs
// — see that file's own comments for why a shared chokepoint exists at all.
import { readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { delimiter, join } from 'node:path';
import {
  boundReport,
  dropCommandFragments,
  MAX_BLOCKS_PER_SESSION,
  markerPath,
  maskCredentials,
  readJSONMarker,
  safeSessionId,
  signatureOf,
  writeJSONMarker,
} from './harness-redact.mjs';

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
// and get silently discarded.
const VERIFY_MAX_BUFFER = Number(process.env.HK_VERIFY_MAX_BUFFER) || 10 * 1024 * 1024;
// How long a kill is given to actually take effect before this function
// gives up waiting and resolves anyway. A kill is a REQUEST, not a
// guarantee the OS honours instantly — this is this script's own backstop
// against a process that refuses to die, independent of VERIFY_TIMEOUT_MS.
// Overridable only so a test can keep the whole run fast; production never
// needs to change it.
const KILL_GRACE_MS = Number(process.env.HK_VERIFY_KILL_GRACE_MS) || 5_000;

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
 * Kills the ENTIRE process tree `child` roots, not merely `child` itself.
 * `spawnSync`'s own `timeout` option (the original implementation of this
 * file) only ever signals the direct child — with `shell: true` that is
 * the SHELL, not whatever the shell went on to run, so a `tsc`/test-runner
 * process the shell started survives a timeout kill and keeps running,
 * one orphan per turn, forever, measured.
 *
 * POSIX: `detached: true` at spawn time (see runVerification) makes the
 * shell the leader of a NEW process group; `process.kill(-pid, signal)`
 * (a NEGATIVE pid) signals every process in that group, which ordinarily
 * includes anything the shell spawns, since a child inherits its parent's
 * process group unless it explicitly calls `setsid`/`setpgid` itself.
 *
 * win32 has no POSIX process groups; `taskkill /T /F` walks the OS's own
 * process tree (via the same mechanism Task Manager's "End process tree"
 * uses) regardless of how the tree was spawned, which is the standard
 * win32 equivalent.
 */
function killTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    // A kill that cannot even be issued (process already gone, permission
    // denied) must never throw — see this file's "never throw" invariant.
  }
}

/**
 * Runs `command` under a shell, bounded by `timeoutMs` and `maxBuffer`,
 * resolving to a result shaped like `spawnSync`'s own (`status`, `signal`,
 * `error`, `stdout`, `stderr`) plus `timedOut`/`overflowed` flags the
 * caller uses to tell "our own kill" apart from any other way the process
 * could have ended. Never throws; a spawn failure resolves rather than
 * rejects, exactly like `spawnSync` returning an `error` field instead of
 * throwing.
 */
function runVerification(command, { cwd, env, timeoutMs, maxBuffer }) {
  return new Promise(resolvePromise => {
    let settled = false;
    let timedOut = false;
    let overflowed = false;
    let killIssued = false;
    let stdout = '';
    let stderr = '';
    let timer;
    let graceTimer = null;

    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolvePromise(result);
    };

    let child;
    try {
      child = spawn(command, {
        cwd,
        env,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // POSIX only — see killTree's comment. A no-op flag on win32,
        // where taskkill does the real work regardless.
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      finish({ status: null, signal: null, error, stdout: '', stderr: '', timedOut: false, overflowed: false });
      return;
    }

    const issueKill = () => {
      if (killIssued) return;
      killIssued = true;
      killTree(child);
      graceTimer = setTimeout(() => {
        finish({ status: null, signal: 'SIGKILL', error: null, stdout, stderr, timedOut, overflowed });
      }, KILL_GRACE_MS);
    };

    const append = (current, chunk) => {
      if (overflowed) return current;
      const next = current + chunk;
      if (next.length > maxBuffer) {
        overflowed = true;
        issueKill(); // mirrors spawnSync's own maxBuffer behaviour: the process is killed, not merely un-listened-to
        return current;
      }
      return next;
    };

    child.stdout?.on('data', chunk => { stdout = append(stdout, chunk.toString('utf8')); });
    child.stderr?.on('data', chunk => { stderr = append(stderr, chunk.toString('utf8')); });

    timer = setTimeout(() => {
      timedOut = true;
      issueKill();
    }, timeoutMs);

    child.on('error', error => {
      finish({ status: null, signal: null, error, stdout, stderr, timedOut, overflowed });
    });
    child.on('exit', (code, signal) => {
      finish({
        status: code,
        signal,
        error: overflowed ? Object.assign(new Error('ENOBUFS'), { code: 'ENOBUFS' }) : null,
        stdout,
        stderr,
        timedOut,
        overflowed,
      });
    });
  });
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin(STDIN_TIMEOUT_MS));
  } catch {
    return 0;
  }
  if (!payload || typeof payload !== 'object') return 0;

  // The documented platform mechanism — see this file's header comment.
  // Our own cap below is defence in depth, not a replacement for this.
  if (payload.stop_hook_active === true) return 0;

  const sessionId = safeSessionId(payload.session_id);
  if (sessionId === null) return 0; // cannot safely track state for this session — see safeSessionId's own comment

  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const scripts = readScripts(root);
  if (!scripts) return 0; // no package.json, or unreadable — nothing to verify

  const picked = pickVerifyCommand(scripts);
  if (!picked) return 0; // neither typecheck nor test exists — nothing to verify

  const path = markerPath(root, sessionId, 'stop');
  const marker = readJSONMarker(path, { count: 0, lastSignature: null, timedOut: false });
  const count = Number.isFinite(Number(marker.count)) && Number(marker.count) >= 0 ? Number(marker.count) : 0;
  const lastSignature = typeof marker.lastSignature === 'string' ? marker.lastSignature : null;

  // A prior turn in this SAME session already established this command
  // cannot finish within the bound — re-running it would pay the full
  // VERIFY_TIMEOUT_MS again to learn nothing new. Skip entirely.
  if (marker.timedOut === true) return 0;

  const binDir = join(root, 'node_modules', '.bin');
  const PATH = [binDir, process.env.PATH ?? process.env.Path ?? ''].filter(Boolean).join(delimiter);

  let result;
  try {
    result = await runVerification(picked.command, {
      cwd: root,
      timeoutMs: VERIFY_TIMEOUT_MS,
      maxBuffer: VERIFY_MAX_BUFFER,
      env: { ...process.env, PATH },
    });
  } catch {
    return 0;
  }
  if (!result) return 0;

  if (result.timedOut) {
    if (count >= MAX_BLOCKS_PER_SESSION) return 0;
    // A fixed signature per `kind` — every timeout looks the same from
    // the outside (there is no output to differentiate it by), so this
    // deliberately collides with itself rather than with a real failure's
    // own content-derived signature.
    const signature = signatureOf([`TIMEOUT: "${picked.kind}" did not finish within the bound`]);
    if (lastSignature === signature) return 0;
    const wrote = writeJSONMarker(path, { count: count + 1, lastSignature: signature, timedOut: true });
    if (!wrote) return 0; // fail open — see this file's header comment
    process.stderr.write(
      `harness-kit: the repository's "${picked.kind}" script did not finish within ${Math.round(VERIFY_TIMEOUT_MS / 1000)}s ` +
      `and was stopped. Verification will be skipped for the rest of this session so it does not pay this cost on every turn.\n`,
    );
    return 2;
  }

  // ENOBUFS (output exceeded VERIFY_MAX_BUFFER) is not a verification
  // failure in itself — the command DID run and DID fail, only the
  // capture buffer, not the command, hit a limit; what was captured
  // before the cutoff is still reported below. Any OTHER error (a spawn
  // failure) or signal that is not our own timeout/overflow kill is never
  // reported as a verification failure.
  const isOverflow = result.error?.code === 'ENOBUFS';
  if ((result.error || result.signal) && !isOverflow) return 0;

  if (result.status === 0) return 0; // verification passed — nothing to say, nothing to track

  const rawLines = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.split(/\r?\n/).filter(l => l.trim());
  // The shared redaction chokepoint — identical layering to
  // lint-touched.mjs's own stderr, because this output reaches stderr too
  // and the command's own body can carry a credential exactly as a
  // `scripts.lint` body has, twice, in this project's own history.
  const redacted = dropCommandFragments(rawLines, [picked.command]).map(maskCredentials);

  if (count >= MAX_BLOCKS_PER_SESSION) {
    process.stderr.write(
      `harness-kit: the stop gate's ${MAX_BLOCKS_PER_SESSION}-block cap for this session has been reached — letting the turn end.\n`,
    );
    return 0;
  }

  const signature = signatureOf(redacted);
  if (lastSignature === signature) {
    process.stderr.write(
      `harness-kit: this is the same "${picked.kind}" failure already reported this session — letting the turn end.\n`,
    );
    return 0;
  }

  const wrote = writeJSONMarker(path, { count: count + 1, lastSignature: signature, timedOut: false });
  // Fail OPEN: the marker is the sole thing bounding how many times this
  // script may block. If it cannot be written, blocking anyway would make
  // every future invocation this session see `count: 0` forever and block
  // without limit — the exact failure mode this whole file exists to
  // prevent. Losing the marker must mean losing the block, never the bound.
  if (!wrote) return 0;

  // Layer 1 redaction can remove EVERY line (e.g. `npm init -y`'s default
  // `scripts.test` prints only the word "specified", an 8+ char fragment
  // of its own command) — blocking with a bare header and no body traps
  // Claude with nothing to act on, which is worse than not blocking. The
  // failure is real, so silence (lint-touched.mjs's own choice when it has
  // nothing to say) would hide it; the fix is an explicit substitute that
  // still blocks, says what happened, and names a command to run by hand —
  // never the command's own TEXT, which is exactly what redaction exists
  // to keep off this surface.
  if (redacted.length === 0) {
    process.stderr.write(
      `harness-kit: the repository's "${picked.kind}" script failed, but its entire output matched the redaction filter ` +
      `and could not be shown here safely — run \`npm run ${picked.kind}\` locally to see the failure.\n`,
    );
  } else {
    process.stderr.write(boundReport(redacted, `harness-kit: the repository's "${picked.kind}" script failed:\n`) + '\n');
  }
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
