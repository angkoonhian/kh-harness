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
// The core and the loader of the extensions, harness-extensions.mjs, are
// used only when each exports `LEVEL` equal to this script's own: a file
// from another kit version, older or newer, is refused whatever functions
// it exports. A core that is missing or refused means no hook runs, and
// every call says so in one fixed notice; while the repository holds an
// extensions file, every call is blocked instead, since nothing can apply
// the extensions it lists. The same holds for the loader, except that the
// gate and the log still run beside the block. Whether there is such a file
// is decided here, before either module is loaded, from Node built-ins
// alone; without one, the loader is never loaded. With one, the extensions
// half is owed an answer (harness-dispatch.mjs's `unfinished`): a run that
// ends before it returned, for whatever reason, blocks the call.
import { lstatSync, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

// What this script requires of harness-dispatch.mjs and
// harness-extensions.mjs, compared by value with the `LEVEL` each exports.
// Raise it in all three together whenever one of them comes to rely on a
// change in another.
const LEVEL = 1;

const EVENT = 'PreToolUse';
const exit = process.exit.bind(process);

const REMEDY = 're-run `node scripts/apply.mjs <repo> --yes` from kh-harness to update the shared modules; if apply reports a file kept or gone, restore it to what kh-harness wrote (git holds it, in the commit that installed it), then run `apply --yes` again.';

const EXTENSIONS_FILE = '.claude/kh-harness/extensions.json';
const MISSING = 'is missing or cannot be loaded';
const MISMATCH = 'is not the version this entry script runs with';
const FAILED = 'could not run this call';

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
 * false when nothing is, a component of it is not a directory, or the links
 * on the way loop. */
function reached(path) {
  try {
    return statSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch (error) {
    if (error?.code === 'ENOTDIR' || error?.code === 'ELOOP') return false;
    throw error;
  }
}

const deny = reason => ({ json: { hookSpecificOutput: { hookEventName: EVENT, permissionDecision: 'deny', permissionDecisionReason: reason } }, stderr: '', exitCode: 0 });

/** The half result that blocks every call because the installed `file` is
 * unusable while the repository holds an extensions file. An `apply --yes`
 * from an older kit would put back the files this script refuses. */
const unusable = (file, problem) => deny(`kh-harness: .claude/scripts/${file} ${problem} while ${EXTENSIONS_FILE} exists, so every tool call is blocked. Run kh-harness apply --yes from a kit at least as new as the one that installed .claude/scripts/dispatch-pre-tool.mjs, or remove the extensions file, outside this session.`);

/** The half result that blocks a call the extensions were not applied to,
 * for `cause`, one of harness-dispatch.mjs's fixed `CAUSES`. */
const notApplied = cause => deny(`kh-harness: the extensions ${EXTENSIONS_FILE} lists were not applied to this call (${cause}), so it is blocked. A time limit shortened through HK_RUN_DEADLINE_MS or HK_STDIN_TIMEOUT_MS in the environment hooks run with blocks every call this way.`);

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
  if (loader.LEVEL !== LEVEL) return unusable('harness-extensions.mjs', MISMATCH);
  return loader.extensionsHalf(payload);
}

/** Halves run before the gate, in order, while the repository holds an
 * extensions file. */
export const preHalves = [{ name: 'extensions', run: extensions, unfinished: notApplied }];

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

async function main(expected) {
  let core;
  try {
    core = await import('./harness-dispatch.mjs');
  } catch {
    return coreUnusable(expected, MISSING);
  }
  if (core.LEVEL !== LEVEL) return coreUnusable(expected, MISMATCH);
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
  const expected = extensionsExpected(process.env.CLAUDE_PROJECT_DIR || process.cwd());
  let code = 0;
  try {
    code = await main(expected);
  } catch {
    // Never throw — a hook that breaks a session is worse than none — but
    // never let an extensions file go unapplied in silence either. The core
    // writes nothing before it returns, so this is the only output.
    code = expected ? coreUnusable(true, FAILED) : 0;
  }
  // Not `exitCode`: a stdin the caller never closed would keep the process.
  exit(code);
}
