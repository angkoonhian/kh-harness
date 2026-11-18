// scripts/lib/ledger.test.mjs
//
// Every test runs against a temporary KH_DATA_DIR, so nothing here reads or
// writes the real `~/.claude/kh-harness`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { repoDataDir } from '../../assets/scripts/harness-log.mjs';
import { appendLedger, LEDGER_KINDS, LEDGER_LOCK_STALE_MS, readLedger, verifyLedger } from './ledger.mjs';

const made = [];
const tempDir = prefix => {
  const d = mkdtempSync(join(tmpdir(), prefix));
  made.push(d);
  return d;
};
after(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

process.env.KH_DATA_DIR = tempDir('hk-ledger-data-');

const ledgerPath = root => join(repoDataDir(root), 'ledger.jsonl');
const sha256Hex = s => createHash('sha256').update(s, 'utf8').digest('hex');

const entry = (over = {}) => ({
  kind: 'proposed',
  learningId: 'gate-no-force-push',
  contentSha256: 'a'.repeat(64),
  evidence: { signature: 'sig-1f3a', sessions: 3, firstTs: '2026-11-01T10:00:00.000Z', lastTs: '2026-11-18T09:30:00.000Z', external: false },
  base: 'b'.repeat(64),
  learned: 'c'.repeat(64),
  approvedBy: null,
  ...over,
});

const lines = root => readFileSync(ledgerPath(root), 'utf8').split('\n').slice(0, -1);

test('LEDGER_KINDS is the fixed list of learning events', () => {
  assert.deepEqual(LEDGER_KINDS, ['proposed', 'replayed', 'rejected', 'trial', 'promoted', 'demoted', 'suspended', 'retired', 'landed', 'reverted', 'wrong']);
  assert.ok(Object.isFrozen(LEDGER_KINDS));
});

test('an appended entry chains to the previous one', () => {
  const root = tempDir('hk-ledger-repo-');
  assert.deepEqual(readLedger(root), []);
  assert.deepEqual(verifyLedger(root), { intact: true, brokenAt: null });

  appendLedger(root, entry());
  appendLedger(root, entry({ kind: 'promoted', approvedBy: 'owner', detail: 'owner approved after replay' }));
  appendLedger(root, entry({ kind: 'retired', approvedBy: `policy:${'d'.repeat(64)}` }));

  const raw = lines(root);
  const read = readLedger(root);
  assert.equal(read.length, 3);
  assert.equal(read[0].prev, null);
  assert.equal(read[1].prev, sha256Hex(raw[0]));
  assert.equal(read[2].prev, sha256Hex(raw[1]));
  assert.deepEqual(read.map(e => e.kind), ['proposed', 'promoted', 'retired']);
  assert.equal(read[1].detail, 'owner approved after replay');
  for (const e of read) assert.ok(!Number.isNaN(Date.parse(e.ts)) && e.ts === new Date(e.ts).toISOString());
  assert.deepEqual(verifyLedger(root), { intact: true, brokenAt: null });
});

test('an edited line breaks the chain at that line', () => {
  const root = tempDir('hk-ledger-repo-');
  for (const kind of ['proposed', 'replayed', 'trial', 'promoted']) appendLedger(root, entry({ kind }));
  const raw = lines(root);
  raw[1] = raw[1].replace('"replayed"', '"rejected"');
  writeFileSync(ledgerPath(root), raw.join('\n') + '\n', 'utf8');
  assert.deepEqual(verifyLedger(root), { intact: false, brokenAt: 2 });
});

test('an unparseable or unreadable line is a break at that line, never a throw', () => {
  const root = tempDir('hk-ledger-repo-');
  for (const kind of ['proposed', 'replayed', 'trial']) appendLedger(root, entry({ kind }));
  const raw = lines(root);

  writeFileSync(ledgerPath(root), [raw[0], raw[1], '{"kind":'].join('\n') + '\n', 'utf8');
  assert.deepEqual(verifyLedger(root), { intact: false, brokenAt: 3 });

  const invalidUtf8 = Buffer.concat([Buffer.from(raw[0] + '\n'), Buffer.from([0xff, 0xfe, 0x0a]), Buffer.from(raw[2] + '\n')]);
  writeFileSync(ledgerPath(root), invalidUtf8);
  assert.deepEqual(verifyLedger(root), { intact: false, brokenAt: 2 });

  writeFileSync(ledgerPath(root), [raw[0], JSON.stringify({ ...JSON.parse(raw[1]), kind: 'invented' }), raw[2]].join('\n') + '\n', 'utf8');
  assert.deepEqual(verifyLedger(root), { intact: false, brokenAt: 2 });
});

test('a removed first line is a break at line 1', () => {
  const root = tempDir('hk-ledger-repo-');
  for (const kind of ['proposed', 'replayed']) appendLedger(root, entry({ kind }));
  writeFileSync(ledgerPath(root), lines(root)[1] + '\n', 'utf8');
  assert.deepEqual(verifyLedger(root), { intact: false, brokenAt: 1 });
});

test('an append after a torn last line keeps its own line and the break stays at the torn one', () => {
  const root = tempDir('hk-ledger-repo-');
  appendLedger(root, entry());
  writeFileSync(ledgerPath(root), lines(root)[0] + '\n{"kind":"pro', 'utf8');
  appendLedger(root, entry({ kind: 'replayed' }));
  const raw = lines(root);
  assert.equal(raw.length, 3);
  assert.equal(JSON.parse(raw[2]).prev, sha256Hex('{"kind":"pro'));
  assert.deepEqual(verifyLedger(root), { intact: false, brokenAt: 2 });
});

test('an unknown kind is refused', () => {
  const root = tempDir('hk-ledger-repo-');
  assert.throws(() => appendLedger(root, entry({ kind: 'invented' })), /kind/);
  assert.throws(() => appendLedger(root, entry({ kind: undefined })), /kind/);
  assert.deepEqual(readLedger(root), []);
});

test('evidence carries counts and never content', () => {
  const root = tempDir('hk-ledger-repo-');
  const withEvidence = over => entry({ evidence: { ...entry().evidence, ...over } });
  assert.throws(() => appendLedger(root, withEvidence({ excerpt: 'git push --force origin main' })), /evidence.*excerpt/);
  assert.throws(() => appendLedger(root, withEvidence({ sessions: ['s-1', 's-2'] })), /sessions/);
  assert.throws(() => appendLedger(root, withEvidence({ sessions: -1 })), /sessions/);
  assert.throws(() => appendLedger(root, withEvidence({ external: 'no' })), /external/);
  assert.throws(() => appendLedger(root, withEvidence({ firstTs: 'yesterday' })), /firstTs/);
  const { signature: _signature, ...withoutSignature } = entry().evidence;
  assert.throws(() => appendLedger(root, entry({ evidence: withoutSignature })), /signature/);
  assert.deepEqual(readLedger(root), []);
});

test('the rest of an entry is checked against its schema', () => {
  const root = tempDir('hk-ledger-repo-');
  assert.throws(() => appendLedger(root, entry({ transcript: 'free text' })), /transcript/);
  assert.throws(() => appendLedger(root, entry({ ts: '2026-01-01T00:00:00.000Z' })), /ts/);
  assert.throws(() => appendLedger(root, entry({ prev: null })), /prev/);
  assert.throws(() => appendLedger(root, entry({ learningId: '' })), /learningId/);
  assert.throws(() => appendLedger(root, entry({ contentSha256: 'xyz' })), /contentSha256/);
  assert.throws(() => appendLedger(root, entry({ base: 7 })), /base/);
  assert.throws(() => appendLedger(root, entry({ approvedBy: 'someone' })), /approvedBy/);
  assert.throws(() => appendLedger(root, entry({ approvedBy: 'policy:' })), /approvedBy/);
  assert.throws(() => appendLedger(root, entry({ detail: 42 })), /detail/);
  assert.deepEqual(readLedger(root), []);
});

test('a lock older than the stale threshold is broken and the append succeeds', () => {
  const root = tempDir('hk-ledger-repo-');
  appendLedger(root, entry());
  const lock = `${ledgerPath(root)}.lock`;
  writeFileSync(lock, '');
  const mtimeMs = statSync(lock).mtimeMs;
  appendLedger(root, entry({ kind: 'replayed' }), { now: () => mtimeMs + LEDGER_LOCK_STALE_MS + 1000 });
  assert.equal(LEDGER_LOCK_STALE_MS, 30_000);
  assert.ok(!existsSync(lock));
  assert.deepEqual(readLedger(root).map(e => e.kind), ['proposed', 'replayed']);
  assert.deepEqual(verifyLedger(root), { intact: true, brokenAt: null });
});

test('a fresh lock held by another writer is waited for, not broken', async () => {
  const root = tempDir('hk-ledger-repo-');
  appendLedger(root, entry());
  const lock = `${ledgerPath(root)}.lock`;
  writeFileSync(lock, 'held');
  // The holder releases after 400 ms, and exits 1 if its lock was taken from
  // it in the meantime.
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    import { readFileSync, unlinkSync } from 'node:fs';
    setTimeout(() => {
      let held = false;
      try { held = readFileSync(${JSON.stringify(lock)}, 'utf8') === 'held'; } catch {}
      if (held) unlinkSync(${JSON.stringify(lock)});
      process.exit(held ? 0 : 1);
    }, 400);
  `], { stdio: 'ignore' });
  const exited = new Promise((resolve, reject) => {
    holder.on('error', reject);
    holder.on('close', resolve);
  });
  const start = Date.now();
  // One second short of stale by the clock the append is given.
  appendLedger(root, entry({ kind: 'replayed' }), { now: () => Date.now() + LEDGER_LOCK_STALE_MS - 1000 });
  assert.ok(Date.now() - start >= 300, 'the append returned before the holder released');
  assert.equal(await exited, 0);
  assert.deepEqual(readLedger(root).map(e => e.kind), ['proposed', 'replayed']);
  assert.deepEqual(verifyLedger(root), { intact: true, brokenAt: null });
});

test('twenty processes appending at once produce one intact chain', async () => {
  const root = tempDir('hk-ledger-repo-');
  const moduleUrl = pathToFileURL(join(import.meta.dirname, 'ledger.mjs')).href;
  // Each child spins until a shared instant so the appends overlap rather
  // than queue behind process start-up.
  const startAt = Date.now() + 1500;
  const child = i => `
    const { appendLedger } = await import(${JSON.stringify(moduleUrl)});
    while (Date.now() < ${startAt}) {}
    appendLedger(${JSON.stringify(root)}, ${JSON.stringify(entry({ learningId: `learning-${i}` }))});
  `;
  const run = i => new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', child(i)], { env: process.env, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    p.stderr.on('data', d => { stderr += d; });
    p.on('error', reject);
    p.on('close', code => (code === 0 ? resolve() : reject(new Error(`child ${i} exited ${code}: ${stderr}`))));
  });
  await Promise.all(Array.from({ length: 20 }, (_, i) => run(i)));

  assert.deepEqual(verifyLedger(root), { intact: true, brokenAt: null });
  const ids = readLedger(root).map(e => e.learningId).sort();
  assert.deepEqual(ids, Array.from({ length: 20 }, (_, i) => `learning-${i}`).sort());
});
