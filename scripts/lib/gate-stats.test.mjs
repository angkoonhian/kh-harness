// scripts/lib/gate-stats.test.mjs
//
// Every test runs against the temporary KH_DATA_DIR learn-fixtures.mjs sets.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { gateStats } from './gate-stats.mjs';
import { logFiring, trialRepo } from './learn-fixtures.mjs';
import { readLedger } from './ledger.mjs';

test('where each firing is, is collected only when asked for, and the counts are the same either way', () => {
  const { root, learning } = trialRepo();
  logFiring(root, 'fire-a', learning.gate, 'a-1');
  logFiring(root, 'fire-b', { ...learning.gate, action: 'block' }, 'b-1');
  const entries = readLedger(root);

  const counted = gateStats(root, entries).gates.get('L1');
  assert.equal(Object.hasOwn(counted, 'places'), false, 'log report never asks, and nothing is built for it');
  const placed = gateStats(root, entries, null, { places: true }).gates.get('L1');
  const { places, ...counts } = placed;
  assert.deepEqual(counts, counted);
  assert.deepEqual(places.map(({ ts, ...p }) => p), [
    { sessionId: 'fire-a', line: 1, action: 'observe' },
    { sessionId: 'fire-b', line: 1, action: 'block' },
  ]);
  assert.ok(places.every(p => typeof p.ts === 'string'));
});
