// scripts/lib/transcript-reader.test.mjs
//
// Every fixture is a synthetic line of an observed shape with placeholder
// content; no line is copied from a real transcript.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { KNOWN_LINE_TYPES, readTranscript, summariseTranscripts } from './transcript-reader.mjs';

const made = [];
const tempDir = () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-transcript-'));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const transcript = lines => {
  const path = join(tempDir(), 'session.jsonl');
  writeFileSync(path, lines.map(l => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n', 'utf8');
  return path;
};

const userText = (text, ts, version = '2.1.327') => ({
  type: 'user', version, timestamp: ts, uuid: 'u-1', parentUuid: null, isSidechain: false, userType: 'external', sessionId: 's-1',
  message: { role: 'user', content: [{ type: 'text', text }] },
});
const prompt = (ts, version) => ({ ...userText('placeholder prompt', ts, version), message: { role: 'user', content: 'placeholder prompt' } });
const assistant = (ts, version = '2.1.327') => ({
  type: 'assistant', version, timestamp: ts, uuid: 'a-1', sessionId: 's-1',
  message: { role: 'assistant', content: [{ type: 'text', text: 'placeholder reply' }] },
});
const interrupt = ts => userText('[Request interrupted by user]', ts);
const toolInterrupt = ts => userText('[Request interrupted by user for tool use]', ts);
const toolResult = (text, ts) => ({
  ...userText('', ts), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't-1', content: text }] },
});

test('KNOWN_LINE_TYPES is a frozen list of the observed line types', () => {
  assert.ok(Object.isFrozen(KNOWN_LINE_TYPES));
  for (const type of ['user', 'assistant', 'system', 'attachment', 'last-prompt', 'file-history-snapshot', 'queue-operation']) {
    assert.ok(KNOWN_LINE_TYPES.includes(type), type);
  }
  assert.equal(new Set(KNOWN_LINE_TYPES).size, KNOWN_LINE_TYPES.length);
});

test('a transcript of known line types yields its interrupts', () => {
  const path = transcript([
    { type: 'permission-mode', permissionMode: 'default', sessionId: 's-1' },
    prompt('2026-11-19T10:00:00.000Z', '2.1.326'),
    assistant('2026-11-19T10:00:01.000Z', '2.1.326'),
    interrupt('2026-11-19T10:00:02.000Z'),
    toolInterrupt('2026-11-19T10:05:00.000Z'),
    toolResult('a tool printed [Request interrupted by user] in its output', '2026-11-19T10:06:00.000Z'),
    userText('quoting [Request interrupted by user] is not an interrupt', '2026-11-19T10:07:00.000Z'),
    { type: 'system', subtype: 'turn_duration', version: '2.1.327', timestamp: '2026-11-19T10:08:00.000Z', durationMs: 1 },
    { type: 'ai-title', aiTitle: 'placeholder', sessionId: 's-1' },
  ]);
  assert.deepEqual(readTranscript(path), {
    status: 'ok',
    claudeCodeVersion: '2.1.327',
    interrupts: [{ ts: '2026-11-19T10:00:02.000Z' }, { ts: '2026-11-19T10:05:00.000Z' }],
    unknownLineTypes: [],
  });
});

test('a transcript whose lines carry no version reports the version as null', () => {
  const path = transcript([{ type: 'ai-title', aiTitle: 'placeholder', sessionId: 's-1' }]);
  assert.deepEqual(readTranscript(path), { status: 'ok', claudeCodeVersion: null, interrupts: [], unknownLineTypes: [] });
});

test('one unknown line type makes the whole session not-checked and names the type', () => {
  const path = transcript([
    interrupt('2026-11-19T10:00:00.000Z'),
    { type: 'future-line-kind', sessionId: 's-1' },
    interrupt('2026-11-19T10:01:00.000Z'),
    { type: 'other-future-kind', sessionId: 's-1' },
    { type: 'future-line-kind', sessionId: 's-1' },
  ]);
  const r = readTranscript(path);
  assert.equal(r.status, 'not-checked');
  assert.deepEqual(r.unknownLineTypes, ['future-line-kind', 'other-future-kind']);
  assert.deepEqual(r.interrupts, [], 'an interrupt seen before the unknown type is not reported either');
  assert.match(r.reason, /future-line-kind/);
  assert.equal(r.claudeCodeVersion, '2.1.327');
});

test('a line that is not JSON, or has no string type, makes the session not-checked', () => {
  for (const bad of ['{"type":"user","message":', '[]', '{"type":3}', '{"sessionId":"s-1"}', '']) {
    const path = transcript([interrupt('2026-11-19T10:00:00.000Z'), bad, assistant('2026-11-19T10:00:01.000Z')]);
    const r = readTranscript(path);
    assert.equal(r.status, 'not-checked', JSON.stringify(bad));
    assert.match(r.reason, /line 2/, JSON.stringify(bad));
    assert.deepEqual(r.interrupts, []);
  }
});

test('an interrupt without a timestamp makes the session not-checked', () => {
  const { timestamp, ...noTs } = interrupt('2026-11-19T10:00:00.000Z');
  const r = readTranscript(transcript([noTs]));
  assert.equal(r.status, 'not-checked');
  assert.match(r.reason, /line 1/);
  assert.deepEqual(r.interrupts, []);
});

test('an unreadable file is not-checked', () => {
  const missing = readTranscript(join(tempDir(), 'absent.jsonl'));
  assert.equal(missing.status, 'not-checked');
  assert.match(missing.reason, /ENOENT/);
  assert.deepEqual({ ...missing, reason: undefined }, { status: 'not-checked', reason: undefined, claudeCodeVersion: null, interrupts: [], unknownLineTypes: [] });

  const directory = readTranscript(tempDir());
  assert.equal(directory.status, 'not-checked');
  assert.match(directory.reason, /EISDIR|EPERM|EACCES/);
});

test('a transcript is read in bounded chunks, so lines span chunk boundaries', () => {
  const big = { ...assistant('2026-11-19T10:00:00.000Z'), message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(3 * 1024 * 1024 + 17) }] } };
  const lines = [];
  for (let i = 0; i < 5; i++) lines.push(big, interrupt(`2026-11-19T10:0${i}:00.000Z`));
  const r = readTranscript(transcript(lines));
  assert.equal(r.status, 'ok');
  assert.equal(r.interrupts.length, 5);
  assert.deepEqual(r.interrupts.at(-1), { ts: '2026-11-19T10:04:00.000Z' });
});

test('a last line without its newline is still read', () => {
  const path = join(tempDir(), 'session.jsonl');
  writeFileSync(path, `${JSON.stringify(assistant('2026-11-19T10:00:00.000Z'))}\n${JSON.stringify(interrupt('2026-11-19T10:00:01.000Z'))}`, 'utf8');
  assert.deepEqual(readTranscript(path).interrupts, [{ ts: '2026-11-19T10:00:01.000Z' }]);
});

test('summariseTranscripts counts sessions checked and not, interrupts in checked ones, and every unknown type', () => {
  const checked = transcript([interrupt('2026-11-19T10:00:00.000Z'), toolInterrupt('2026-11-19T10:01:00.000Z')]);
  const alsoChecked = transcript([interrupt('2026-11-19T11:00:00.000Z')]);
  const unknown = transcript([interrupt('2026-11-19T12:00:00.000Z'), { type: 'zeta-kind' }, { type: 'alpha-kind' }]);
  const unknownAgain = transcript([{ type: 'alpha-kind' }]);
  const missing = join(tempDir(), 'absent.jsonl');
  assert.deepEqual(summariseTranscripts([checked, alsoChecked, unknown, unknownAgain, missing]), {
    checked: 2,
    notChecked: 3,
    interrupts: 3,
    unknownLineTypes: ['alpha-kind', 'zeta-kind'],
  });
  assert.deepEqual(summariseTranscripts([]), { checked: 0, notChecked: 0, interrupts: 0, unknownLineTypes: [] });
});
