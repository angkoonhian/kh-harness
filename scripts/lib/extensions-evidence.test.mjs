// scripts/lib/extensions-evidence.test.mjs
//
// What P5.extensions reads from a real repository, and, for each sentence
// that depends on the installed kit files, what the installed entry script
// then does with a PreToolUse call, run as a child process in the same test
// so the check's words and the hook's behaviour cannot drift apart. A block
// is the deny object extensions-half.test.mjs pins against the hooks
// reference.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { EXTENSION_HOOK_FILES, extensionsEvidence } from './extensions-evidence.mjs';
import { buildGaps } from './gap-model.mjs';
import { KIT_VERSION } from './manifest.mjs';
import { selectProfile } from './profiles/index.mjs';
import { DISPATCH_PRE_PATH, HARNESS_DISPATCH_PATH, HARNESS_EXTENSIONS_PATH, everyLoadedSibling, installedScriptProposal } from './propose.mjs';
import { EXTENSIONS_PATH, moduleSha256 } from '../../assets/scripts/harness-extensions.mjs';
import { sandboxMarkerDir } from './test-marker-sandbox.mjs';

const made = [];
const tempDir = (prefix = 'hk-ext-evidence-') => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

sandboxMarkerDir();
const DATA_DIR = tempDir('hk-ext-evidence-data-');

function write(d, rel, text) {
  mkdirSync(join(d, rel, '..'), { recursive: true });
  writeFileSync(join(d, rel), text);
}

const entry = (id, onFailure, source) => ({ id, version: '1.0.0', module: `.claude/ext/${id}.mjs`, sha256: moduleSha256(Buffer.from(source)), onFailure });
const ALLOW = 'export const preToolUse = () => ({ decision: \'allow\' });\n';
const BLOCK = 'export const preToolUse = () => ({ decision: \'block\', message: \'refused by a\' });\n';
const HOOK_FILE_PATHS = Object.values(EXTENSION_HOOK_FILES).flat();
const every = status => Object.fromEntries(HOOK_FILE_PATHS.map(path => [path, status]));
const CURRENT = every('current');
const HARNESS_LOG = '.claude/scripts/harness-log.mjs';
const HARNESS_REDACT = '.claude/scripts/harness-redact.mjs';

/** A repository holding the entry script and every installed script it
 * loads, as this kit writes them today. */
function installedRepo() {
  const d = tempDir();
  mkdirSync(join(d, '.git'));
  for (const path of [DISPATCH_PRE_PATH, ...everyLoadedSibling(DISPATCH_PRE_PATH)]) write(d, path, installedScriptProposal(path, KIT_VERSION).contents);
  return d;
}

/** The current entry script with the extension point taken out: what an
 * install from before it holds. */
function entryWithoutExtensions() {
  const current = installedScriptProposal(DISPATCH_PRE_PATH, KIT_VERSION).contents;
  const older = current.replace('...(expected ? preHalves : []),', '');
  assert.notEqual(older, current, 'the entry script no longer spreads preHalves into its halves');
  return older;
}

const harness = d => ({
  instructions: { path: null, lines: 0 }, agentsMd: null, reconPresent: false,
  claudeDir: { settings: true, localSettings: false, denyRules: 0, hooks: [], hookRegistrations: { PreToolUse: [{ script: DISPATCH_PRE_PATH, matcher: null }] }, agents: [], skills: [], commands: [], rules: [] },
  otherEditors: [], architecture: null, handoff: null, bootstrap: null, gitattributes: false, remotes: [],
  extensions: extensionsEvidence(d),
});
const stack = { languages: ['typescript'], packageManager: 'npm', isWorkspace: false, packages: [{ name: 'app', dir: '.', manifestPath: 'package.json', scripts: [] }], ci: [] };
const check = d => buildGaps({ stack, harness: harness(d), exposures: [], profile: selectProfile(stack), git: { branch: 'main', isRepo: true }, files: [] })
  .find(c => c.id === 'P5.extensions');

/** The deny reason the installed entry script gives a Bash call, or null
 * when it does not deny it. */
function hookDenies(d) {
  const r = spawnSync(process.execPath, [join(d, DISPATCH_PRE_PATH)], {
    input: JSON.stringify({ session_id: 'sess-1', hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_1' }),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: d, KH_DATA_DIR: DATA_DIR },
    timeout: 30_000,
  });
  assert.equal(r.status, 0, `exit status; stderr: ${r.stderr}`);
  if (r.stdout.trim() === '') return null;
  const out = JSON.parse(r.stdout);
  return out.hookSpecificOutput?.permissionDecision === 'deny' ? out.hookSpecificOutput.permissionDecisionReason : null;
}

const REMEDY = 'run kh-harness apply --yes; P0.kitskew says whether it can update each file';
const UNCHECKED = 'matches its recorded sha256 (whether it loads and runs is not checked)';
const unusableDeny = file => `kh-harness: .claude/scripts/${file} is missing or cannot be loaded while .claude/kh-harness/extensions.json exists, so every tool call is blocked. Run kh-harness apply --yes from a kit at least as new as the one that installed .claude/scripts/dispatch-pre-tool.mjs, or remove the extensions file, outside this session.`;

test('no file is absent, a bad file is malformed with the loader\'s own problem text', () => {
  const d = tempDir();
  assert.deepEqual(extensionsEvidence(d), { state: 'absent' });
  write(d, EXTENSIONS_PATH, '[ not json');
  assert.deepEqual(extensionsEvidence(d), { state: 'malformed', problem: 'it is not JSON', installed: every('missing') });
});

test('each extension is listed with its hash state, and its recorded sha256 is not', () => {
  const d = installedRepo();
  const entries = [entry('a', 'block', ALLOW), entry('b', 'allow', ALLOW), entry('c', 'block', ALLOW)];
  write(d, '.claude/ext/a.mjs', ALLOW);
  write(d, '.claude/ext/b.mjs', `${ALLOW}// changed after hashing\n`);
  write(d, EXTENSIONS_PATH, JSON.stringify(entries));
  assert.deepEqual(extensionsEvidence(d), { state: 'ok', installed: CURRENT, extensions: [
    { id: 'a', version: '1.0.0', module: '.claude/ext/a.mjs', onFailure: 'block', hash: 'matches' },
    { id: 'b', version: '1.0.0', module: '.claude/ext/b.mjs', onFailure: 'allow', hash: 'differs' },
    { id: 'c', version: '1.0.0', module: '.claude/ext/c.mjs', onFailure: 'block', hash: 'missing' },
  ] });
});

test('an installed kit file is current only while it holds what this kit writes there today, line endings aside', () => {
  const d = installedRepo();
  write(d, EXTENSIONS_PATH, '[]');
  write(d, DISPATCH_PRE_PATH, installedScriptProposal(DISPATCH_PRE_PATH, KIT_VERSION).contents.replace(/\n/g, '\r\n'));
  write(d, HARNESS_DISPATCH_PATH, '// another core\n');
  rmSync(join(d, HARNESS_EXTENSIONS_PATH));
  write(d, HARNESS_LOG, installedScriptProposal(HARNESS_LOG, '0.0.1').contents);
  assert.deepEqual(extensionsEvidence(d).installed, { ...CURRENT, [HARNESS_DISPATCH_PATH]: 'other', [HARNESS_EXTENSIONS_PATH]: 'missing', [HARNESS_LOG]: 'other-version' });
});

test('the files the hook needs are the entry script, the core, the loader, and every installed script those load', () => {
  assert.deepEqual(EXTENSION_HOOK_FILES, {
    entry: [DISPATCH_PRE_PATH],
    core: [HARNESS_DISPATCH_PATH, ...everyLoadedSibling(HARNESS_DISPATCH_PATH)],
    loader: [HARNESS_EXTENSIONS_PATH, ...everyLoadedSibling(HARNESS_EXTENSIONS_PATH)],
  });
  assert.ok(EXTENSION_HOOK_FILES.loader.includes(HARNESS_LOG) && EXTENSION_HOOK_FILES.loader.includes(HARNESS_REDACT));
});

test('listing an extension does not load it', () => {
  const d = tempDir();
  const marker = join(d, 'loaded');
  const source = `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(marker)}, '');\nexport const preToolUse = () => ({ decision: 'allow' });\n`;
  write(d, '.claude/ext/a.mjs', source);
  write(d, EXTENSIONS_PATH, JSON.stringify([entry('a', 'block', source)]));
  assert.equal(extensionsEvidence(d).extensions[0].hash, 'matches');
  assert.equal(existsSync(marker), false, 'the module was imported');
});

// --- The check's sentence beside the installed hook's behaviour -------------

test('an entry script that is not the one this kit installs: what it does was not read, and an older one ignores the file', () => {
  const d = installedRepo();
  write(d, DISPATCH_PRE_PATH, entryWithoutExtensions());
  write(d, '.claude/ext/a.mjs', BLOCK);
  write(d, EXTENSIONS_PATH, JSON.stringify([entry('a', 'block', BLOCK)]));
  const c = check(d);
  assert.equal(c.state, 'failing');
  assert.deepEqual(c.evidence, [
    `.claude/kh-harness/extensions.json lists 1 extension, and what the hook does with the file was not read: ${DISPATCH_PRE_PATH} is not the file this kit installs; ${REMEDY}`,
    `a 1.0.0: .claude/ext/a.mjs ${UNCHECKED}; onFailure block`,
  ]);
  assert.equal(hookDenies(d), null, 'the older entry script never ran the blocking extension');

  write(d, EXTENSIONS_PATH, '[ not json');
  const malformed = check(d);
  assert.deepEqual([malformed.state, malformed.evidence], ['failing', [
    `.claude/kh-harness/extensions.json cannot be used (it is not JSON), and what the hook does with the file was not read: ${DISPATCH_PRE_PATH} is not the file this kit installs; ${REMEDY}`,
  ]]);
  assert.equal(hookDenies(d), null, 'the older entry script allows the call despite the malformed file');
});

test('a current entry script without its loader blocks every call, whatever the entries say and with none', () => {
  const d = installedRepo();
  rmSync(join(d, HARNESS_EXTENSIONS_PATH));
  const blocked = `every tool call is blocked: ${HARNESS_EXTENSIONS_PATH} is missing; ${REMEDY}`;
  const cases = [
    { name: 'a matching allow entry', file: [entry('a', 'allow', ALLOW)], module: ALLOW, lines: [`a 1.0.0: .claude/ext/a.mjs ${UNCHECKED}; onFailure allow`] },
    { name: 'a differing allow entry', file: [entry('a', 'allow', ALLOW)], module: `${ALLOW}// changed\n`, lines: ['a 1.0.0: .claude/ext/a.mjs does not match its recorded sha256; onFailure allow'] },
    { name: 'an empty list', file: [], module: null, header: `.claude/kh-harness/extensions.json lists no extension, and ${blocked}`, lines: [] },
  ];
  for (const { name, file, module, header, lines } of cases) {
    if (module !== null) write(d, '.claude/ext/a.mjs', module);
    write(d, EXTENSIONS_PATH, JSON.stringify(file));
    const c = check(d);
    assert.equal(c.state, 'failing', name);
    assert.deepEqual(c.evidence, [header ?? `.claude/kh-harness/extensions.json lists 1 extension, and ${blocked}`, ...lines], name);
    assert.equal(hookDenies(d), unusableDeny('harness-extensions.mjs'), name);
  }
});

test('a current entry script without its core blocks every call', () => {
  const d = installedRepo();
  rmSync(join(d, HARNESS_DISPATCH_PATH));
  write(d, '.claude/ext/a.mjs', ALLOW);
  write(d, EXTENSIONS_PATH, JSON.stringify([entry('a', 'allow', ALLOW)]));
  const c = check(d);
  assert.deepEqual([c.state, c.evidence[0]], ['failing', `.claude/kh-harness/extensions.json lists 1 extension, and every tool call is blocked: ${HARNESS_DISPATCH_PATH} is missing; ${REMEDY}`]);
  assert.equal(hookDenies(d), unusableDeny('harness-dispatch.mjs'));
});

test('a current entry script beside a loader this kit did not install: what it does was not read', () => {
  const d = installedRepo();
  write(d, HARNESS_EXTENSIONS_PATH, '// another loader\n');
  write(d, '.claude/ext/a.mjs', ALLOW);
  write(d, EXTENSIONS_PATH, JSON.stringify([entry('a', 'allow', ALLOW)]));
  const c = check(d);
  assert.deepEqual([c.state, c.evidence[0]], ['failing', `.claude/kh-harness/extensions.json lists 1 extension, and what the hook does with the file was not read: ${HARNESS_EXTENSIONS_PATH} is not the file this kit installs; ${REMEDY}`]);
});

test('all three current: the consequence each line states is what the hook does', () => {
  const d = installedRepo();
  write(d, '.claude/ext/a.mjs', ALLOW);
  write(d, EXTENSIONS_PATH, JSON.stringify([entry('a', 'block', ALLOW)]));
  const clean = check(d);
  assert.deepEqual([clean.state, clean.evidence], ['declared', [
    '.claude/kh-harness/extensions.json lists 1 extension, run by .claude/scripts/dispatch-pre-tool.mjs before every tool call',
    `a 1.0.0: .claude/ext/a.mjs ${UNCHECKED}; onFailure block`,
  ]]);
  assert.equal(hookDenies(d), null);

  write(d, '.claude/ext/a.mjs', `${ALLOW}// changed\n`);
  const changed = check(d);
  assert.deepEqual([changed.state, changed.evidence[1]], ['failing', 'a 1.0.0: .claude/ext/a.mjs does not match its recorded sha256; onFailure block, so every tool call is blocked']);
  assert.match(hookDenies(d), /^kh-harness extension a: its module file does not match the sha256 recorded for it, so this call is blocked/);

  write(d, EXTENSIONS_PATH, '[ not json');
  assert.deepEqual(check(d).evidence, ['.claude/kh-harness/extensions.json cannot be used (it is not JSON), so every tool call is blocked']);
  assert.match(hookDenies(d), /^kh-harness: \.claude\/kh-harness\/extensions\.json cannot be used \(it is not JSON\), so every tool call is blocked/);
});

test('a module the loader imports that is missing blocks every call, whatever the entries say and with none', () => {
  const cases = [
    { missing: HARNESS_LOG, file: [entry('a', 'allow', ALLOW)], header: `.claude/kh-harness/extensions.json lists 1 extension, and every tool call is blocked: ${HARNESS_LOG} is missing; ${REMEDY}` },
    { missing: HARNESS_LOG, file: [], header: `.claude/kh-harness/extensions.json lists no extension, and every tool call is blocked: ${HARNESS_LOG} is missing; ${REMEDY}` },
    { missing: HARNESS_REDACT, file: [], header: `.claude/kh-harness/extensions.json lists no extension, and every tool call is blocked: ${HARNESS_REDACT} is missing; ${REMEDY}` },
  ];
  for (const { missing, file, header } of cases) {
    const d = installedRepo();
    rmSync(join(d, missing));
    write(d, '.claude/ext/a.mjs', ALLOW);
    write(d, EXTENSIONS_PATH, JSON.stringify(file));
    const c = check(d);
    assert.deepEqual([c.state, c.evidence[0]], ['failing', header], missing);
    assert.equal(hookDenies(d), unusableDeny('harness-extensions.mjs'), missing);
  }
});

test('a module the loader imports that this kit did not write: what the hook does was not read', () => {
  const d = installedRepo();
  write(d, HARNESS_LOG, `${installedScriptProposal(HARNESS_LOG, KIT_VERSION).contents}// edited\n`);
  write(d, '.claude/ext/a.mjs', ALLOW);
  write(d, EXTENSIONS_PATH, JSON.stringify([entry('a', 'block', ALLOW)]));
  const c = check(d);
  assert.equal(c.state, 'failing');
  assert.deepEqual(c.evidence, [
    `.claude/kh-harness/extensions.json lists 1 extension, and what the hook does with the file was not read: ${HARNESS_LOG} is not the file this kit installs; ${REMEDY}`,
    `a 1.0.0: .claude/ext/a.mjs ${UNCHECKED}; onFailure block`,
  ]);
  assert.equal(hookDenies(d), null, 'this edit happens to leave the loader working');
});

test('a kit file stamped by another kh-harness version is named as such', () => {
  const d = installedRepo();
  write(d, DISPATCH_PRE_PATH, installedScriptProposal(DISPATCH_PRE_PATH, '0.0.1').contents);
  write(d, '.claude/ext/a.mjs', ALLOW);
  write(d, EXTENSIONS_PATH, JSON.stringify([entry('a', 'block', ALLOW)]));
  const c = check(d);
  assert.deepEqual([c.state, c.evidence[0]], ['failing', `.claude/kh-harness/extensions.json lists 1 extension, and what the hook does with the file was not read: ${DISPATCH_PRE_PATH} carries another kh-harness version's stamp; ${REMEDY}`]);
});
