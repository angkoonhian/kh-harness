import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addHookEntry, hasEquivalentHook, revertPatch } from './settings-merge.mjs';

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
