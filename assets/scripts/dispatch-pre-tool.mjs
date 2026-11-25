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
// no hook runs, and every call says so in one fixed notice.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const EVENT = 'PreToolUse';
const CORE = ['combine', 'dispatch', 'emit', 'half', 'readPayload', 'runHalves'];

const REMEDY = 're-run `node scripts/apply.mjs <repo> --yes` from kh-harness to update the shared modules; if apply reports a file kept or gone, restore it to what kh-harness wrote (git holds it, in the commit that installed it), then run `apply --yes` again.';

/** Halves run before the gate, in order. */
export const preHalves = [];

function coreNotice(problem) {
  process.stdout.write(JSON.stringify({ systemMessage: `kh-harness dispatch-pre-tool: .claude/scripts/harness-dispatch.mjs ${problem}, so no kh-harness hook ran on ${EVENT} — ${REMEDY}` }) + '\n');
  return 0;
}

async function main() {
  let core;
  try {
    core = await import('./harness-dispatch.mjs');
  } catch {
    return coreNotice('is missing or cannot be loaded');
  }
  if (CORE.some(name => !(name in core))) return coreNotice('is older than this entry script and lacks what it needs');
  return core.dispatch(EVENT, [
    ...preHalves,
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
