// scripts/lib/log-cli.test.mjs
//
// `log` as a command, and its enable, disable and status subcommands. Every
// test runs against the temporary KH_DATA_DIR `log-fixtures.mjs` sets, so
// nothing here reads or writes the real `~/.claude`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, linkSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { appendEvent, isEnabled, repoDataDir, setEnabled, storeBlob } from '../../assets/scripts/harness-log.mjs';
import { LOGGED_EVENTS } from '../../assets/scripts/session-log.mjs';
import { EXIT_CODES, LOG_USAGE } from './cli.mjs';
import {
  CANARY, DATA_ROOT, DAY_MS, project, runLog, sealAll, sealedFile, sessionFile, snapshot, statusJson, tempDir, touchAgo, writeSession,
} from './log-fixtures.mjs';
import { logStatus, SESSION_LOG_SCRIPT } from './log-lib.mjs';

const INTACT = { intact: true, brokenAt: null, sessionsMissing: [], sessionsAltered: [], sessionsPending: [], unreadable: false, tornTail: false };

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
  assert.match(r.stdout, /is removed once a session's last event is 90 days old/);
  assert.match(r.stdout, /only from a session that has been sealed and still matches the index/);
  assert.match(r.stdout, /only when a session starts while the log is enabled or `maintain` is run/);
  assert.match(r.stdout, /`status` counts the sessions past the period and says why/);
  assert.doesNotMatch(r.stdout, /is kept for 90 days and then removed/, 'the unconditional promise is gone');
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

/** Registers the logging hook on `events` in the project's settings. */
function registerHook(root, events) {
  const entry = [{ hooks: [{ type: 'command', command: 'node', args: [`\${CLAUDE_PROJECT_DIR}/${SESSION_LOG_SCRIPT}`] }] }];
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude/settings.json'), JSON.stringify({ hooks: Object.fromEntries(events.map(event => [event, entry])) }));
}

test('enable says recording starts only when the hook is registered on every logged event', () => {
  const root = project();
  registerHook(root, LOGGED_EVENTS);
  const r = runLog(root, 'enable');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`The hook is registered on all ${LOGGED_EVENTS.length} logged events in \\.claude/settings\\.json: recording starts with the next event\\.`));
  const json = statusJson(root);
  assert.equal(json.hookRegistered, true);
  assert.deepEqual(json.hookEvents, { registered: LOGGED_EVENTS.length, logged: LOGGED_EVENTS.length });
  assert.match(runLog(root, 'status').stdout, new RegExp(`the hook is registered on all ${LOGGED_EVENTS.length} logged events`));
});

test('a hook registered on some of the logged events is said to record only those', () => {
  const root = project();
  registerHook(root, ['PreToolUse', 'Stop', 'Notification']);
  const r = runLog(root, 'enable');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, new RegExp(`The hook is registered on 2 of the ${LOGGED_EVENTS.length} logged events in \\.claude/settings\\.json: only those are recorded until \`apply\` registers the rest\\.`));
  assert.doesNotMatch(r.stdout, /recording starts with/);
  const json = statusJson(root);
  assert.equal(json.hookRegistered, false, 'not on every event');
  assert.deepEqual(json.hookEvents, { registered: 2, logged: LOGGED_EVENTS.length });
  assert.match(runLog(root, 'status').stdout, new RegExp(`the hook is registered on 2 of the ${LOGGED_EVENTS.length} logged events`));
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

test('an unexpected failure is one line and exit 2', () => {
  const root = project();
  // A directory where the enablement record belongs cannot be written.
  mkdirSync(join(repoDataDir(root), 'enabled.json'), { recursive: true });
  const r = runLog(root, 'enable');
  assert.equal(r.status, 2);
  assert.equal(r.stderr.trim().split('\n').length, 1, r.stderr);
  assert.match(r.stderr, /enable failed/);
  assert.equal(r.stdout, '');
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

test('disable and enable refuse a data directory that is a link, and write nothing through it', () => {
  const root = project();
  const elsewhere = tempDir('hk-log-elsewhere-');
  mkdirSync(DATA_ROOT, { recursive: true });
  symlinkSync(elsewhere, repoDataDir(root), 'junction');
  for (const sub of ['disable', 'enable']) {
    const r = runLog(root, sub);
    assert.equal(r.status, 3, `${sub}: ${r.stdout}`);
    assert.match(r.stderr, /link/);
  }
  assert.deepEqual(snapshot(elsewhere), {});
});

test('disable replaces an enabled record hard-linked to another file, and refuses one that is a symbolic link', t => {
  const root = project();
  setEnabled(root, true);
  const elsewhere = tempDir('hk-log-elsewhere-');
  const record = join(repoDataDir(root), 'enabled.json');
  const other = join(elsewhere, 'other.json');
  writeFileSync(other, '{"enabled":true}');
  rmSync(record);
  linkSync(other, record);
  const replaced = runLog(root, 'disable');
  assert.equal(replaced.status, 0, replaced.stderr);
  assert.equal(readFileSync(other, 'utf8'), '{"enabled":true}', 'the other file is not written through');
  assert.equal(isEnabled(root), false);

  rmSync(record);
  try {
    symlinkSync(other, record, 'file');
  } catch (error) {
    t.skip(`this account cannot create a file link (${error.code})`);
    return;
  }
  const refused = runLog(root, 'disable');
  assert.equal(refused.status, 3, refused.stdout);
  assert.match(refused.stderr, /enabled\.json is a link/);
  assert.equal(readFileSync(other, 'utf8'), '{"enabled":true}');
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
  assert.deepEqual(json.index, INTACT);
  assert.deepEqual(json.ledger, { intact: true, brokenAt: null });
  assert.equal(json.unparseableLines, 0);
  assert.equal(json.unreadableSessions, 0);
});

test('status does not call unsealed sessions verified', () => {
  const root = project();
  writeSession(root, 's1');
  writeSession(root, 's2');
  const json = statusJson(root);
  assert.deepEqual([json.sealedSessions, json.unsealedSessions], [0, 2]);
  const text = runLog(root, 'status').stdout;
  assert.match(text, /no session is sealed yet, so nothing has been verified/);
  assert.match(text, /sealed: 0, with events not yet sealed: 2/);
});

test('status says how many sealed sessions an intact index covers', () => {
  const root = project();
  writeSession(root, 's1');
  writeSession(root, 's2');
  sealAll(root);
  writeSession(root, 's3');
  const json = statusJson(root);
  assert.deepEqual([json.sealedSessions, json.unsealedSessions], [2, 1]);
  assert.match(runLog(root, 'status').stdout, /each of the 2 sealed sessions matches it; events not yet sealed, in 1 sessions, are not checked/);
});

test('status reports counts it could not read as not read when the sessions directory cannot be listed', () => {
  const root = project();
  mkdirSync(repoDataDir(root), { recursive: true });
  // A file where the sessions directory belongs cannot be listed.
  writeFileSync(join(repoDataDir(root), 'sessions'), 'not a directory');
  const json = statusJson(root);
  assert.equal(json.sessionsUnlistable, true);
  for (const field of ['sessions', 'sealedSessions', 'unsealedSessions', 'unparseableLines', 'unreadableSessions', 'transcripts']) {
    assert.equal(json[field], null, field);
  }
  const text = runLog(root, 'status').stdout;
  assert.match(text, /unparseable lines: not read/);
  assert.match(text, /unreadable sessions: not read/);
  assert.match(text, /no sealed session was verified/);
  assert.doesNotMatch(text, /index: intact/);
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

test('status names a session larger than it reads', () => {
  const root = project();
  writeSession(root, 's1');
  appendEvent(root, 'big', { type: 'Stop', pad: 'x'.repeat(6000) });
  process.env.KH_LOG_MAX_FILE_BYTES = '4000';
  let json;
  let text;
  try {
    json = statusJson(root);
    text = runLog(root, 'status').stdout;
  } finally {
    delete process.env.KH_LOG_MAX_FILE_BYTES;
  }
  assert.deepEqual(json.sessionsOverLimit, ['big']);
  assert.equal(json.unreadableSessions, 1);
  assert.match(text, /sessions larger than this command reads, counted as unreadable and not sealed or expired: big/);
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
  assert.match(text, /blob sweep: blocked, so content held in blobs is not being expired: sealed sessions do not match the index \(altered: edited\)/);
});

test('status says a chain broken between lines does not stop blob content expiring while the sealed files match', () => {
  const root = project();
  writeSession(root, 's1');
  writeSession(root, 's2');
  sealAll(root);
  const index = join(repoDataDir(root), 'index.jsonl');
  const [first, second] = readFileSync(index, 'utf8').split('\n');
  writeFileSync(index, `${first}\n{"torn\n${second}\n`);
  const json = statusJson(root);
  assert.equal(json.index.brokenAt, 2);
  assert.deepEqual(json.blobSweep, { skipped: false, reason: null });
  const text = runLog(root, 'status').stdout;
  assert.match(text, /chain broken at line 2/);
  assert.match(text, /blob sweep: not blocked; every sealed session matches its latest index line/);
});

test('status says an unfinished last index line is not damage', () => {
  const root = project();
  writeSession(root, 's1');
  sealAll(root);
  writeFileSync(join(repoDataDir(root), 'index.jsonl'), '{"sessionId":"s2","sh', { flag: 'a' });
  const json = statusJson(root);
  assert.deepEqual(json.index, { ...INTACT, tornTail: true });
  const text = runLog(root, 'status').stdout;
  assert.match(text, /index: intact/);
  assert.match(text, /the index ends in an unfinished line, left by an interrupted append; the next maintenance run removes it, and it is not damage/);
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

/** A sealed session file holding one prompt from three days ago, with a
 * one-day retention period. */
function oldSealedSession(root, id) {
  mkdirSync(join(repoDataDir(root), 'sessions'), { recursive: true });
  writeFileSync(join(repoDataDir(root), 'config.json'), JSON.stringify({ contentRetentionDays: 1 }));
  const old = new Date(Date.now() - 3 * DAY_MS).toISOString();
  writeFileSync(sealedFile(root, id), gzipSync(Buffer.from(`${JSON.stringify({ type: 'UserPromptSubmit', ts: old, prompt: CANARY })}\n`)));
}

const NONE_PAST = { sessions: 0, notSealed: 0, awaitingMaintenance: 0, unverifiable: 0, unreadable: 0 };

test('status counts content past the retention period that could not be verified', () => {
  const root = project();
  oldSealedSession(root, 'unindexed');
  const json = statusJson(root);
  assert.equal(json.retentionDays, 1);
  assert.deepEqual(json.contentPastRetention, { ...NONE_PAST, sessions: 1, unverifiable: 1 });
});

test('status counts every session holding content past the period, sealed or not, with the reason, on a disabled log too', () => {
  const root = project();
  const old = new Date(Date.now() - 3 * DAY_MS).toISOString();
  const prompt = (ts, text = CANARY) => `${JSON.stringify({ schema: 1, ...(ts === null ? {} : { ts }), pid: 1, type: 'UserPromptSubmit', prompt: text })}\n`;
  mkdirSync(join(repoDataDir(root), 'sessions'), { recursive: true });
  writeFileSync(sessionFile(root, 'sealed-old'), prompt(old));
  sealAll(root);
  oldSealedSession(root, 'unindexed');
  writeFileSync(sessionFile(root, 'plain-old'), prompt(old));
  writeFileSync(sessionFile(root, 'resumed'), prompt(old) + prompt(new Date().toISOString()));
  writeFileSync(sessionFile(root, 'timeless'), prompt(null));
  writeFileSync(sessionFile(root, 'structure-only'), `${JSON.stringify({ schema: 1, ts: old, pid: 1, type: 'Stop' })}\n`);
  writeFileSync(sealedFile(root, 'bad-gz'), 'not gzip');
  touchAgo(sealedFile(root, 'bad-gz'), 3 * DAY_MS);
  writeSession(root, 'fresh');

  const json = statusJson(root);
  assert.equal(json.enabled, false);
  assert.deepEqual(json.contentPastRetention, { sessions: 4, notSealed: 1, awaitingMaintenance: 1, unverifiable: 1, unreadable: 1 });
  assert.equal(json.contentWithoutTime, 1);
  const text = runLog(root, 'status').stdout;
  assert.match(text, /content is removed once a session's last event is 1 days old/);
  assert.match(text, /the log is disabled, so no session start seals or expires anything; `maintain` still does/);
  assert.match(text, /sessions holding content past the period: 4/);
  assert.match(text, /not yet sealed, which `maintain` seals and then expires: 1/);
  assert.match(text, /sealed, waiting for a session start or `maintain`: 1/);
  assert.match(text, /kept, because the sealed file does not match the index or the index cannot be read: 1/);
  assert.match(text, /unreadable, judged by the file's age: 1/);
  assert.match(text, /sessions holding content whose events carry no time, which never expire: 1/);
  assert.equal(text.includes(CANARY), false);
});

test('status says nothing is past the period when nothing is', () => {
  const root = project();
  setEnabled(root, true);
  writeSession(root, 'fresh');
  const json = statusJson(root);
  assert.deepEqual(json.contentPastRetention, NONE_PAST);
  assert.equal(json.contentWithoutTime, 0);
  const text = runLog(root, 'status').stdout;
  assert.match(text, /sessions holding content past the period: 0/);
  assert.doesNotMatch(text, /the log is disabled/);
});

test('an unreadable index is reported as unreadable, not as a broken chain, and its old content as unverified', () => {
  const root = project();
  oldSealedSession(root, 'aged');
  // A directory where the index belongs cannot be read as a file.
  mkdirSync(join(repoDataDir(root), 'index.jsonl'));
  const json = statusJson(root);
  assert.equal(json.index.unreadable, true);
  assert.equal(json.index.brokenAt, null);
  assert.deepEqual(json.contentPastRetention, { ...NONE_PAST, sessions: 1, unverifiable: 1 });
  assert.equal(json.blobSweep.reason, 'the index could not be read');
  const text = runLog(root, 'status').stdout;
  assert.match(text, /index: could not be read/);
  assert.doesNotMatch(text, /chain broken/);
});

test('status reports the ledger chain', () => {
  const root = project();
  writeSession(root, 's1');
  writeFileSync(join(repoDataDir(root), 'ledger.jsonl'), '{"not":"a ledger line"}\n');
  const json = statusJson(root);
  assert.deepEqual(json.ledger, { intact: false, brokenAt: 1 });
  assert.match(runLog(root, 'status').stdout, /ledger: broken at line 1/);
});

test('status does not call a ledger that does not exist intact', () => {
  const root = project();
  writeSession(root, 's1');
  const json = statusJson(root);
  assert.deepEqual(json.ledger, { intact: true, brokenAt: null });
  assert.equal(json.ledgerEntries, 0);
  const text = runLog(root, 'status').stdout;
  assert.match(text, /ledger: no entry yet, so there is no chain to check/);
  assert.doesNotMatch(text, /ledger: intact/);
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
  const dir = tempDir('hk-log-transcript-');
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
  assert.deepEqual(json.transcripts, { checked: 1, notChecked: 1, interrupts: 1, unknownLineTypes: 0, skipped: 0, sessionsWithoutTranscript: 1 });
  assert.match(runLog(root, 'status').stdout, /half-written/);
});

test('a transcript path that is relative or not a regular file is skipped, and no transcript string is printed', () => {
  const root = project();
  const dir = tempDir('hk-log-transcript-');
  const strange = join(dir, 'strange.jsonl');
  writeFileSync(strange, `${JSON.stringify({ type: CANARY })}\n`);
  appendEvent(root, 'a', { type: 'SessionStart', session_id: 'a', transcriptPath: 'relative/transcript.jsonl' });
  appendEvent(root, 'b', { type: 'SessionStart', session_id: 'b', transcriptPath: dir });
  appendEvent(root, 'c', { type: 'SessionStart', session_id: 'c', transcriptPath: strange });
  const json = statusJson(root);
  assert.deepEqual(json.transcripts, { checked: 0, notChecked: 1, interrupts: 0, unknownLineTypes: 1, skipped: 2, sessionsWithoutTranscript: 0 });
  for (const args of [['status'], ['status', '--json']]) {
    const r = runLog(root, ...args);
    assert.equal(`${r.stdout}${r.stderr}`.includes(CANARY), false, args.join(' '));
  }
  assert.match(runLog(root, 'status').stdout, /paths skipped, not absolute or not a regular file: 2/);
});

test('status names what hooks cannot see', () => {
  const root = project();
  writeSession(root, 's1');
  const json = statusJson(root);
  assert.deepEqual(json.blindSpots, [
    'an interrupt between tool calls (one while a tool runs is recorded, as an interrupted call)',
    'cancelled tools',
    'permission denials outside auto mode',
  ]);
  const text = runLog(root, 'status').stdout;
  for (const spot of json.blindSpots) assert.ok(text.includes(spot), spot);
  assert.doesNotMatch(text, /^ {2}user interrupts$/m, 'an interrupt while a tool runs is recorded, so interrupts are not unseen as a whole');
  assert.match(text, /the transcripts that could be checked count interrupts of both kinds, and nothing else listed here/);
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
  for (const args of [['status'], ['status', '--json'], ['report'], ['report', '--json'], ['maintain'], ['enable'], ['disable'], ['purge']]) {
    const r = runLog(root, ...args);
    assert.equal(`${r.stdout}${r.stderr}`.includes(CANARY), false, args.join(' '));
  }
});

test('an unknown subcommand exits 2', () => {
  const root = project();
  for (const sub of ['stats', 'learn']) {
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
  const r = runLog(join(tempDir('hk-log-gone-'), 'absent'), 'status');
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
  for (const word of ['enable', 'disable', 'status', 'report', 'maintain', 'purge', '--yes', '--json']) assert.ok(LOG_USAGE.includes(word), word);
});

test('the usage text states retention with its conditions, and what maintain needs and returns', () => {
  const usage = LOG_USAGE.replace(/\s+/g, ' ');
  assert.match(usage, /Content is removed once a session's last event is older than the retention period/);
  assert.match(usage, /only from a session that has been sealed and still matches the index/);
  assert.match(usage, /only when a session starts while the log is enabled or `maintain` is run/);
  assert.doesNotMatch(usage, /Content is kept for the retention period/);
  assert.match(usage, /It runs on a disabled log too/);
  assert.doesNotMatch(usage, /Needs the log enabled|run to the end/);
  assert.match(usage, /up to five minutes for each step/);
  assert.match(usage, /2 is also .* `maintain` when sealing, retention or the blob sweep did not run or stopped before its end/);
  assert.doesNotMatch(usage, /`maintain` on a log that is not enabled/);
});
