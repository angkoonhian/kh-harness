// scripts/lib/gate-stats.test.mjs
//
// Every test runs against the temporary KH_DATA_DIR learn-fixtures.mjs sets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renameSync } from 'node:fs';
import { join } from 'node:path';

import { repoDataDir, sessionFileName } from '../../assets/scripts/harness-log.mjs';
import { gateStats } from './gate-stats.mjs';
import { log, logFiring, trialRepo } from './learn-fixtures.mjs';
import { readLedger } from './ledger.mjs';

const outcome = (type, sessionId, toolUseId, over = {}) =>
  ({ type, tool: 'Bash', inputHash: 'h'.repeat(64), status: type === 'PostToolUse' ? 'ok' : 'error', tool_use_id: toolUseId, session_id: sessionId, ...over });
const started = (sessionId, toolUseId, over = {}) => ({ type: 'PreToolUse', tool: 'Bash', inputHash: 'h'.repeat(64), tool_use_id: toolUseId, session_id: sessionId, ...over });
const rerouted = root => gateStats(root, readLedger(root)).gates.get('L1').rerouted;

test('rerouted counts the next call of the tool that started after the firing, by the same agent', () => {
  const { root, learning } = trialRepo();
  const warn = { ...learning.gate, action: 'warn' };

  logFiring(root, 'plain', warn, 'p-1');
  log(root, 'plain', started('plain', 'p-2'), outcome('PostToolUse', 'plain', 'p-2'));
  assert.equal(rerouted(root), 1, 'the next call started after the firing and succeeded');

  // A call already running when the gate fired is not the next call.
  log(root, 'parallel', started('parallel', 'q-2'));
  logFiring(root, 'parallel', warn, 'q-1');
  log(root, 'parallel', outcome('PostToolUse', 'parallel', 'q-2'));
  assert.equal(rerouted(root), 1);
  log(root, 'parallel', started('parallel', 'q-3'), outcome('PostToolUse', 'parallel', 'q-3'));
  assert.equal(rerouted(root), 2, 'the call after it is');

  // A sub-agent's call is not the warned agent's next call.
  logFiring(root, 'agents', warn, 'r-1');
  log(root, 'agents', started('agents', 'r-2', { agent_id: 'sub-1' }), outcome('PostToolUse', 'agents', 'r-2', { agent_id: 'sub-1' }));
  assert.equal(rerouted(root), 2);
  logFiring(root, 'agents', warn, 'r-3', { agent_id: 'sub-1' });
  log(root, 'agents', started('agents', 'r-4', { agent_id: 'sub-1' }), outcome('PostToolUse', 'agents', 'r-4', { agent_id: 'sub-1' }));
  assert.equal(rerouted(root), 3, 'a sub-agent\'s own next call counts for its own firing');

  // A next call that was denied is the next call, and it did not succeed.
  logFiring(root, 'denied', warn, 's-1');
  log(root, 'denied', started('denied', 's-2'), { type: 'PermissionDenied', tool: 'Bash', inputHash: 'h'.repeat(64), tool_use_id: 's-2', session_id: 'denied' },
    started('denied', 's-3'), outcome('PostToolUse', 'denied', 's-3'));
  assert.equal(rerouted(root), 3);
});

test('two gates that fired on one call are each rerouted by the call after it', () => {
  const { root, learning } = trialRepo();
  logFiring(root, 'both', { ...learning.gate, action: 'block' }, 't-1');
  logFiring(root, 'both', { ...learning.gate, id: 'L2', action: 'warn' }, 't-1');
  log(root, 'both', started('both', 't-2'), outcome('PostToolUse', 'both', 't-2'));
  const { gates } = gateStats(root, readLedger(root));
  assert.deepEqual([gates.get('L1').rerouted, gates.get('L2').rerouted], [1, 1]);
});

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

test('a session whose events are in a claimed file is counted as read and as being sealed, and its firings are not counted', () => {
  const { root, learning } = trialRepo();
  logFiring(root, 'fire-a', learning.gate, 'a-1');
  logFiring(root, 'fire-b', learning.gate, 'b-1');
  const listedBefore = gateStats(root, readLedger(root)).sessionsRead;
  const plain = join(repoDataDir(root), 'sessions', sessionFileName('fire-b'));
  renameSync(plain, `${plain}.sealing`);
  const stats = gateStats(root, readLedger(root));
  assert.equal(stats.sessionsRead, listedBefore, 'it is still among the sessions listed');
  assert.equal(stats.sessionsBeingSealed, 1);
  assert.equal(stats.gates.get('L1').firings, 1);
});
