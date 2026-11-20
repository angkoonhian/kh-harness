#!/usr/bin/env node
// PostToolUse hook: lints the file an Edit/Write tool just touched and, if
// the linter reports a problem IN THAT FILE, tells Claude immediately by
// writing to stderr and exiting 2. Exit 2 does not block anything; the edit
// already happened, and the point is only to surface the problem fast.
//
// A lint run that did not confirm the file clean — the linter is missing,
// crashed, timed out, or failed without reporting on the file — is not a
// clean file. It exits 0 with one JSON object on stdout, telling both the
// user and Claude, once per session (see notConfirmedClean). The only other
// thing this script writes to stdout is the notice that the shared module
// beside it cannot be used (see assetNotice).
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
// uncovered file, an out-of-root file or a project with no lint script all
// end the same way — silently, exit 0, since there was nothing to check.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve, isAbsolute, basename, delimiter, relative, sep } from 'node:path';

// The shared module beside this hook can be older than the hook: `apply`
// leaves a hand-edited copy in place, and a static import of a name that copy
// lacks fails at link time with a stack trace on every run. Its shape is
// probed instead, and beside a stale or missing copy the hook does no work:
// it tells the person the fix in one `systemMessage` and exits 0, once per
// session when the copy still has the marker helpers and on every run when
// it does not. The shared module cannot hold this text: it is the file that
// may be missing.
const NEEDED = [
  'boundReport', 'dropCommandFragments', 'markerPath', 'maskText', 'MAX_REPORTS_SINCE_CLEAN',
  'pathTokenExemptions', 'projectRoot', 'readJSONMarker', 'runBounded', 'safeSessionId', 'signatureOf',
  'stripUnsafe', 'writeJSONMarker',
];
const MARKING = ['markerPath', 'projectRoot', 'safeSessionId'];
const REMEDY = 're-run `node scripts/apply.mjs <repo> --yes` from kh-harness to update the shared asset; if apply reports a file kept or gone, restore it to what kh-harness wrote (git holds it, in the commit that installed it), then run `apply --yes` again.';
let asset = {};
let assetProblem = null;
try {
  asset = await import('./harness-redact.mjs');
  if (NEEDED.some(name => !(name in asset))) assetProblem = 'is older than this hook and lacks what it needs';
} catch {
  assetProblem = 'is missing or cannot be loaded';
}
const {
  boundReport, dropCommandFragments, markerPath, maskText, MAX_REPORTS_SINCE_CLEAN, pathTokenExemptions,
  projectRoot, readJSONMarker, runBounded, safeSessionId, signatureOf, stripUnsafe, writeJSONMarker,
} = asset;

/** The exit code after telling the person, at most once in the session
 * `rawSessionId` names, that this hook did nothing because of the shared
 * module. A marker that cannot be made means the sentence is given anyway. */
function assetNotice(rawSessionId) {
  const sentence = `kh-harness lint-touched: .claude/scripts/harness-redact.mjs ${assetProblem}, so edited files are not linted — ${REMEDY}`;
  if (MARKING.every(name => name in asset)) {
    const sessionId = safeSessionId(rawSessionId);
    const tag = createHash('sha256').update(sentence, 'utf8').digest('hex').slice(0, 16);
    const path = sessionId === null ? null : markerPath(projectRoot(), sessionId, `lint-touched-notice-${tag}`);
    if (path !== null) {
      try {
        writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
      } catch (error) {
        if (error?.code === 'EEXIST') return 0;
      }
    }
  }
  process.stdout.write(JSON.stringify({ systemMessage: sentence }) + '\n');
  return 0;
}

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
// and get silently discarded — `runBounded` keeps the first LINT_MAX_BUFFER
// characters and lets the linter finish (see the call below).
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
 * appended — the lint script runs unmodified, and the attribution
 * filter (mentionsFile) still does its job, because that filter is already
 * required regardless of whether the path was appended. Appending is a
 * performance optimization only; correctness never depends on it.
 *
 * This is NOT, by itself, a containment guarantee: the class admits `.` and
 * `/`, so it happily matches `../x.ts`. Containment is enforced separately,
 * by resolving and checking against the project root (see isContained),
 * before this allowlist is ever consulted — see main().
 */
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9_./-]+$/;

// `.ts/.tsx/.js/.jsx/.mjs/.cjs` are the extensions a package.json-owned
// project's lint script plausibly covers; `.py` is the pyproject.toml
// analogue. There is no sniffing for an actually-installed linter beyond
// that.
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

/** Nearest ancestor of `startDir`, bounded at `rootDir` inclusive, whose
 * `manifestName` declares a lint script (as `readScript` reads it), with
 * that script — or null when none does. A nested package's own lint script
 * wins over one further up the tree; a manifest that declares none is
 * passed over, since a workspace package that leaves linting to the
 * repository root is still linted by the root's script.
 *
 * The bound terminates the walk at `rootDir` OR the filesystem root,
 * whichever comes first — both checks are unconditional, so a comparison
 * bug in one can never make the walk run past the other. `samePath`, not
 * `===`, decides the root bound, because `absPath`/`startDir` is never
 * required to share root's exact casing (see isContained's comment); a
 * plain `dir === root` can silently never fire and let the walk continue
 * to the filesystem root, adopting a manifest the project does not own. */
function findLintOwner(startDir, rootDir, manifestName, readScript) {
  let dir = resolve(startDir);
  const root = resolve(rootDir);
  for (;;) {
    if (existsSync(join(dir, manifestName))) {
      const lintScript = readScript(dir);
      if (lintScript) return { ownerDir: dir, lintScript };
    }
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

/**
 * The edited file is appended only to a PLAIN command. A script holding a
 * pipeline, a chain, a substitution or a newline is run unmodified:
 * appended to `a | b` or `a && b` the path lands on the LAST stage, where a
 * `tee` tail would overwrite the edited file.
 * A `;` is deliberately NOT a separator here: it is far more often inside
 * a quoted `node -e` body than between shell commands, and the cost of
 * missing a `;`-chain is a path appended to its last command.
 * A bare `.` or `./` token anywhere in the command is dropped first, so
 * `eslint .` and `eslint . --ext .ts` lint the one file instead of the whole
 * project plus the one file. Attribution
 * (`mentionsFile`) does not depend on any of this; appending is a cost
 * optimisation and the unmodified script still reports correctly.
 */
const COMPOUND_COMMAND = /[|`\n]|&&|\$\(/;
function appendTarget(lintScript, quotedPath) {
  if (COMPOUND_COMMAND.test(lintScript)) return lintScript;
  const kept = lintScript.split(/\s+/).filter(t => t !== '.' && t !== './');
  return `${kept.join(' ')} ${quotedPath}`;
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

const MAX_DISPLAY_PATH = 200;

/**
 * The edited file's name as this hook prints it, to stderr and into the
 * model's context: `tool_input.file_path` is attacker-shaped, so what a
 * reader cannot see is stripped, newlines and tabs become spaces so the
 * name stays on one line, and it is cut to MAX_DISPLAY_PATH characters,
 * ending in `…` when cut. Display only: the lint command, the marker keys
 * and attribution all use the real path.
 */
function displayPath(filePath) {
  const chars = Array.from(stripUnsafe(filePath).replace(/[\n\t]/g, ' '));
  return chars.length <= MAX_DISPLAY_PATH ? chars.join('') : `${chars.slice(0, MAX_DISPLAY_PATH - 1).join('')}…`;
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
 * home for the next leak, so the caller (main) MUST pass this function only
 * output `maskText` has already masked, and MUST run its full return value
 * through the same dropCommandFragments chokepoint as any other line,
 * never a parallel path.
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
 * The two-layer redaction (fragment denylist + credential masking) lives in
 * harness-redact.mjs, shared with verify-touched.mjs; see that file for what
 * each layer catches. `dropCommandFragments` is called below with
 * `[lintScript, fullCommand]` and an exemption set built from the appended
 * path.
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
 * `lines` is never empty: a failure with nothing attributable to the edited
 * file is not a lint report but a not-confirmed-clean notice (see
 * notConfirmedClean).
 */
function writeReport(lines) {
  process.stderr.write(boundReport(lines) + '\n');
  return 2;
}

/**
 * Dedupes a standing lint error so its FULL diagnostic is dumped once until
 * the file lints clean, not once per edit — without this, a file with one
 * unfixed lint error gets the identical notice re-surfaced on every single
 * subsequent edit to that file, which is how a sensor teaches people to
 * ignore it.
 * Keyed on `file + signature` (not merely the file) so a NEW, different
 * error on the same file still gets a full report: the SAME shared
 * signature/cap machinery verify-touched.mjs uses for the Stop gate,
 * applied per file here rather than once per session, since a sensor
 * naturally has one independent "stream" of potential issues per file
 * rather than one for the whole repository.
 *
 * Review correction (this was specified, then reversed, by the same
 * reviewer): a repeat MUST NEVER go fully silent. Claude edits a file,
 * is told about an issue, edits again meaning to fix it, and the fix
 * does not work — the identical error persists. Silence in that exact
 * moment is indistinguishable from the fix having worked; reporting
 * nothing is worse than the noise this was built to remove, because
 * `PostToolUse` exit 2 never blocks the turn — re-reporting costs tokens,
 * never a stall. So an identical repeat gets a TERSE one-line notice
 * instead (`action: 'terse'`) — still exit 2, naming the file and how many
 * times this exact issue has now been seen — never the full diagnostic
 * dump again, and never nothing. There is deliberately no suppression
 * threshold for an UNCHANGED issue: a fixed cutoff after N terse repeats
 * would only move the "silence impersonates success" defect to a later
 * count instead of removing it, so EVERY repeat, however many, gets its
 * own terse line.
 *
 * The per-file cap (`MAX_REPORTS_SINCE_CLEAN`) bounds the number of
 * DISTINCT full-diagnostic dumps for one file since it last linted clean.
 * A genuinely new error past the cap is never dropped either: it gets a
 * one-line count of the further distinct issues instead of its diagnostic,
 * still exit 2, so a new problem never looks like a clean file. A clean
 * run clears the file's history (see forgetFile), so the cap counts from
 * there and an error that returns after it is reported in full again.
 *
 * Returns `{ action: 'report' }` (an ordinary full report should proceed —
 * including when there is no usable `session_id` to key dedupe state on
 * at all, which is simply the old always-report behaviour) or
 * `{ action: 'terse', message }`.
 * A marker write failure fails OPEN in the opposite direction from
 * verify-touched.mjs's: there, failing to record state must never cause
 * an unbounded BLOCK; here, it must never cause a real problem to go
 * silently unreported — a write failure still returns `'report'`,
 * accepting that the dedupe nicety may not perfectly persist, rather than
 * ever hiding or flattening a lint finding.
 */
function dedupeDecision(root, sessionId, filePath, signature) {
  if (sessionId === null) return { action: 'report' };
  const path = markerPath(root, sessionId, 'sensor');
  const files = readFileHistories(path);
  const entry = Object.hasOwn(files, filePath) && files[filePath] && typeof files[filePath] === 'object' ? files[filePath] : null;
  // `count` is every distinct issue since the file last linted clean,
  // including those past the cap, so the further-issues line can count them.
  const count = Number.isFinite(Number(entry?.count)) && Number(entry?.count) >= 0 ? Number(entry.count) : 0;
  const lastSignature = typeof entry?.lastSignature === 'string' ? entry.lastSignature : null;
  const repeats = Number.isFinite(Number(entry?.repeats)) && Number(entry?.repeats) >= 0 ? Number(entry.repeats) : 0;
  const record = state => writeJSONMarker(path, { files: { ...files, [filePath]: state } });

  if (lastSignature === signature) {
    record({ count, lastSignature, repeats: repeats + 1 });
    const seen = repeats + 2; // +1 for the original report, +1 for this occurrence
    return {
      action: 'terse',
      message: `lint-touched: ${displayPath(filePath)} — unchanged since the last edit (the same issue has now been reported ${seen} times since the file last linted clean)`,
    };
  }

  record({ count: count + 1, lastSignature: signature, repeats: 0 });
  if (count >= MAX_REPORTS_SINCE_CLEAN) {
    return {
      action: 'terse',
      message: `lint-touched: ${count + 1 - MAX_REPORTS_SINCE_CLEAN} further distinct issues in ${displayPath(filePath)}; run the lint script`,
    };
  }
  return { action: 'report' };
}

/** The sensor marker's per-file histories, or `{}` when there are none. */
function readFileHistories(path) {
  const marker = readJSONMarker(path, { files: {} });
  return marker?.files && typeof marker.files === 'object' && !Array.isArray(marker.files) ? marker.files : {};
}

/** Clears `filePath`'s history after it lints clean. Best-effort: a write
 * that fails leaves the old history, which can only make a later report
 * terser, never hide it. */
function forgetFile(root, sessionId, filePath) {
  if (sessionId === null) return;
  const path = markerPath(root, sessionId, 'sensor');
  const files = readFileHistories(path);
  if (!Object.hasOwn(files, filePath)) return;
  const rest = { ...files };
  delete rest[filePath];
  writeJSONMarker(path, { files: rest });
}

/**
 * Says, once per session, that `shownPath` (the edited file, through
 * displayPath) was not confirmed clean — never a lint failure, so exit 0,
 * where Claude Code reads stdout as JSON and shows nothing from stderr. The one sentence goes to the person as
 * `systemMessage` and to the model as PostToolUse `additionalContext`, so
 * neither mistakes "never checked" for "clean". `outcome` carries the exit
 * code, signal or timeout and nothing from the linter's output: none of
 * that output named the file, so none of it is attributed to the file.
 * Once per session, not per file: a missing or broken linter fails the
 * same way for every file, and the sentence says later files go
 * unreported. A marker that cannot be read or written means the notice is
 * shown again, never that it is lost.
 */
function notConfirmedClean(root, sessionId, shownPath, outcome) {
  const path = sessionId === null ? null : markerPath(root, sessionId, 'sensor-unchecked');
  if (path !== null) {
    if (readJSONMarker(path, {}).noticed === true) return 0;
    writeJSONMarker(path, { noticed: true });
  }
  const sentence = `lint-touched: the lint script ${outcome}, so ${shownPath} was not confirmed clean. Files not confirmed later this session are not reported again.`;
  process.stdout.write(JSON.stringify({
    systemMessage: sentence,
    hookSpecificOutput: { hookEventName: 'PostToolUse', additionalContext: sentence },
  }) + '\n');
  return 0;
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
  if (assetProblem !== null) return assetNotice(payload.session_id);

  const root = projectRoot();
  const absPath = isAbsolute(filePath) ? filePath : join(root, filePath);
  // Containment BEFORE anything else touches the filesystem on this path's
  // behalf: an out-of-root file must never cause an out-of-tree
  // package.json to be found, read, or run — see isContained's comment.
  if (!isContained(root, absPath)) return 0;
  const startDir = dirname(absPath);

  // A pyproject.toml owner covers `.py` for the purpose of DECIDING whether
  // the file is in scope at all; readPyLintScript looks for the closest
  // real analogue to `scripts.lint` that pyproject.toml actually has.
  //
  // A .py file's NEAREST pyproject.toml rarely has a lint entry of its own.
  // In a workspace that drives every package through npm (a uv workspace
  // whose Python members each have a package.json whose `scripts.lint` is
  // `uv run ruff check …`), the command sits in a package.json in the SAME
  // directory as that pyproject.toml, so that one package.json is read when
  // the pyproject.toml has no lint entry; a pyproject entry wins. No other
  // package.json is: one further up belongs to a different, usually
  // JavaScript, package, whose linter would report nonsense on a .py file.
  // Found on a real uv + npm workspace, where every Python edit went
  // unlinted.
  let nearestPyproject = true;
  const readPyOwnerScript = dir => {
    const nearest = nearestPyproject;
    nearestPyproject = false;
    return readPyLintScript(dir) ?? (nearest ? readLintScript(dir) : null);
  };
  const owner = isJs
    ? findLintOwner(startDir, root, 'package.json', readLintScript)
    : findLintOwner(startDir, root, 'pyproject.toml', readPyOwnerScript);
  if (!owner) return 0;
  const { ownerDir, lintScript } = owner;

  // Resolved relative to ownerDir — which is runBounded's own `cwd` below —
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
  // captured output ever reaches stderr, masked (see maskText), filtered
  // for attribution, then stripped of command fragments (see
  // dropCommandFragments) before writeReport is ever called.
  const fullCommand = SAFE_RELATIVE_PATH.test(relToOwner)
    ? appendTarget(lintScript, quoteArg(relToOwner))
    : lintScript;
  const binDirs = [join(ownerDir, 'node_modules', '.bin'), join(root, 'node_modules', '.bin')];
  const PATH = [...binDirs, process.env.PATH ?? process.env.Path ?? ''].filter(Boolean).join(delimiter);

  const before = statSnapshot(absPath);

  // The shared bounded runner (harness-redact.mjs): a timeout kills the
  // whole process tree, not merely the shell, which is all that
  // `spawnSync({ timeout })` signals. An overflow keeps the first
  // LINT_MAX_BUFFER characters and lets the linter finish: the linter DID
  // run and DID produce output worth reporting.
  let result;
  try {
    result = await runBounded(fullCommand, {
      cwd: ownerDir,
      timeoutMs: LINT_TIMEOUT_MS,
      maxBuffer: LINT_MAX_BUFFER,
      env: { ...process.env, PATH },
    });
  } catch {
    return 0;
  }
  if (!result) return 0;

  // A timeout (our own kill), a spawn failure or any other signal is never
  // reported as a lint failure: whatever the run printed is incomplete.
  const sessionId = safeSessionId(payload.session_id);
  const shownPath = displayPath(filePath);
  if (result.timedOut) return notConfirmedClean(root, sessionId, shownPath, `timed out after ${LINT_TIMEOUT_MS / 1000}s before reporting on ${shownPath}`);
  if (result.error) return notConfirmedClean(root, sessionId, shownPath, 'could not be started');
  if (result.signal) return notConfirmedClean(root, sessionId, shownPath, `was killed by ${result.signal} before reporting on ${shownPath}`);

  // The file the edit touched may have been rewritten by scripts.lint
  // itself (an auto-fixing `--fix`/`--write` linter) — checked BEFORE the
  // "clean" short-circuit below, because that is exactly the case this
  // catches: the linter exits 0 after silently changing what Claude just
  // wrote. Reported in place of a lint failure, not alongside one, because
  // it is more urgent: whatever lint result exists may describe content
  // that no longer exists.
  if (hasChanged(before, statSnapshot(absPath))) {
    return writeReport([
      `lint-touched: ${shownPath} was modified by the lint script while it was being checked — Claude's edit may no longer match what is on disk.`,
    ]);
  }

  if (result.status === 0) { // clean — on overflow too: the linter's own exit code decides, with what was captured reported below
    forgetFile(root, sessionId, filePath);
    return 0;
  }

  const base = basename(filePath);
  // Each stream is masked as a whole before attribution and command
  // redaction, so a private key's body lines are masked with its header
  // whichever lines are dropped later, and a key left open in one stream
  // cannot swallow the other.
  const combined = `${maskText(result.stdout ?? '')}\n${maskText(result.stderr ?? '')}`;
  const attributed = extractAttributedBlocks(combined.split(/\r?\n/), filePath, base);
  // The edited file, its basename, and every token of the lint script that
  // names a directory of that file or a config file (`eslint src/components`,
  // `eslint -c .eslintrc.cjs`) — a diagnostic naming those is the report,
  // not an echo of the command. See pathTokenExemptions in harness-redact.mjs.
  const exemptions = new Set([relToOwner, basename(relToOwner), ...pathTokenExemptions(lintScript, [relToOwner])]);
  // Each command in both forms: the output is already masked, so an echo of
  // a command that carries a credential matches only the masked form, while
  // a credential value printed alone, outside any context the mask
  // recognises, matches only a raw token.
  const reported = dropCommandFragments(attributed, [lintScript, fullCommand].flatMap(c => [c, maskText(c)]), exemptions);
  // Nothing attributable survived: the run failed without saying anything
  // about this file, so it was not confirmed clean — and a filtered-out
  // report never participates in dedupe bookkeeping.
  if (reported.length === 0) return notConfirmedClean(root, sessionId, shownPath, `exited with code ${result.status} without reporting on ${shownPath}`);

  const decision = dedupeDecision(root, sessionId, filePath, signatureOf(reported));
  if (decision.action === 'terse') return writeReport([decision.message]);

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
