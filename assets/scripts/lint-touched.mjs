#!/usr/bin/env node
// PostToolUse hook: lints the file an Edit/Write tool just touched and, if
// the linter reports a problem IN THAT FILE, tells Claude immediately by
// writing to stderr and exiting 2 — plain stdout is invisible to Claude, so
// this script never writes to it. Exit 2 does not block anything; the edit
// already happened, and the point is only to surface the problem fast.
//
// This script itself never writes to the repository — but the project's
// OWN lint script might (an auto-fixing `scripts.lint` such as
// `eslint --fix` rewrites the very file it was asked to check). That is
// detected (see statSnapshot/hasChanged below) and reported as a failure
// rather than left for Claude to discover on its own.
//
// Reads the PostToolUse payload from stdin and takes CLAUDE_PROJECT_DIR as
// the project root, falling back to process.cwd() when it is unset. Never
// throws, and every spawn is bounded and wrapped: a malformed payload, an
// uncovered file, an out-of-root file, a missing lint script, or a linter
// that hangs all end the same way — silently, exit 0.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, isAbsolute, basename, delimiter, relative, sep } from 'node:path';
import {
  boundReport,
  dropCommandFragments,
  maskCredentials,
  MAX_BLOCKS_PER_SESSION,
  markerPath,
  readJSONMarker,
  safeSessionId,
  signatureOf,
  writeJSONMarker,
} from './harness-redact.mjs';

// Overridable so a test can exercise the timeout path in milliseconds, not
// minutes; defaults to the real 30s bound otherwise.
const LINT_TIMEOUT_MS = Number(process.env.HK_LINT_TIMEOUT_MS) || 30_000;
// A hard ceiling on how long reading stdin may block. PostToolUse always
// supplies and closes stdin promptly, so this should never fire in
// practice — but "never hang" is this file's own invariant, and a plain
// `readFileSync(0)` has no way to honour it if that assumption is ever
// wrong. Reading asynchronously (see readStdin) is what makes a timer
// actually able to pre-empt it; a blocking sync read cannot be raced.
const STDIN_TIMEOUT_MS = Number(process.env.HK_STDIN_TIMEOUT_MS) || 5_000;
// Generous but bounded: raised from spawnSync's 1MB default so a verbose
// `eslint .` whole-project run (the fallback path below) does not overflow
// and get silently discarded — see the overflow handling near `isOverflow`.
// Overridable (like HK_LINT_TIMEOUT_MS) so a test can cross the threshold
// with a small fixture instead of generating megabytes of real output.
const LINT_MAX_BUFFER = Number(process.env.HK_LINT_MAX_BUFFER) || 10 * 1024 * 1024;

/**
 * `tool_input.file_path` is attacker-shaped: it is NEVER required to exist
 * on disk (existsSync below is only ever used to locate the OWNING
 * package.json, never to validate this path), and it goes straight into a
 * shell command string. A hand-quoted argument is exactly the kind of thing
 * that is subtly wrong on one platform — a `"`-escaping scheme that holds on
 * POSIX can still let a `"` terminate a cmd.exe-quoted argument early,
 * because `\"` is not an escape to cmd.exe. Rather than trying to make
 * quoting provably correct on both shells, this allowlist removes the
 * problem instead: only a path built entirely from these characters is ever
 * interpolated into the command string at all. Anything else is NEVER
 * appended — the lint script runs unmodified, and ruling 1's attribution
 * filter (mentionsFile) still does its job, because that filter is already
 * required regardless of whether the path was appended (`eslint .` ignores
 * an appended path anyway). Appending is a performance optimization only;
 * correctness never depends on it.
 *
 * This is NOT, by itself, a containment guarantee: the class admits `.` and
 * `/`, so it happily matches `../x.ts`. Containment is enforced separately,
 * by resolving and checking against the project root (see isContained),
 * before this allowlist is ever consulted — see main().
 */
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9_./-]+$/;

// `.ts/.tsx/.js/.jsx/.mjs/.cjs` are the extensions a package.json-owned
// project's lint script plausibly covers; `.py` is the pyproject.toml
// analogue. No sniffing for an actually-installed linter beyond that — see
// task-3-brief.md's ruling on extension coverage.
const JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const PY_EXTENSIONS = new Set(['.py']);

/** Reads all of stdin, bounded by STDIN_TIMEOUT_MS. Async (not
 * `readFileSync(0)`) specifically so the timer below can actually race it —
 * a blocking synchronous read cannot be pre-empted by a timer on the same
 * thread, no matter how the timer is scheduled. */
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

function extensionOf(filePath) {
  const base = basename(filePath);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
}

/** True if any path segment is exactly `..` — rejected outright, before any
 * resolution happens, rather than relying on SAFE_RELATIVE_PATH (which
 * admits `.` and `/` and therefore admits `..` too; see its comment). */
function hasDotDotSegment(filePath) {
  return filePath.split(/[\\/]/).includes('..');
}

/** Case-insensitive on win32 (where `resolve('c:/a')` and `resolve('C:/a')`
 * are NOT the same string, but ARE the same directory), exact elsewhere. */
function samePath(a, b) {
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/**
 * Containment, decided by resolving both paths and asking `path.relative`
 * whether one escapes the other — never by inspecting the input string.
 * This is deliberately the same shape as apply-lib.mjs's `assertContained`
 * (which this standalone hook cannot import): `path.relative` decomposes
 * into real path segments, so it does not fall for a textual prefix trick
 * like `/root` matching `/rootevil` the way a bare `startsWith` would.
 * Case-insensitive on win32 for the same reason `samePath` is — a drive
 * letter typed in a different case is the same directory, not a different
 * one, and must not be treated as "escaped" OR "contained" inconsistently
 * with the rest of this file.
 */
function isContained(root, absPath) {
  const r = resolve(root);
  const p = resolve(absPath);
  const rr = process.platform === 'win32' ? r.toLowerCase() : r;
  const rp = process.platform === 'win32' ? p.toLowerCase() : p;
  const rel = relative(rr, rp);
  return !isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`);
}

/** Nearest ancestor of `startDir`, bounded at `rootDir` inclusive, that
 * contains `filename`. This is the package that OWNS the edited file —
 * never the repository root by default, so a nested package's own (and
 * possibly lint-less) manifest wins over one further up the tree.
 *
 * The bound terminates the walk at `rootDir` OR the filesystem root,
 * whichever comes first — both checks are unconditional, so a comparison
 * bug in one can never make the walk run past the other. `samePath`, not
 * `===`, decides the root bound, because `absPath`/`startDir` is never
 * required to share root's exact casing (see isContained's comment); a
 * plain `dir === root` can silently never fire and let the walk continue
 * to the filesystem root, adopting a manifest the project does not own. */
function findAncestorWith(startDir, rootDir, filename) {
  let dir = resolve(startDir);
  const root = resolve(rootDir);
  for (;;) {
    if (existsSync(join(dir, filename))) return dir;
    if (samePath(dir, root)) return null;
    const parent = dirname(dir);
    if (parent === dir) return null; // reached the filesystem root
    dir = parent;
  }
}

function readLintScript(ownerDir) {
  try {
    const pkg = JSON.parse(readFileSync(join(ownerDir, 'package.json'), 'utf8'));
    const lint = pkg?.scripts?.lint;
    return typeof lint === 'string' && lint.trim() ? lint : null;
  } catch {
    return null;
  }
}

/**
 * A minimal, intentionally narrow TOML read. `pyproject.toml` has no
 * standardized `scripts.lint` equivalent the way `package.json` does, so
 * this looks for the closest real-world analogue — a bare `[scripts]` or
 * `[tool.poetry.scripts]` table with a `lint = "..."` entry — by scanning
 * lines, not by pulling in a TOML parser (zero runtime dependencies). No
 * sniffing for an installed linter: if neither table defines `lint`, there
 * is nothing to run, by design, not by omission.
 */
function readPyLintScript(ownerDir) {
  try {
    const text = readFileSync(join(ownerDir, 'pyproject.toml'), 'utf8');
    let inScriptsTable = false;
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      const header = line.match(/^\[([^\]]+)\]$/);
      if (header) {
        inScriptsTable = header[1] === 'scripts' || header[1] === 'tool.poetry.scripts';
        continue;
      }
      if (!inScriptsTable) continue;
      const m = line.match(/^lint\s*=\s*"([^"]*)"\s*$/) || line.match(/^lint\s*=\s*'([^']*)'\s*$/);
      if (m && m[1].trim()) return m[1];
    }
    return null;
  } catch {
    return null;
  }
}

// Belt-and-braces quoting for the allowlisted case only — SAFE_RELATIVE_PATH
// already excludes every character that would need escaping (no space, no
// quote, no shell metacharacter), so this can never be handed a dangerous
// value. It is not what makes the append safe; the allowlist is.
function quoteArg(value) {
  return process.platform === 'win32'
    ? `"${value.replace(/"/g, '\\"')}"`
    : `'${value.replace(/'/g, "'\\''")}'`;
}

/** True if `line` plausibly refers to the edited file: matched on the path
 * as given AND on its basename, with `\` and `/` treated as equivalent —
 * this repo is developed on Windows and its tests run on both. */
function mentionsFile(line, filePath, base) {
  const normLine = line.replace(/\\/g, '/');
  const normPath = filePath.replace(/\\/g, '/');
  return normLine.includes(normPath) || line.includes(base);
}

/**
 * Attribution BLOCKS, not just attributed lines. A single line mentioning
 * the edited file is too narrow for the dominant real linter's own default
 * output: eslint's "stylish" formatter prints the bare file path on its
 * own line, then each diagnostic on a FOLLOWING indented line that never
 * itself mentions the file — reporting only the bare path line tells
 * Claude something is wrong and gives it no way to know what.
 *
 * The rule: a line that mentions the edited file OPENS a block and is
 * forwarded. A line that follows and begins with whitespace is forwarded
 * as a CONTINUATION of that block, exempt from mentionsFile but NEVER
 * from redaction — continuations are the first output this hook emits
 * that is not anchored to the edited path, which makes them the natural
 * home for the next leak, so the caller (main) MUST run the full return
 * value of this function through the same dropCommandFragments /
 * maskCredentials chokepoint as any other line, never a parallel path.
 * The block closes at the first blank line or the first non-indented
 * line; a later line must mention the file again to open a new one.
 */
function extractAttributedBlocks(lines, filePath, base) {
  const out = [];
  let inBlock = false;
  for (const line of lines) {
    if (!line.trim()) { inBlock = false; continue; } // a blank line always closes a block
    const isContinuation = inBlock && /^[ \t]/.test(line);
    if (isContinuation) {
      out.push(line);
      continue;
    }
    inBlock = false;
    if (mentionsFile(line, filePath, base)) {
      out.push(line);
      inBlock = true;
    }
  }
  return out;
}

function statSnapshot(path) {
  try {
    const st = statSync(path);
    return { size: st.size, mtimeMs: st.mtimeMs };
  } catch {
    return null; // absent — never treated as "changed" by itself below
  }
}

/** True only when the file demonstrably differs, or appeared/disappeared —
 * never true when either snapshot could not be taken, so a stat failure
 * can only under-report a mutation, never fabricate one. */
function hasChanged(before, after) {
  if (before === null && after === null) return false;
  if (before === null || after === null) return true;
  return before.size !== after.size || before.mtimeMs !== after.mtimeMs;
}

/**
 * Ruling 2's two-layer redaction (fragment denylist + credential masking)
 * now lives in harness-redact.mjs, shared verbatim with verify-touched.mjs —
 * see that file's own comment for what each layer catches and why a shared
 * chokepoint exists at all. `dropCommandFragments` is called below with
 * `[lintScript, fullCommand]` and an exemption set built from the appended
 * path, exactly reproducing this file's previous (lintScript, fullCommand,
 * appendedPath)-shaped call.
 */

/**
 * The single chokepoint every byte reported to Claude passes through —
 * bounded by both line count and byte size (`boundReport`, shared with
 * verify-touched.mjs so neither hook's bound can drift from the other's),
 * and this is the ONLY `process.stderr.write` in this file. Nothing
 * upstream may write to stderr directly; every path that can report
 * something builds a line list and hands it here, so redaction (above)
 * cannot be bypassed by a future call site that forgets it.
 *
 * Unlike verify-touched.mjs, an EMPTY `lines` here genuinely means nothing
 * happened: this hook's own report is already attribution-filtered (see
 * extractAttributedBlocks), so a failure that mentions nothing about the
 * edited file was correctly never attributed to it, and staying silent is
 * the right call, not a missing guard — verify-touched.mjs blocks on every
 * real failure of a WHOLE-repo command, where "nothing survived redaction"
 * can still mean "the command genuinely failed", which is why that file
 * needs an explicit substitute message instead of this early return.
 */
function writeReport(lines) {
  if (lines.length === 0) return 0;
  process.stderr.write(boundReport(lines) + '\n');
  return 2;
}

/**
 * Dedupes a standing lint error so it is reported once per session, not
 * once per edit — without this, a file with one unfixed lint error gets
 * the identical notice re-surfaced on every single subsequent edit to that
 * file, which is how a sensor teaches people to ignore it. Keyed on `file
 * + signature` (not merely the file) so a NEW, different error on the same
 * file still gets reported: the SAME shared signature/cap machinery
 * verify-touched.mjs uses for the Stop gate, applied per file here rather
 * than once per session, since a sensor naturally has one independent
 * "stream" of potential issues per file rather than one for the whole
 * repository.
 *
 * Returns `true` when this exact (file, signature) pair has already been
 * reported `MAX_BLOCKS_PER_SESSION` times or more for THIS file, or was
 * the most recently reported one for it. A marker write failure fails
 * OPEN in the opposite direction from verify-touched.mjs's: there, failing
 * to record state must never cause an unbounded BLOCK; here, it must
 * never cause a real problem to go silently UNREPORTED — so a write
 * failure here still reports (returns `false`), accepting that the
 * dedupe nicety may not perfectly persist, rather than ever hiding a lint
 * finding from Claude. No `session_id` to key on (malformed payload, or a
 * value that fails `safeSessionId`) means dedupe is simply skipped — the
 * old, always-report behaviour, not a reason to suppress anything.
 */
function shouldSuppressDuplicate(root, sessionId, filePath, signature) {
  if (sessionId === null) return false;
  const path = markerPath(root, sessionId, 'sensor');
  const marker = readJSONMarker(path, { files: {} });
  const files = marker?.files && typeof marker.files === 'object' && !Array.isArray(marker.files) ? marker.files : {};
  const entry = files[filePath] && typeof files[filePath] === 'object' ? files[filePath] : null;
  const count = Number.isFinite(Number(entry?.count)) && Number(entry?.count) >= 0 ? Number(entry.count) : 0;
  const lastSignature = typeof entry?.lastSignature === 'string' ? entry.lastSignature : null;

  if (count >= MAX_BLOCKS_PER_SESSION || lastSignature === signature) return true;

  writeJSONMarker(path, { files: { ...files, [filePath]: { count: count + 1, lastSignature: signature } } });
  return false;
}

async function main() {
  let payload;
  try {
    payload = JSON.parse(await readStdin(STDIN_TIMEOUT_MS));
  } catch {
    return 0;
  }
  if (!payload || typeof payload !== 'object') return 0;

  const filePath = payload?.tool_input?.file_path;
  if (typeof filePath !== 'string' || filePath === '') return 0;
  if (hasDotDotSegment(filePath)) return 0;

  const ext = extensionOf(filePath);
  const isJs = JS_EXTENSIONS.has(ext);
  const isPy = PY_EXTENSIONS.has(ext);
  if (!isJs && !isPy) return 0;

  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const absPath = isAbsolute(filePath) ? filePath : join(root, filePath);
  // Containment BEFORE anything else touches the filesystem on this path's
  // behalf: an out-of-root file must never cause an out-of-tree
  // package.json to be found, read, or run — see isContained's comment.
  if (!isContained(root, absPath)) return 0;
  const startDir = dirname(absPath);

  // A pyproject.toml owner covers `.py` for the purpose of DECIDING whether
  // the file is in scope at all; readPyLintScript looks for the closest
  // real analogue to `scripts.lint` that pyproject.toml actually has.
  const manifestName = isJs ? 'package.json' : 'pyproject.toml';
  const ownerDir = findAncestorWith(startDir, root, manifestName);
  if (!ownerDir) return 0;

  const lintScript = isJs ? readLintScript(ownerDir) : readPyLintScript(ownerDir);
  if (!lintScript) return 0;

  // Resolved relative to ownerDir — which is spawnSync's own `cwd` below —
  // not root-relative `filePath`. Appending the root-relative form handed
  // a nested package's linter a path that does not exist relative to
  // where it actually runs, producing a bogus "file not found" blamed on
  // the edit. This is also what makes SAFE_RELATIVE_PATH reachable on
  // Windows at all: a production `file_path` there is absolute (a drive
  // letter and `\`) and can never match the allowlist, but a path relative
  // to ownerDir almost always will.
  const relToOwner = relative(ownerDir, absPath).split(sep).join('/');

  // Invoked as the project's own lint script would be by `npm run lint --
  // <file>`, but through a shell directly (see package.json's own
  // `scripts.lint`): the script body is never altered. The touched file is
  // appended ONLY when `relToOwner` matches SAFE_RELATIVE_PATH — see that
  // constant's comment for why a non-matching path is never appended at
  // all, rather than escaped. `scripts.lint`'s TEXT is NEVER printed,
  // logged, or included in any error message below — only its own
  // captured output ever reaches stderr, filtered for attribution, then
  // redacted in two layers (see dropCommandFragments, maskCredentials)
  // before writeReport is ever called.
  const fullCommand = SAFE_RELATIVE_PATH.test(relToOwner)
    ? `${lintScript} ${quoteArg(relToOwner)}`
    : lintScript;
  const binDirs = [join(ownerDir, 'node_modules', '.bin'), join(root, 'node_modules', '.bin')];
  const PATH = [...binDirs, process.env.PATH ?? process.env.Path ?? ''].filter(Boolean).join(delimiter);

  const before = statSnapshot(absPath);

  let result;
  try {
    result = spawnSync(fullCommand, {
      cwd: ownerDir,
      timeout: LINT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      shell: true,
      maxBuffer: LINT_MAX_BUFFER,
      env: { ...process.env, PATH },
    });
  } catch {
    return 0;
  }
  if (!result) return 0;

  // ENOBUFS (output exceeded LINT_MAX_BUFFER) is NOT a lint failure, but
  // unlike a spawn failure or a real timeout, the linter DID run and DID
  // produce output worth reporting — only the pipe buffer, not the
  // linter, hit a limit. Reporting what was captured (rather than
  // discarding it, which is spawnSync's own default behaviour) is the
  // whole fix; everything below already tolerates a truncated/null
  // `result.status` the same way it tolerates a clean exit.
  const isOverflow = result.error?.code === 'ENOBUFS';
  // Any OTHER error (spawn failure) or signal (most commonly our own
  // timeout kill) is never reported as a lint failure.
  if ((result.error || result.signal) && !isOverflow) return 0;

  // The file the edit touched may have been rewritten by scripts.lint
  // itself (an auto-fixing `--fix`/`--write` linter) — checked BEFORE the
  // "clean" short-circuit below, because that is exactly the case this
  // catches: the linter exits 0 after silently changing what Claude just
  // wrote. Reported in place of a lint failure, not alongside one, because
  // it is more urgent: whatever lint result exists may describe content
  // that no longer exists.
  if (hasChanged(before, statSnapshot(absPath))) {
    return writeReport([
      `lint-touched: ${filePath} was modified by the lint script while it was being checked — Claude's edit may no longer match what is on disk.`,
    ]);
  }

  if (result.status === 0) return 0; // clean (status is null on overflow, so this never short-circuits it away)

  const base = basename(filePath);
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const attributed = extractAttributedBlocks(combined.split(/\r?\n/), filePath, base);
  const exemptions = new Set([relToOwner, basename(relToOwner)]);
  const survived = dropCommandFragments(attributed, [lintScript, fullCommand], exemptions);
  const reported = survived.map(maskCredentials);
  if (reported.length === 0) return 0; // nothing attributable survived — writeReport's own guard would catch this too, but checking first means a filtered-out report never participates in dedupe bookkeeping at all

  const sessionId = safeSessionId(payload.session_id);
  if (shouldSuppressDuplicate(root, sessionId, filePath, signatureOf(reported))) return 0;

  return writeReport(reported);
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
