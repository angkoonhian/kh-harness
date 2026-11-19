// scripts/lib/latency-fixtures.mjs
//
// NOT A TEST (named `*-fixtures.mjs`, so `npm test`'s glob skips it): how the
// hook latency tests measure what a hook adds to a bare `node` start.
import { spawnSync } from 'node:child_process';

const timed = run => {
  const start = process.hrtime.bigint();
  run();
  return Number(process.hrtime.bigint() - start) / 1e6;
};

const sorted = times => [...times].sort((a, b) => a - b);
const median = times => {
  const s = sorted(times);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * What a hook run adds, in ms, to a bare `node -e 0` given the same `stdin`
 * and `env`: the fastest of `pairs` runs of `runHookOnce` less the fastest
 * of as many bare runs, the two kinds alternating which goes first.
 * `runHookOnce` runs the hook once and asserts its outcome. Returns
 * `{ added, summary }`, `summary` naming the floors and medians.
 *
 * Other processes slow every node start on the machine, and the hook's
 * added work, more of the same loading and running, slows with it: a
 * difference of medians that read 45 ms on a quiet machine read 100 to
 * 130 ms beside a full suite, for the same hook. The load comes and goes, so
 * the fastest run of each kind is the least slowed one; a delay in the hook
 * is in every hook run, the fastest included. `npm test` runs the tests
 * named `latency budget: …` after the rest of the suite, one file at a time
 * (latency-phase.test.mjs holds that in place), so the suite's own processes
 * are never that load.
 */
export function addedLatency({ runHookOnce, stdin, env, pairs }) {
  const hook = [];
  const bare = [];
  const runBare = () => {
    const r = spawnSync(process.execPath, ['-e', '0'], { input: stdin, encoding: 'utf8', env });
    if (r.status !== 0) throw new Error(`a bare node start exited ${r.status}: ${r.stderr}`);
  };
  for (let i = 0; i < pairs; i++) {
    const order = i % 2 === 0 ? [[hook, runHookOnce], [bare, runBare]] : [[bare, runBare], [hook, runHookOnce]];
    for (const [times, run] of order) times.push(timed(run));
  }
  const hookFloor = sorted(hook)[0];
  const bareFloor = sorted(bare)[0];
  return {
    added: hookFloor - bareFloor,
    summary: `fastest hook run ${hookFloor.toFixed(1)} ms, fastest bare node start ${bareFloor.toFixed(1)} ms (medians ${median(hook).toFixed(1)} and ${median(bare).toFixed(1)} ms) over ${pairs} interleaved pairs`,
  };
}
