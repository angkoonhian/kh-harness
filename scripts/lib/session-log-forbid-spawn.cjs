// scripts/lib/session-log-forbid-spawn.cjs
//
// A `--require` preload for session-log.test.mjs, not a suite. Every
// process-creating function of `child_process` records its name in the file
// `KH_SPAWN_TRAP` names and then throws. The record is the evidence: a hook
// that catches the throw and exits 0 would otherwise hide the call.
'use strict';
const { appendFileSync } = require('node:fs');
const childProcess = require('node:child_process');

for (const name of ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork']) {
  childProcess[name] = () => {
    appendFileSync(process.env.KH_SPAWN_TRAP, `${name}\n`);
    throw new Error(`child_process.${name} is forbidden here`);
  };
}
