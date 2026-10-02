import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { emptyManifest, readManifest, sha256 } from './manifest.mjs';
import { assertAllowed, applyProposals, renderDiff } from './apply-lib.mjs';

const repo = () => mkdtempSync(join(tmpdir(), 'hk-apply-'));
const fileProposal = (o = {}) => ({ kind: 'file', path: 'HANDOFF.md', step: 16, contents: 'hello\n', checkId: 'P4.handoff', reason: 'r', ...o });

test('the allowlist admits the kit\'s own paths', () => {
  for (const p of ['CLAUDE.md', 'HANDOFF.md', 'docs/ARCHITECTURE.md', 'docs/harness/x.json', '.claude/settings.json', 'scripts/bootstrap.sh']) {
    assert.doesNotThrow(() => assertAllowed(p), p);
  }
});

test('the allowlist REFUSES anything else', () => {
  for (const p of ['src/index.ts', 'package.json', '../escape.md', '/etc/passwd', 'docs/README.md', '.git/config']) {
    assert.throws(() => assertAllowed(p), /not allowed/i, p);
  }
});

test('writes a proposed file and records it in the manifest', () => {
  const d = repo();
  const { manifest } = applyProposals({ root: d, proposals: [fileProposal()], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  assert.equal(readFileSync(join(d, 'HANDOFF.md'), 'utf8'), 'hello\n');
  assert.equal(manifest.files[0].sha256, sha256('hello\n'));
});

test('REFUSES to overwrite a file it did not write', () => {
  const d = repo();
  writeFileSync(join(d, 'HANDOFF.md'), 'user content\n');
  const r = applyProposals({ root: d, proposals: [fileProposal()], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  assert.equal(readFileSync(join(d, 'HANDOFF.md'), 'utf8'), 'user content\n', 'must not overwrite');
  assert.equal(r.written.length, 0);
  assert.equal(r.skipped.length, 1);
});

test('REFUSES to overwrite a file the user edited after we wrote it', () => {
  const d = repo();
  const m = emptyManifest('0.2.0');
  const r1 = applyProposals({ root: d, proposals: [fileProposal()], manifest: m, kitVersion: '0.2.0' });
  writeFileSync(join(d, 'HANDOFF.md'), 'edited by user\n');
  const r2 = applyProposals({ root: d, proposals: [fileProposal({ contents: 'new\n' })], manifest: r1.manifest, kitVersion: '0.2.0' });
  assert.equal(readFileSync(join(d, 'HANDOFF.md'), 'utf8'), 'edited by user\n');
  assert.equal(r2.skipped[0].why, 'ours-modified');
});

test('a settings-hook proposal merges and records a hash-identified patch', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Edit(x)'] } }));
  const p = { kind: 'settings-hook', event: 'SessionStart', step: 16, entry: { type: 'command', command: 'node x.mjs' }, checkId: 'P4.sessionbrief', reason: 'r' };
  const { manifest } = applyProposals({ root: d, proposals: [p], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  const s = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(s.permissions, { deny: ['Edit(x)'] }, 'unrelated settings survive');
  assert.equal(s.hooks.SessionStart.length, 1);
  assert.match(manifest.settingsPatches[0].entrySha256, /^[0-9a-f]{64}$/);
});

test('a settings-hook proposal carrying a matcher (the per-edit sensor, on PostToolUse) writes it to settings.json', () => {
  const d = repo();
  const p = {
    kind: 'settings-hook', event: 'PostToolUse', step: 9, matcher: 'Write|Edit',
    entry: { type: 'command', command: 'node .claude/scripts/lint-touched.mjs' },
    checkId: 'P2.sensor', reason: 'r',
  };
  applyProposals({ root: d, proposals: [p], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  const s = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(s.hooks.PostToolUse[0], { matcher: 'Write|Edit', hooks: [p.entry] });
});

// Minor 10: renderDiff's preview and applyProposals's actual write build the
// matcherEntry independently unless both go through buildMatcherEntry — a
// preview that lies about what apply will write is worse than no preview.
// This parses the `+` lines BACK out of the rendered diff and asserts they
// deep-equal what actually landed on disk, so the two cannot silently drift.
test('the settings-hook preview and the actual write agree on the matcherEntry shape', () => {
  const d = repo();
  const p = {
    kind: 'settings-hook', event: 'PostToolUse', step: 9, matcher: 'Write|Edit',
    entry: { type: 'command', command: 'node .claude/scripts/lint-touched.mjs' },
    checkId: 'P2.sensor', reason: 'r',
  };
  const diff = renderDiff(d, p);
  const addedJson = diff.split('\n')
    .filter(l => l.startsWith('+') && !l.startsWith('+++')) // exclude the `+++ b/...` diff header
    .map(l => l.slice(1))
    .join('\n');
  const previewed = JSON.parse(addedJson);

  applyProposals({ root: d, proposals: [p], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  const written = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8')).hooks.PostToolUse[0];

  assert.deepEqual(previewed, written, 'the preview must describe EXACTLY what apply writes');
});

test('applying twice is a no-op', () => {
  const d = repo();
  const r1 = applyProposals({ root: d, proposals: [fileProposal()], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  const r2 = applyProposals({ root: d, proposals: [fileProposal()], manifest: r1.manifest, kitVersion: '0.2.0' });
  assert.equal(r2.written.length, 0);
  assert.equal(r1.manifest.files.length, 1);
  // A do-nothing implementation also satisfies written.length === 0; pin the
  // actual file content down so a regression that stops writing altogether
  // (rather than genuinely detecting a no-op) cannot pass silently.
  assert.equal(readFileSync(join(d, 'HANDOFF.md'), 'utf8'), 'hello\n', 'file must be byte-identical after the second apply');
  assert.equal(r2.skipped.some(s => s.path === 'HANDOFF.md' && s.why === 'unchanged'), true, 'idempotence is reported, not silent');
});

test('renderDiff shows added lines for a new file', () => {
  const diff = renderDiff(repo(), fileProposal());
  assert.match(diff, /^\+hello$/m);
});

test('a proposal targeting a disallowed path throws before anything is written', () => {
  const d = repo();
  assert.throws(() => applyProposals({ root: d, proposals: [fileProposal({ path: 'src/evil.ts' })], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' }), /not allowed/i);
  assert.equal(existsSync(join(d, 'src/evil.ts')), false);
});

// --- Fix round 1 -----------------------------------------------------------

test('CLAUDE.md that already exists is redirected, never written in place', () => {
  const d = repo();
  writeFileSync(join(d, 'CLAUDE.md'), '# hand-tuned notes\nkeep me\n');
  const p = { kind: 'file', path: 'CLAUDE.md', step: 1, contents: '# generated\n', checkId: 'P1.instructions', reason: 'r' };
  const { written, redirected, manifest } = applyProposals({ root: d, proposals: [p], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  assert.equal(readFileSync(join(d, 'CLAUDE.md'), 'utf8'), '# hand-tuned notes\nkeep me\n', 'CLAUDE.md must never be touched');
  assert.equal(readFileSync(join(d, 'docs/harness/CLAUDE.proposed.md'), 'utf8'), '# generated\n');
  assert.deepEqual(redirected, [{ from: 'CLAUDE.md', to: 'docs/harness/CLAUDE.proposed.md' }]);
  assert.equal(written.length, 1);
  assert.equal(written[0].path, 'docs/harness/CLAUDE.proposed.md');
  assert.equal(manifest.files.some(f => f.path === 'CLAUDE.md'), false, 'no manifest entry for the untouched file');
});

test('renderDiff for an existing CLAUDE.md previews the redirect target, not a deletion of the user\'s file', () => {
  const d = repo();
  writeFileSync(join(d, 'CLAUDE.md'), '# hand-tuned notes\nkeep me\n');
  const p = { kind: 'file', path: 'CLAUDE.md', step: 1, contents: '# generated\n', checkId: 'P1.instructions', reason: 'r' };
  const diff = renderDiff(d, p);
  assert.doesNotMatch(diff, /-keep me/, 'must never present the user\'s own file as being deleted');
  assert.doesNotMatch(diff, /-# hand-tuned notes/);
  assert.match(diff, /CLAUDE\.proposed\.md/, 'must name the redirect target');
  assert.match(diff, /\+# generated/, 'must preview the content that will actually be written');
});

test('the input manifest is not mutated, including nested arrays', () => {
  const d = repo();
  const original = emptyManifest('0.2.0');
  original.files.push({ path: 'OTHER.md', sha256: sha256('x'), step: 1, writtenAt: 'then' });
  const originalFilesRef = original.files;
  const { manifest } = applyProposals({ root: d, proposals: [fileProposal()], manifest: original, kitVersion: '0.2.0' });
  assert.notEqual(manifest.files, originalFilesRef, 'the returned files array must be a new array, not the same reference');
  assert.equal(original.files.length, 1, 'a shallow {...manifest} clone would leak the push below into this array too');
  assert.equal(manifest.files.length, 2);
});

test('pre-write validation is order-independent: a disallowed second entry blocks the whole batch', () => {
  const d = repo();
  const proposals = [fileProposal(), fileProposal({ path: 'src/evil.ts', checkId: 'x' })];
  assert.throws(() => applyProposals({ root: d, proposals, manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' }), /not allowed/i);
  assert.equal(existsSync(join(d, 'HANDOFF.md')), false, 'the valid first entry must not be written either');
});

test('an unparseable settings.json is left untouched and reported, not destroyed', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  const original = '{ "permissions": { "deny": ["Edit(x)"], }, }'; // trailing commas — invalid JSON
  writeFileSync(join(d, '.claude/settings.json'), original);
  const p = { kind: 'settings-hook', event: 'SessionStart', step: 16, entry: { type: 'command', command: 'node x.mjs' }, checkId: 'P4.sessionbrief', reason: 'r' };
  const r = applyProposals({ root: d, proposals: [p], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  assert.equal(readFileSync(join(d, '.claude/settings.json'), 'utf8'), original, 'must not touch an unparseable settings file');
  assert.equal(r.patched.length, 0);
  assert.equal(r.skipped[0].why, 'unparseable');
  assert.equal(r.manifest.settingsPatches.length, 0, 'no patch may be recorded for a write that did not happen');
});

test('a settings.json holding a JSON array is treated like unparseable — nothing written, nothing recorded', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), '[]');
  const p = { kind: 'settings-hook', event: 'SessionStart', step: 16, entry: { type: 'command', command: 'node x.mjs' }, checkId: 'P4.sessionbrief', reason: 'r' };
  const r = applyProposals({ root: d, proposals: [p], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  assert.equal(readFileSync(join(d, '.claude/settings.json'), 'utf8'), '[]');
  assert.equal(r.patched.length, 0);
  assert.equal(r.skipped[0].why, 'unparseable');
  assert.equal(r.manifest.settingsPatches.length, 0);
});

test('a mid-batch write failure stops processing but returns normally with everything written so far recorded', () => {
  const d = repo();
  mkdirSync(join(d, 'docs'), { recursive: true });
  writeFileSync(join(d, 'docs/harness'), 'a plain file sitting where a directory needs to go\n');
  const p1 = fileProposal(); // HANDOFF.md — should succeed
  const p2 = { kind: 'file', path: 'docs/harness/x.json', step: 1, contents: '{}\n', checkId: 'x', reason: 'r' };
  const r = applyProposals({ root: d, proposals: [p1, p2], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  assert.equal(readFileSync(join(d, 'HANDOFF.md'), 'utf8'), 'hello\n', 'the proposal before the failure must still be written');
  assert.equal(r.written.length, 1);
  assert.equal(r.written[0].path, 'HANDOFF.md');
  assert.equal(r.failed.length, 1);
  assert.match(r.failed[0].path, /docs.harness/);
  assert.ok(r.failed[0].error.length > 0);
  assert.equal(r.manifest.files.length, 1, 'the manifest returned must record exactly what was actually written');
});

// --- C2: the settings preview must not print the user's settings ---------

const SECRET_SETTINGS = {
  env: { DEPLOY_TOKEN: 'glpat-SECRET-IN-ENV' },
  hooks: {
    Stop: [{ hooks: [{ type: 'command', command: "curl -H 'PRIVATE-TOKEN: ghp_SECRET_IN_HOOK' https://example.invalid" }] }],
  },
  permissions: { deny: ['Edit(secrets/**)'] },
};
const hookProposal = { kind: 'settings-hook', event: 'SessionStart', step: 16, entry: { type: 'command', command: 'node x.mjs' }, checkId: 'P4.sessionbrief', reason: 'r' };

test('C2: a settings-hook preview never prints the user\'s own settings', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(SECRET_SETTINGS, null, 2));

  const diff = renderDiff(d, hookProposal);
  assert.doesNotMatch(diff, /SECRET-IN-ENV/, 'a credential in env must never reach the preview');
  assert.doesNotMatch(diff, /SECRET_IN_HOOK/, 'a token in an unrelated hook command must never reach the preview');
  assert.doesNotMatch(diff, /DEPLOY_TOKEN|permissions|Edit\(secrets/, 'no part of the user\'s settings belongs in a one-entry preview');

  // Still a useful preview: it shows exactly what will be added, and where.
  assert.match(diff, /^\+\s*"command": "node x\.mjs"$/m, 'the entry that will actually be added must be shown');
  assert.match(diff, /hooks\.SessionStart/, 'and the preview must say where it goes');
});

test('C2: a settings-hook preview with a matcher shows the matcher, still without the user\'s own settings', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(SECRET_SETTINGS, null, 2));

  const p = {
    kind: 'settings-hook', event: 'PostToolUse', step: 9, matcher: 'Write|Edit',
    entry: { type: 'command', command: 'node .claude/scripts/lint-touched.mjs' },
    checkId: 'P2.sensor', reason: 'r',
  };
  const diff = renderDiff(d, p);
  assert.doesNotMatch(diff, /SECRET-IN-ENV|SECRET_IN_HOOK/, 'no part of the user\'s settings belongs in this preview either');
  assert.match(diff, /"matcher": "Write\|Edit"/, 'the matcher being added is shown');
  assert.match(diff, /hooks\.PostToolUse/);
});

test('C2: a secret in an existing entry under the same event is not shown either', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: 'node theirs.mjs --token=ghp_SECRET_SAME_EVENT' }] }],
    },
  }, null, 2));

  const diff = renderDiff(d, hookProposal);
  assert.doesNotMatch(diff, /SECRET_SAME_EVENT/, 'diffing the whole hooks[event] subtree would still leak');
  assert.match(diff, /1 existing hooks\.SessionStart entry/, 'the preview must still say it is appending, not replacing');
});

test('a pre-existing directory junction cannot route a write outside the repository', () => {
  const d = repo();
  const outside = mkdtempSync(join(tmpdir(), 'hk-outside-'));
  symlinkSync(outside, join(d, 'docs'), 'junction');
  const p = { kind: 'file', path: 'docs/harness/evil.md', step: 1, contents: 'x', checkId: 'x', reason: 'r' };
  assert.throws(() => applyProposals({ root: d, proposals: [p], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' }), /not allowed/i);
  assert.equal(existsSync(join(outside, 'harness')), false, 'nothing may be written through the junction');
});

test('a dangling symlink sitting at the target itself is refused, not silently followed', () => {
  const d = repo();
  const outside = join(mkdtempSync(join(tmpdir(), 'hk-outside2-')), 'does-not-exist.md');
  symlinkSync(outside, join(d, 'HANDOFF.md'), 'file');
  assert.throws(() => applyProposals({ root: d, proposals: [fileProposal()], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' }), /not allowed/i);
  assert.equal(existsSync(outside), false, 'the dangling target must not have been created');
});

// --- Task 2: settings-deny proposals apply additively ----------------------

const denyProposal = (globs = ['Edit(prisma/migrations/**)', 'Edit(pnpm-lock.yaml)']) =>
  ({ kind: 'settings-deny', step: 11, globs, checkId: 'P2.protected', reason: 'r' });

test('a settings-deny proposal merges and records a hash-identified patch', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ env: { KEEP: '1' } }));
  const { manifest, patched } = applyProposals({ root: d, proposals: [denyProposal()], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  const s = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(s.permissions.deny, ['Edit(prisma/migrations/**)', 'Edit(pnpm-lock.yaml)']);
  assert.deepEqual(s.env, { KEEP: '1' }, 'unrelated settings survive');
  assert.equal(patched.length, 1);
  assert.equal(manifest.settingsPatches[0].container, '/permissions/deny');
  assert.match(manifest.settingsPatches[0].entrySha256, /^[0-9a-f]{64}$/);
});

test('a settings-deny proposal whose rules are all already present is reported unchanged, not rewritten', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  const before = JSON.stringify({ permissions: { deny: ['Edit(prisma/migrations/**)', 'Edit(pnpm-lock.yaml)'] } }, null, 2);
  writeFileSync(join(d, '.claude/settings.json'), before);
  const { skipped, patched, manifest } = applyProposals({ root: d, proposals: [denyProposal()], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  assert.equal(readFileSync(join(d, '.claude/settings.json'), 'utf8'), before, 'file must be byte-identical — nothing to add');
  assert.equal(patched.length, 0);
  assert.equal(skipped.some(s => s.path === '.claude/settings.json' && s.why === 'unchanged'), true);
  assert.equal(manifest.settingsPatches.length, 0, 'no patch may be recorded when nothing was added');
});

test('a settings-deny proposal adds only the genuinely new rules when some already exist', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Edit(prisma/migrations/**)'] } }));
  const { manifest } = applyProposals({ root: d, proposals: [denyProposal()], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  const s = JSON.parse(readFileSync(join(d, '.claude/settings.json'), 'utf8'));
  assert.deepEqual(s.permissions.deny, ['Edit(prisma/migrations/**)', 'Edit(pnpm-lock.yaml)'], 'no duplicate of the pre-existing rule');
  assert.deepEqual(manifest.settingsPatches[0].rules, ['Edit(pnpm-lock.yaml)']);
});

test('an unparseable settings.json is left untouched when a settings-deny proposal targets it', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  const original = '{ "permissions": { "deny": ["Edit(x)"], }, }'; // trailing commas — invalid JSON
  writeFileSync(join(d, '.claude/settings.json'), original);
  const r = applyProposals({ root: d, proposals: [denyProposal()], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  assert.equal(readFileSync(join(d, '.claude/settings.json'), 'utf8'), original, 'must not touch an unparseable settings file');
  assert.equal(r.patched.length, 0);
  assert.equal(r.skipped[0].why, 'unparseable');
  assert.equal(r.manifest.settingsPatches.length, 0, 'no patch may be recorded for a write that did not happen');
});

// --- the settings-deny preview must not print the user's own settings -----

const denySecretProposal = { kind: 'settings-deny', step: 11, globs: ['Edit(prisma/migrations/**)'], checkId: 'P2.protected', reason: 'r' };

test('a settings-deny preview never prints the user\'s own settings', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(SECRET_SETTINGS, null, 2));

  const diff = renderDiff(d, denySecretProposal);
  assert.doesNotMatch(diff, /SECRET-IN-ENV/, 'a credential in env must never reach the preview');
  assert.doesNotMatch(diff, /SECRET_IN_HOOK/, 'a token in an unrelated hook command must never reach the preview');
  assert.doesNotMatch(diff, /DEPLOY_TOKEN|Edit\(secrets/, 'no part of the user\'s settings belongs in a one-rule preview');

  // Still a useful preview: it shows exactly what will be added, and where.
  assert.match(diff, /^\+"Edit\(prisma\/migrations\/\*\*\)"$/m, 'the rule that will actually be added must be shown');
  assert.match(diff, /permissions\.deny/, 'and the preview must say where it goes');
});

test('a secret in an existing deny rule under the same container is not shown either', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({
    permissions: { deny: ['Bash(curl --header "Authorization: Bearer ghp_SECRET_SAME_CONTAINER":*)'] },
  }, null, 2));

  const diff = renderDiff(d, denySecretProposal);
  assert.doesNotMatch(diff, /SECRET_SAME_CONTAINER/, 'diffing the whole permissions.deny array would still leak');
  assert.match(diff, /1 existing permissions\.deny entr/, 'the preview must still say it is appending, not replacing');
});

// --- the preview shows nothing when every proposed rule is already present
// (not reachable through the CLI — gap-model.mjs flips P2.protected to
// `declared` once any deny rule exists, so renderDiff is never called on
// this shape in practice; this documents the defensively-redundant branch
// directly, by calling renderDiff itself, the way the brief's "report
// unchanged" exception already covers apply-side at the library level) ---

test('the settings-deny preview shows nothing to add when every proposed rule is already present', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  writeFileSync(join(d, '.claude/settings.json'), JSON.stringify({ permissions: { deny: ['Edit(prisma/migrations/**)'] } }));
  const diff = renderDiff(d, denySecretProposal); // proposes exactly Edit(prisma/migrations/**), already present
  assert.match(diff, /every proposed rule is already present — nothing would be added/);
  assert.doesNotMatch(diff, /^\+"/m, 'nothing may be shown as being added when nothing is new');
});

// --- a malformed permissions.deny must never crash the dry run -----------
//
// Before this fix, readSettingsResult validated only the top-level JSON
// shape; `renderSettingsDenyDiff` then called `addDenyRules` unguarded,
// which assumes `permissions.deny` is already an array (`.push(...)`,
// `new Set(...)`). Any settings.json with a non-array `permissions.deny`,
// or a non-object `permissions`, crashed `renderDiff` with a raw
// TypeError — reachable from `apply.mjs`'s DEFAULT (no --yes) path, in
// violation of the stated exit 0/2/3 contract. Fixed by extending
// readSettingsResult itself to refuse these shapes exactly like
// unparseable JSON, so both renderDiff and applyProposals route through
// the existing 'could not be parsed' / 'unparseable' paths with no new
// error handling needed at either call site.

const MALFORMED_DENY_SHAPES = [
  ['deny is a string', { permissions: { deny: 'Edit(secrets/**)' } }],
  ['deny is an object', { permissions: { deny: { 0: 'Edit(secrets/**)' } } }],
  ['deny is a number', { permissions: { deny: 3 } }],
  ['permissions is a string', { permissions: 'nope' }],
];

test('renderDiff never throws on a malformed permissions.deny — reports it like unparseable JSON instead', () => {
  for (const [label, shape] of MALFORMED_DENY_SHAPES) {
    const d = repo();
    mkdirSync(join(d, '.claude'), { recursive: true });
    writeFileSync(join(d, '.claude/settings.json'), JSON.stringify(shape));
    assert.doesNotThrow(() => renderDiff(d, denySecretProposal), label);
    const diff = renderDiff(d, denySecretProposal);
    assert.match(diff, /could not be parsed as a JSON object/, `${label}: must report the same way as unparseable JSON`);
  }
});

test('applyProposals never throws on a malformed permissions.deny — skips it as unparseable, writes nothing', () => {
  const d = repo();
  mkdirSync(join(d, '.claude'), { recursive: true });
  const original = JSON.stringify({ permissions: { deny: 'Edit(secrets/**)' } });
  writeFileSync(join(d, '.claude/settings.json'), original);
  const r = applyProposals({ root: d, proposals: [denySecretProposal], manifest: emptyManifest('0.2.0'), kitVersion: '0.2.0' });
  assert.equal(readFileSync(join(d, '.claude/settings.json'), 'utf8'), original, 'must not touch a settings.json it cannot safely merge into');
  assert.equal(r.patched.length, 0);
  assert.equal(r.failed.length, 0, 'this is a refusal, not a write failure');
  assert.equal(r.skipped[0].why, 'unparseable');
});
