#!/usr/bin/env node
// assets/scripts/dispatch-pre-tool.mjs
//
// PreToolUse entry script: runs, in one process and in this order, the
// halves in `preHalves`, the gate hook (tool-gate.mjs) and the logging hook
// (session-log.mjs), through the shared core harness-dispatch.mjs, and
// writes their combined output. Always exits with the highest code a half
// returned. Its registration in .claude/settings.json is the switch: the
// hooks it runs are not registered on this event separately.
//
// A core that is missing or too old to provide what this script uses means
// no hook runs, and every call says so in one fixed notice; while the
// repository holds an extensions file, every call is blocked instead, since
// nothing can apply the extensions it lists. The same holds for the loader
// of those extensions, harness-extensions.mjs, except that the gate and the
// log still run beside the block. Whether there is such a file is decided
// here, before either module is loaded, from Node built-ins alone; without
// one, the loader is never loaded.
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const EVENT = 'PreToolUse';
const CORE = ['dispatch', 'half'];

const REMEDY = 're-run `node scripts/apply.mjs <repo> --yes` from kh-harness to update the shared modules; if apply reports a file kept or gone, restore it to what kh-harness wrote (git holds it, in the commit that installed it), then run `apply --yes` again.';

const EXTENSIONS_FILE = '.claude/kh-harness/extensions.json';
const MISSING = 'is missing or cannot be loaded';
const OLDER = 'is older than this entry script and lacks what it needs';

/** True unless the extensions file is plainly not there, by the rule
 * harness-extensions.mjs's `readExtensions` reads it by: a `.claude` that is
 * a file, a `.claude` link through which anything is at the file's path, a
 * `.claude/kh-harness` that is not a directory, anything at the file's
 * path, and any failure to look, make it there. */
function extensionsExpected(root) {
  try {
    const claude = lstatSync(join(root, '.claude'), { throwIfNoEntry: false });
    if (claude === undefined) return false;
    if (claude.isSymbolicLink()) return reached(join(root, EXTENSIONS_FILE));
    if (!claude.isDirectory()) return true;
    const khHarness = lstatSync(join(root, '.claude/kh-harness'), { throwIfNoEntry: false });
    if (khHarness === undefined) return false;
    if (!khHarness.isDirectory()) return true;
    return lstatSync(join(root, EXTENSIONS_FILE), { throwIfNoEntry: false }) !== undefined;
  } catch {
    return true;
  }
}

/** True when something is at `path`, following every link on the way;
 * false when nothing is, or a component of it is not a directory. */
function reached(path) {
  try {
    return statSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch (error) {
    if (error?.code === 'ENOTDIR') return false;
    throw error;
  }
}

/** The half result that blocks every call because the installed `file` is
 * unusable while the repository holds an extensions file. */
const unusable = (file, problem) => ({
  json: { hookSpecificOutput: { hookEventName: EVENT, permissionDecision: 'deny', permissionDecisionReason: `kh-harness: .claude/scripts/${file} ${problem} while ${EXTENSIONS_FILE} exists, so every tool call is blocked. Run kh-harness apply --yes, or remove the extensions file, outside this session.` } },
  stderr: '',
  exitCode: 0,
});

/** The extensions half, from the loader imported here rather than at the
 * top, so a loader that cannot be loaded leaves the gate and the log
 * running. */
async function extensions(payload) {
  let loader;
  try {
    loader = await import('./harness-extensions.mjs');
  } catch {
    return unusable('harness-extensions.mjs', MISSING);
  }
  if (typeof loader.extensionsHalf !== 'function') return unusable('harness-extensions.mjs', OLDER);
  return loader.extensionsHalf(payload);
}

/** Halves run before the gate, in order, while the repository holds an
 * extensions file. */
export const preHalves = [{ name: 'extensions', run: extensions }];

function coreNotice(problem) {
  process.stdout.write(JSON.stringify({ systemMessage: `kh-harness dispatch-pre-tool: .claude/scripts/harness-dispatch.mjs ${problem}, so no kh-harness hook ran on ${EVENT} — ${REMEDY}` }) + '\n');
  return 0;
}

/** Without a core nothing reads the payload, so the block is written for
 * whatever call this is. */
function coreUnusable(expected, problem) {
  if (!expected) return coreNotice(problem);
  process.stdout.write(JSON.stringify(unusable('harness-dispatch.mjs', problem).json) + '\n');
  return 0;
}

async function main() {
  const expected = extensionsExpected(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  let core;
  try {
    core = await import('./harness-dispatch.mjs');
  } catch {
    return coreUnusable(expected, MISSING);
  }
  if (CORE.some(name => typeof core[name] !== 'function')) return coreUnusable(expected, OLDER);
  return core.dispatch(EVENT, [
    ...(expected ? preHalves : []),
    core.half('gate', 'tool-gate.mjs', 'gateHalf', () => import('./tool-gate.mjs')),
    core.half('log', 'session-log.mjs', 'logHalf', () => import('./session-log.mjs')),
  ]);
}

/** True when this file is the process's entry point rather than an import.
 * Both sides are resolved to their real spelling, since the command line may
 * name the script through a link or a win32 short name. */
function isEntryPoint() {
  try {
    return realpathSync.native(process.argv[1]) === realpathSync.native(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  let code = 0;
  try {
    code = await main();
  } catch {
    code = 0; // never throw — a hook that breaks a session is worse than none
  }
  // Not `exitCode`: a stdin the caller never closed would keep the process.
  process.exit(code);
}
