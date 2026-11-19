// scripts/lib/failures-evidence.test.mjs
//
// Every test runs against a temporary KH_DATA_DIR, so nothing here reads or
// writes the real `~/.claude/kh-harness`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { appendEvent, setEnabled } from '../../assets/scripts/harness-log.mjs';
import { failureSignature, FAILURE_EVENT } from './recurrence.mjs';
import { FAILURES_PATH, failuresEvidence, parseFailures } from './failures-evidence.mjs';
import { buildGaps } from './gap-model.mjs';
import { detectHarness } from './detect-harness.mjs';
import { detectStack } from './detect-stack.mjs';
import { selectProfile } from './profiles/index.mjs';
import { listFiles } from './scan.mjs';

const DETECT = resolve(import.meta.dirname, '..', 'detect.mjs');

const made = [];
const tempDir = prefix => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

process.env.KH_DATA_DIR = tempDir('hk-fail-data-');

function write(d, rel, text) {
  mkdirSync(join(d, rel, '..'), { recursive: true });
  writeFileSync(join(d, rel), text);
}

const HARNESS = { type: 'harness', base: 'base-canary', learned: 'learned-canary', model: 'model-canary' };
const failure = (sessionId, firstErrorLine) => ({
  type: FAILURE_EVENT, tool_name: 'Bash', inputHash: 'input-canary', firstErrorLine,
  session_id: sessionId, tool_use_id: `${sessionId}-use`,
});
const LABELLED_LINE = 'Error: zebra-canary-labelled went wrong';
const UNLABELLED_LINE = 'Error: zebra-canary-unlabelled went wrong';
const SESSIONS = ['sess-canary-one', 'sess-canary-two', 'sess-canary-three'];

/** Three sessions in which two distinct failures each recur. */
function logRecurrences(root) {
  for (const id of SESSIONS) {
    for (const event of [HARNESS, failure(id, LABELLED_LINE), failure(id, UNLABELLED_LINE)]) {
      assert.deepEqual(appendEvent(root, id, event), { written: true });
    }
  }
  return failureSignature(failure(SESSIONS[0], LABELLED_LINE), root);
}

const failuresCheck = root => {
  const { files } = listFiles(root);
  const stack = detectStack(root, files);
  const harness = detectHarness(root, files);
  const checks = buildGaps({ stack, harness, exposures: [], profile: selectProfile(stack), git: { branch: 'main', isRepo: true }, files, root });
  return checks.find(c => c.id === 'P5.failures');
};

test('a heading with two signatures parses', () => {
  const text = [
    '# Failures',
    '## F1 — The test runner is given a dropped flag',
    '- signatures: 0123456789abcdef, fedcba9876543210',
    '',
  ].join('\n');
  assert.deepEqual(parseFailures(text), [
    { id: 'F1', title: 'The test runner is given a dropped flag', signatures: ['0123456789abcdef', 'fedcba9876543210'] },
  ]);
});

test('entries come in file order; a heading without a signatures line has none; comments are ignored', () => {
  const text = [
    '<!--',
    '## F9 — inside a comment',
    '- signatures: 0123456789abcdef',
    '-->',
    '## F2 — second written first',
    '- why: not a key this file reads',
    '## F1 — covers nothing yet',
    '## Notes',
    '- signatures: 0123456789abcdef',
    '',
  ].join('\r\n');
  assert.deepEqual(parseFailures(text), [
    { id: 'F2', title: 'second written first', signatures: [] },
    { id: 'F1', title: 'covers nothing yet', signatures: [] },
  ]);
});

test('anything in a signatures list that is not 16 lowercase hex is dropped and counted', () => {
  const d = tempDir('hk-fail-repo-');
  write(d, FAILURES_PATH, [
    '## F1 — mixed',
    '- signatures: 0123456789abcdef, 0123456789ABCDEF, 0123456789abcde, not-a-signature, ',
    '',
  ].join('\n'));
  assert.deepEqual(parseFailures(readFileSync(join(d, FAILURES_PATH), 'utf8'))[0].signatures, ['0123456789abcdef']);
  const ev = failuresEvidence(d);
  assert.equal(ev.kinds, 1);
  assert.equal(ev.malformedSignatures, 3);
  assert.match(failuresCheck(d).evidence.join('\n'), /3 malformed signature ids ignored/);
});

test('parseFailures never throws', () => {
  for (const input of [null, undefined, 42, '', '## F', '## F1', '- signatures: 0123456789abcdef']) {
    assert.ok(Array.isArray(parseFailures(input)));
  }
  assert.deepEqual(parseFailures('## F1'), [{ id: 'F1', title: '', signatures: [] }]);
});

test('with no taxonomy, P5.failures is absent and decidable, and apply scaffolds it', () => {
  const c = failuresCheck(tempDir('hk-fail-repo-'));
  assert.equal(c.state, 'absent');
  assert.equal(c.decidable, true);
  assert.equal(c.via, 'apply');
  assert.match(c.proposal, /docs\/harness\/FAILURES\.md/);
});

test('with the log not enabled, no sessions are read and that is not a failure', () => {
  const d = tempDir('hk-fail-repo-');
  write(d, FAILURES_PATH, '# Failures\n');
  logRecurrences(d);
  const c = failuresCheck(d);
  assert.equal(c.state, 'declared');
  assert.deepEqual(c.evidence, [
    `${FAILURES_PATH}: 0 failure kinds named`,
    'no sessions read — the session log is not enabled on this machine',
  ]);
});

test('with the log enabled and empty, no sessions are read', () => {
  const d = tempDir('hk-fail-repo-');
  write(d, FAILURES_PATH, '# Failures\n');
  setEnabled(d, true);
  const c = failuresCheck(d);
  assert.equal(c.state, 'declared');
  assert.match(c.evidence.join('\n'), /no sessions read — the session log holds no sessions/);
});

test('with every recurrence labelled, P5.failures is declared, never verified', () => {
  const d = tempDir('hk-fail-repo-');
  setEnabled(d, true);
  const sig = logRecurrences(d);
  write(d, FAILURES_PATH, `## F1 — covers both\n- signatures: ${sig}, ${failureSignature(failure(SESSIONS[0], UNLABELLED_LINE), d)}\n`);
  const c = failuresCheck(d);
  assert.equal(c.state, 'declared');
  assert.match(c.evidence.join('\n'), /2 recurrences, 0 not labelled/);
});

test('detect reports how many recurrences are unlabelled, by count only', () => {
  const d = tempDir('hk-fail-repo-');
  setEnabled(d, true);
  const labelled = logRecurrences(d);
  write(d, FAILURES_PATH, `# Failures\n\n## F1 — The canary kind\n- signatures: ${labelled}\n`);
  const stdout = execFileSync(process.execPath, [DETECT, d, '--json'], { encoding: 'utf8' });
  const report = JSON.parse(stdout);
  const c = report.checks.find(x => x.id === 'P5.failures');
  assert.equal(c.state, 'declared');
  assert.deepEqual(c.evidence, [
    `${FAILURES_PATH}: 1 failure kind named`,
    '3 sessions read: 2 recurrences, 1 not labelled in docs/harness/FAILURES.md',
  ]);
  const saved = readFileSync(join(d, 'docs/harness/detect.json'), 'utf8');
  for (const out of [stdout, saved]) {
    for (const content of ['zebra-canary', ...SESSIONS, 'base-canary', 'model-canary', 'input-canary', 'The canary kind', labelled]) {
      assert.ok(!out.includes(content), `the report carries ${content} from the log or the taxonomy`);
    }
  }
});
