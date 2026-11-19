// scripts/lib/integrity-evidence.test.mjs
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { integrityEvidence } from './integrity-evidence.mjs';
import { buildGaps } from './gap-model.mjs';
import { MANIFEST_PATH, readManifestResult, sha256 } from './manifest.mjs';
import { renderLearnedEntry } from './learned-registry.mjs';
import { selectProfile } from './profiles/index.mjs';
import { TOOL_GATE_PATH, HARNESS_GATES_PATH } from './propose.mjs';
import { gateSha256 } from '../../assets/scripts/harness-gates.mjs';
import { GATES_PATH } from '../../assets/scripts/harness-log.mjs';
import { LEARNED_PATH, RULES_PATH } from '../../assets/scripts/harness-redact.mjs';
import { GATE_FILE_MAX_BYTES } from '../../assets/scripts/tool-gate.mjs';
import { APPLY, DETECT, fixture, run, sandboxDataDir } from './lifecycle-fixtures.mjs';

sandboxDataDir();

const made = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-integrity-'));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

function write(d, rel, text) {
  mkdirSync(join(d, rel, '..'), { recursive: true });
  writeFileSync(join(d, rel), text);
}

/** A repository with `files` written to disk and recorded, as `apply`
 * records them, in the manifest that is returned. */
function installed(files, extra = {}) {
  const d = tempDir();
  for (const [rel, text] of Object.entries(files)) write(d, rel, text);
  const manifest = {
    schema: 1, kitVersion: '0.0.0', installedAt: '2026-11-19T00:00:00.000Z', settingsPatches: [],
    files: Object.entries(files).map(([path, text]) => ({ path, sha256: sha256(Buffer.from(text, 'utf8')) })),
    ...extra,
  };
  return { d, manifest };
}

const gate = (id, o = {}) => ({ id, tool: 'Bash', field: 'command', match: { kind: 'token', value: 'rm -rf' }, action: 'warn', message: 'Move files to the trash folder instead.', ...o });
const gateFile = gates => JSON.stringify({ schema: 1, gates }, null, 2) + '\n';
/** A registry entry approving the gate hash at `approvedAction`; with none,
 * the entry as the kit wrote it before entries named their action. */
function learned(id, approvedSha256, approvedAction) {
  const r = renderLearnedEntry({
    id, title: 'Do not delete files outright', why: 'Deleted build output was needed later.', enforcedBy: 'hook', pointer: GATES_PATH,
    evidenceSummary: { signature: '0123456789abcdef', sessions: 2, firstTs: null, lastTs: null, external: false }, approvedSha256, approvedAction,
  });
  assert.equal(r.error, undefined);
  return r;
}
/** The learned registry with an entry approving each gate's current hash
 * and action. */
const registryFor = gates => ['# Learned rules', '', ...gates.map(g => learned(g.id, gateSha256(g), g.action).text)].join('\n');

const HOOKS = { [TOOL_GATE_PATH]: '// tool gate\n', [HARNESS_GATES_PATH]: '// gate language\n' };

test('an untouched install is declared', () => {
  const g = gate('L1');
  const { d, manifest } = installed({ ...HOOKS, [GATES_PATH]: gateFile([g]), [LEARNED_PATH]: registryFor([g]) },
    { learnings: [{ id: 'L1', gateSha256: gateSha256(g) }] });
  const r = integrityEvidence(d, manifest);
  assert.deepEqual(r.problems, []);
  assert.deepEqual(r.summary, [
    `4 harness files recorded in ${MANIFEST_PATH} match it`,
    `${GATES_PATH}: 1 gate, each approved in ${LEARNED_PATH} for its content and its action`,
    `1 landed learning recorded in ${MANIFEST_PATH}, each matched by its gate`,
  ]);
});

test('an edited hook script is named', () => {
  const { d, manifest } = installed(HOOKS);
  write(d, TOOL_GATE_PATH, '// tool gate, edited\n');
  assert.deepEqual(integrityEvidence(d, manifest).problems, [`modified since kh-harness wrote it: ${TOOL_GATE_PATH}`]);
});

test('a hook script deleted while still recorded is named', () => {
  const { d, manifest } = installed(HOOKS);
  rmSync(join(d, HARNESS_GATES_PATH));
  assert.deepEqual(integrityEvidence(d, manifest).problems, [`recorded in ${MANIFEST_PATH} but missing: ${HARNESS_GATES_PATH}`]);
});

test('a CRLF checkout of an untouched hook script is not an integrity failure', () => {
  const { d, manifest } = installed(HOOKS);
  write(d, TOOL_GATE_PATH, '// tool gate\r\n');
  assert.deepEqual(integrityEvidence(d, manifest).problems, []);
});

test('documents the owner writes into are never an integrity failure', () => {
  const docs = { 'HANDOFF.md': '# Handoff\n', [RULES_PATH]: '# Rules\n', 'docs/harness/FAILURES.md': '# Failures\n', '.claude/rules/api.md': '# API\n' };
  const { d, manifest } = installed({ ...HOOKS, ...docs });
  for (const rel of Object.keys(docs)) write(d, rel, 'the owner wrote this\n');
  rmSync(join(d, 'HANDOFF.md'));
  const r = integrityEvidence(d, manifest);
  assert.deepEqual(r.problems, []);
  assert.equal(r.summary[0], `2 harness files recorded in ${MANIFEST_PATH} match it`);
});

test('a recorded gate file or learned registry that was edited is named', () => {
  const g = gate('L1');
  const { d, manifest } = installed({ [GATES_PATH]: gateFile([g]), [LEARNED_PATH]: registryFor([g]) });
  write(d, LEARNED_PATH, registryFor([g]) + '\n');
  write(d, GATES_PATH, gateFile([g]) + '\n');
  assert.deepEqual(integrityEvidence(d, manifest).problems, [
    `modified since kh-harness wrote it: ${GATES_PATH}`,
    `modified since kh-harness wrote it: ${LEARNED_PATH}`,
  ]);
});

test('a gate whose text changed after approval is named', () => {
  const g = gate('L1');
  const { d, manifest } = installed(HOOKS);
  write(d, LEARNED_PATH, registryFor([g]));
  write(d, GATES_PATH, gateFile([{ ...g, match: { kind: 'token', value: 'rm -r' } }]));
  assert.deepEqual(integrityEvidence(d, manifest).problems, [
    `L1 in ${GATES_PATH}: changed since it was approved — its hash is not the approved-sha256 of L1 in ${LEARNED_PATH}`,
    `L1 in ${LEARNED_PATH}: approved, but no gate in ${GATES_PATH} has its approved-sha256`,
  ]);
});

test('a gate whose action alone changed after approval is named, in either direction, though its hash is unchanged', () => {
  for (const [approved, committed] of [['warn', 'block'], ['block', 'warn'], ['block', 'observe']]) {
    const g = gate('L1', { action: approved });
    const { d, manifest } = installed(HOOKS);
    write(d, LEARNED_PATH, registryFor([g]));
    const changed = { ...g, action: committed };
    assert.equal(gateSha256(changed), gateSha256(g), 'fixture: the hash leaves the action out');
    write(d, GATES_PATH, gateFile([changed]));
    const r = integrityEvidence(d, manifest);
    assert.deepEqual(r.problems, [`L1 in ${GATES_PATH}: its action changed since it was approved — it is not the approved-action of L1 in ${LEARNED_PATH}`], `${approved} to ${committed}`);
    assert.deepEqual(r.summary, []);
  }
});

test('an entry written before entries named their action approves a gate for its content and not for its action, and the check says so', () => {
  const old = gate('L1', { action: 'block' });
  const current = gate('L2', { match: { kind: 'literal', value: 'git push --force' } });
  const { d, manifest } = installed(HOOKS);
  write(d, LEARNED_PATH, ['# Learned rules', '', learned('L1', gateSha256(old)).text, learned('L2', gateSha256(current), current.action).text].join('\n'));
  write(d, GATES_PATH, gateFile([old, current]));
  const r = integrityEvidence(d, manifest);
  assert.deepEqual(r.problems, [
    `L1 in ${GATES_PATH}: not approved for its action — its entry in ${LEARNED_PATH} records no approved-action, as an entry landed by an older kh-harness does not; `
      + '`learn revert L1 --yes` then `learn land L1 --yes`, at a terminal on the machine that landed it, writes one',
  ], 'neither passed as approved nor reported as changed; the entry beside it is unaffected');
  assert.deepEqual(r.summary, []);
});

test('an approval of a gate\'s hash under another id approves no action for it', () => {
  const g = gate('L1');
  const { d, manifest } = installed(HOOKS);
  write(d, LEARNED_PATH, ['# Learned rules', '', learned('L8', gateSha256(g), 'block').text].join('\n'));
  write(d, GATES_PATH, gateFile([g]));
  assert.deepEqual(integrityEvidence(d, manifest).problems, [
    `L1 in ${GATES_PATH}: not approved for its action — no entry L1 in ${LEARNED_PATH} approves its hash, so none records an action for it`,
  ]);
});

test('a gate with no registry entry is named', () => {
  const approved = gate('L1');
  const stray = gate('L2', { match: { kind: 'literal', value: 'git push --force' } });
  const { d, manifest } = installed(HOOKS);
  write(d, LEARNED_PATH, registryFor([approved]));
  write(d, GATES_PATH, gateFile([approved, stray]));
  assert.deepEqual(integrityEvidence(d, manifest).problems, [`L2 in ${GATES_PATH}: no entry in ${LEARNED_PATH} approves it`]);
});

test('a gate file with no learned registry beside it names every gate', () => {
  const { d, manifest } = installed(HOOKS);
  write(d, GATES_PATH, gateFile([gate('L1')]));
  assert.deepEqual(integrityEvidence(d, manifest).problems, [`L1 in ${GATES_PATH}: no entry in ${LEARNED_PATH} approves it`]);
});

test('a gate file that cannot be parsed is named, and its gates are not judged further', () => {
  const g = gate('L1');
  const { d, manifest } = installed(HOOKS, { learnings: [{ id: 'L1', gateSha256: gateSha256(g) }] });
  write(d, LEARNED_PATH, registryFor([g]));
  write(d, GATES_PATH, '{ not json');
  assert.deepEqual(integrityEvidence(d, manifest).problems, [`${GATES_PATH} cannot be parsed as a gate file: the gate file is not valid JSON`]);
});

test('entries the gate language rejects are named by position, and a suspension by its id', () => {
  const g = gate('L1');
  const { d, manifest } = installed(HOOKS);
  write(d, LEARNED_PATH, registryFor([g]));
  write(d, GATES_PATH, gateFile([g, { id: 'L1; rm -rf /', tool: 'Bash' }, { id: 'L3', suspended: true }]));
  assert.deepEqual(integrityEvidence(d, manifest).problems, [
    `${GATES_PATH}: entry 2 is not a gate (id must be L followed by 1 to 9 digits, without a leading zero)`,
    `${GATES_PATH}: L3 is a suspension, which only this machine's gate file may hold`,
  ]);
});

test('a landed learning with no gate is named', () => {
  const g = gate('L1');
  const { d, manifest } = installed(HOOKS, { learnings: [
    { id: 'L1', gateSha256: gateSha256(g) },
    { id: 'L2', gateSha256: gateSha256(gate('L2')) },
  ] });
  write(d, LEARNED_PATH, registryFor([g]));
  write(d, GATES_PATH, gateFile([g]));
  assert.deepEqual(integrityEvidence(d, manifest).problems, [
    `landed learning L2 in ${MANIFEST_PATH}: no gate in ${GATES_PATH} has its id and hash`,
  ]);
});

test('a manifest whose landed learnings are not id-and-hash records never reaches the cross-check: it is corrupt, and the check fails on that', () => {
  for (const learnings of [
    [{ id: '\u001b[2Jforged', gateSha256: 'x' }], ['not a learning'], [{ id: 'L99' }], [{ id: 'L98', gateSha256: null }],
    [{ id: 'L97', gateSha256: 'A'.repeat(64) }], [['L96', 'a'.repeat(64)]], { L1: 'x' },
  ]) {
    const { d, manifest } = installed(HOOKS, { learnings });
    write(d, MANIFEST_PATH, JSON.stringify(manifest));
    assert.equal(readManifestResult(d).state, 'corrupt', JSON.stringify(learnings));
    const check = integrityGap(d, null);
    assert.equal(check.state, 'failing');
    assert.deepEqual(check.evidence, [`${MANIFEST_PATH} could not be read as a manifest, so the kit's files could not be checked against it`]);
  }
});

test('a well-formed landed learning with no gate file is named by its id', () => {
  const { d, manifest } = installed(HOOKS, { learnings: [{ id: 'L1', gateSha256: gateSha256(gate('L1')) }] });
  assert.deepEqual(integrityEvidence(d, manifest).problems, [`landed learning L1 in ${MANIFEST_PATH}: no gate in ${GATES_PATH} has its id and hash`]);
});

test('a manifest that records no harness file says so', () => {
  const { d, manifest } = installed({ 'HANDOFF.md': '# Handoff\n' });
  assert.deepEqual(integrityEvidence(d, manifest).summary, [`${MANIFEST_PATH} records no harness file`, `${GATES_PATH}: no committed gate file`]);
});

test('an approved learned entry with no gate is named, by its line when its id is not a gate id', () => {
  const g = gate('L1');
  const { d, manifest } = installed(HOOKS);
  const forged = learned('L9', gateSha256(gate('L9')), 'warn').text.replace('## L9', '## Lx9');
  write(d, LEARNED_PATH, [registryFor([g]), forged].join('\n'));
  assert.deepEqual(integrityEvidence(d, manifest).problems, [
    `L1 in ${LEARNED_PATH}: approved, but no gate in ${GATES_PATH} has its approved-sha256`,
    `the entry at line 13 in ${LEARNED_PATH}: approved, but no gate in ${GATES_PATH} has its approved-sha256`,
  ]);
});

test('an owner\'s entry in the learned registry with no origin is not cross-checked', () => {
  const { d, manifest } = installed(HOOKS);
  write(d, LEARNED_PATH, learned('L1', 'a'.repeat(64)).text.replace('- origin: learned\n', ''));
  assert.deepEqual(integrityEvidence(d, manifest).problems, []);
});

test('a recorded path that could reach the terminal unsafely is named by its position', () => {
  // A right-to-left override, which a file system accepts and a terminal
  // obeys.
  const unsafe = '.claude/scripts/x\u202egpj.mjs';
  const { d, manifest } = installed({ ...HOOKS, [unsafe]: '// x\n' });
  write(d, unsafe, '// edited\n');
  assert.deepEqual(integrityEvidence(d, manifest).problems, [`modified since kh-harness wrote it: the file at position 3 in ${MANIFEST_PATH}`]);
});

test('a recorded harness path that resolves outside the repository is named by its position', () => {
  const { d, manifest } = installed(HOOKS);
  manifest.files.push({ path: '.claude/scripts/../../../outside.mjs', sha256: 'a'.repeat(64) });
  const r = integrityEvidence(d, manifest);
  assert.deepEqual(r.problems, [`the file at position 3 in ${MANIFEST_PATH} resolves outside the repository, so it was not read`]);
});

test('a gate file larger than the gate hook loads is named, and one at the limit is read', () => {
  const g = gate('L1');
  const { d, manifest } = installed(HOOKS);
  write(d, LEARNED_PATH, registryFor([g]));
  const text = gateFile([g]);
  write(d, GATES_PATH, text + ' '.repeat(GATE_FILE_MAX_BYTES - Buffer.byteLength(text)));
  assert.deepEqual(integrityEvidence(d, manifest).problems, []);

  write(d, GATES_PATH, text + ' '.repeat(GATE_FILE_MAX_BYTES + 1 - Buffer.byteLength(text)));
  assert.deepEqual(integrityEvidence(d, manifest).problems, [
    `${GATES_PATH} is larger than ${GATE_FILE_MAX_BYTES} bytes, so the gate hook ignores it and none of its gates apply`,
  ]);
});

// --- The check ---------------------------------------------------------------

const stack = { languages: [], packageManager: null, isWorkspace: false, packages: [], ci: [] };
const harness = {
  instructions: { path: null, lines: 0 }, agentsMd: null, reconPresent: false,
  claudeDir: { settings: false, localSettings: false, denyRules: 0, hooks: [], hookEvents: {}, hookRegistrations: {}, agents: [], skills: [], commands: [], rules: [] },
  otherEditors: [], architecture: null, handoff: null, bootstrap: null, gitattributes: false, remotes: [],
};
const integrityGap = (root, manifest) => buildGaps({ stack, harness, exposures: [], profile: selectProfile(stack), git: { branch: 'main', isRepo: true }, files: [], root, manifest, kitVersion: '0.0.0' })
  .find(c => c.id === 'P5.integrity');

test('P5.integrity sits directly after P5.toolgate, and P0.kitskew stays last', () => {
  const ids = buildGaps({ stack, harness, exposures: [], profile: selectProfile(stack), git: { branch: 'main', isRepo: true }, files: [] }).map(c => c.id);
  assert.equal(ids[ids.indexOf('P5.toolgate') + 1], 'P5.integrity');
  assert.equal(ids.at(-1), 'P0.kitskew');
});

test('P5.integrity is n/a with no manifest, failing with its problems, declared otherwise, and never proposes', () => {
  const none = integrityGap(undefined, null);
  assert.equal(none.state, 'n/a');
  assert.deepEqual(none.evidence, [`no ${MANIFEST_PATH}: nothing was installed`]);
  assert.equal(integrityGap(tempDir(), null).state, 'n/a', 'a repository with no manifest file');

  const { d, manifest } = installed(HOOKS);
  const clean = integrityGap(d, manifest);
  assert.equal(clean.state, 'declared');
  assert.deepEqual(clean.evidence, [`2 harness files recorded in ${MANIFEST_PATH} match it`, `${GATES_PATH}: no committed gate file`]);

  write(d, TOOL_GATE_PATH, '// edited\n');
  const broken = integrityGap(d, manifest);
  assert.equal(broken.state, 'failing');
  assert.deepEqual(broken.evidence, [`modified since kh-harness wrote it: ${TOOL_GATE_PATH}`]);
  for (const c of [none, clean, broken]) {
    assert.equal(c.proposal, null);
    assert.equal(c.via, null);
  }
});

test('P5.integrity is failing when the manifest is corrupt', () => {
  const d = tempDir();
  write(d, MANIFEST_PATH, '{ "schema": 1, "files": [');
  const c = integrityGap(d, null);
  assert.equal(c.state, 'failing');
  assert.deepEqual(c.evidence, [`${MANIFEST_PATH} could not be read as a manifest, so the kit's files could not be checked against it`]);
  assert.equal(c.proposal, null);
});

test('P5.integrity throws when given a manifest without the root to read it against', () => {
  const { manifest } = installed(HOOKS);
  assert.throws(() => integrityGap(undefined, manifest), /P5\.integrity/);
});

test('detect reports an applied install as declared, and names a hook script edited afterwards', () => {
  const d = fixture();
  made.push(d);
  run(APPLY, d, '--yes');
  const integrity = () => JSON.parse(run(DETECT, d, '--json')).checks.find(c => c.id === 'P5.integrity');
  assert.equal(integrity().state, 'declared');

  write(d, 'HANDOFF.md', readFileSync(join(d, 'HANDOFF.md'), 'utf8') + '\nThe owner\'s notes.\n');
  assert.equal(integrity().state, 'declared', 'an edit to a scaffolded document is its intended use');

  write(d, TOOL_GATE_PATH, readFileSync(join(d, TOOL_GATE_PATH), 'utf8') + '\n// edited\n');
  const edited = integrity();
  assert.equal(edited.state, 'failing');
  assert.deepEqual(edited.evidence, [`modified since kh-harness wrote it: ${TOOL_GATE_PATH}`]);
});
