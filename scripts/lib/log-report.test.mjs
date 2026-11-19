// scripts/lib/log-report.test.mjs
//
// `log report`: the recurrences and gate firings the log holds, and exactly
// what was read to find them. Every test runs against the temporary
// KH_DATA_DIR `log-fixtures.mjs` sets, so nothing here reads or writes the
// real `~/.claude`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { appendEvent, LOCAL_GATES_FILE, repoDataDir } from '../../assets/scripts/harness-log.mjs';
import { ledgerEntry } from './learn-lib.mjs';
import { appendLedger } from './ledger.mjs';
import { project, runLog, sealAll, sealedFile, sessionFile, snapshot, writeSession } from './log-fixtures.mjs';
import { buildLogReport, NOT_CLAIMED, REROUTED_MEANS } from './log-report.mjs';
import { failureSignature } from './recurrence.mjs';

const BASE = 'b'.repeat(64);
const OTHER_BASE = 'c'.repeat(64);
const MODEL = 'claude-opus-test';
const harness = (base = BASE, model = MODEL) => ({ type: 'harness', base, learned: 'l'.repeat(64), model });

// Built at runtime so no fixture is a literal a reader could mistake for
// real content; free of digits and hex runs, which normalisation rewrites.
const INPUT_MARKER = ['kh', 'input', 'marker'].join('-');
const OUTPUT_MARKER = ['kh', 'output', 'marker'].join('-');
const PROMPT_MARKER = ['kh', 'prompt', 'marker'].join('-');
const PATH_MARKER = ['kh', 'path', 'marker'].join('-');

const failure = (over = {}) => ({
  type: 'PostToolUseFailure',
  tool: 'Bash',
  inputHash: 'i'.repeat(64),
  status: 'error',
  firstErrorLine: 'Error: tests failed',
  input: { command: `run ${INPUT_MARKER}` },
  output: `Error: tests failed ${OUTPUT_MARKER}`,
  ...over,
});

function log(root, sessionId, ...events) {
  for (const event of events) assert.deepEqual(appendEvent(root, sessionId, { session_id: sessionId, ...event }), { written: true });
}

const reportText = root => {
  const r = runLog(root, 'report');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  return r.stdout;
};

const reportJson = root => {
  const r = runLog(root, 'report', '--json');
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

/** A learning as the ledger entries for it need it: no file is written, as
 * for a gate learned on another machine or a learning since deleted. */
const learningNamed = id => ({
  id,
  sha256: 'a'.repeat(64),
  evidence: { signature: 'f'.repeat(16), sessions: 2, firstTs: '2026-11-01T10:00:00.000Z', lastTs: '2026-11-02T10:00:00.000Z', external: false },
});
const IDENTITY = { base: BASE, learned: 'l'.repeat(64) };

/** Marks the firing at `line` of `sessionId` wrong for the learning `id`. */
const markWrong = (root, id, sessionId, line) =>
  appendLedger(root, ledgerEntry(learningNamed(id), IDENTITY, { kind: 'wrong', approvedBy: 'owner', firing: { sessionId, line } }));
const promote = (root, id) => appendLedger(root, ledgerEntry(learningNamed(id), IDENTITY, { kind: 'promoted', approvedBy: 'owner', action: 'warn' }));

test('the report states how many sessions it read and under which harness and model', () => {
  const root = project();
  log(root, 'a', harness(), failure());
  log(root, 'b', harness(), failure());
  log(root, 'c', harness(OTHER_BASE), failure(), failure({ tool: 'Edit' }));
  log(root, 'd', harness(OTHER_BASE), failure({ tool: 'Edit' }));
  log(root, 'e', harness(OTHER_BASE), failure({ tool: 'Edit' }));
  log(root, 'f', { type: 'SessionStart', source: 'startup' });
  const json = reportJson(root);
  assert.equal(json.sessionsRead, 6);
  // The group of the recurrence in the most sessions comes first.
  assert.deepEqual(json.groups.map(g => [g.base, g.model, g.recurrences.map(r => [r.tool, r.sessions.length])]), [
    [OTHER_BASE, MODEL, [['Edit', 3]]],
    [BASE, MODEL, [['Bash', 2]]],
  ]);
  const text = reportText(root);
  assert.match(text, /sessions read: 6/);
  assert.ok(text.includes(`harness ${BASE}, model ${MODEL}`), text);
  assert.ok(text.includes(`harness ${OTHER_BASE}, model ${MODEL}`), text);
});

test('it lists each recurrence with its session count', () => {
  const root = project();
  for (const id of ['a', 'b', 'c']) log(root, id, harness(), failure());
  log(root, 'c', failure());
  log(root, 'a', failure({ tool: 'Read', firstErrorLine: 'Error: no such file' }));
  log(root, 'b', failure({ tool: 'Read', firstErrorLine: 'Error: no such file' }));
  log(root, 'c', failure({ tool: 'Grep', firstErrorLine: 'Error: once only' }));
  const [group] = reportJson(root).groups;
  const bash = failureSignature({ ...failure() }, root);
  assert.deepEqual(group.recurrences.map(r => [r.tool, r.sessions.length, r.count]), [['Bash', 3, 4], ['Read', 2, 2]]);
  assert.equal(group.recurrences[0].signature, bash);
  const text = reportText(root);
  assert.match(text, new RegExp(`${bash}  Bash: in 3 sessions, 4 times`));
  assert.match(text, /Read: in 2 sessions, 2 times/);
  assert.doesNotMatch(text, /Grep/, 'a failure in one session does not recur');
  assert.match(text, /examples: a event 2, b event 2, c event 2/);
});

test('it never prints tool input or output', () => {
  const root = project();
  const tool = { type: 'PostToolUse', tool: 'Read', inputHash: 'r'.repeat(64), status: 'ok', input: { file_path: `/tmp/${PATH_MARKER}` }, output: OUTPUT_MARKER };
  for (const id of ['a', 'b']) {
    log(root, id,
      { type: 'SessionStart', source: 'startup', transcriptPath: `/tmp/${PATH_MARKER}.jsonl` },
      { type: 'UserPromptSubmit', prompt: `please ${PROMPT_MARKER}` },
      harness(),
      tool,
      failure(),
      { type: 'gate_firing', gateId: 'L1', gateSha256: 'a'.repeat(64), action: 'block', tool: 'Bash' },
      { type: 'InstructionsLoaded', path: `/tmp/${PATH_MARKER}/CLAUDE.md` });
  }
  sealAll(root);
  log(root, 'c', harness(), tool, failure());
  for (const args of [['report'], ['report', '--json']]) {
    const r = runLog(root, ...args);
    assert.equal(r.status, 0, r.stderr);
    for (const marker of [INPUT_MARKER, OUTPUT_MARKER, PROMPT_MARKER, PATH_MARKER]) {
      assert.equal(`${r.stdout}${r.stderr}`.includes(marker), false, `${args.join(' ')}: ${marker}`);
    }
    assert.ok(r.stdout.includes('Error: tests failed'), 'the error line is shown');
  }
});

test('an error line is shown only cleaned: one line, nothing invisible, delimiters escaped, at most 200 characters', () => {
  const root = project();
  const errorMarker = ['kh', 'error', 'marker'].join('-');
  const raw = `Error:\u001b[31m <${errorMarker}>\u200b\nsecond\tline \u2028${'x'.repeat(300)}`;
  log(root, 'a', harness(), failure({ firstErrorLine: raw }));
  log(root, 'b', harness(), failure({ firstErrorLine: raw }));
  const prefix = `Error: <${errorMarker}> second line `;
  const cleaned = `Error: &lt;${errorMarker}&gt; second line ${'x'.repeat(200 - prefix.length)}`;
  const [r] = reportJson(root).groups[0].recurrences;
  assert.equal(r.errorLine, cleaned);
  const text = reportText(root);
  assert.ok(text.includes(`error: ${cleaned}\n`), text);
  assert.equal(text.includes(`<${errorMarker}>`), false);
  assert.equal(text.includes('x'.repeat(201 - prefix.length)), false);
  assert.doesNotMatch(text, /[\u001b\u200b\u2028\t]/);
  for (const out of [text, runLog(root, 'report', '--json').stdout]) {
    assert.equal(out.split(errorMarker).length - 1, 1, 'the marker appears once, in the cleaned line');
  }
});

test('each recurrence names the failure kind that lists its signature, or says it is unlabelled', () => {
  const root = project();
  for (const id of ['a', 'b']) log(root, id, harness(), failure(), failure({ tool: 'Edit' }));
  const bash = failureSignature(failure(), root);
  const absent = reportJson(root);
  assert.deepEqual(absent.taxonomy, { path: 'docs/harness/FAILURES.md', state: 'absent' });
  assert.deepEqual(absent.groups[0].recurrences.map(r => r.failureKinds), [[], []]);
  assert.match(reportText(root), /failure kind: unlabelled; there is no docs\/harness\/FAILURES\.md/);

  mkdirSync(join(root, 'docs/harness'), { recursive: true });
  writeFileSync(join(root, 'docs/harness/FAILURES.md'), `# Failures\n\n## F2 — tests\n- signatures: ${bash}\n`);
  const labelled = reportJson(root);
  assert.equal(labelled.taxonomy.state, 'read');
  const kinds = Object.fromEntries(labelled.groups[0].recurrences.map(r => [r.tool, r.failureKinds]));
  assert.deepEqual(kinds, { Bash: ['F2'], Edit: [] });
  const text = reportText(root);
  assert.match(text, /failure kind: F2/);
  assert.match(text, /failure kind: unlabelled\n/);
});

test('a taxonomy that cannot be read leaves every label not read', () => {
  const root = project();
  for (const id of ['a', 'b']) log(root, id, harness(), failure());
  mkdirSync(join(root, 'docs/harness/FAILURES.md'), { recursive: true });
  const json = reportJson(root);
  assert.equal(json.taxonomy.state, 'unreadable');
  assert.equal(json.groups[0].recurrences[0].failureKinds, null);
  assert.match(reportText(root), /failure kind: not read, because docs\/harness\/FAILURES\.md could not be read/);
});

test('gate firings are counted per gate and action, and a warn or block followed by a successful call of the same tool is rerouted', () => {
  const root = project();
  const firing = (gateId, action, tool, useId) => ({ type: 'gate_firing', gateId, gateSha256: 'a'.repeat(64), action, tool, tool_use_id: useId });
  const after = (type, tool, useId) => ({ type, tool, inputHash: 'h'.repeat(64), status: type === 'PostToolUse' ? 'ok' : 'error', tool_use_id: useId });
  log(root, 'g1', firing('L1', 'block', 'Bash', 'u1'), after('PostToolUse', 'Read', 'u2'), after('PostToolUse', 'Bash', 'u3'));
  log(root, 'g2', firing('L1', 'block', 'Bash', 'u4'), after('PostToolUseFailure', 'Bash', 'u5'), after('PostToolUse', 'Bash', 'u6'));
  log(root, 'g3', firing('L1', 'block', 'Bash', 'u7'), firing('L1', 'block', 'Bash', 'u8'), after('PostToolUse', 'Bash', 'u9'));
  log(root, 'g4', firing('L1', 'block', 'Bash', 'u10'), after('PostToolUseFailure', 'Bash', 'u10'), after('PostToolUse', 'Bash', 'u11'));
  log(root, 'g5', firing('L1', 'block', 'Bash', 'u12'));
  log(root, 'g6', firing('L2', 'warn', 'Read', 'u13'), firing('L2', 'observe', 'Read', 'u14'), after('PostToolUse', 'Read', 'u14'));
  log(root, 'g7', firing('<L9>', 'block', 'Bash', 'u15'), firing('L3', 'shout', 'Bash', 'u16'));
  const { gates } = reportJson(root);
  assert.equal(gates.sessionsRead, 7);
  assert.equal(gates.firingsMalformed, 2);
  assert.equal(gates.reroutedMeans, REROUTED_MEANS);
  // L1: g1, g3's second block and g4 are rerouted; g3's first block was
  // followed by the next call, blocked. L2: the warning's next Read call
  // succeeded; the observation told nobody anything.
  const zero = { markedWrong: 0, markedWrongTotal: 0 };
  assert.deepEqual(gates.firings, [
    { gateId: 'L1', fired: { observe: 0, warn: 0, block: 6 }, rerouted: 3, ...zero, gateSha256s: ['a'.repeat(64)] },
    { gateId: 'L2', fired: { observe: 1, warn: 1, block: 0 }, rerouted: 1, ...zero, gateSha256s: ['a'.repeat(64)] },
  ]);
  const text = reportText(root);
  assert.ok(text.includes(REROUTED_MEANS), 'the report states what rerouted means');
  assert.match(REROUTED_MEANS, /warn or block/);
  assert.match(text, /L1: fired 6 times \(observe 0, warn 0, block 6\); rerouted after 3 of 6 warnings and blocks; marked wrong: 0 since the last promotion or landing, 0 in all/);
  assert.match(text, /L2: fired 2 times \(observe 1, warn 1, block 0\); rerouted after 1 of 1 warnings and blocks;/);
  assert.match(text, /firing events not counted, because their gate id or action is not one a gate can have: 2/);
  assert.doesNotMatch(text, /L9|shout/);
});

test('marked wrong is read from the ledger, and a broken ledger is reported as not read', () => {
  const root = project();
  const warned = { type: 'gate_firing', gateId: 'L1', gateSha256: 'a'.repeat(64), action: 'warn', tool: 'Bash' };
  log(root, 'a', warned, warned);
  markWrong(root, 'L1', 'a', 1);
  promote(root, 'L1');
  markWrong(root, 'L1', 'a', 2);
  markWrong(root, 'L4', 'a', 1);
  const json = reportJson(root);
  assert.deepEqual(json.ledger, { intact: true, brokenAt: null });
  assert.deepEqual(json.gates.firings.map(g => [g.gateId, g.markedWrong, g.markedWrongTotal, g.fired.warn]), [['L1', 1, 2, 2], ['L4', 1, 1, 0]]);
  assert.match(reportText(root), /L1: .*marked wrong: 1 since the last promotion or landing, 2 in all/);

  writeFileSync(join(repoDataDir(root), 'ledger.jsonl'), '{"not":"a ledger line"}\n', { flag: 'a' });
  const broken = reportJson(root);
  assert.deepEqual(broken.ledger, { intact: false, brokenAt: 5 });
  assert.deepEqual(broken.gates.firings.map(g => [g.gateId, g.markedWrong, g.markedWrongTotal]), [['L1', null, null]]);
  assert.match(reportText(root), /L1: .*marked wrong: not read, because the ledger's chain is broken at line 5/);
});

test('a gate id with no learning on this machine is reported from its firings alone, never marked wrong', () => {
  const root = project();
  log(root, 'a',
    { type: 'gate_firing', gateId: 'L7', gateSha256: 'a'.repeat(64), action: 'block', tool: 'Bash', tool_use_id: 'u1' },
    { type: 'PostToolUse', tool: 'Bash', inputHash: 'h'.repeat(64), status: 'ok', tool_use_id: 'u2' });
  // A learning since deleted, whose ledger entries remain.
  markWrong(root, 'L4', 'a', 1);
  const r = runLog(root, 'report', '--json');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stderr, '');
  const { firings } = JSON.parse(r.stdout).gates;
  assert.deepEqual(firings.map(g => [g.gateId, g.markedWrong, g.markedWrongTotal]), [['L4', 1, 1], ['L7', 0, 0]]);
  assert.deepEqual(firings[1],
    { gateId: 'L7', fired: { observe: 0, warn: 0, block: 1 }, rerouted: 1, markedWrong: 0, markedWrongTotal: 0, gateSha256s: ['a'.repeat(64)] });
  assert.match(reportText(root), /L7: fired 1 time \(observe 0, warn 0, block 1\); rerouted after 1 of 1 warnings and blocks; marked wrong: 0 since the last promotion or landing, 0 in all/);
});

test('the report counts what it could not read', () => {
  const root = project();
  log(root, 'a', harness(), failure());
  log(root, 'b', harness(), failure());
  log(root, 'c', failure());
  log(root, 'd', harness('unreadable'), failure());
  writeFileSync(sessionFile(root, 'a'), 'not json\n', { flag: 'a' });
  writeFileSync(sealedFile(root, 'e'), 'not gzip');
  const json = reportJson(root);
  assert.deepEqual(
    [json.sessionsRead, json.sessionsUnreadable, json.linesUnparseable, json.failuresUnattributed],
    [5, 1, 1, 2],
  );
  assert.deepEqual([json.gates.sessionsRead, json.gates.sessionsUnreadable], [5, 1]);
  const text = reportText(root);
  assert.match(text, /sessions read: 5; of them unreadable, in whole or part: 1; unparseable lines: 1/);
  assert.match(text, /failures left out, because no harness and model was recorded before them: 2/);
});

test('with no log it says nothing was read', () => {
  const root = project();
  const json = reportJson(root);
  assert.equal(json.exists, false);
  assert.equal(json.sessionsRead, 0);
  assert.deepEqual(json.groups, []);
  assert.deepEqual(json.gates.firings, []);
  const text = reportText(root);
  assert.match(text, /No log for this repository on this machine/);
  assert.match(text, /nothing was read/);
  assert.ok(text.includes(repoDataDir(root)), 'it names where it looked');
});

test('a sessions directory that cannot be listed is reported as not read', () => {
  const root = project();
  mkdirSync(repoDataDir(root), { recursive: true });
  writeFileSync(join(repoDataDir(root), 'sessions'), 'not a directory');
  const json = reportJson(root);
  assert.equal(json.sessionsUnlistable, true);
  for (const field of ['sessionsRead', 'sessionsUnreadable', 'linesUnparseable', 'failuresUnattributed', 'groups']) assert.equal(json[field], null, field);
  assert.equal(json.gates, null);
  const text = reportText(root);
  assert.match(text, /sessions: not read, because the sessions directory could not be listed/);
  assert.doesNotMatch(text, /sessions read: 0/);
});

test('the report ends with the sentence saying what it does not claim', () => {
  for (const root of [project(), (() => {
    const r = project();
    writeSession(r, 's1');
    return r;
  })()]) {
    assert.ok(reportText(root).trimEnd().endsWith(NOT_CLAIMED));
    assert.equal(reportJson(root).notClaimed, NOT_CLAIMED);
  }
  assert.match(NOT_CLAIMED, /does not show that outcomes improved/);
});

test('report writes nothing: the data directory is byte-identical before and after', () => {
  const root = project();
  for (const id of ['a', 'b']) log(root, id, harness(), failure());
  sealAll(root);
  log(root, 'c', harness(), failure(), { type: 'gate_firing', gateId: 'L1', gateSha256: 'a'.repeat(64), action: 'block', tool: 'Bash' });
  markWrong(root, 'L1', 'c', 3);
  // A gate the ledger grants nothing, which any step that writes would
  // remove from the local gate set.
  const ungranted = { id: 'L1', tool: 'Bash', field: 'command', match: { kind: 'token', value: '--watch' }, message: 'Run the tests once.', action: 'block' };
  writeFileSync(join(repoDataDir(root), LOCAL_GATES_FILE), JSON.stringify({ schema: 1, gates: [ungranted] }));
  const before = snapshot(repoDataDir(root));
  for (const args of [['report'], ['report', '--json']]) assert.equal(runLog(root, ...args).status, 0);
  buildLogReport(root);
  assert.deepEqual(snapshot(repoDataDir(root)), before);
});

test('--json on report prints the report object and nothing else on stdout', () => {
  const root = project();
  for (const id of ['a', 'b']) log(root, id, harness(), failure());
  const r = runLog(root, 'report', '--json');
  assert.equal(r.status, 0);
  assert.equal(r.stderr, '');
  assert.deepEqual(JSON.parse(r.stdout), JSON.parse(JSON.stringify(buildLogReport(root))));
});
