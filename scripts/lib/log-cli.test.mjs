// scripts/lib/log-cli.test.mjs
//
// Every test runs against a temporary KH_DATA_DIR, so nothing here reads or
// writes the real `~/.claude/kh-harness` or the real `~/.claude`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

import { appendEvent, isEnabled, repoDataDir, sessionFileName, setEnabled, storeBlob } from '../../assets/scripts/harness-log.mjs';
import { SEAL_IDLE_MS, sealClosedSessions } from '../../assets/scripts/harness-seal.mjs';
import { EXIT_CODES, LOG_USAGE } from './cli.mjs';
import { logStatus, SESSION_LOG_SCRIPT } from './log-lib.mjs';

const LOG = resolve(import.meta.dirname, '..', 'log.mjs');

const made = [];
const tempDir = prefix => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const DATA_ROOT = tempDir('hk-logcli-data-');
process.env.KH_DATA_DIR = DATA_ROOT;

const DAY_MS = 86_400_000;
const MINUTE_MS = 60_000;

/** A project root that is its own repository, so the key never depends on
 * what lies above the temp directory. */
function project() {
  const d = tempDir('hk-logcli-repo-');
  mkdirSync(join(d, '.git'));
  return d;
}

const runLog = (...args) => spawnSync(process.execPath, [LOG, ...args], { encoding: 'utf8', env: { ...process.env, KH_DATA_DIR: DATA_ROOT } });

const sessionFile = (root, id) => join(repoDataDir(root), 'sessions', sessionFileName(id));
const sealedFile = (root, id) => `${sessionFile(root, id)}.gz`;

const touchAgo = (path, msAgo) => {
  const at = new Date(Date.now() - msAgo);
  utimesSync(path, at, at);
};

// Built at runtime so no fixture is a literal the repository's own sweep or
// a reader could mistake for real content.
const CANARY = ['kh', 'canary', 'do-not-print', '7f3a'].join('-');

/** A session of a prompt and a tool call that failed, every content field
 * holding the canary. */
function writeSession(root, id) {
  for (const event of [
    { type: 'SessionStart', session_id: id, source: 'startup' },
    { type: 'UserPromptSubmit', session_id: id, prompt: `please ${CANARY}` },
    { type: 'PostToolUse', session_id: id, tool: 'Bash', inputHash: 'a'.repeat(64), status: 'ok', input: { command: `echo ${CANARY}` }, output: CANARY },
    { type: 'PostToolUseFailure', session_id: id, tool: 'Bash', inputHash: 'b'.repeat(64), status: 'error', firstErrorLine: `Error: ${CANARY}`, input: { command: CANARY }, output: `Error: ${CANARY}` },
  ]) {
    assert.equal(appendEvent(root, id, event).written, true);
  }
}

/** Seals every session as if they had all been idle past the threshold. */
const sealAll = root => sealClosedSessions(root, { now: Date.now() + SEAL_IDLE_MS + MINUTE_MS });

/** Every file under `dir`, by relative path, with its bytes. */
function snapshot(dir) {
  const files = {};
  const walk = rel => {
    for (const entry of readdirSync(join(dir, rel), { withFileTypes: true })) {
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else files[path] = readFileSync(join(dir, path)).toString('base64');
    }
  };
  walk('');
  return files;
}

const statusJson = root => {
  const r = runLog(root, 'status', '--json');
  assert.equal(r.status, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test('status on a repository with no log says so and exits 0', () => {
  const root = project();
  const r = runLog(root, 'status');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /no log/i);
  assert.ok(r.stdout.includes(repoDataDir(root)), 'it names where it looked');
  assert.equal(existsSync(repoDataDir(root)), false, 'status creates nothing');
  const json = statusJson(root);
  assert.equal(json.exists, false);
  assert.equal(json.enabled, false);
  assert.equal(json.sessions, 0);
});

test('enable says the scrub is best-effort and names the retention period', () => {
  const root = project();
  const r = runLog(root, 'enable');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(isEnabled(root), true);
  assert.ok(r.stdout.includes(repoDataDir(root)), 'where the log is kept');
  assert.match(r.stdout, /best-effort/);
  assert.match(r.stdout, /may be missed/);
  assert.match(r.stdout, /every tool call's input and output/);
  assert.match(r.stdout, /90 days/);
  assert.match(r.stdout, /structure is kept until/i);
  assert.match(r.stdout, /log\.mjs .* disable/);
  assert.match(r.stdout, /log\.mjs .* purge/);
  assert.match(r.stdout, /not registered/, 'a repository without the hook is told so');
});

test('enable names the retention period the owner configured', () => {
  const root = project();
  mkdirSync(repoDataDir(root), { recursive: true });
  writeFileSync(join(repoDataDir(root), 'config.json'), JSON.stringify({ contentRetentionDays: 30 }));
  const r = runLog(root, 'enable');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /30 days/);
});

test('enable says when the hook is already registered', () => {
  const root = project();
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude/settings.json'), JSON.stringify({
    hooks: { PreToolUse: [{ hooks: [{ type: 'command', command: 'node', args: [`\${CLAUDE_PROJECT_DIR}/${SESSION_LOG_SCRIPT}`] }] }] },
  }));
  const r = runLog(root, 'enable');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /hook is registered/);
  assert.equal(statusJson(root).hookRegistered, true);
});

test('an unreadable settings file is reported as unreadable, not as unregistered', () => {
  const root = project();
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude/settings.json'), '{ not json');
  const json = statusJson(root);
  assert.equal(json.hookRegistered, null);
  assert.match(json.settingsProblem, /not valid JSON/);
  assert.match(runLog(root, 'status').stdout, /settings\.json is not valid JSON/);
});

test('disable turns the log off and keeps what it holds', () => {
  const root = project();
  setEnabled(root, true);
  writeSession(root, 's1');
  const r = runLog(root, 'disable');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(isEnabled(root), false);
  assert.equal(existsSync(sessionFile(root, 's1')), true);
  assert.match(r.stdout, /purge/);
});

test('disable on a repository with no log writes nothing', () => {
  const root = project();
  const r = runLog(root, 'disable');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(repoDataDir(root)), false);
});

test('status reports sessions, size and the date range it read', () => {
  const root = project();
  setEnabled(root, true);
  writeSession(root, 's1');
  writeSession(root, 's2');
  const json = statusJson(root);
  assert.equal(json.exists, true);
  assert.equal(json.enabled, true);
  assert.equal(json.location, repoDataDir(root));
  assert.equal(json.sessions, 2);
  assert.ok(json.bytes > 0);
  assert.ok(Date.parse(json.firstTs) <= Date.parse(json.lastTs));
  assert.equal(json.hookRegistered, false);
  assert.deepEqual(json.index, { intact: true, brokenAt: null, sessionsMissing: [], sessionsAltered: [], sessionsPending: [] });
  assert.deepEqual(json.ledger, { intact: true, brokenAt: null });
  assert.equal(json.unparseableLines, 0);
  assert.equal(json.unreadableSessions, 0);
});

test('status counts claimed and temporary files in the size it reports', () => {
  const root = project();
  writeSession(root, 's1');
  const before = statusJson(root).bytes;
  writeFileSync(`${sessionFile(root, 's1')}.sealing`, 'x'.repeat(1000));
  const json = statusJson(root);
  assert.equal(json.bytes, before + 1000);
  assert.equal(json.sessionsBeingSealed, 1);
});

test('status reports an altered session', () => {
  const root = project();
  writeSession(root, 'kept');
  writeSession(root, 'edited');
  sealAll(root);
  writeFileSync(sealedFile(root, 'edited'), gzipSync(Buffer.from('{"type":"Stop"}\n')));
  const json = statusJson(root);
  assert.equal(json.index.intact, false);
  assert.deepEqual(json.index.sessionsAltered, ['edited']);
  assert.deepEqual(json.blobSweep.skipped, true);
  assert.match(json.blobSweep.reason, /altered: edited/);
  const text = runLog(root, 'status').stdout;
  assert.match(text, /altered: edited/);
  assert.match(text, /not intact/);
});

test('status lists a pending session apart from altered ones', () => {
  const root = project();
  writeSession(root, 'p1');
  sealAll(root);
  // A run interrupted between its index append and its rename leaves the
  // sealed content in the temporary file and no sealed file.
  const sealed = sealedFile(root, 'p1');
  writeFileSync(`${sessionFile(root, 'p1')}.gz.tmp`, readFileSync(sealed));
  rmSync(sealed);
  const json = statusJson(root);
  assert.deepEqual(json.index.sessionsPending, ['p1']);
  assert.deepEqual(json.index.sessionsAltered, []);
  assert.deepEqual(json.index.sessionsMissing, []);
  assert.match(runLog(root, 'status').stdout, /pending: p1/);
});

test('status counts content past the retention period that could not be verified', () => {
  const root = project();
  mkdirSync(repoDataDir(root), { recursive: true });
  writeFileSync(join(repoDataDir(root), 'config.json'), JSON.stringify({ contentRetentionDays: 1 }));
  const old = new Date(Date.now() - 3 * DAY_MS).toISOString();
  mkdirSync(join(repoDataDir(root), 'sessions'), { recursive: true });
  // A sealed file the index does not name, holding a prompt older than the
  // period.
  writeFileSync(sealedFile(root, 'unindexed'), gzipSync(Buffer.from(`${JSON.stringify({ type: 'UserPromptSubmit', ts: old, prompt: CANARY })}\n`)));
  const json = statusJson(root);
  assert.equal(json.retentionDays, 1);
  assert.equal(json.contentPastRetentionUnverified, 1);
});

test('status reports the ledger chain', () => {
  const root = project();
  writeSession(root, 's1');
  writeFileSync(join(repoDataDir(root), 'ledger.jsonl'), '{"not":"a ledger line"}\n');
  const json = statusJson(root);
  assert.deepEqual(json.ledger, { intact: false, brokenAt: 1 });
  assert.match(runLog(root, 'status').stdout, /ledger: broken at line 1/);
});

test('status reports unparseable lines and unreadable sessions', () => {
  const root = project();
  writeSession(root, 's1');
  writeFileSync(sessionFile(root, 's1'), 'not json\n', { flag: 'a' });
  mkdirSync(join(repoDataDir(root), 'sessions'), { recursive: true });
  writeFileSync(sealedFile(root, 's2'), 'not gzip');
  const json = statusJson(root);
  assert.equal(json.unparseableLines, 1);
  assert.equal(json.unreadableSessions, 1);
});

test('status reads transcript coverage from each session start', () => {
  const root = project();
  const dir = tempDir('hk-logcli-transcript-');
  const good = join(dir, 'good.jsonl');
  writeFileSync(good, `${JSON.stringify({
    type: 'user', timestamp: '2026-11-19T10:00:00.000Z', message: { role: 'user', content: [{ type: 'text', text: '[Request interrupted by user]' }] },
  })}\n`);
  const partial = join(dir, 'partial.jsonl');
  writeFileSync(partial, '{"type":"user","mess');
  appendEvent(root, 'a', { type: 'SessionStart', session_id: 'a', transcriptPath: good });
  appendEvent(root, 'b', { type: 'SessionStart', session_id: 'b', transcriptPath: partial });
  appendEvent(root, 'c', { type: 'Stop', session_id: 'c' });
  const json = statusJson(root);
  assert.deepEqual(
    { checked: json.transcripts.checked, notChecked: json.transcripts.notChecked, interrupts: json.transcripts.interrupts, sessionsWithoutTranscript: json.transcripts.sessionsWithoutTranscript },
    { checked: 1, notChecked: 1, interrupts: 1, sessionsWithoutTranscript: 1 },
  );
  assert.match(runLog(root, 'status').stdout, /half-written/);
});

test('status names what hooks cannot see', () => {
  const root = project();
  writeSession(root, 's1');
  const json = statusJson(root);
  assert.deepEqual(json.blindSpots, ['user interrupts', 'cancelled tools', 'permission denials outside auto mode']);
  const text = runLog(root, 'status').stdout;
  for (const spot of json.blindSpots) assert.ok(text.includes(spot), spot);
  // With no data directory the blind spots still hold.
  assert.match(runLog(project(), 'status').stdout, /permission denials outside auto mode/);
});

test('status writes nothing: the data directory is byte-identical before and after', () => {
  const root = project();
  setEnabled(root, true);
  writeSession(root, 's1');
  writeSession(root, 's2');
  sealAll(root);
  writeSession(root, 's3');
  storeBlob(root, 'x'.repeat(10));
  const before = snapshot(repoDataDir(root));
  for (const args of [['status'], ['status', '--json']]) assert.equal(runLog(root, ...args).status, 0);
  logStatus(root);
  assert.deepEqual(snapshot(repoDataDir(root)), before);
  assert.equal(existsSync(join(repoDataDir(root), 'verified.json')), false, 'not even the verification cache');
});

test('--json on status prints the status object and nothing else on stdout', () => {
  const root = project();
  writeSession(root, 's1');
  const r = runLog(root, 'status', '--json');
  assert.equal(r.status, 0);
  assert.deepEqual(JSON.parse(r.stdout), JSON.parse(JSON.stringify(logStatus(root))));
});

test('no subcommand prints event content', () => {
  const root = project();
  setEnabled(root, true);
  writeSession(root, 's1');
  writeSession(root, 's2');
  sealAll(root);
  writeFileSync(sealedFile(root, 's2'), gzipSync(Buffer.from(`${JSON.stringify({ type: 'UserPromptSubmit', prompt: CANARY })}\n`)));
  writeSession(root, 's3');
  for (const args of [['status'], ['status', '--json'], ['maintain'], ['enable'], ['disable'], ['purge']]) {
    const r = runLog(root, ...args);
    assert.equal(`${r.stdout}${r.stderr}`.includes(CANARY), false, args.join(' '));
  }
});

test('maintain seals and expires what the hook would, and says what it did', () => {
  const root = project();
  setEnabled(root, true);
  mkdirSync(repoDataDir(root), { recursive: true });
  writeFileSync(join(repoDataDir(root), 'config.json'), JSON.stringify({ contentRetentionDays: 1 }));
  writeSession(root, 'old');
  touchAgo(sessionFile(root, 'old'), SEAL_IDLE_MS + MINUTE_MS);
  writeSession(root, 'live');
  const blob = storeBlob(root, 'unreferenced');
  touchAgo(join(repoDataDir(root), 'blobs', `${blob.sha256}.gz`), 2 * DAY_MS);
  const r = runLog(root, 'maintain');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /sessions sealed: 1/);
  assert.match(r.stdout, /blobs removed: 1/);
  assert.match(r.stdout, /content expired: 0/, 'the events are newer than the period');
  assert.equal(existsSync(sealedFile(root, 'old')), true);
  assert.equal(existsSync(sessionFile(root, 'live')), true, 'a session written in the last ten minutes is left');
  assert.equal(existsSync(join(repoDataDir(root), 'blobs', `${blob.sha256}.gz`)), false);
});

test('maintain expires content older than the retention period', () => {
  const root = project();
  setEnabled(root, true);
  const old = new Date(Date.now() - 100 * DAY_MS).toISOString();
  mkdirSync(join(repoDataDir(root), 'sessions'), { recursive: true });
  writeFileSync(sessionFile(root, 'aged'), `${JSON.stringify({ schema: 1, ts: old, pid: 1, type: 'UserPromptSubmit', prompt: CANARY })}\n`);
  touchAgo(sessionFile(root, 'aged'), SEAL_IDLE_MS + MINUTE_MS);
  const r = runLog(root, 'maintain');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /sessions sealed: 1/);
  assert.match(r.stdout, /content expired: 1 sessions/);
  assert.equal(r.stdout.includes(CANARY), false);
  assert.equal(statusJson(root).index.intact, true);
});

test('maintain says why the blob sweep was skipped', () => {
  const root = project();
  setEnabled(root, true);
  writeSession(root, 'edited');
  sealAll(root);
  writeFileSync(sealedFile(root, 'edited'), gzipSync(Buffer.from('{"type":"Stop"}\n')));
  const r = runLog(root, 'maintain');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /blob sweep skipped: sealed sessions do not match the index \(altered: edited\)/);
});

test('maintain refuses while the log is not enabled', () => {
  const root = project();
  writeSession(root, 's1');
  const r = runLog(root, 'maintain');
  assert.equal(r.status, 3);
  assert.match(r.stderr, /not enabled/);
});

test('purge without --yes removes nothing', () => {
  const root = project();
  setEnabled(root, true);
  writeSession(root, 's1');
  const before = snapshot(repoDataDir(root));
  const r = runLog(root, 'purge');
  assert.equal(r.status, 0, r.stderr);
  assert.ok(r.stdout.includes(repoDataDir(root)));
  assert.match(r.stdout, /sessions/);
  assert.match(r.stdout, /--yes/);
  assert.deepEqual(snapshot(repoDataDir(root)), before);
  assert.equal(isEnabled(root), true);
});

test('purge --yes removes the repository\'s data directory and nothing else', () => {
  const root = project();
  const other = project();
  setEnabled(root, true);
  writeSession(root, 's1');
  setEnabled(other, true);
  writeSession(other, 's1');
  writeFileSync(join(DATA_ROOT, 'beside.txt'), 'kept');
  const otherBefore = snapshot(repoDataDir(other));
  const r = runLog(root, 'purge', '--yes');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(existsSync(repoDataDir(root)), false);
  assert.equal(isEnabled(root), false);
  assert.equal(existsSync(DATA_ROOT), true);
  assert.equal(readFileSync(join(DATA_ROOT, 'beside.txt'), 'utf8'), 'kept');
  assert.deepEqual(snapshot(repoDataDir(other)), otherBefore);
  assert.equal(existsSync(root), true, 'the repository itself is untouched');
});

test('purge --yes with no log has nothing to remove', () => {
  const root = project();
  const r = runLog(root, 'purge', '--yes');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /nothing to purge/i);
  assert.equal(existsSync(repoDataDir(root)), false);
});

test('purge refuses a data directory that is a link, and leaves its target', () => {
  const root = project();
  const elsewhere = tempDir('hk-logcli-elsewhere-');
  writeFileSync(join(elsewhere, 'keep.txt'), 'kept');
  mkdirSync(DATA_ROOT, { recursive: true });
  symlinkSync(elsewhere, repoDataDir(root), 'junction');
  assert.equal(lstatSync(repoDataDir(root)).isSymbolicLink(), true);
  const r = runLog(root, 'purge', '--yes');
  assert.equal(r.status, 3, r.stdout);
  assert.match(r.stderr, /link/);
  assert.equal(readFileSync(join(elsewhere, 'keep.txt'), 'utf8'), 'kept');
  assert.equal(existsSync(repoDataDir(root)), true);
});

test('an unknown subcommand exits 2', () => {
  const root = project();
  for (const sub of ['report', 'stats']) {
    const r = runLog(root, sub);
    assert.equal(r.status, 2, sub);
    assert.match(r.stderr, /unknown subcommand/);
  }
});

test('a missing subcommand or path exits 2 and points at --help', () => {
  for (const args of [[], [project()]]) {
    const r = runLog(...args);
    assert.equal(r.status, 2);
    assert.match(r.stderr, /--help/);
  }
  const r = runLog(join(tempDir('hk-logcli-gone-'), 'absent'), 'status');
  assert.equal(r.status, 2);
});

test('log --help prints its usage on stdout, names every flag and subcommand, and exits 0', () => {
  for (const flag of ['--help', '-h']) {
    const r = runLog(flag);
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), LOG_USAGE.trim());
    assert.equal(r.stderr, '');
  }
  assert.ok(LOG_USAGE.includes(EXIT_CODES));
  for (const word of ['enable', 'disable', 'status', 'maintain', 'purge', '--yes', '--json']) assert.ok(LOG_USAGE.includes(word), word);
});
