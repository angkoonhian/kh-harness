import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addHookEntry, hasEquivalentHook, revertPatch, addDenyRules } from './settings-merge.mjs';

const ENTRY = { type: 'command', command: 'node .claude/scripts/session-brief.mjs' };

test('adds a hook to an empty settings object without mutating the input', () => {
  const before = {};
  const { settings, patch } = addHookEntry(before, 'SessionStart', ENTRY);
  assert.deepEqual(before, {}, 'input must not be mutated');
  assert.equal(settings.hooks.SessionStart.length, 1);
  assert.equal(patch.container, '/hooks/SessionStart');
  assert.match(patch.entrySha256, /^[0-9a-f]{64}$/);
});

test('preserves unrelated settings and unrelated events', () => {
  const before = { permissions: { deny: ['Edit(x)'] }, hooks: { Stop: [{ hooks: [{ type: 'command', command: 'a' }] }] } };
  const { settings } = addHookEntry(before, 'SessionStart', ENTRY);
  assert.deepEqual(settings.permissions, { deny: ['Edit(x)'] });
  assert.equal(settings.hooks.Stop.length, 1);
  assert.equal(settings.hooks.SessionStart.length, 1);
});

test('appends after an existing hook on the same event', () => {
  const before = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'theirs' }] }] } };
  const { settings } = addHookEntry(before, 'SessionStart', ENTRY);
  assert.equal(settings.hooks.SessionStart.length, 2);
  assert.equal(settings.hooks.SessionStart[0].hooks[0].command, 'theirs', 'user hook stays first');
});

test('hasEquivalentHook detects an existing command', () => {
  const { settings } = addHookEntry({}, 'SessionStart', ENTRY);
  assert.equal(hasEquivalentHook(settings, 'SessionStart', ENTRY.command), true);
  assert.equal(hasEquivalentHook(settings, 'Stop', ENTRY.command), false);
  assert.equal(hasEquivalentHook({}, 'SessionStart', ENTRY.command), false);
});

test('revertPatch removes by hash, not by index', () => {
  const { settings: s1, patch } = addHookEntry({}, 'SessionStart', ENTRY);
  // The user then adds their own hook ABOVE ours.
  s1.hooks.SessionStart.unshift({ hooks: [{ type: 'command', command: 'user-added' }] });
  const { settings: s2, reverted } = revertPatch(s1, patch);
  assert.equal(reverted, true);
  assert.equal(s2.hooks.SessionStart.length, 1);
  assert.equal(s2.hooks.SessionStart[0].hooks[0].command, 'user-added', 'must remove OURS, not index 0');
});

test('revertPatch reports false when our entry was already changed', () => {
  const { settings: s1, patch } = addHookEntry({}, 'SessionStart', ENTRY);
  s1.hooks.SessionStart[0].hooks[0].command = 'edited by user';
  const { reverted } = revertPatch(s1, patch);
  assert.equal(reverted, false, 'an edited entry is the user\'s now');
});

test('revertPatch prunes an emptied event but leaves other events', () => {
  const { settings: s1, patch } = addHookEntry({ hooks: { Stop: [{ hooks: [] }] } }, 'SessionStart', ENTRY);
  const { settings: s2 } = revertPatch(s1, patch);
  assert.equal(s2.hooks.SessionStart, undefined);
  assert.ok(s2.hooks.Stop);
});

test('revertPatch returns reverted:false when patch missing container without throwing', () => {
  const patch = { entrySha256: 'abc123' };
  const settings = { hooks: { SessionStart: [{ hooks: [ENTRY] }] } };
  const { reverted } = revertPatch(settings, patch);
  assert.equal(reverted, false);
});

test('revertPatch returns reverted:false when container does not start with /hooks/', () => {
  const patch = { container: '/permissions/deny', entrySha256: 'abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc1' };
  const settings = { hooks: { SessionStart: [{ hooks: [ENTRY] }] } };
  const { reverted } = revertPatch(settings, patch);
  assert.equal(reverted, false);
});

test('revertPatch returns reverted:false when entrySha256 is malformed', () => {
  const patch = { container: '/hooks/SessionStart', entrySha256: 'not-a-valid-hex' };
  const settings = { hooks: { SessionStart: [{ hooks: [ENTRY] }] } };
  const { reverted } = revertPatch(settings, patch);
  assert.equal(reverted, false);
});

test('revertPatch returns reverted:false when patch is null without throwing', () => {
  const settings = { hooks: { SessionStart: [{ hooks: [ENTRY] }] } };
  const { reverted } = revertPatch(settings, null);
  assert.equal(reverted, false);
});

test('revertPatch returns reverted:false when patch is undefined without throwing', () => {
  const settings = { hooks: { SessionStart: [{ hooks: [ENTRY] }] } };
  const { reverted } = revertPatch(settings, undefined);
  assert.equal(reverted, false);
});

test('revertPatch with valid patch still reverts correctly', () => {
  const { settings: s1, patch } = addHookEntry({}, 'SessionStart', ENTRY);
  s1.hooks.SessionStart.unshift({ hooks: [{ type: 'command', command: 'user-added' }] });
  const { settings: s2, reverted } = revertPatch(s1, patch);
  assert.equal(reverted, true, 'valid patch must still revert');
  assert.equal(s2.hooks.SessionStart.length, 1);
  assert.equal(s2.hooks.SessionStart[0].hooks[0].command, 'user-added');
});

test('adds deny rules to an empty settings object without mutating the input', () => {
  const before = {};
  const { settings, patch, added } = addDenyRules(before, ['Edit(prisma/migrations/**)']);
  assert.deepEqual(before, {}, 'input must not be mutated');
  assert.deepEqual(settings.permissions.deny, ['Edit(prisma/migrations/**)']);
  assert.deepEqual(added, ['Edit(prisma/migrations/**)']);
  assert.equal(patch.container, '/permissions/deny');
  assert.match(patch.entrySha256, /^[0-9a-f]{64}$/);
});

test('preserves the user\'s existing deny rules and appends after them', () => {
  const before = { permissions: { deny: ['Bash(rm:*)'] }, env: { KEEP: '1' } };
  const { settings } = addDenyRules(before, ['Edit(migrations/**)']);
  assert.deepEqual(settings.permissions.deny, ['Bash(rm:*)', 'Edit(migrations/**)']);
  assert.deepEqual(settings.env, { KEEP: '1' }, 'unrelated settings survive');
});

test('never adds a rule the user already has', () => {
  const before = { permissions: { deny: ['Edit(migrations/**)'] } };
  const { settings, added } = addDenyRules(before, ['Edit(migrations/**)', 'Edit(dist/**)']);
  assert.deepEqual(added, ['Edit(dist/**)'], 'only the genuinely new rule is ours');
  assert.equal(settings.permissions.deny.filter(r => r === 'Edit(migrations/**)').length, 1, 'no duplicate');
});

test('revertPatch removes only the rules we added', () => {
  const before = { permissions: { deny: ['Bash(rm:*)'] } };
  const { settings: s1, patch } = addDenyRules(before, ['Edit(migrations/**)']);
  s1.permissions.deny.push('Read(./.env)');           // the user adds their own afterwards
  const { settings: s2, reverted } = revertPatch(s1, patch);
  assert.equal(reverted, true);
  assert.deepEqual(s2.permissions.deny, ['Bash(rm:*)', 'Read(./.env)'], 'both of theirs survive');
});

test('revertPatch reports false when our rule was already removed by hand', () => {
  const { settings: s1, patch } = addDenyRules({}, ['Edit(migrations/**)']);
  s1.permissions.deny = [];
  assert.equal(revertPatch(s1, patch).reverted, false);
});

test('reverting the last deny rule prunes the empty structure', () => {
  const { settings: s1, patch } = addDenyRules({}, ['Edit(migrations/**)']);
  const { settings: s2 } = revertPatch(s1, patch);
  assert.equal(s2.permissions?.deny, undefined);
});

test('adding no new rules yields no patch', () => {
  const before = { permissions: { deny: ['Edit(migrations/**)'] } };
  const { patch, added } = addDenyRules(before, ['Edit(migrations/**)']);
  assert.deepEqual(added, []);
  assert.equal(patch, null, 'nothing was added, so there is nothing to record or revert');
});

test('dedupes identical globs within a single call', () => {
  const before = {};
  const { settings, added } = addDenyRules(before, ['Edit(x)', 'Edit(x)']);
  assert.deepEqual(added, ['Edit(x)'], 'only one rule is genuinely new');
  assert.equal(settings.permissions.deny.filter(r => r === 'Edit(x)').length, 1, 'no duplicate in settings');
});

test('dedupes a glob that is both a duplicate within the call and already in settings', () => {
  const before = { permissions: { deny: ['Edit(x)'] } };
  const { settings, added } = addDenyRules(before, ['Edit(x)', 'Edit(x)', 'Edit(y)']);
  assert.deepEqual(added, ['Edit(y)'], 'only the genuinely new rule is reported');
  assert.equal(settings.permissions.deny.length, 2, 'exactly two rules total');
  assert.deepEqual(settings.permissions.deny, ['Edit(x)', 'Edit(y)']);
});

test('reverting the last deny rule prunes the permissions object itself when it holds nothing else', () => {
  const { settings: s1, patch } = addDenyRules({}, ['Edit(migrations/**)']);
  const { settings: s2 } = revertPatch(s1, patch);
  assert.equal(s2.permissions, undefined, 'permissions object must be pruned, not left as {}');
});

test('reverting the last deny rule leaves sibling keys like allow and defaultMode intact', () => {
  const before = { permissions: { deny: ['Edit(x)'], allow: ['Read(*)'], defaultMode: 'allow' } };
  const { settings: s1, patch } = addDenyRules(before, ['Edit(y)']);
  const { settings: s2 } = revertPatch(s1, patch);
  assert.ok(s2.permissions, 'permissions object must be preserved');
  assert.equal(s2.permissions.deny.length, 1);
  assert.deepEqual(s2.permissions.deny, ['Edit(x)']);
  assert.deepEqual(s2.permissions.allow, ['Read(*)'], 'allow key must survive');
  assert.equal(s2.permissions.defaultMode, 'allow', 'defaultMode must survive');
});
