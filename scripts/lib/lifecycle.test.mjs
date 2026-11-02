// scripts/lib/lifecycle.test.mjs — the install and uninstall cycles, end to
// end through the real CLIs. Gates, drift and the dry run are in
// lifecycle-gates.test.mjs; review-finding regressions in
// lifecycle-regressions.test.mjs; the fixtures in lifecycle-fixtures.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256, emptyManifest } from './manifest.mjs';
// Whole-branch review, F2: the two commands can only be held to agree about
// the capabilities `apply` is actually able to write. A prompt-gated check
// (P0.recon, P1.instructions, P1.architecture) has no generator at all, so
// `detect` keeps offering "run the prompt" forever by design and `apply`
// correctly says it has nothing to do — that asymmetry is not a
// contradiction. Membership-tested against the real table rather than a
// hand-maintained id list, so a capability added later is covered with no
// test edit (same discipline as propose.test.mjs's coherence test).
import { GENERATORS } from './propose.mjs';
import { DETECT, APPLY, UNINSTALL, git, run, settings, manifestOf, fixture, workspaceFixture, freshFixtureNoClaudeDir, linesAfter } from './lifecycle-fixtures.mjs';

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
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-a', '-q', '-m', 'accept kh-harness settings patch');

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

  // 9. the user's own settings are STRUCTURALLY identical to where they
  // started (deepEqual on the parsed object — this never compared raw
  // bytes; apply rewrites the whole file via JSON.stringify(..., null, 2),
  // so whitespace/formatting can legitimately differ even when nothing of
  // the user's own content changed — see apply-lib.mjs's own note on this
  // and finding 7 of the task-8b report for why that is accepted, not fixed).
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
    // what of theirs was found — the coordinator's explicit requirement —
    // on EVERY event this plan touches, not only PostToolUse.
    assert.match(JSON.stringify(find(before, 'P2.protected').evidence), /secrets/,
      'P2.protected must name the user\'s own unrelated deny rule');
    assert.match(JSON.stringify(find(before, 'P2.sensor').evidence), /my-own-thing/,
      'P2.sensor must name the user\'s own unrelated PostToolUse hook');
    assert.match(JSON.stringify(find(before, 'P2.stopgate').evidence), /my-own-stop-thing/,
      'P2.stopgate must name the user\'s own unrelated Stop hook');
    assert.match(JSON.stringify(find(before, 'P4.sessionbrief').evidence), /my-own-startup-thing/,
      'P4.sessionbrief must name the user\'s own unrelated SessionStart hook');

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
    // Every one of the three events now holds TWO entries: the user's own
    // (seeded in workspaceFixture, BEFORE this apply) and ours, appended
    // beside it — exactly the "add beside their content" the coordinator's
    // ruling asked to prove, on all three events, not only PostToolUse
    // (finding 8: the three code paths are not identical). Found by
    // content, not by a fixed index, since which one apply appends after
    // is an implementation detail, not something this test should pin.
    assert.equal(s1.hooks.PostToolUse.length, 2, 'the user\'s own PostToolUse hook survives, ours is added beside it');
    assert.equal(s1.hooks.Stop.length, 2, 'the user\'s own Stop hook survives, ours is added beside it');
    assert.equal(s1.hooks.SessionStart.length, 2, 'the user\'s own SessionStart hook survives, ours is added beside it');

    const theirPostToolUse = s1.hooks.PostToolUse.find(m => m.hooks[0].command === 'node my-own-thing.mjs');
    const ourPostToolUse = s1.hooks.PostToolUse.find(m => m.hooks[0].args?.[0] === '${CLAUDE_PROJECT_DIR}/.claude/scripts/lint-touched.mjs');
    assert.ok(theirPostToolUse, 'the user\'s own hook must still be there');
    assert.equal(theirPostToolUse.matcher, undefined, 'their hook is untouched — it never had a matcher');
    assert.ok(ourPostToolUse, 'our hook must be registered');
    assert.equal(ourPostToolUse.matcher, 'Write|Edit');

    const theirStop = s1.hooks.Stop.find(m => m.hooks[0].command === 'node my-own-stop-thing.mjs');
    const ourStop = s1.hooks.Stop.find(m => m.hooks[0].args?.[0] === '${CLAUDE_PROJECT_DIR}/.claude/scripts/verify-touched.mjs');
    assert.ok(theirStop, 'the user\'s own Stop hook must still be there');
    assert.ok(ourStop, 'our Stop hook must be registered');
    assert.equal(ourStop.matcher, undefined, 'the Stop entry takes no matcher');

    const theirSessionStart = s1.hooks.SessionStart.find(m => m.hooks[0].command === 'node my-own-startup-thing.mjs');
    const ourSessionStart = s1.hooks.SessionStart.find(m => m.hooks[0].args?.[0] === '${CLAUDE_PROJECT_DIR}/.claude/scripts/session-brief.mjs');
    assert.ok(theirSessionStart, 'the user\'s own SessionStart hook must still be there');
    assert.ok(ourSessionStart, 'our SessionStart hook must be registered');

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
    git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-a', '-q', '-m', 'accept kh-harness settings patch');
  });

  await t.test('5. re-apply is a no-op', () => {
    const before2 = Object.fromEntries(NEW_PATHS.map(p => [p, readFileSync(join(d, p), 'utf8')]));
    run(APPLY, d, '--yes');
    for (const p of NEW_PATHS) assert.equal(readFileSync(join(d, p), 'utf8'), before2[p], `${p} must be byte-identical after a no-op re-apply`);
    const s2 = settings(d);
    assert.equal(s2.hooks.PostToolUse.length, 2, 'no duplicate PostToolUse hook — still exactly theirs + ours');
    assert.equal(s2.hooks.Stop.length, 2, 'no duplicate Stop hook — still exactly theirs + ours');
    assert.equal(s2.hooks.SessionStart.length, 2, 'no duplicate SessionStart hook — still exactly theirs + ours');
    assert.deepEqual(s2.permissions.deny, s1.permissions.deny, 'no duplicate deny rules');
  });

  await t.test('6. the user edits two of the files kh-harness wrote', () => {
    // HANDOFF.md (Plan 2's own artefact, already covered above) and
    // scripts/bootstrap.sh — a generated file from THIS plan (ruling 3: the
    // drift stage must cover one, not only HANDOFF.md).
    writeFileSync(join(d, 'HANDOFF.md'), '# My own handoff\nMid-refactor.\n');
    writeFileSync(join(d, 'scripts/bootstrap.sh'), '#!/usr/bin/env bash\necho "hand-patched bootstrap"\n');
    // Coordinator nit: a stage with no assertion of its own proves
    // nothing about ITSELF — stage 7 only proves the edit SURVIVES, which
    // says nothing if the edit never actually landed in the first place.
    assert.equal(readFileSync(join(d, 'HANDOFF.md'), 'utf8'), '# My own handoff\nMid-refactor.\n');
    assert.equal(readFileSync(join(d, 'scripts/bootstrap.sh'), 'utf8'), '#!/usr/bin/env bash\necho "hand-patched bootstrap"\n');
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

  await t.test('9. the user\'s settings are STRUCTURALLY identical to what they had, apart from what we added and removed', () => {
    // "Structurally", not byte-for-byte: this is a deepEqual on the PARSED
    // object. apply rewrites the whole file via JSON.stringify(settings,
    // null, 2), so a user whose original file was compact, differently
    // indented, or had different key order gets a reformatted file back —
    // the content is unchanged but the bytes are not. See finding 7 of the
    // task-8b report: this is a disclosed, accepted limitation (fixing it
    // needs a format-preserving JSON editor, a dependency or a parser this
    // zero-dependency project is not taking on), not something this
    // assertion was ever able to catch or that it claims to.
    //
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
      'exactly the user\'s own deny rule survives — every rule kh-harness added is gone');
    // All three events had a sibling (finding 8) — each must end with
    // exactly ONE entry left: the user's own, by hash, not by position.
    assert.equal(finalSettings.hooks.PostToolUse.length, 1, 'our PostToolUse hook is gone; the user\'s own, which was there FIRST, survives');
    assert.deepEqual(finalSettings.hooks.PostToolUse[0], { hooks: [{ type: 'command', command: 'node my-own-thing.mjs' }] });
    assert.equal(finalSettings.hooks.Stop.length, 1, 'our Stop hook is gone; the user\'s own, which was there FIRST, survives');
    assert.deepEqual(finalSettings.hooks.Stop[0], { hooks: [{ type: 'command', command: 'node my-own-stop-thing.mjs' }] });
    assert.equal(finalSettings.hooks.SessionStart.length, 1, 'our SessionStart hook is gone; the user\'s own, which was there FIRST, survives');
    assert.deepEqual(finalSettings.hooks.SessionStart[0], { hooks: [{ type: 'command', command: 'node my-own-startup-thing.mjs' }] });
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
  assert.equal(stopHooks[0].hooks[0].command, 'node');
  assert.deepEqual(stopHooks[0].hooks[0].args, ['${CLAUDE_PROJECT_DIR}/.claude/scripts/verify-touched.mjs'], 'exec form: no shell, and a path that holds from any working directory');

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
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/kh-harness-fixture.git');
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
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/kh-harness-fixture.git');
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
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/kh-harness-fixture.git');
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
  assert.match(out, /kh-harness\.manifest\.json/, 'the message must name the file it could not write');

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
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/kh-harness-fixture.git');
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

// Coordinator finding (Major): apply used to treat an unparseable manifest
// exactly like a missing one — `readManifest(root) ?? emptyManifest(...)`
// — so it silently wrote a fresh, EMPTY manifest at the end of the run,
// permanently losing the record of every file a prior install had
// written. Those files became invisible to uninstall forever, with no
// notice. Must refuse instead, exactly like the default-branch and
// dirty-tree gates: exit 3, name the file, no automatic repair.
test('apply refuses on an unparseable manifest — exit 3, names the file, and does not touch it', () => {
  const d = fixture();
  const corrupt = '{ this is not valid json, and definitely not our schema';
  writeFileSync(join(d, '.claude/kh-harness.manifest.json'), corrupt);

  let err;
  try { run(APPLY, d, '--yes'); } catch (e) { err = e; }
  assert.ok(err, 'apply must not report success when it cannot reconcile the existing install');
  assert.equal(err.status, 3, 'same CLI contract as the default-branch and dirty-tree refusals');

  const out = String(err.stdout ?? '') + String(err.stderr ?? '');
  assert.doesNotMatch(out, /node:internal\/|\bat ModuleJob\b|^Node\.js v/m, 'no stack trace may reach the user');
  assert.match(out, /kh-harness\.manifest\.json/, 'the message must name the file that could not be reconciled');

  // No automatic repair: the corrupt file is byte-for-byte untouched, and
  // nothing else was written either.
  assert.equal(readFileSync(join(d, '.claude/kh-harness.manifest.json'), 'utf8'), corrupt);
  assert.equal(existsSync(join(d, 'HANDOFF.md')), false, 'nothing is written when the run refuses this early');
});

test('I3: a deleted settings file lets uninstall finish, clear the manifest, and exit 0', () => {
  const d = fixture();
  run(APPLY, d, '--yes');
  assert.equal(settings(d).hooks.SessionStart.length, 1);
  assert.equal(existsSync(join(d, '.claude/kh-harness.manifest.json')), true);

  // The user deletes their own settings file. No hook remains registered.
  rmSync(join(d, '.claude/settings.json'));

  const out = run(UNINSTALL, d, '--yes');               // throws on any non-zero exit
  assert.match(out, /absent/i, 'the reason must be stated, and distinguishable from unreadable');
  assert.doesNotMatch(out, /could not be read/i, 'there is no read failure here to report');
  assert.equal(existsSync(join(d, '.claude/kh-harness.manifest.json')), false,
    'the manifest must be cleared, or uninstall is impossible on every future run, forever');
});

test('I7: uninstall with no argument exits 2, never 1', () => {
  let err;
  try { execFileSync(process.execPath, [UNINSTALL], { encoding: 'utf8' }); } catch (e) { err = e; }
  assert.ok(err, 'a missing argument is still a refusal to act');
  assert.equal(err.status, 2, 'the CLI contract is exit 0, 2 or 3 — 1 means "the process crashed"');
  assert.match(String(err.stderr ?? ''), /usage/i, 'and it must say how to call it');
});

// --- Audit Tier 2, finding 15: uninstall exited 0 with a hook still
// --- registered -------------------------------------------------------------
test('uninstall --yes exits 2 when a recorded hook could not be reverted, and says which', () => {
  const d = fixture();
  run(APPLY, d, '--yes');
  const s = settings(d);
  const stop = (s.hooks?.Stop ?? []).find(m => m.hooks.some(h => /verify-touched/.test(JSON.stringify(h))));
  assert.ok(stop, 'fixture sanity: our Stop hook is registered');
  stop.hooks[0].args.push('--edited-by-the-user'); // the hash no longer matches the manifest's patch record
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(s, null, 2) + '\n');

  let err;
  try { run(UNINSTALL, d, '--yes'); } catch (e) { err = e; }
  assert.ok(err, 'a hook left registered is not a clean uninstall');
  assert.equal(err.status, 2, 'exit 0 would tell a script the uninstall was complete');
  assert.match(String(err.stdout), /Could not revert:/);
  assert.match(String(err.stdout), /hooks\/Stop/);
});


test('a complete uninstall removes every directory and the empty settings.json apply itself created (Task 9b finding 4)', () => {
  const d = freshFixtureNoClaudeDir();
  assert.equal(existsSync(join(d, '.claude')), false, 'fixture sanity: no .claude/ exists before apply');

  run(APPLY, d, '--yes');
  // Fixture sanity: apply really did create all three containers, and a
  // settings.json of its own — otherwise "removes them" would be vacuous.
  assert.ok(existsSync(join(d, '.claude/settings.json')), 'fixture sanity: apply created settings.json');
  assert.ok(existsSync(join(d, '.claude/scripts')), 'fixture sanity: apply created .claude/scripts/');
  assert.ok(existsSync(join(d, 'scripts/bootstrap.sh')), 'fixture sanity: apply created scripts/');
  assert.ok(Object.keys(settings(d)).length > 0, 'fixture sanity: the created settings.json is not already empty');

  const out = run(UNINSTALL, d, '--yes');
  assert.equal(existsSync(join(d, '.claude/settings.json')), false, 'the settings.json apply created, now empty, must be removed');
  assert.equal(existsSync(join(d, '.claude/scripts')), false, 'the directory apply created must be removed once empty');
  assert.equal(existsSync(join(d, '.claude')), false, 'the directory apply created must be removed once empty');
  assert.equal(existsSync(join(d, 'scripts')), false, 'the directory apply created must be removed once empty');
  assert.match(out, /Removed/, 'the cleanup must be disclosed, not silent');
});

// Coordinator round 2, finding 1: the dry-run preview is the path a
// cautious user reaches for first, and it used to under-report what --yes
// actually does (it never predicted the settings.json/directory cleanup at
// all). This drives the REAL CLI twice — once without --yes, once with —
// on the SAME fixture, and asserts the predicted set equals the actual set,
// rather than asserting facts about each run independently.

test('PARITY: the dry-run preview predicts exactly the settings.json/directory cleanup --yes performs, through the real CLI (Task 9b, coordinator round 2 finding 1)', () => {
  const d = freshFixtureNoClaudeDir();
  run(APPLY, d, '--yes');

  const dry = run(UNINSTALL, d);
  const predictedSettings = linesAfter(dry, 'Will remove (now empty, created by kh-harness):');
  const predictedDirs = linesAfter(dry, 'Will remove empty directories it created:');
  assert.deepEqual(predictedSettings, ['.claude/settings.json'], 'fixture sanity: the dry run must predict the settings.json cleanup');
  assert.ok(predictedDirs.length > 0, 'fixture sanity: the dry run must predict at least one directory removal');

  const real = run(UNINSTALL, d, '--yes');
  const actualDirs = linesAfter(real, 'Removed empty directories it created:');
  const actuallyRemoved = linesAfter(real, 'Removed:');

  assert.deepEqual(
    predictedSettings.every(p => actuallyRemoved.includes(p)), true,
    'everything the dry run predicted for settings.json must actually have been removed',
  );
  assert.deepEqual(predictedDirs.sort(), actualDirs.sort(), 'the predicted directory set must equal the actual directory set');
});

test('a directory that existed before apply is never removed by uninstall, even once it is empty again (Task 9b finding 4)', () => {
  const d = freshFixtureNoClaudeDir();
  // The user's own, pre-existing `scripts/` directory with their own file —
  // apply must not credit itself with creating it, and uninstall must
  // never remove a directory that predates this tool.
  mkdirSync(join(d, 'scripts'), { recursive: true });
  writeFileSync(join(d, 'scripts/their-own.sh'), '#!/bin/sh\necho mine\n');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'add my own scripts dir');

  run(APPLY, d, '--yes');
  assert.ok(existsSync(join(d, 'scripts/bootstrap.sh')));
  rmSync(join(d, 'scripts/their-own.sh')); // the directory becomes empty of the user's OWN content too
  run(UNINSTALL, d, '--yes');
  assert.equal(existsSync(join(d, 'scripts')), true, 'a directory that existed before this tool ran must never be removed by it');
});

// --- Audit Tier 1, finding 4: after a CRLF conversion of the kit's own files
// --- (core.autocrlf=true on Windows), apply must still recognise them ------
test('apply after a CRLF conversion of the kit\'s own files reports no "kept (modified)"', () => {
  const d = fixture();
  run(APPLY, d, '--yes');
  const files = manifestOf(d).files.map(f => f.path);
  assert.ok(files.length >= 3, `fixture sanity: the first apply must have written several files, got ${files.length}`);
  // What a checkout with core.autocrlf=true does to every text file.
  for (const rel of files) {
    const lf = readFileSync(join(d, rel), 'utf8');
    assert.equal(lf.includes('\r'), false, `fixture sanity: the kit writes LF only (${rel})`);
    writeFileSync(join(d, rel), lf.replace(/\n/g, '\r\n'));
  }
  const out = run(APPLY, d, '--yes');
  assert.doesNotMatch(out, /kept\s+\S+ \(modified/, `a line-ending rewrite is not a user edit:\n${out}`);
  assert.match(out, /no actions/, 'nothing is left to do: every file is still recognised as ours');
});

test('a complete apply-then-uninstall cycle leaves git status clean when settings.json existed before apply (Task 9b finding 5)', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-life-cleangit-'));
  writeFileSync(join(d, 'package.json'), JSON.stringify({ name: 'app', scripts: { test: 'vitest' } }));
  mkdirSync(join(d, '.claude'), { recursive: true });
  // Pre-existing, already-tracked settings.json — LF, no trailing newline —
  // matching the real-world case (cashmigo) this finding came from, minus
  // the CRLF line-ending reformat, which remains a disclosed, un-fixed
  // limitation (see apply-lib.mjs's own ruling against a format-preserving
  // JSON editor). The trailing-newline byte is the one this fix controls.
  const original = JSON.stringify({ hooks: { SessionStart: [{ matcher: 'startup|resume|compact', hooks: [{ type: 'command', command: 'node docs/agent-context/inject.js' }] }] } }, null, 2);
  writeFileSync(join(d, '.claude/settings.json'), original); // no trailing newline, LF already
  mkdirSync(join(d, 'docs/agent-context'), { recursive: true });
  writeFileSync(join(d, 'docs/agent-context/inject.js'), '// their own hook\n');
  execFileSync('git', ['init', '-q', d]);
  git(d, 'checkout', '-q', '-b', 'chore/harness');
  git(d, 'remote', 'add', 'origin', 'https://example.invalid/kh-harness-fixture.git');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init');

  // Deliberately NOT committed in between: HANDOFF.md and the hook scripts
  // stay untracked the whole time (as they do for a real user reviewing the
  // diff before committing), so only the PRE-EXISTING tracked settings.json
  // can possibly show up in `git status` afterward — exactly the file this
  // finding is about.
  run(APPLY, d, '--yes');
  const out = run(UNINSTALL, d, '--yes');
  assert.match(out, /Removed/);

  const status = execFileSync('git', ['-C', d, 'status', '--porcelain'], { encoding: 'utf8' });
  assert.equal(status.trim(), '', `git status must be clean after the full cycle; got:\n${status}`);
});


// --- Phase 3: intent and rules, end to end ---------------------------------
//
// The registry's designed workflow is two applies with a human in between:
// apply (scaffold, empty) → the user writes rules → apply (the re-injection
// hook, decidable only once there is something to inject). This walks that
// exact sequence through the real CLIs and ends where every other lifecycle
// ends: uninstall removes what is ours and keeps what the user wrote.
test('PHASE 3 LIFECYCLE: scaffold → fill → hook → uninstall keeps the filled registry', () => {
  const d = fixture();
  const RULES = 'docs/harness/RULES.md';
  const BRIEF = '.claude/scripts/rules-brief.mjs';
  const state = (report, id) => report.checks.find(c => c.id === id);

  // 1. Nothing yet: the scaffold is proposed; the hook has nothing to inject
  // (undecidable, and NOT a question — P3.rules already says what to do);
  // the intent document is proposed because this fixture has no docs at all.
  const r1 = JSON.parse(run(DETECT, d, '--json'));
  assert.equal(state(r1, 'P3.rules').state, 'absent');
  assert.match(state(r1, 'P3.rules').proposal, /scaffold docs\/harness\/RULES\.md/);
  assert.equal(state(r1, 'P3.reinject').state, 'absent');
  assert.equal(state(r1, 'P3.reinject').decidable, false);
  assert.equal(state(r1, 'P3.reinject').question, null);
  assert.equal(state(r1, 'P3.intent').state, 'absent');
  assert.match(state(r1, 'P3.intent').proposal, /run the intent prompt/);

  // 2. apply --yes writes the scaffold and no hook.
  run(APPLY, d, '--yes');
  assert.ok(existsSync(join(d, RULES)));
  assert.match(readFileSync(join(d, RULES), 'utf8'), /Generated by kh-harness/);
  assert.equal(existsSync(join(d, BRIEF)), false, 'no hook until there is a rule to inject');
  assert.equal(settings(d).hooks?.UserPromptSubmit, undefined);

  // 3. detect: scaffold recognised as ours, still empty; the hook now asks.
  const r3 = JSON.parse(run(DETECT, d, '--json'));
  assert.equal(state(r3, 'P3.rules').state, 'declared');
  assert.deepEqual(state(r3, 'P3.rules').evidence, [`${RULES} (0 rules — scaffold not yet filled in)`]);
  assert.equal(state(r3, 'P3.reinject').state, 'absent');
  assert.match(state(r3, 'P3.reinject').question, /at least one rule/);
  assert.equal(state(r3, 'P3.rules').proposal, null, 'the scaffold must not be re-proposed');

  // 4. The user writes one rule, pointing at a real enforcer, and commits
  // (apply's dirty-tree gate is the reason — the real workflow).
  writeFileSync(join(d, RULES), readFileSync(join(d, RULES), 'utf8') +
    '\n## R1 — The test suite runs before any commit\n- why: a red suite on main costs everyone\n- enforced-by: test\n- pointer: package.json\n- priority: high\n');
  git(d, 'add', '-A');
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'accept scaffold, add R1');

  // 5. apply --yes now installs the hook and its shared asset.
  const dry = run(APPLY, d);
  assert.match(dry, /UserPromptSubmit/, 'the dry run names the hook it would register');
  assert.equal(existsSync(join(d, BRIEF)), false, 'the dry run writes nothing');
  run(APPLY, d, '--yes');
  assert.ok(existsSync(join(d, BRIEF)));
  assert.ok(existsSync(join(d, '.claude/scripts/harness-redact.mjs')));
  assert.equal(settings(d).hooks.UserPromptSubmit.length, 1);
  assert.equal('matcher' in settings(d).hooks.UserPromptSubmit[0], false, 'UserPromptSubmit takes no matcher');
  assert.deepEqual(settings(d).permissions, { deny: ['Edit(secrets/**)'] }, 'their settings survive');

  // 6. THE CLOSED LOOP: everything we wrote, we now recognise as present.
  const r6 = JSON.parse(run(DETECT, d, '--json'));
  assert.equal(state(r6, 'P3.rules').state, 'declared');
  assert.ok(state(r6, 'P3.rules').evidence.some(e => e.includes('1 rule — 1 enforced (test 1)')), JSON.stringify(state(r6, 'P3.rules').evidence));
  assert.equal(state(r6, 'P3.reinject').state, 'declared');
  assert.deepEqual(state(r6, 'P3.reinject').evidence, [`UserPromptSubmit hook: ${BRIEF}`]);
  assert.equal(r6.checks.filter(c => c.id.startsWith('P3.') && c.id !== 'P3.intent' && c.proposal).length, 0);

  // 7. The installed hook actually injects the rule, through the shared asset
  // that was copied beside it.
  const hookOut = execFileSync(process.execPath, [join(d, BRIEF)], { cwd: d, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: d } });
  const ctx = JSON.parse(hookOut).hookSpecificOutput;
  assert.equal(ctx.hookEventName, 'UserPromptSubmit');
  assert.match(ctx.additionalContext, /- R1: The test suite runs before any commit \[enforced-by: test\]/);

  // 8. uninstall: the hook and its script go; the FILLED registry stays, and
  // the reason is the user-authored-body gate — not merely "modified".
  git(d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-a', '-q', '-m', 'accept hook patch');
  const out = run(UNINSTALL, d, '--yes');
  assert.equal(existsSync(join(d, BRIEF)), false);
  assert.equal(settings(d).hooks?.UserPromptSubmit, undefined, 'our hook is gone');
  assert.ok(existsSync(join(d, RULES)), 'the user\'s rules must survive');
  assert.match(readFileSync(join(d, RULES), 'utf8'), /R1 — The test suite runs before any commit/);
  assert.match(out, /RULES\.md/, 'must say what it left behind');
});
