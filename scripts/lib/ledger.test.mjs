// scripts/lib/ledger.test.mjs
//
// Every test runs against a temporary KH_DATA_DIR, so nothing here reads or
// writes the real `~/.claude/kh-harness`.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { repoDataDir } from '../../assets/scripts/harness-log.mjs';
import { appendLedger, isApprover, LEDGER_KINDS, LEDGER_LOCK_STALE_MS, readLedger, verifyLedger } from './ledger.mjs';

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
  appendLedger(root, entry({ kind: 'promoted', approvedBy: 'owner', action: 'warn', detail: 'owner approved after replay' }));
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
  for (const kind of ['proposed', 'replayed', 'trial', 'demoted']) appendLedger(root, entry({ kind }));
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
  assert.throws(() => appendLedger(root, entry({ approvedBy: 'policy:abc' })), /approvedBy/);
  assert.throws(() => appendLedger(root, entry({ approvedBy: `policy:${'D'.repeat(64)}` })), /approvedBy/);
  assert.throws(() => appendLedger(root, entry({ approvedBy: `policy:${'d'.repeat(65)}` })), /approvedBy/);
  assert.throws(() => appendLedger(root, entry({ approvedBy: '' })), /approvedBy/);
  assert.throws(() => appendLedger(root, entry({ detail: 42 })), /detail/);
  assert.deepEqual(readLedger(root), []);
});

test('an approver is the owner or a policy named by its 64-hex hash', () => {
  for (const v of ['owner', `policy:${'0123456789abcdef'.repeat(4)}`]) assert.equal(isApprover(v), true, v);
  for (const v of [null, undefined, '', 'Owner', 'policy:', 'policy:abc', `policy:${'d'.repeat(63)}`, `policy:${'A'.repeat(64)}`, ` owner`, 7]) {
    assert.equal(isApprover(v), false, String(v));
  }
});

test('a promoted entry carries the action it grants, and no other kind carries one', () => {
  const root = tempDir('hk-ledger-repo-');
  for (const action of ['warn', 'block']) appendLedger(root, entry({ kind: 'promoted', approvedBy: 'owner', action }));
  assert.deepEqual(readLedger(root).map(e => e.action), ['warn', 'block']);
  assert.throws(() => appendLedger(root, entry({ kind: 'promoted', approvedBy: 'owner' })), /action/);
  assert.throws(() => appendLedger(root, entry({ kind: 'promoted', approvedBy: 'owner', action: 'observe' })), /action/);
  assert.throws(() => appendLedger(root, entry({ kind: 'demoted', action: 'warn' })), /action/);
  assert.equal(readLedger(root).length, 2);
  assert.deepEqual(verifyLedger(root), { intact: true, brokenAt: null });

  const raw = lines(root);
  writeFileSync(ledgerPath(root), [raw[0], JSON.stringify({ ...JSON.parse(raw[1]), action: 'observe' })].join('\n') + '\n', 'utf8');
  assert.deepEqual(verifyLedger(root), { intact: false, brokenAt: 2 }, 'a stored entry is held to the same rule');
});

test('a wrong entry carries the firing it marks, and no other kind carries one', () => {
  const root = tempDir('hk-ledger-repo-');
  const firing = { sessionId: 'session-1', line: 3 };
  appendLedger(root, entry({ kind: 'wrong', approvedBy: 'owner', firing }));
  assert.deepEqual(readLedger(root)[0].firing, firing);
  for (const bad of [undefined, null, {}, { sessionId: 'session-1' }, { ...firing, line: 0 }, { ...firing, line: 1.5 }, { ...firing, sessionId: '../x' }, { ...firing, extra: 1 }]) {
    assert.throws(() => appendLedger(root, entry({ kind: 'wrong', approvedBy: 'owner', firing: bad })), /firing/, JSON.stringify(bad));
  }
  assert.throws(() => appendLedger(root, entry({ kind: 'trial', firing })), /firing/);
  assert.equal(readLedger(root).length, 1);
  assert.deepEqual(verifyLedger(root), { intact: true, brokenAt: null });
});

const lockOf = root => `${ledgerPath(root)}.lock`;
const ownerLock = (pid, token) => JSON.stringify({ pid, token });
const DEAD_PID = 2 ** 30;
// A clock that moves a second each time it is read, so the five-second lock
// wait ends after a few readings instead of five real seconds.
const steppingClock = start => {
  let t = start;
  return () => (t += 1000);
};
// True while the lock is the one this process's append created, which is
// only inside the append's locked section.
const ownLockHeld = root => {
  try {
    const owner = JSON.parse(readFileSync(lockOf(root), 'utf8'));
    return owner.pid === process.pid && owner.token !== 'another-writer';
  } catch {
    return false;
  }
};

test('a lock whose writer is dead is broken and the append succeeds', () => {
  const root = tempDir('hk-ledger-repo-');
  appendLedger(root, entry());
  writeFileSync(lockOf(root), ownerLock(DEAD_PID, 'crashed-writer'));
  const probed = [];
  appendLedger(root, entry({ kind: 'replayed' }), { isAlive: pid => (probed.push(pid), pid !== DEAD_PID) });
  assert.ok(probed.includes(DEAD_PID));
  assert.ok(!existsSync(lockOf(root)));
  assert.ok(!existsSync(`${lockOf(root)}.break`));
  assert.deepEqual(readLedger(root).map(e => e.kind), ['proposed', 'replayed']);
  assert.deepEqual(verifyLedger(root), { intact: true, brokenAt: null });
});

test('a lock whose writer is alive is never broken, however old', () => {
  const root = tempDir('hk-ledger-repo-');
  appendLedger(root, entry());
  const held = ownerLock(4242, 'slow-writer');
  writeFileSync(lockOf(root), held);
  const dayAgo = new Date(Date.now() - 86_400_000);
  utimesSync(lockOf(root), dayAgo, dayAgo);
  assert.throws(
    () => appendLedger(root, entry({ kind: 'replayed' }), { now: steppingClock(Date.now()), isAlive: () => true }),
    /ledger is locked: .* \(last error EEXIST\)$/,
  );
  assert.equal(readFileSync(lockOf(root), 'utf8'), held);
  assert.deepEqual(readLedger(root).map(e => e.kind), ['proposed']);
});

test('an unreadable lock is broken only after the stale threshold', () => {
  assert.equal(LEDGER_LOCK_STALE_MS, 30_000);
  const root = tempDir('hk-ledger-repo-');
  appendLedger(root, entry());
  writeFileSync(lockOf(root), '{"pid":');
  const { mtimeMs } = statSync(lockOf(root));
  assert.throws(
    () => appendLedger(root, entry({ kind: 'replayed' }), { now: steppingClock(mtimeMs + LEDGER_LOCK_STALE_MS - 10_000) }),
    /ledger is locked/,
  );
  assert.equal(readFileSync(lockOf(root), 'utf8'), '{"pid":');
  appendLedger(root, entry({ kind: 'replayed' }), { now: () => mtimeMs + LEDGER_LOCK_STALE_MS + 1000 });
  assert.ok(!existsSync(lockOf(root)));
  assert.deepEqual(readLedger(root).map(e => e.kind), ['proposed', 'replayed']);
  assert.deepEqual(verifyLedger(root), { intact: true, brokenAt: null });
});

test('releasing does not delete a lock that another writer now holds', () => {
  const root = tempDir('hk-ledger-repo-');
  appendLedger(root, entry());
  const foreign = ownerLock(process.pid, 'another-writer');
  // The append reads its clock inside the locked section; that reading
  // stands in for another writer taking the lock over.
  const now = () => {
    if (ownLockHeld(root)) writeFileSync(lockOf(root), foreign);
    return Date.now();
  };
  assert.throws(() => appendLedger(root, entry({ kind: 'replayed' }), { now }), /ledger lock lost/);
  assert.equal(readFileSync(lockOf(root), 'utf8'), foreign);
});

test('a writer whose lock was taken away writes nothing and says the lock was lost', () => {
  const root = tempDir('hk-ledger-repo-');
  appendLedger(root, entry());
  const before = readFileSync(ledgerPath(root));
  const now = () => {
    if (ownLockHeld(root)) rmSync(lockOf(root));
    return Date.now();
  };
  assert.throws(() => appendLedger(root, entry({ kind: 'replayed' }), { now }), /^Error: ledger lock lost/);
  assert.deepEqual(readFileSync(ledgerPath(root)), before);
  assert.ok(!existsSync(lockOf(root)));
});

test('a fresh lock held by another writer is waited for, not broken', async () => {
  const root = tempDir('hk-ledger-repo-');
  appendLedger(root, entry());
  const lock = lockOf(root);
  // The holder releases after 400 ms, and exits 1 if its lock was taken from
  // it in the meantime.
  const holder = spawn(process.execPath, ['--input-type=module', '-e', `
    import { readFileSync, unlinkSync } from 'node:fs';
    setTimeout(() => {
      let held = false;
      try { held = JSON.parse(readFileSync(${JSON.stringify(lock)}, 'utf8')).token === 'holder'; } catch {}
      if (held) unlinkSync(${JSON.stringify(lock)});
      process.exit(held ? 0 : 1);
    }, 400);
  `], { stdio: 'ignore' });
  const exited = new Promise((resolve, reject) => {
    holder.on('error', reject);
    holder.on('close', resolve);
  });
  writeFileSync(lock, ownerLock(holder.pid, 'holder'));
  const start = Date.now();
  // A clock that never advances: the wait cannot time out however slowly the
  // holder starts, and the lock is judged by its live writer alone.
  appendLedger(root, entry({ kind: 'replayed' }), { now: () => 0 });
  assert.ok(Date.now() - start >= 200, 'the append returned before the holder released');
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
