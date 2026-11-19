// scripts/lib/hook-skew.test.mjs
//
// Every installed hook beside an older or missing sibling module. `apply`
// leaves a hand-edited script in place, so a hook can find itself beside the
// shared module of an earlier release;
// `fixtures/harness-redact.0.1.0.mjs.gz.b64` is that module as release 0.1.0
// shipped it (commit 681189d), gzipped and then base64-encoded: the
// repository's own credential sweep reads every source file and would read
// a second copy of the credential table's comments, and no tracked file
// under scripts/ may hold a NUL byte. Whatever the sibling's state, a hook
// exits 0, writes nothing to stderr, and says at most one thing per session.
//
// Every test runs against a temporary KH_DATA_DIR and HK_MARKER_DIR.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';

import { readEvents, setEnabled } from '../../assets/scripts/harness-log.mjs';
import { sandboxMarkerDir } from './test-marker-sandbox.mjs';

const REPO = resolve(import.meta.dirname, '..', '..');
const ASSETS = join(REPO, 'assets', 'scripts');
const OLD_REDACT = gunzipSync(Buffer.from(readFileSync(join(import.meta.dirname, 'fixtures', 'harness-redact.0.1.0.mjs.gz.b64'), 'utf8'), 'base64'));
const OLD_REDACT_SOURCE = '681189d:assets/scripts/harness-redact.mjs';

const made = [];
const tempDir = prefix => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

sandboxMarkerDir();
process.env.KH_DATA_DIR = tempDir('hk-skew-data-');

/** A project that is its own repository, holding a lint script and a test
 * script so the two process hooks would have work to do. */
function project() {
  const root = tempDir('hk-skew-repo-');
  mkdirSync(join(root, '.git'));
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'src', 'a.js'), 'export const a = 1;\n');
  writeFileSync(join(root, 'package.json'), JSON.stringify({ scripts: { lint: 'node -e 0', test: 'node -e 0' } }));
  return root;
}

/** Every installed script in a directory of its own, with each name in
 * `replaced` holding that text instead, or absent when it is null. */
function installed(replaced) {
  const dir = tempDir('hk-skew-scripts-');
  for (const name of readdirSync(ASSETS)) copyFileSync(join(ASSETS, name), join(dir, name));
  for (const [name, text] of Object.entries(replaced)) {
    if (text === null) rmSync(join(dir, name));
    else writeFileSync(join(dir, name), text);
  }
  return dir;
}

const PAYLOADS = {
  'session-log.mjs': s => ({ session_id: s, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_1' }),
  'tool-gate.mjs': s => ({ session_id: s, hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'toolu_1' }),
  'loop-watch.mjs': s => ({ session_id: s, hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_input: { command: 'npm test' }, error: 'Exit code 1' }),
  'rules-brief.mjs': s => ({ session_id: s, hook_event_name: 'UserPromptSubmit', prompt: 'fix the parser' }),
  'session-brief.mjs': s => ({ session_id: s, hook_event_name: 'SessionStart', source: 'startup' }),
  'lint-touched.mjs': s => ({ session_id: s, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: 'src/a.js' } }),
  'verify-touched.mjs': s => ({ session_id: s, hook_event_name: 'Stop' }),
};
const HOOKS = Object.keys(PAYLOADS);

function runHook(dir, hook, root, payload) {
  return spawnSync(process.execPath, [join(dir, hook)], {
    input: JSON.stringify(payload),
    encoding: 'utf8',
    env: { ...process.env, CLAUDE_PROJECT_DIR: root },
  });
}

/** Asserts the run ended as a hook must beside a sibling it cannot use, and
 * returns what it said: the `systemMessage` of its JSON output, its plain
 * stdout line, or null when it said nothing. */
function said(result, hook) {
  assert.equal(result.status, 0, `${hook} exit status; stderr: ${result.stderr}`);
  assert.equal(result.stderr, '', `${hook} stderr`);
  if (result.stdout === '') return null;
  assert.equal(result.stdout.trimEnd().split('\n').length, 1, `${hook} prints one line`);
  let output;
  try {
    output = JSON.parse(result.stdout);
  } catch {
    return result.stdout.trimEnd();
  }
  assert.deepEqual(Object.keys(output), ['systemMessage'], `${hook} decides nothing and adds no context`);
  return output.systemMessage;
}

test('the fixture is the shared module release 0.1.0 shipped', t => {
  let shipped;
  try {
    shipped = execFileSync('git', ['show', OLD_REDACT_SOURCE], { cwd: REPO, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    t.skip(`this checkout does not hold ${OLD_REDACT_SOURCE} (a shallow clone)`);
    return;
  }
  assert.ok(shipped.equals(OLD_REDACT));
});

test('fixture sanity: every hook runs beside the current siblings, exits 0 and writes nothing to stderr', () => {
  const dir = installed({});
  const root = project();
  for (const hook of HOOKS) {
    const result = runHook(dir, hook, root, PAYLOADS[hook](`current-${hook}`));
    assert.equal(result.status, 0, `${hook}; stderr: ${result.stderr}`);
    assert.equal(result.stderr, '', hook);
    assert.doesNotMatch(result.stdout, /older than this hook|cannot be loaded/, hook);
  }
});

for (const hook of HOOKS) {
  test(`${hook} beside the 0.1.0 harness-redact.mjs exits 0 with one notice per session and no stack trace`, () => {
    const dir = installed({ 'harness-redact.mjs': OLD_REDACT });
    const root = project();
    setEnabled(root, true);
    const session = `old-${hook.replace(/\W/g, '-')}`;
    const first = said(runHook(dir, hook, root, PAYLOADS[hook](session)), hook);
    assert.match(first ?? '', /^kh-harness[^:]*: .*\.claude\/scripts\/harness-[a-z]+\.mjs (is older than this hook and lacks what it needs|is missing or cannot be loaded)/, hook);
    assert.match(first, /re-run `node scripts\/apply\.mjs <repo> --yes`/, `${hook} names the fix`);
    // A session start happens once, so session-brief has nothing to repeat.
    if (hook !== 'session-brief.mjs') {
      assert.equal(said(runHook(dir, hook, root, PAYLOADS[hook](session)), hook), null, `${hook} tells a session once`);
      assert.equal(said(runHook(dir, hook, root, PAYLOADS[hook](`${session}-2`)), hook), first, `${hook} tells the next session`);
    }
  });

  test(`${hook} with harness-redact.mjs missing exits 0 with at most one line and no stack trace`, () => {
    const dir = installed({ 'harness-redact.mjs': null });
    const root = project();
    const session = `missing-${hook.replace(/\W/g, '-')}`;
    // With no marker helpers at all, session-log speaks at a session start only.
    const payload = hook === 'session-log.mjs' ? PAYLOADS['session-brief.mjs'](session) : PAYLOADS[hook](session);
    const line = said(runHook(dir, hook, root, payload), hook);
    assert.match(line ?? '', /^kh-harness[^:]*: .*is missing or cannot be loaded/, hook);
  });
}

/** The names the installed script `importer` imports from its sibling
 * `from`, read from its source. */
function importedFrom(importer, from) {
  const source = readFileSync(join(ASSETS, importer), 'utf8');
  const found = new RegExp(`import \\{([^}]*)\\} from '\\./${from.replaceAll('.', '\\.')}';`).exec(source);
  assert.ok(found, `${importer} imports from ${from}`);
  return found[1].split(',').map(name => name.trim()).filter(name => name !== '');
}

/** Every installed script in a directory of its own, where the module
 * `name` lacks the export `missing`: the whole module stands beside it under
 * another name and is exported again without that one. */
async function installedWithout(name, missing) {
  const all = Object.keys(await import(pathToFileURL(join(ASSETS, name)).href));
  assert.ok(all.includes(missing), `${name} exports ${missing}`);
  const dir = installed({});
  renameSync(join(dir, name), join(dir, `whole-${name}`));
  writeFileSync(join(dir, name), `export { ${all.filter(n => n !== missing).join(', ')} } from './whole-${name}';\n`);
  return dir;
}

const SESSION_START = session => ({ session_id: session, hook_event_name: 'SessionStart', source: 'startup', model: 'm' });

// A hook that loads a chain of siblings names the stale one, not the sibling
// that then fails to link against it.
for (const [hook, importers, payload] of [
  ['tool-gate.mjs', ['harness-log.mjs', 'harness-gates.mjs'], PAYLOADS['tool-gate.mjs']],
  ['session-log.mjs', ['harness-log.mjs', 'harness-seal.mjs'], SESSION_START],
]) {
  test(`${hook} beside a harness-redact.mjs lacking a name another sibling imports names harness-redact.mjs`, async () => {
    const names = [...new Set(importers.flatMap(importer => importedFrom(importer, 'harness-redact.mjs')))];
    assert.ok(names.length > 0);
    for (const name of names) {
      const dir = await installedWithout('harness-redact.mjs', name);
      const root = project();
      setEnabled(root, true);
      const notice = said(runHook(dir, hook, root, payload(`lacks-${name}`)), hook);
      assert.match(notice ?? '', /\.claude\/scripts\/harness-redact\.mjs is older than this hook and lacks what it needs/, `${hook} without ${name}`);
    }
  });
}

test('session-log beside a harness-log.mjs lacking a name harness-seal.mjs imports names harness-log.mjs', async () => {
  for (const name of importedFrom('harness-seal.mjs', 'harness-log.mjs')) {
    const dir = await installedWithout('harness-log.mjs', name);
    const root = project();
    setEnabled(root, true);
    const notice = said(runHook(dir, 'session-log.mjs', root, SESSION_START(`log-lacks-${name}`)), 'session-log.mjs');
    assert.match(notice ?? '', /\.claude\/scripts\/harness-log\.mjs is older than this hook and lacks what it needs/, `without ${name}`);
  }
});

test('session-log beside a harness-redact.mjs without the marker helpers is silent on every event but a session start', () => {
  // Without the marker helpers a notice cannot be made once-only, and this
  // hook runs on every event, so only the event that opens a session says it.
  const dir = installed({ 'harness-redact.mjs': 'export const projectRoot = () => process.cwd();\n' });
  const root = project();
  assert.equal(said(runHook(dir, 'session-log.mjs', root, PAYLOADS['session-log.mjs']('nomark-1')), 'session-log.mjs'), null);
  const start = { session_id: 'nomark-1', hook_event_name: 'SessionStart', source: 'startup' };
  assert.match(said(runHook(dir, 'session-log.mjs', root, start), 'session-log.mjs'), /harness-redact\.mjs is older than this hook/);
});

test('session-log beside a harness-seal.mjs that is older or missing records the event and says so once per session', () => {
  const start = session => ({ session_id: session, hook_event_name: 'SessionStart', source: 'startup', model: 'm' });
  for (const [seal, problem] of [['export const sealClosedSessions = () => ({});\n', 'is older than this hook and lacks what it needs'], [null, 'is missing or cannot be loaded']]) {
    const dir = installed({ 'harness-seal.mjs': seal });
    const root = project();
    setEnabled(root, true);
    const first = said(runHook(dir, 'session-log.mjs', root, start('seal-1')), 'session-log.mjs');
    assert.match(first, new RegExp(`^kh-harness session-log: \\.claude/scripts/harness-seal\\.mjs ${problem}, so sessions are not sealed and old content is not expired`));
    assert.equal(said(runHook(dir, 'session-log.mjs', root, start('seal-1')), 'session-log.mjs'), null, 'once per session');
    assert.deepEqual(readEvents(root, 'seal-1').events.filter(e => e.type === 'SessionStart').length, 2, 'the events are still recorded');
  }
});
