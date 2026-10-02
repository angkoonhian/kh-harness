#!/usr/bin/env node
// PostToolUse hook: lints the file an Edit/Write tool just touched and, if
// the linter reports a problem IN THAT FILE, tells Claude immediately by
// writing to stderr and exiting 2 — plain stdout is invisible to Claude, so
// this script never writes to it. Exit 2 does not block anything; the edit
// already happened, and the point is only to surface the problem fast.
//
// Reads the PostToolUse payload from stdin and takes CLAUDE_PROJECT_DIR as
// the project root, falling back to process.cwd() when it is unset. Never
// throws, never writes to the repository, and every spawn is bounded and
// wrapped: a malformed payload, an uncovered file, a missing lint script,
// or a linter that hangs all end the same way — silently, exit 0.
import { existsSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve, isAbsolute, basename, delimiter } from 'node:path';

// Overridable so a test can exercise the timeout path in milliseconds, not
// minutes; defaults to the real 30s bound otherwise.
const LINT_TIMEOUT_MS = Number(process.env.HK_LINT_TIMEOUT_MS) || 30_000;
// Mirrors session-brief.mjs's own bound on what it prints to a session.
const MAX_REPORT_LINES = 60;

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
 */
const SAFE_RELATIVE_PATH = /^[A-Za-z0-9_./-]+$/;

// `.ts/.tsx/.js/.jsx/.mjs/.cjs` are the extensions a package.json-owned
// project's lint script plausibly covers; `.py` is the pyproject.toml
// analogue. No sniffing for an actually-installed linter beyond that — see
// task-3-brief.md's ruling on extension coverage.
const JS_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']);
const PY_EXTENSIONS = new Set(['.py']);

function readStdin() {
  try {
    return readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

function extensionOf(filePath) {
  const base = basename(filePath);
  const i = base.lastIndexOf('.');
  return i <= 0 ? '' : base.slice(i).toLowerCase();
}

/** Nearest ancestor of `startDir`, bounded at `rootDir` inclusive, that
 * contains `filename`. This is the package that OWNS the edited file —
 * never the repository root by default, so a nested package's own (and
 * possibly lint-less) manifest wins over one further up the tree. */
function findAncestorWith(startDir, rootDir, filename) {
  let dir = resolve(startDir);
  const root = resolve(rootDir);
  for (;;) {
    if (existsSync(join(dir, filename))) return dir;
    if (dir === root) return null;
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

function main() {
  let payload;
  try {
    payload = JSON.parse(readStdin());
  } catch {
    return 0;
  }
  if (!payload || typeof payload !== 'object') return 0;

  const filePath = payload?.tool_input?.file_path;
  if (typeof filePath !== 'string' || filePath === '') return 0;

  const ext = extensionOf(filePath);
  const isJs = JS_EXTENSIONS.has(ext);
  const isPy = PY_EXTENSIONS.has(ext);
  if (!isJs && !isPy) return 0;

  const root = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const absPath = isAbsolute(filePath) ? filePath : join(root, filePath);
  const startDir = dirname(absPath);

  // A pyproject.toml owner covers `.py` for the purpose of DECIDING whether
  // the file is in scope at all; it has no standardized `scripts.lint`
  // equivalent, so there is nothing to run yet (see readLintScript).
  const manifestName = isJs ? 'package.json' : 'pyproject.toml';
  const ownerDir = findAncestorWith(startDir, root, manifestName);
  if (!ownerDir) return 0;

  const lintScript = isJs ? readLintScript(ownerDir) : null;
  if (!lintScript) return 0;

  // Invoked as the project's own lint script would be by `npm run lint --
  // <file>`, but through a shell directly (see package.json's own
  // `scripts.lint`): the script body is never altered. The touched file is
  // appended ONLY when it matches SAFE_RELATIVE_PATH — see that constant's
  // comment for why a non-matching path is never appended at all, rather
  // than escaped. `scripts.lint`'s TEXT is NEVER printed, logged, or
  // included in any error message below — only ITS OWN CAPTURED OUTPUT ever
  // reaches stderr, and only once it is confirmed to mention the edited file
  // (see mentionsFile / the attribution filter).
  const fullCommand = SAFE_RELATIVE_PATH.test(filePath)
    ? `${lintScript} ${quoteArg(filePath)}`
    : lintScript;
  const binDirs = [join(ownerDir, 'node_modules', '.bin'), join(root, 'node_modules', '.bin')];
  const PATH = [...binDirs, process.env.PATH ?? process.env.Path ?? ''].filter(Boolean).join(delimiter);

  let result;
  try {
    result = spawnSync(fullCommand, {
      cwd: ownerDir,
      timeout: LINT_TIMEOUT_MS,
      stdio: ['ignore', 'pipe', 'pipe'],
      encoding: 'utf8',
      shell: true,
      env: { ...process.env, PATH },
    });
  } catch {
    return 0;
  }

  // Covers both an outright spawn failure and a timeout (spawnSync sets
  // `result.error` with code ETIMEDOUT when LINT_TIMEOUT_MS elapses) —
  // neither is a lint failure, and neither is ever reported as one.
  if (!result || result.error || result.signal) return 0;
  if (result.status === 0) return 0;

  const base = basename(filePath);
  const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  const lines = combined.split(/\r?\n/).filter(l => l.trim() && mentionsFile(l, filePath, base));
  if (lines.length === 0) return 0; // nothing attributable to this edit

  const shown = lines.slice(0, MAX_REPORT_LINES);
  let report = shown.join('\n');
  if (lines.length > MAX_REPORT_LINES) {
    report += `\n--- truncated: ${lines.length - MAX_REPORT_LINES} more line(s) ---`;
  }
  process.stderr.write(report + '\n');
  return 2;
}

let code = 0;
try {
  code = main();
} catch {
  code = 0; // never throw — a hook that breaks a session is worse than none
}
process.exit(code);
