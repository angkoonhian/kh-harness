// scripts/lib/failures-evidence.test.mjs
//
// Every test runs against a temporary KH_DATA_DIR, so nothing here reads or
// writes the real `~/.claude/kh-harness`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { appendEvent, setEnabled } from '../../assets/scripts/harness-log.mjs';
import { toLogEvent } from '../../assets/scripts/session-log.mjs';
import { failureSignature, FAILURE_EVENT } from './recurrence.mjs';
import { FAILURES_PATH, failuresEvidence, parseFailures } from './failures-evidence.mjs';
import { buildGaps } from './gap-model.mjs';
import { detectHarness } from './detect-harness.mjs';
import { detectStack } from './detect-stack.mjs';
import { selectProfile } from './profiles/index.mjs';
import { listFiles } from './scan.mjs';

const DETECT = resolve(import.meta.dirname, '..', 'detect.mjs');
const HARNESS_LOG = resolve(import.meta.dirname, '..', '..', 'assets', 'scripts', 'harness-log.mjs');

const made = [];
const tempDir = prefix => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const DATA_DIR = tempDir('hk-fail-data-');
process.env.KH_DATA_DIR = DATA_DIR;

function write(d, rel, text) {
  mkdirSync(join(d, rel, '..'), { recursive: true });
  writeFileSync(join(d, rel), text);
}

const HARNESS = { type: 'harness', base: 'base-canary', learned: 'learned-canary', model: 'model-canary' };
/** A failure as the logging hook records it. */
const failure = (sessionId, error) => toLogEvent({
  hook_event_name: FAILURE_EVENT, session_id: sessionId, tool_use_id: `${sessionId}-use`,
  tool_name: 'Bash', tool_input: { command: 'input-canary' }, error,
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

/**
 * A preload that records, in `record`, every path under KH_DATA_DIR that a
 * synchronous fs call is given. It records rather than throws, because the
 * log library catches what it reads and a throw would go unseen.
 */
function accessProbe() {
  const dir = tempDir('hk-fail-probe-');
  const record = join(dir, 'accesses.txt');
  const preload = join(dir, 'probe.mjs');
  writeFileSync(preload, [
    "import fs from 'node:fs';",
    "import { syncBuiltinESMExports } from 'node:module';",
    `const record = ${JSON.stringify(record)};`,
    'const norm = p => String(p).replace(/\\\\/g, "/").toLowerCase();',
    'const data = norm(process.env.KH_DATA_DIR);',
    'const append = fs.appendFileSync;',
    "for (const name of ['readdirSync', 'readFileSync', 'statSync', 'lstatSync', 'existsSync', 'openSync', 'opendirSync', 'accessSync']) {",
    '  const real = fs[name];',
    '  fs[name] = (p, ...rest) => {',
    "    if (norm(p).startsWith(data)) append(record, `${name} ${p}\\n`);",
    '    return real(p, ...rest);',
    '  };',
    '}',
    'syncBuiltinESMExports();',
    '',
  ].join('\n'));
  return { record, importArg: pathToFileURL(preload).href };
}

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
  assert.equal(ev.signatures, 1);
  assert.equal(ev.malformedSignatures, 3);
  assert.match(failuresCheck(d).evidence.join('\n'), /3 malformed signature ids ignored/);
});

test('a level-2 heading that is not "F<n> — title" is ignored and counted', () => {
  const d = tempDir('hk-fail-repo-');
  write(d, FAILURES_PATH, [
    '## F1 — kept',
    '- signatures: 0123456789abcdef',
    '## FI — mistyped id',
    '- signatures: fedcba9876543210',
    '## Notes',
    '',
  ].join('\n'));
  const ev = failuresEvidence(d);
  assert.equal(ev.kinds, 1);
  assert.equal(ev.signatures, 1, 'a signature under an ignored heading belongs to no failure kind');
  assert.equal(ev.ignoredHeadings, 2);
  assert.deepEqual(failuresCheck(d).evidence, [
    `${FAILURES_PATH}: 1 failure kind named, listing 1 signature id`,
    '2 level-2 headings ignored (a failure kind\'s heading is "## F<n> — <title>")',
    '`log report` shows which recurrences no failure kind labels',
  ]);
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

test('a FAILURES.md that cannot be read is declared, with the could-not-be-read line', () => {
  const d = tempDir('hk-fail-repo-');
  mkdirSync(join(d, FAILURES_PATH), { recursive: true });
  const c = failuresCheck(d);
  assert.equal(c.state, 'declared');
  assert.deepEqual(c.evidence, [`${FAILURES_PATH} exists but could not be read — the failure kinds it names are unknown`]);
});

test('with failure kinds named, P5.failures is declared, never verified', () => {
  const d = tempDir('hk-fail-repo-');
  write(d, FAILURES_PATH, '## F1 — one\n- signatures: 0123456789abcdef, fedcba9876543210\n## F2 — two\n');
  const c = failuresCheck(d);
  assert.equal(c.state, 'declared');
  assert.deepEqual(c.evidence, [
    `${FAILURES_PATH}: 2 failure kinds named, listing 2 signature ids`,
    '`log report` shows which recurrences no failure kind labels',
  ]);
});

test('the access probe sees a read of the session log', () => {
  const d = tempDir('hk-fail-repo-');
  setEnabled(d, true);
  const probe = accessProbe();
  execFileSync(process.execPath, ['--import', probe.importArg, '--input-type=module', '-e',
    `const { isEnabled } = await import(${JSON.stringify(pathToFileURL(HARNESS_LOG).href)}); isEnabled(${JSON.stringify(d)});`], { encoding: 'utf8' });
  assert.ok(existsSync(probe.record) && readFileSync(probe.record, 'utf8').length > 0, 'without this, the test below proves nothing');
});

test('detect does not read the session log, and no log or taxonomy content reaches its output', () => {
  const d = tempDir('hk-fail-repo-');
  setEnabled(d, true);
  const labelled = logRecurrences(d);
  write(d, FAILURES_PATH, `# Failures\n\n## F1 — The canary kind\n- signatures: ${labelled}\n`);
  const probe = accessProbe();
  const stdout = execFileSync(process.execPath, ['--import', probe.importArg, DETECT, d, '--json'], { encoding: 'utf8' });
  assert.equal(existsSync(probe.record) ? readFileSync(probe.record, 'utf8') : '', '', 'detect touched the session log directory');
  const c = JSON.parse(stdout).checks.find(x => x.id === 'P5.failures');
  assert.equal(c.state, 'declared');
  assert.deepEqual(c.evidence, [
    `${FAILURES_PATH}: 1 failure kind named, listing 1 signature id`,
    '`log report` shows which recurrences no failure kind labels',
  ]);
  const saved = readFileSync(join(d, 'docs/harness/detect.json'), 'utf8');
  for (const out of [stdout, saved]) {
    for (const content of ['zebra-canary', ...SESSIONS, 'base-canary', 'model-canary', 'input-canary', 'The canary kind', labelled]) {
      assert.ok(!out.includes(content), `the report carries ${content} from the log or the taxonomy`);
    }
  }
});
