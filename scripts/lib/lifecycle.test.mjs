// scripts/lib/lifecycle.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sha256 } from './manifest.mjs';

const DETECT = resolve(import.meta.dirname, '..', 'detect.mjs');
const APPLY = resolve(import.meta.dirname, '..', 'apply.mjs');
const UNINSTALL = resolve(import.meta.dirname, '..', 'uninstall.mjs');

const git = (d, ...a) => execFileSync('git', ['-C', d, ...a], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
const run = (script, d, ...a) => execFileSync(process.execPath, [script, d, ...a], { encoding: 'utf8' });
const settings = d => JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
const manifestOf = d => JSON.parse(readFileSync(join(d, '.claude/harness-kit.manifest.json'), 'utf8'));

function fixture() {
  const d = mkdtempSync(join(tmpdir(), 'hk-life-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'vitest' } }));
  // Deliberately NO lockfile here (unlike most other fixtures in this
  // file): Task 8b made P2.protected's `declared` state mean OUR OWN
  // derived deny rules are present, not merely that the deny array is
  // non-empty. With a lockfile present, the pre-existing unrelated rule
  // below would make P2.protected `absent` + a NEW proposal (correctly —
  // it genuinely does not protect the lockfile), and apply would then add
  // a rule of its own here, which is a real behaviour this file already
  // covers elsewhere (STOPGATE test, LOAD-BEARING-2) but would break this
  // fixture's own point: that the user's unrelated setting is left
  // completely alone because there is nothing here to propose over it.
  writeFileSync(join(d, 'tsconfig.json'), '{}');
  mkdirSync(join(d, '.claude'), { recursive: true });
  // The user's own setting, which must survive every stage.
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Edit(secrets/**)'] } }, null, 2));
  execFileSync('git', ['init', '-q', d]);
  git(d, 'checkout', '-q', '-b', 'chore/harness');   // not a default branch
  // P4.remote must already be satisfied — this test's stage-4 assertion
  // sweeps every P4.* check, not just the two apply actually writes, and
  // apply.mjs has no generator for P4.remote (adding a remote is not
  // something the tool can do on a user's behalf). Without one, that check
  // would stay 'absent' with a proposal forever, for a reason unrelated to
  // what this test is about.
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/harness-kit-fixture.git');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return d;
}

/**
 * The fixture for this plan's own capabilities, walked through the same
 * nine stages the P4-only fixture above already proved the mechanism for.
 * Task 8's brief: a TypeScript WORKSPACE (P1.pathrules is decidable only
 * for one — see pathrules-evidence.mjs), with a lockfile (P1.bootstrap),
 * declared `lint` and `typecheck` scripts at the root (P2.sensor,
 * P2.stopgate), and a `prisma/migrations` directory (P2.protected evidence).
 *
 * The root package declares BOTH scripts; the one workspace MEMBER
 * (packages/api) declares NEITHER — real P2.scripts evidence (see the
 * check's "advice only" assertions below) that falls out of the same
 * fixture rather than needing a package of its own.
 *
 * Task 8b (coordinator ruling, after the original version of this fixture
 * had to seed the user's own settings AFTER the first apply): every
 * gap-model.mjs check this plan touches now credits `declared` only when
 * OUR OWN artefact is present — a specific resolved hook path, or OUR OWN
 * derived deny rules — never merely because the place it lives is
 * occupied by something of the user's. That fix is what makes the
 * coordinator's original ruling satisfiable: the fixture below seeds a
 * deny rule and a hook that are genuinely the USER'S OWN, unrelated to
 * anything this plan writes, BEFORE the first apply, and every one of
 * P2.sensor/P2.stopgate/P2.protected/P4.sessionbrief still goes through a
 * real absent -> proposal -> write -> declared cycle regardless (stage 1
 * proves each is still genuinely `absent`, not pre-satisfied by this
 * content).
 *
 * `Edit(secrets/**)` and `node my-own-thing.mjs` (my-own-thing.mjs is a
 * real tracked file, so its command resolves to a real path, exactly like
 * the brief's own `fixtureWithHook` example in task-8b-brief.md) are
 * deliberately unrelated to anything this repository's real evidence would
 * ever make THIS plan propose — proven by stage 1 below, not merely
 * asserted.
 */
function workspaceFixture() {
  const d = mkdtempSync(join(tmpdir(), 'hk-life-ws-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({
    name: 'app',
    workspaces: ['packages/*'],
    scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit', test: 'vitest' },
  }));
  writeFileSync(join(d, 'package-lock.json'), '{}');
  writeFileSync(join(d, 'tsconfig.json'), '{}');
  mkdirSync(join(d, 'packages/api'), { recursive: true });
  writeFileSync(join(d, 'packages/api/package.json'), JSON.stringify({ name: '@app/api', scripts: {} }));
  writeFileSync(join(d, 'packages/api/index.ts'), 'export const ok = true;\n');
  mkdirSync(join(d, 'prisma/migrations/0001_init'), { recursive: true });
  writeFileSync(join(d, 'prisma/migrations/0001_init/migration.sql'), '-- init\n');
  // The user's own deny rule and hook — present from before the FIRST
  // detect/apply call, as the coordinator originally asked. Neither
  // matches anything this plan's own generators derive for this
  // repository (stage 1 proves that), so both must survive untouched,
  // sitting beside whatever harness-kit itself adds.
  writeFileSync(join(d, 'my-own-thing.mjs'), '// the user\'s own automation, unrelated to harness-kit\n');
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({
    permissions: { deny: ['Edit(secrets/**)'] },
    hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'node my-own-thing.mjs' }] }] },
  }, null, 2));
  execFileSync('git', ['init', '-q', d]);
  git(d, 'checkout', '-q', '-b', 'chore/harness');   // not a default branch
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/harness-kit-fixture.git');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');
  return d;
}

test('LOAD-BEARING: detect -> apply -> no-op -> user edit -> drift -> uninstall', () => {
  const d = fixture();

  // 1. detect reports both continuity capabilities absent
  const before = JSON.parse(run(DETECT, d, '--json'));
  const idState = id => before.checks.find(c => c.id === id).state;
  assert.equal(idState('P4.handoff'), 'absent');
  assert.equal(idState('P4.sessionbrief'), 'absent');

  // 2. apply without --yes is a dry run: it shows and writes nothing
  const dry = run(APPLY, d);
  assert.match(dry, /HANDOFF\.md/);
  assert.equal(existsSync(join(d, 'HANDOFF.md')), false, 'the default must never write');

  // 3. apply --yes writes both files and registers the hook
  run(APPLY, d, '--yes');
  assert.ok(existsSync(join(d, 'HANDOFF.md')));
  assert.ok(existsSync(join(d, '.claude/scripts/session-brief.mjs')));
  assert.equal(settings(d).hooks.SessionStart.length, 1);
  assert.deepEqual(settings(d).permissions, { deny: ['Edit(secrets/**)'] }, 'their settings survive apply');

  // 4. THE CLOSED LOOP: what we wrote, we now recognise as present
  const after = JSON.parse(run(DETECT, d, '--json'));
  const afterState = id => after.checks.find(c => c.id === id).state;
  assert.equal(afterState('P4.handoff'), 'declared');
  assert.equal(afterState('P4.sessionbrief'), 'declared');
  assert.equal(after.checks.filter(c => c.id.startsWith('P4.') && c.proposal).length, 0);

  // apply just patched the tracked .claude/settings.json without committing
  // it — exactly what a real user does next: review the diff, then commit.
  // (HANDOFF.md and the session-brief script are new, untracked files;
  // `commit -a` only stages modifications to files already tracked, so they
  // are deliberately left alone here — the point of this commit is only to
  // clear the one pre-existing tracked file apply touched.)
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-a', '-q', '-m', 'accept harness-kit settings patch');

  // 5. applying again changes nothing
  const handoffHash = readFileSync(join(d, 'HANDOFF.md'), 'utf8');
  run(APPLY, d, '--yes');
  assert.equal(readFileSync(join(d, 'HANDOFF.md'), 'utf8'), handoffHash);
  assert.equal(settings(d).hooks.SessionStart.length, 1, 'no duplicate hook');

  // 6. the user edits what we wrote
  writeFileSync(join(d, 'HANDOFF.md'), '# My own handoff\nMid-refactor.\n');

  // 7. apply reports the drift and leaves the edit alone
  const drift = run(APPLY, d, '--yes');
  assert.equal(readFileSync(join(d, 'HANDOFF.md'), 'utf8'), '# My own handoff\nMid-refactor.\n');
  assert.match(drift, /HANDOFF\.md/);
  assert.match(drift, /modified|kept|skipped/i, 'drift must be reported, not silent');

  // 8. uninstall removes what is untouched, keeps the edit, reverts the hook
  const out = run(UNINSTALL, d, '--yes');
  assert.equal(existsSync(join(d, '.claude/scripts/session-brief.mjs')), false);
  assert.equal(readFileSync(join(d, 'HANDOFF.md'), 'utf8'), '# My own handoff\nMid-refactor.\n');
  assert.match(out, /HANDOFF\.md/, 'must say what it left behind');
  assert.equal(settings(d).hooks, undefined, 'our hook is gone');

  // 9. the user's own settings are byte-identical to where they started
  assert.deepEqual(settings(d).permissions, { deny: ['Edit(secrets/**)'] });
});

// Ruling 5: split into subtests, one per stage, rather than one flat test
// function — but ALL of them run sequentially inside ONE `test()`, sharing
// the same fixture directory and the same closed-over variables (`d`,
// `before`, `s1`, `m1`, ...) through plain JS closures. Node's test runner
// runs a parent's subtests in declaration order and waits for each `await`
// before starting the next, so stage 5 genuinely sees the repository stage
// 4 left behind, exactly as a single flat function would — the dependency
// ruling 5 warns not to lose. Splitting this way buys what a flat function
// cannot: a failing stage is reported by NAME ("5. re-apply is a no-op"),
// not by line number inside one 180-line callback.
test('LOAD-BEARING-2: every capability this plan adds, through the same nine stages, in one workspace fixture', async (t) => {
  const d = workspaceFixture();
  const find = (report, id) => report.checks.find(c => c.id === id);
  // Every capability this plan added that writes something — P2.scripts is
  // deliberately excluded (see its own stage below): it is advice-only by
  // design, and never gets a generator at all (gap-model.mjs, propose.mjs's
  // own comment on `GENERATORS`).
  const CAPS = ['P1.bootstrap', 'P1.pathrules', 'P2.sensor', 'P2.stopgate', 'P2.protected', 'P4.handoff', 'P4.sessionbrief'];
  const NEW_PATHS = [
    'HANDOFF.md',
    'scripts/bootstrap.sh',
    '.claude/rules/packages-api.md',
    '.claude/scripts/lint-touched.mjs',
    '.claude/scripts/verify-touched.mjs',
    '.claude/scripts/harness-redact.mjs',
    '.claude/scripts/session-brief.mjs',
  ];
  let s1, m1;

  await t.test('1. detect: every capability reports absent, decidable, with a proposal — even with the user\'s OWN unrelated deny rule and hook already in settings.json', () => {
    // This fixture's workspace layout, lockfile, and declared lint/typecheck
    // scripts are real evidence for every one of them (see workspaceFixture's
    // own comment for which fact backs which check). Task 8b: the pre-existing
    // `Edit(secrets/**)` deny rule and `node my-own-thing.mjs` PostToolUse hook
    // (seeded in workspaceFixture, present from BEFORE this very first detect
    // call) must NOT satisfy P2.protected/P2.sensor by themselves — this is
    // the ruling the coordinator asked for from the start, now satisfiable
    // because gap-model.mjs checks for OUR artefact, not for occupancy.
    const before = JSON.parse(run(DETECT, d, '--json'));
    for (const id of CAPS) {
      const c = find(before, id);
      assert.equal(c.state, 'absent', `${id} must be absent before apply, despite the user's own unrelated settings`);
      assert.equal(c.decidable, true, `${id} must be decidable in this fixture`);
      assert.ok(c.proposal, `${id} must carry a proposal`);
    }
    // The proposal is not suppressed by the user's own content, and it names
    // what of theirs was found — the coordinator's explicit requirement.
    assert.match(JSON.stringify(find(before, 'P2.protected').evidence), /secrets/,
      'P2.protected must name the user\'s own unrelated deny rule');
    assert.match(JSON.stringify(find(before, 'P2.sensor').evidence), /my-own-thing/,
      'P2.sensor must name the user\'s own unrelated PostToolUse hook');

    // P2.scripts: advice only. The workspace member (packages/api) declares
    // neither `lint` nor `typecheck` — real evidence for the advice, not a
    // contrived absence — while the root package's own lint+typecheck mean
    // this is NOT simply "nothing to advise about".
    const scripts0 = find(before, 'P2.scripts');
    assert.equal(scripts0.state, 'absent');
    assert.equal(scripts0.decidable, false, 'P2.scripts must never be decidable — it has no generator at all');
    assert.equal(scripts0.proposal, null, 'P2.scripts must never carry a proposal');
    assert.ok(scripts0.advice.length > 0, 'P2.scripts must carry advice naming the missing scripts');
  });

  await t.test('2. dry run writes nothing', () => {
    // settings.json already exists (the user's own content, seeded in
    // workspaceFixture) — captured before the dry run so the assertion
    // below can prove it is genuinely untouched, not merely that it exists.
    const settingsBefore = readFileSync(join(d, '.claude/settings.json'), 'utf8');
    const dry = run(APPLY, d);
    assert.match(dry, /HANDOFF\.md/);
    assert.match(dry, /scripts\/bootstrap\.sh/);
    assert.match(dry, /\.claude\/rules\/packages-api\.md/);
    assert.match(dry, /lint-touched\.mjs/);
    assert.match(dry, /verify-touched\.mjs/);
    assert.match(dry, /session-brief\.mjs/);
    for (const p of NEW_PATHS) assert.equal(existsSync(join(d, p)), false, `the default must never write ${p}`);
    assert.equal(readFileSync(join(d, '.claude/settings.json'), 'utf8'), settingsBefore,
      'the default must never write settings.json either — not even to the user\'s own, pre-existing one');
  });

  await t.test('3. apply --yes writes everything, records it in the manifest, registers every hook, and adds the deny rules', () => {
    run(APPLY, d, '--yes');
    for (const p of NEW_PATHS) assert.ok(existsSync(join(d, p)), `apply must write ${p}`);

    // The manifest must record every one of them — not just that the FILE
    // landed on disk. A generator that writes its file but skips the
    // manifest entry leaves uninstall permanently unable to remove it (see
    // manifest.mjs's own comment on `classify`), and no gap-model check in
    // this plan actually consults the manifest, so detect alone would never
    // catch that defect — only this direct read of the manifest can.
    m1 = manifestOf(d);
    for (const p of NEW_PATHS) {
      const entry = m1.files.find(f => f.path === p);
      assert.ok(entry, `the manifest must record ${p}`);
      assert.equal(entry.sha256, sha256(readFileSync(join(d, p), 'utf8')), `the manifest's hash for ${p} must match what's actually on disk`);
    }

    s1 = settings(d);
    // PostToolUse now holds TWO entries: the user's own (seeded in
    // workspaceFixture, BEFORE this apply) and ours, appended beside it —
    // exactly the "add beside their content" the coordinator's ruling
    // asked to prove. Found by content, not by a fixed index, since which
    // one apply appends after is an implementation detail, not something
    // this test should pin.
    assert.equal(s1.hooks.PostToolUse.length, 2, 'the user\'s own PostToolUse hook survives, ours is added beside it');
    const theirPostToolUse = s1.hooks.PostToolUse.find(m => m.hooks[0].command === 'node my-own-thing.mjs');
    const ourPostToolUse = s1.hooks.PostToolUse.find(m => m.hooks[0].command === 'node .claude/scripts/lint-touched.mjs');
    assert.ok(theirPostToolUse, 'the user\'s own hook must still be there');
    assert.equal(theirPostToolUse.matcher, undefined, 'their hook is untouched — it never had a matcher');
    assert.ok(ourPostToolUse, 'our hook must be registered');
    assert.equal(ourPostToolUse.matcher, 'Write|Edit');
    assert.equal(s1.hooks.Stop.length, 1, 'Stop had nothing of the user\'s — only ours');
    assert.equal(s1.hooks.SessionStart.length, 1, 'SessionStart had nothing of the user\'s — only ours');
    assert.equal(s1.hooks.Stop[0].matcher, undefined, 'the Stop entry takes no matcher');
    assert.equal(s1.hooks.Stop[0].hooks[0].command, 'node .claude/scripts/verify-touched.mjs');
    assert.equal(s1.hooks.SessionStart[0].hooks[0].command, 'node .claude/scripts/session-brief.mjs');

    // permissions.deny: the user's own `Edit(secrets/**)` survives, and
    // our own derived rules are added beside it.
    assert.ok(s1.permissions.deny.includes('Edit(secrets/**)'), 'the user\'s own deny rule survives apply');
    const ours = s1.permissions.deny.filter(r => r !== 'Edit(secrets/**)');
    assert.ok(ours.length > 0, 'apply must add protected-path deny rules beside the user\'s own');
    assert.ok(ours.every(r => r.startsWith('Edit(')), 'every added rule is an Edit(...) deny pattern');

    // P2.scripts never writes to a manifest this tool is not allowed to touch.
    assert.equal(readFileSync(join(d, 'packages/api/package.json'), 'utf8'), JSON.stringify({ name: '@app/api', scripts: {} }),
      'P2.scripts must never modify a package manifest — it is advice only');
  });

  await t.test('4. THE CLOSED LOOP: re-detect recognises everything written', () => {
    const after = JSON.parse(run(DETECT, d, '--json'));
    for (const id of CAPS) assert.equal(find(after, id).state, 'declared', `${id} must be recognised as declared once written`);
    // Scoped to CAPS, not every check in the report: P1.instructions,
    // P1.architecture and P0.recon are also `absent` with a `proposal`
    // string in this fixture (no CLAUDE.md, no ARCHITECTURE.md, no recon
    // doc) — but genuinely so, since neither apply.mjs's GENERATORS table
    // nor this plan has anything that writes them. Their proposal
    // persisting is correct, not a leak; this assertion is about the
    // capabilities THIS plan added.
    assert.equal(CAPS.filter(id => find(after, id).proposal).length, 0, 'none of this plan\'s own capabilities remains proposed');
    const scriptsAfter = find(after, 'P2.scripts');
    assert.equal(scriptsAfter.state, 'absent', 'P2.scripts is untouched by apply — still absent');
    assert.equal(scriptsAfter.proposal, null);

    // .claude/settings.json is TRACKED here (unlike the first LOAD-BEARING
    // fixture, which had no pre-existing settings.json) — apply's patch to
    // it is therefore a modification apply.mjs's own dirty-tree gate would
    // refuse on the NEXT run unless committed, exactly what a real user
    // does next: review the diff, then commit.
    git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-a', '-q', '-m', 'accept harness-kit settings patch');
  });

  await t.test('5. re-apply is a no-op', () => {
    const before2 = Object.fromEntries(NEW_PATHS.map(p => [p, readFileSync(join(d, p), 'utf8')]));
    run(APPLY, d, '--yes');
    for (const p of NEW_PATHS) assert.equal(readFileSync(join(d, p), 'utf8'), before2[p], `${p} must be byte-identical after a no-op re-apply`);
    const s2 = settings(d);
    assert.equal(s2.hooks.PostToolUse.length, 2, 'no duplicate PostToolUse hook — still exactly theirs + ours');
    assert.equal(s2.hooks.Stop.length, 1, 'no duplicate Stop hook');
    assert.equal(s2.hooks.SessionStart.length, 1, 'no duplicate SessionStart hook');
    assert.deepEqual(s2.permissions.deny, s1.permissions.deny, 'no duplicate deny rules');
  });

  await t.test('6. the user edits two of the files harness-kit wrote', () => {
    // HANDOFF.md (Plan 2's own artefact, already covered above) and
    // scripts/bootstrap.sh — a generated file from THIS plan (ruling 3: the
    // drift stage must cover one, not only HANDOFF.md).
    writeFileSync(join(d, 'HANDOFF.md'), '# My own handoff\nMid-refactor.\n');
    writeFileSync(join(d, 'scripts/bootstrap.sh'), '#!/usr/bin/env bash\necho "hand-patched bootstrap"\n');
  });

  await t.test('7. drift reported and the edit survives, on this apply AND the next one', () => {
    // Apply, then apply AGAIN, to prove this is not a one-time report but
    // holds on every subsequent run (ruling 3: "survives apply, survives
    // re-apply").
    for (let i = 0; i < 2; i++) {
      const drift = run(APPLY, d, '--yes');
      assert.equal(readFileSync(join(d, 'HANDOFF.md'), 'utf8'), '# My own handoff\nMid-refactor.\n', `HANDOFF.md edit must survive apply #${i + 1}`);
      assert.equal(readFileSync(join(d, 'scripts/bootstrap.sh'), 'utf8'), '#!/usr/bin/env bash\necho "hand-patched bootstrap"\n', `bootstrap.sh edit must survive apply #${i + 1}`);
      assert.match(drift, /HANDOFF\.md/, `apply #${i + 1} must report HANDOFF.md's drift`);
      assert.match(drift, /bootstrap\.sh/, `apply #${i + 1} must report bootstrap.sh's drift`);
      assert.match(drift, /modified|kept|skipped/i, `apply #${i + 1} must report drift, not stay silent`);
    }
  });

  let out;
  await t.test('8. uninstall removes what is untouched, keeps both edits, reverts every hook', () => {
    out = run(UNINSTALL, d, '--yes');
    for (const p of ['.claude/scripts/lint-touched.mjs', '.claude/scripts/verify-touched.mjs', '.claude/scripts/session-brief.mjs', '.claude/rules/packages-api.md']) {
      assert.equal(existsSync(join(d, p)), false, `${p} must be removed`);
    }
    // Ruling 2: the shared module is installed once (asserted at stage 3 —
    // a single file, regardless of which of P2.sensor/P2.stopgate's
    // generators happened to propose it first) and uninstall must remove it
    // too, not leave it behind. "Both hooks are registered only when it is
    // present" is the negative case — the FINDING 5 test above already
    // covers that in isolation; this is the positive half, in the full CLI
    // lifecycle.
    assert.equal(existsSync(join(d, '.claude/scripts/harness-redact.mjs')), false,
      'the shared redaction asset is removed too, not left behind');
    assert.equal(readFileSync(join(d, 'HANDOFF.md'), 'utf8'), '# My own handoff\nMid-refactor.\n', 'HANDOFF.md edit survives uninstall');
    assert.equal(readFileSync(join(d, 'scripts/bootstrap.sh'), 'utf8'), '#!/usr/bin/env bash\necho "hand-patched bootstrap"\n', 'bootstrap.sh edit survives uninstall');
    assert.match(out, /HANDOFF\.md/, 'must say what it left behind');
    assert.match(out, /bootstrap\.sh/, 'must say what it left behind for this plan\'s own artefact too');
  });

  await t.test('9. the user\'s settings are byte-identical to what they had, apart from what we added and removed', () => {
    // The round trip ruling 1 cares about most, now exercised across all
    // four settings patches (three hook events plus deny rules) — and,
    // because the user's own deny rule and hook were seeded BEFORE the
    // first apply (stage 1), this proves uninstall correctly distinguishes
    // ours from a SIBLING that was there FIRST, by hash, not by position
    // (see uninstall-lib.mjs's own comment on `revertPatch`: "index-based
    // removal would take out the wrong hook the moment the user adds one
    // of their own above ours").
    const finalSettings = settings(d);
    assert.deepEqual(finalSettings.permissions.deny, ['Edit(secrets/**)'],
      'exactly the user\'s own deny rule survives — every rule harness-kit added is gone');
    assert.equal(finalSettings.hooks.Stop, undefined, 'our Stop hook, which had no sibling, is gone entirely');
    assert.equal(finalSettings.hooks.SessionStart, undefined, 'our SessionStart hook, which had no sibling, is gone entirely');
    assert.equal(finalSettings.hooks.PostToolUse.length, 1, 'our PostToolUse hook is gone; the user\'s own, which was there FIRST, survives');
    assert.deepEqual(finalSettings.hooks.PostToolUse[0], { hooks: [{ type: 'command', command: 'node my-own-thing.mjs' }] });
  });
});

test('STOPGATE: apply installs verify-touched.mjs, the shared redaction asset, and a matcher-less Stop hook; uninstall removes all three', () => {
  // fixture() declares a `test` script and no existing Stop hook, so
  // P2.stopgate is absent and decidable — and, unlike the LOAD-BEARING test
  // above, this fixture has no `lint` script, so P2.sensor never fires.
  // That isolates this test to P2.stopgate's OWN responsibility for
  // installing (and, on uninstall, removing) the shared redaction asset —
  // see task-4 ruling 3: a shared module that apply installs but uninstall
  // leaves behind is a defect in its own right, not merely untested.
  const d = fixture();

  const before = JSON.parse(run(DETECT, d, '--json'));
  assert.equal(before.checks.find(c => c.id === 'P2.stopgate').state, 'absent');

  run(APPLY, d, '--yes');
  assert.ok(existsSync(join(d, '.claude/scripts/verify-touched.mjs')), 'the Stop gate script is installed');
  assert.ok(existsSync(join(d, '.claude/scripts/harness-redact.mjs')), 'the shared redaction asset is installed');
  const stopHooks = settings(d).hooks.Stop;
  assert.equal(stopHooks.length, 1);
  assert.equal(stopHooks[0].matcher, undefined, 'the Stop entry takes no matcher');
  assert.equal(stopHooks[0].hooks[0].command, 'node .claude/scripts/verify-touched.mjs');

  const after = JSON.parse(run(DETECT, d, '--json'));
  assert.equal(after.checks.find(c => c.id === 'P2.stopgate').state, 'declared');

  run(UNINSTALL, d, '--yes');
  assert.equal(existsSync(join(d, '.claude/scripts/verify-touched.mjs')), false, 'the Stop gate script is removed');
  assert.equal(existsSync(join(d, '.claude/scripts/harness-redact.mjs')), false,
    'the shared redaction asset is removed too, not left behind — the install/uninstall asymmetry this ruling exists to prevent');
  assert.equal(settings(d).hooks, undefined, 'the Stop hook is reverted');
});

test('FINDING 5: a settings-hook is never registered when its shared dependency is missing from disk, even though the batch plan says otherwise', () => {
  // Reproduces the review's exact Case C: P2.sensor installs
  // lint-touched.mjs + the shared harness-redact.mjs and registers a
  // PostToolUse hook. The user then deletes the shared module. A LATER
  // run, for an unrelated reason (a `typecheck` script now exists, making
  // P2.stopgate absent+decidable), proposes verify-touched.mjs and a Stop
  // settings-hook — but NOT harness-redact.mjs, because propose.mjs's own
  // "never re-propose a file already in the manifest" rule (correct for a
  // self-contained asset the user deliberately deleted) silently skips it
  // here too, even though its absence now breaks BOTH hooks. Without
  // Finding 5's fix, apply would register the Stop hook anyway, and it
  // would die with ERR_MODULE_NOT_FOUND on every single turn.
  const d = mkdtempSync(join(tmpdir(), 'hk-life-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { lint: 'eslint .' } }));
  // tsconfig.json is what tips selectProfile toward "typescript" rather
  // than "generic" — the generic profile's own appliesToSteps() excludes
  // steps 9/10 (P2.sensor/P2.stopgate) entirely, which would make this
  // fixture's checks never even get considered, for a reason unrelated to
  // what this test is about.
  writeFileSync(join(d, 'tsconfig.json'), '{}');
  mkdirSync(join(d, '.claude'), { recursive: true });
  execFileSync('git', ['init', '-q', d]);
  git(d, 'checkout', '-q', '-b', 'chore/harness');
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/harness-kit-fixture.git');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');

  // Step 1: P2.sensor installs lint-touched.mjs + harness-redact.mjs and
  // registers PostToolUse.
  run(APPLY, d, '--yes');
  assert.ok(existsSync(join(d, '.claude/scripts/lint-touched.mjs')));
  assert.ok(existsSync(join(d, '.claude/scripts/harness-redact.mjs')));
  assert.equal(settings(d).hooks.PostToolUse.length, 1);
  // `-a` would stage only MODIFICATIONS to already-tracked files; settings.json
  // here is a brand-new (untracked) file, same as HANDOFF.md/lint-touched.mjs,
  // so this needs `-A` to actually pick it up.
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'accept settings patch');

  // Step 2: the user deletes the shared module, and separately adds a
  // `typecheck` script — the unrelated change that makes P2.stopgate fire.
  rmSync(join(d, '.claude/scripts/harness-redact.mjs'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { lint: 'eslint .', typecheck: 'tsc --noEmit' } }));
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'add typecheck, delete shared module');

  // Step 3: run 2 proposes verify-touched.mjs + a Stop hook, but (per
  // propose.mjs's own manifest dedupe) NOT harness-redact.mjs.
  const out = run(APPLY, d, '--yes');
  assert.ok(existsSync(join(d, '.claude/scripts/verify-touched.mjs')), 'the Stop gate script is still written');
  assert.equal(existsSync(join(d, '.claude/scripts/harness-redact.mjs')), false,
    'sanity: the shared module genuinely was not rewritten this run — the dependency really is missing');
  assert.equal(settings(d).hooks.Stop, undefined,
    'the Stop hook must NEVER be registered while the module it imports is missing from disk');
  assert.match(out, /missing-dependency/, 'the skip must be reported, not silent');
  assert.match(out, /harness-redact\.mjs/, 'the report must name which dependency was missing');

  // The EARLIER PostToolUse hook, registered in a previous run while its
  // own dependency genuinely existed, is untouched by this run — this
  // fix only ever refuses a NEW activation, never revokes an existing one.
  assert.equal(settings(d).hooks.PostToolUse.length, 1, 'an already-registered, unrelated hook is left alone');

  // The manifest (tracked since step 1's `git add -A`) was just updated
  // in place by this run's own write of verify-touched.mjs's entry —
  // commit that before the next apply call, or it refuses on a dirty tree
  // for a reason unrelated to what this test is about.
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'record partial install');

  // Confirms this is a genuine FILESYSTEM gate, not a permanent one-way
  // block: once the dependency is back on disk (by whatever means — this
  // check only ever asks `existsSync`, never the stale manifest), the
  // very next run completes the activation the previous one correctly
  // withheld. Both file proposals are skipped on this run too (they are
  // already in the manifest from the earlier runs, so propose.mjs's own
  // dedupe never re-proposes them) — only the settings-hook proposal
  // remains, and this time its dependency check passes.
  writeFileSync(join(d, '.claude/scripts/harness-redact.mjs'), 'export const CREDENTIAL_RULES = [];\n');
  run(APPLY, d, '--yes');
  assert.equal(settings(d).hooks.Stop.length, 1,
    'once the dependency genuinely exists on disk again, activation proceeds — this is a real-state gate, not a one-way trap');
});

test('C2: a secret anywhere in settings.json reaches no part of a dry run\'s output', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-life-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'vitest' } }));
  writeFileSync(join(d, 'package-lock.json'), '{}');
  writeFileSync(join(d, 'tsconfig.json'), '{}');
  mkdirSync(join(d, '.claude'), { recursive: true });
  // A credential in `env`, and a token inside a hook command for an event
  // this run has no business touching. detect-exposure already treats both
  // of these shapes as credential carriers.
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({
    env: { DEPLOY_TOKEN: 'glpat-SECRET-IN-ENV' },
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command: "curl -H 'PRIVATE-TOKEN: ghp_SECRET_IN_HOOK' https://x.invalid" }] }],
    },
    permissions: { deny: ['Edit(secrets/**)'] },
  }, null, 2));
  execFileSync('git', ['init', '-q', d]);
  git(d, 'checkout', '-q', '-b', 'chore/harness');
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/harness-kit-fixture.git');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');

  // The default, with no --yes: the run a user gets without asking for one.
  const out = run(APPLY, d);
  assert.match(out, /SessionStart/, 'the settings proposal must still be previewed');
  assert.doesNotMatch(out, /SECRET-IN-ENV/, 'a credential in env must not reach stdout');
  assert.doesNotMatch(out, /SECRET_IN_HOOK/, 'a token in an unrelated hook command must not reach stdout');
});

test('C3: a manifest that cannot be written exits 2 with a readable message, never a stack trace', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-life-'));
  // No `test`/`typecheck` script here (deliberately): Task 4's P2.stopgate
  // generator would otherwise find evidence for a Stop-gate proposal and,
  // sorting before P4.handoff by step number (10 < 16), hit the
  // `.claude`-is-a-file write failure FIRST — before HANDOFF.md is ever
  // attempted — which is exactly the ordering this fixture must NOT have
  // (see the lockfile comment immediately below, which already documents
  // the same hazard for P2.protected).
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: {} }));
  // No lockfile here (deliberately, unlike the other fixtures in this file):
  // Task 2's P2.protected check would find evidence for a deny-rule
  // proposal and, sorting before P4.handoff by step number, hit the
  // `.claude`-is-a-file write failure FIRST — stopping the batch before
  // HANDOFF.md below is ever attempted. This test is about the
  // manifest-write failure path, not about which proposal happens to sort
  // first, so the fixture carries no protected path to propose over.
  writeFileSync(join(d, 'tsconfig.json'), '{}');
  // `.claude` as a plain file. Every write beneath it fails, including the
  // `mkdirSync` inside writeManifest — the one write in the tool that must
  // not fail silently, because a file on disk with no manifest entry is a
  // file `uninstall` can never remove.
  writeFileSync(join(d, '.claude'), 'a plain file sitting where a directory needs to go\n');
  execFileSync('git', ['init', '-q', d]);
  git(d, 'checkout', '-q', '-b', 'chore/harness');
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/harness-kit-fixture.git');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');

  let err;
  try { run(APPLY, d, '--yes'); } catch (e) { err = e; }
  assert.ok(err, 'apply must not report success when it could not record what it wrote');
  assert.equal(err.status, 2, 'the CLI contract is exit 0, 2 or 3 — never 1, never a raw throw');

  const out = String(err.stdout ?? '') + String(err.stderr ?? '');
  // The cause (`EEXIST ... mkdir '<path>'`) belongs in the message. The Node
  // frames around it do not.
  assert.doesNotMatch(out, /node:internal\/|\bat ModuleJob\b|^Node\.js v/m, 'no stack trace may reach the user');
  assert.match(out, /harness-kit\.manifest\.json/, 'the message must name the file it could not write');

  // The proposal that landed before the failure is on disk and untracked;
  // saying so is the difference between a recoverable repository and a trap.
  assert.equal(existsSync(join(d, 'HANDOFF.md')), true);
  assert.match(out, /HANDOFF\.md/, 'must name what is on disk but untracked');
});

test('C3b: with a lockfile present (the common real case), the settings-deny write fails FIRST and nothing is written at all — still exits 2 cleanly', () => {
  // Review finding: C3 above deliberately omits a lockfile so HANDOFF.md
  // (a 'file' proposal) lands before the failure, pinning "partial work is
  // reported". But virtually every real repository has a lockfile, which
  // makes P2.protected's settings-deny proposal the FIRST one attempted
  // (it sorts before P4.handoff by step number) — and that is the one that
  // fails here, so NOTHING is ever written. C3's "partial work" coverage
  // is real but now sits in the less common ordering; this test restores
  // coverage of the common ordering without reverting C3's fixture.
  const d = mkdtempSync(join(tmpdir(), 'hk-life-'));
  // No `test`/`typecheck` script (deliberately, same reason as C3 above):
  // Task 4's P2.stopgate sorts BEFORE P2.protected (step 10 < 11), and this
  // test is specifically about P2.protected's settings-deny write being the
  // first failure — a Stop-gate proposal here would shadow it by failing
  // first instead.
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: {} }));
  writeFileSync(join(d, 'package-lock.json'), '{}');
  writeFileSync(join(d, 'tsconfig.json'), '{}');
  writeFileSync(join(d, '.claude'), 'a plain file sitting where a directory needs to go\n');
  execFileSync('git', ['init', '-q', d]);
  git(d, 'checkout', '-q', '-b', 'chore/harness');
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/harness-kit-fixture.git');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');

  let err;
  try { run(APPLY, d, '--yes'); } catch (e) { err = e; }
  assert.ok(err, 'apply must not report success when it could not record what it wrote');
  assert.equal(err.status, 2, 'the CLI contract is exit 0, 2 or 3 — never 1, never a raw throw');

  const out = String(err.stdout ?? '') + String(err.stderr ?? '');
  assert.doesNotMatch(out, /node:internal\/|\bat ModuleJob\b|^Node\.js v/m, 'no stack trace may reach the user');
  assert.match(out, /\.claude[\\/]settings\.json/, 'the message must name the settings write that failed first in this ordering');

  // Nothing after the first failed write is ever attempted — the opposite
  // half of C3's "partial work" case, and the one real repos actually hit.
  assert.equal(existsSync(join(d, 'HANDOFF.md')), false, 'nothing written when the first proposal in the batch fails');
});

test('I3: a deleted settings file lets uninstall finish, clear the manifest, and exit 0', () => {
  const d = fixture();
  run(APPLY, d, '--yes');
  assert.equal(settings(d).hooks.SessionStart.length, 1);
  assert.equal(existsSync(join(d, '.claude/harness-kit.manifest.json')), true);

  // The user deletes their own settings file. No hook remains registered.
  rmSync(join(d, '.claude/settings.json'));

  const out = run(UNINSTALL, d, '--yes');               // throws on any non-zero exit
  assert.match(out, /absent/i, 'the reason must be stated, and distinguishable from unreadable');
  assert.doesNotMatch(out, /could not be read/i, 'there is no read failure here to report');
  assert.equal(existsSync(join(d, '.claude/harness-kit.manifest.json')), false,
    'the manifest must be cleared, or uninstall is impossible on every future run, forever');
});

test('I7: uninstall with no argument exits 2, never 1', () => {
  let err;
  try { execFileSync(process.execPath, [UNINSTALL], { encoding: 'utf8' }); } catch (e) { err = e; }
  assert.ok(err, 'a missing argument is still a refusal to act');
  assert.equal(err.status, 2, 'the CLI contract is exit 0, 2 or 3 — 1 means "the process crashed"');
  assert.match(String(err.stderr ?? ''), /usage/i, 'and it must say how to call it');
});

test('apply refuses on a default branch unless told otherwise', () => {
  const d = fixture();
  git(d, 'checkout', '-q', '-b', 'master');
  assert.throws(
    () => run(APPLY, d, '--yes'),
    e => e.status === 3 && /--allow-default-branch/.test(String(e.stderr ?? e.stdout)),
  );
  assert.equal(existsSync(join(d, 'HANDOFF.md')), false);
  assert.doesNotThrow(() => run(APPLY, d, '--yes', '--allow-default-branch'));
});

test('apply refuses on a dirty working tree unless told otherwise', () => {
  const d = fixture();
  writeFileSync(join(d, 'package.json'), '{"name":"edited"}');
  assert.throws(() => run(APPLY, d, '--yes'), e => e.status === 3);
  assert.doesNotThrow(() => run(APPLY, d, '--yes', '--allow-dirty'));
});

test('C4: a malformed permissions.deny does not crash the DEFAULT (dry-run) apply path', () => {
  // Reproduces the exact live crash the review found: before the
  // readSettingsResult fix, `renderSettingsDenyDiff` called `addDenyRules`
  // unguarded on `permissions.deny`, so a dry run against a settings.json
  // with a non-array deny crashed with a raw TypeError and exit 1 — on the
  // DEFAULT path (no flag needed), which is the one a cautious user
  // reaches for first.
  const d = mkdtempSync(join(tmpdir(), 'hk-life-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'vitest' } }));
  writeFileSync(join(d, 'package-lock.json'), '{}');
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ permissions: { deny: 'Edit(secrets/**)' } }));
  execFileSync('git', ['init', '-q', d]);
  git(d, 'checkout', '-q', '-b', 'chore/harness');
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/harness-kit-fixture.git');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');

  const out = run(APPLY, d); // no --yes: the default dry run
  assert.doesNotMatch(out, /node:internal\/|TypeError|\bat ModuleJob\b|^Node\.js v/m, 'no stack trace may reach the user');
  assert.match(out, /could not be parsed as a JSON object/, 'the malformed deny must be reported the same way as unparseable JSON');
});
