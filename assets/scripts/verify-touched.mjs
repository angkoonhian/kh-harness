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
// project root, falling back to process.cwd(). Writes to stdout only the
// `systemMessage` notice of an exit-0 turn (Claude Code shows nothing from
// stderr then), never writes inside the repository, and every spawn is
// bounded. The redaction applied to the command's own output, and the
// marker/signature machinery above, are shared with lint-touched.mjs via
// harness-redact.mjs
// — see that file's own comments for why a shared chokepoint exists at all.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import {
  boundReport,
  dropCommandFragments,
  MAX_BLOCKS_PER_SESSION,
  markerPath,
  maskCredentials,
  pathTokenExemptions,
  projectRoot,
  readJSONMarker,
  runBounded,
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

// The bounded runner and the process-tree kill live in harness-redact.mjs
// (`runBounded`, `killTree`) since audit Tier 3, shared with lint-touched.mjs.

/**
 * A fingerprint of the working tree — HEAD, `git status` for tracked and
 * untracked files, and the size and mtime of every path status lists — or
 * null outside a repository or when git cannot answer. Audit Tier 3,
 * finding 10: the whole typecheck re-ran on turns that changed nothing (a
 * read-only Q&A turn included). A fingerprint equal to the one recorded
 * after the last PASSING run means there is nothing new to verify, at the
 * cost of one `git status` and a few stats instead of a typecheck. Content
 * is not hashed: a tracked file edited twice between turns keeps its status
 * line but not its mtime and size, which is what the stats are for.
 */
function treeFingerprint(root) {
  // Bounded like every other spawn in this file: a hung filesystem, or a
  // project under a directory that is itself a repository, must not hold
  // the turn. A failure here means "no fingerprint": the gate runs as before.
  const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 });
  let top;
  let head;
  let status;
  try {
    // `git status --porcelain` paths are REPOSITORY-root relative whatever
    // the working directory (Tier 3 review, Critical 1: stat-ing them
    // against a project rooted below the toplevel — a monorepo package —
    // found nothing, hashed every path as `gone`, and a file edited twice
    // between turns was skipped as unchanged).
    top = git(['rev-parse', '--show-toplevel']).trim();
    status = git(['status', '--porcelain', '-z', '--untracked-files=all']);
  } catch {
    return null;
  }
  try {
    head = git(['rev-parse', '--verify', '-q', 'HEAD']).trim();
  } catch {
    head = 'unborn';
  }
  // Not seen here, by design: an IGNORED file never appears in status, so a
  // verification that depends on a gitignored input Claude edits is skipped
  // — the one blind spot of fingerprinting the index instead of the disk.
  const hash = createHash('sha256').update(head).update('\0').update(status);
  const records = status.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i];
    if (record.length < 4) continue;
    const xy = record.slice(0, 2);
    const path = record.slice(3);
    // A rename or copy emits the ORIGINAL path as the next record; the
    // status text already covers it, and it is not a path to stat.
    if (xy.includes('R') || xy.includes('C')) i += 1;
    try {
      const st = statSync(join(top, path));
      hash.update(`${path}\0${st.size}\0${st.mtimeMs}\0`);
    } catch {
      hash.update(`${path}\0gone\0`);
    }
  }
  return hash.digest('hex');
}

/**
 * An exit-0 notice. Claude Code never shows a hook's stderr when it exits 0
 * (audit Tier 3, finding 12: the "already reported" and "cap reached" lines
 * were invisible); `systemMessage` is the documented field "shown to the
 * user", and stdout is where it goes.
 */
function notice(text) {
  process.stdout.write(JSON.stringify({ systemMessage: text }) + '\n');
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

  // Shared with session-brief.mjs, which used a bare process.cwd() —
  // whole-branch review, F4: three hooks, two conventions, one of them wrong.
  const root = projectRoot();
  const scripts = readScripts(root);
  if (!scripts) return 0; // no package.json, or unreadable — nothing to verify

  const picked = pickVerifyCommand(scripts);
  if (!picked) return 0; // neither typecheck nor test exists — nothing to verify

  const path = markerPath(root, sessionId, 'stop');
  const marker = readJSONMarker(path, { count: 0, lastSignature: null, timedOut: false, verifiedFingerprint: null });
  const count = Number.isFinite(Number(marker.count)) && Number(marker.count) >= 0 ? Number(marker.count) : 0;
  const lastSignature = typeof marker.lastSignature === 'string' ? marker.lastSignature : null;
  const verifiedFingerprint = typeof marker.verifiedFingerprint === 'string' ? marker.verifiedFingerprint : null;

  // A prior turn in this SAME session already established this command
  // cannot finish within the bound — re-running it would pay the full
  // VERIFY_TIMEOUT_MS again to learn nothing new. Skip entirely.
  if (marker.timedOut === true) return 0;

  // Nothing changed since the last PASSING run of this session: nothing to
  // verify — see treeFingerprint. Outside a repository there is no
  // fingerprint and every turn runs.
  const fingerprint = treeFingerprint(root);
  if (fingerprint !== null && fingerprint === verifiedFingerprint) return 0;
  // Keeps the rest of the marker (count, lastSignature) as it is.
  const remember = extra => writeJSONMarker(path, { count, lastSignature, timedOut: false, verifiedFingerprint: null, ...extra });

  const binDir = join(root, 'node_modules', '.bin');
  const PATH = [binDir, process.env.PATH ?? process.env.Path ?? ''].filter(Boolean).join(delimiter);

  let result;
  try {
    result = await runBounded(picked.command, {
      cwd: root,
      timeoutMs: VERIFY_TIMEOUT_MS,
      maxBuffer: VERIFY_MAX_BUFFER,
      killGraceMs: KILL_GRACE_MS,
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
    const wrote = remember({ count: count + 1, lastSignature: signature, timedOut: true });
    if (!wrote) return 0; // fail open — see this file's header comment
    process.stderr.write(
      `kh-harness: the repository's "${picked.kind}" script did not finish within ${Math.round(VERIFY_TIMEOUT_MS / 1000)}s ` +
      `and was stopped. Verification will be skipped for the rest of this session so it does not pay this cost on every turn.\n`,
    );
    return 2;
  }

  // An overflow (output exceeded VERIFY_MAX_BUFFER) is not a verification
  // failure in itself: the command ran to its own end — audit Tier 3,
  // finding 12: it used to be KILLED at the cutoff and then blamed, so a
  // passing but verbose command blocked the turn — and `result.status` is
  // its own. What was captured before the cut is reported below, with the
  // cut named in the header. Any error (a spawn failure) or signal (a kill
  // that was not our own timeout) is never reported as a verification
  // failure.
  if (result.error || result.signal) return 0;

  if (result.status === 0) {
    // Verification passed — nothing to say; remember the tree it passed
    // on, so an unchanged tree is not verified again this session.
    if (fingerprint !== null) remember({ verifiedFingerprint: fingerprint });
    return 0;
  }

  const rawLines = `${result.stdout ?? ''}\n${result.stderr ?? ''}`.split(/\r?\n/).filter(l => l.trim());
  // The shared redaction chokepoint — identical layering to
  // lint-touched.mjs's own stderr, because this output reaches stderr too
  // and the command's own body can carry a credential exactly as a
  // `scripts.lint` body has, twice, in this project's own history. A token
  // of the command that names a config file (`tsc -p tsconfig.build.json`)
  // is exempt from the fragment rule, or every diagnostic mentioning the
  // config would be dropped as an echo of the command.
  const redacted = dropCommandFragments(rawLines, [picked.command], pathTokenExemptions(picked.command)).map(maskCredentials);

  if (count >= MAX_BLOCKS_PER_SESSION) {
    notice(`kh-harness: the stop gate's ${MAX_BLOCKS_PER_SESSION}-block cap for this session has been reached — letting the turn end.`);
    return 0;
  }

  const signature = signatureOf(redacted);
  if (lastSignature === signature) {
    notice(`kh-harness: this is the same "${picked.kind}" failure already reported this session — letting the turn end.`);
    return 0;
  }

  const wrote = remember({ count: count + 1, lastSignature: signature });
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
      `kh-harness: the repository's "${picked.kind}" script failed, but its entire output matched the redaction filter ` +
      `and could not be shown here safely — run \`npm run ${picked.kind}\` locally to see the failure.\n`,
    );
  } else {
    const cut = result.overflowed
      ? ` (output cut at ${Math.round(VERIFY_MAX_BUFFER / 1024)} KB; run \`npm run ${picked.kind}\` for the rest)`
      : '';
    process.stderr.write(boundReport(redacted, `kh-harness: the repository's "${picked.kind}" script failed${cut}:\n`) + '\n');
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
