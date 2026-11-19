// scripts/lib/canary-fixtures.mjs
//
// NOT A TEST (named `*-fixtures.mjs`, so `npm test`'s glob skips it): the
// orphan canary the process-tree tests share. `canary.cjs` starts a
// grandchild that writes a heartbeat every 50 ms, then hangs. Every process
// in the tree records its own pid the moment it runs, and the canary also
// records the grandchild's pid as soon as it is spawned, so a grandchild
// whose spawn raced a kill is known whether or not it ever ran.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sleep = ms => new Promise(res => setTimeout(res, ms));

/** Writes `canary.cjs` into `dir`; returns the paths it writes to. */
export function writeCanary(dir, launchedLine) {
  const heartbeat = join(dir, 'heartbeat.txt');
  const pidsFile = join(dir, 'pids.txt');
  const grandchild = [
    `require('fs').appendFileSync(${JSON.stringify(pidsFile)}, process.pid + '\\n');`,
    `let n = 0; setInterval(() => { n++; require('fs').writeFileSync(${JSON.stringify(heartbeat)}, String(n)); }, 50);`,
  ].join(' ');
  writeFileSync(join(dir, 'canary.cjs'), [
    "const { appendFileSync } = require('fs');",
    `appendFileSync(${JSON.stringify(pidsFile)}, process.pid + '\\n');`,
    `const grandchild = require('child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' });`,
    `appendFileSync(${JSON.stringify(pidsFile)}, grandchild.pid + '\\n');`,
    `console.error(${JSON.stringify(launchedLine)});`,
    'setInterval(() => {}, 1000);',
  ].join('\n'));
  return { heartbeat, pidsFile };
}

/** Every pid the canary's tree recorded, positive integers only: on POSIX,
 * kill(0) and kill(-n) signal a whole process group, the runner's own for
 * 0, and the file ends in a newline whose split yields `''`, which is 0. */
export function recordedPids(pidsFile) {
  if (!existsSync(pidsFile)) return [];
  return [...new Set(readFileSync(pidsFile, 'utf8').split(/\s+/).map(Number).filter(n => Number.isInteger(n) && n > 0))];
}

const isAlive = pid => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
};

/** Resolves once no pid the tree recorded is alive, or rejects with the
 * survivors after `boundMs`. A grandchild spawned while the kill landed may
 * record itself late, so the pids are read afresh on every look. */
export async function assertNoSurvivor(pidsFile, heartbeat, { boundMs = 2000, settleMs = 500 } = {}) {
  const deadline = Date.now() + boundMs;
  let living = recordedPids(pidsFile).filter(isAlive);
  while (living.length > 0 && Date.now() < deadline) {
    await sleep(50);
    living = recordedPids(pidsFile).filter(isAlive);
  }
  assert.deepEqual(living, [], `processes of the timed-out command survived: ${living.join(', ')}`);
  // A process that escaped the kill and is still starting has not recorded
  // itself yet; one that runs writes the heartbeat.
  const before = existsSync(heartbeat) ? readFileSync(heartbeat, 'utf8') : null;
  await sleep(settleMs);
  const after = existsSync(heartbeat) ? readFileSync(heartbeat, 'utf8') : null;
  assert.equal(after, before, 'the heartbeat must not advance: no grandchild survived the kill');
  assert.deepEqual(recordedPids(pidsFile).filter(isAlive), [], 'no process of the tree recorded itself after the kill');
}

/** Force-kills every pid the tree recorded. A teardown: never throws. */
export function killRecorded(pidsFile) {
  let pids = [];
  try {
    pids = recordedPids(pidsFile);
  } catch {
    // best-effort: a teardown that throws must never mask the test's result
  }
  for (const pid of pids) {
    try {
      if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' });
      else process.kill(pid, 'SIGKILL');
    } catch {
      // already gone, or never started
    }
  }
}
