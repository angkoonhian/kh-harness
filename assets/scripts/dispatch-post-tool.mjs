#!/usr/bin/env node
// assets/scripts/dispatch-post-tool.mjs
//
// PostToolUse entry script: runs, in one process and in this order, the
// logging hook (session-log.mjs) and the lint sensor (lint-touched.mjs),
// through the shared core harness-dispatch.mjs, and writes their combined
// output. Always exits with the highest code a half returned, so a lint
// report exits 2. Its registration in .claude/settings.json is the switch:
// the hooks it runs are not registered on this event separately.
//
// A core that is missing or too old to provide what this script uses means
// no hook runs, and every call says so in one fixed notice.
const EVENT = 'PostToolUse';
const CORE = ['combine', 'dispatch', 'emit', 'half', 'readPayload', 'runHalves'];

const REMEDY = 're-run `node scripts/apply.mjs <repo> --yes` from kh-harness to update the shared modules; if apply reports a file kept or gone, restore it to what kh-harness wrote (git holds it, in the commit that installed it), then run `apply --yes` again.';

function coreNotice(problem) {
  process.stdout.write(JSON.stringify({ systemMessage: `kh-harness dispatch-post-tool: .claude/scripts/harness-dispatch.mjs ${problem}, so no kh-harness hook ran on ${EVENT} — ${REMEDY}` }) + '\n');
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
    core.half('log', 'session-log.mjs', 'logHalf', () => import('./session-log.mjs')),
    core.half('lint', 'lint-touched.mjs', 'lintHalf', () => import('./lint-touched.mjs')),
  ]);
}

let code = 0;
try {
  code = await main();
} catch {
  code = 0; // never throw — a hook that breaks a session is worse than none
}
// Not `exitCode`: a stdin the caller never closed would keep the process.
process.exit(code);
