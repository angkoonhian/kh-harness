import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addHookEntry, hasEquivalentHook, hookPathTokens, hookScriptOf, normalizeMatcher, matcherCovers, revertPatch, revertPatches, addDenyRules } from './settings-merge.mjs';
import { sha256 } from './manifest.mjs';
import { DISPATCH_PRE_PATH, GENERATOR_SCRIPT_PATHS } from './propose.mjs';
import { execEntry } from './hook-evidence.mjs';

// What revertPatch may remove: every generator hook script, and the deny
// rules these tests' patches add.
const PRODUCIBLE = {
  producibleHookScripts: new Set(GENERATOR_SCRIPT_PATHS),
  producibleDenyRules: new Set(['Edit(migrations/**)', 'Edit(y)']),
};

const ENTRY = { type: 'command', command: 'node .claude/scripts/session-brief.mjs' };

test('adds a hook to an empty settings object without mutating the input', () => {
  const before = {};
  const { settings, patch } = addHookEntry(before, 'SessionStart', ENTRY);
  assert.deepEqual(before, {}, 'input must not be mutated');
  assert.equal(settings.hooks.SessionStart.length, 1);
  assert.equal(patch.container, '/hooks/SessionStart');
  assert.match(patch.entrySha256, /^[0-9a-f]{64}$/);
});

test('a hook patch records the hash of its entry as canonical JSON, whatever order the entry\'s keys were written in', () => {
  const canonical = '{"hooks":[{"command":"node .claude/scripts/lint-touched.mjs","timeout":5,"type":"command"}],"matcher":"Write|Edit"}';
  const written = addHookEntry({}, 'PostToolUse', { type: 'command', command: 'node .claude/scripts/lint-touched.mjs', timeout: 5 }, 'Write|Edit');
  assert.equal(written.patch.entrySha256, sha256(canonical), 'the bytes a manifest already records for this entry');
  const reordered = { hooks: { PostToolUse: [JSON.parse('{"matcher":"Write|Edit","hooks":[{"timeout":5,"command":"node .claude/scripts/lint-touched.mjs","type":"command"}]}')] } };
  const reverted = revertPatch(reordered, written.patch, PRODUCIBLE);
  assert.deepEqual(reverted.kept, []);
  assert.deepEqual(reverted.settings, {}, 'the entry is found by its content, not its key order');
});

test('an entry the owner gave a __proto__ key is not taken for the one the kit wrote', () => {
  const { settings, patch } = addHookEntry({}, 'SessionStart', ENTRY);
  const edited = JSON.parse(JSON.stringify(settings).replace('{"hooks":[{', '{"__proto__":{"edited":true},"hooks":[{'));
  assert.ok(Object.hasOwn(edited.hooks.SessionStart[0], '__proto__'), 'fixture: the key is the entry\'s own');
  const r = revertPatch(edited, patch, PRODUCIBLE);
  assert.deepEqual(r.kept.map(k => k.reason), ['patch-modified'], 'its hash is not the recorded one, so it is kept');
  assert.equal(r.settings.hooks.SessionStart.length, 1);
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
  assert.equal(hasEquivalentHook(settings, 'SessionStart', ENTRY), true);
  assert.equal(hasEquivalentHook(settings, 'Stop', ENTRY), false);
  assert.equal(hasEquivalentHook({}, 'SessionStart', ENTRY), false);
});

// Audit Tier 2, finding 7 (second half): the same command under a DIFFERENT
// matcher is a different hook — a user's `node x.mjs` under `Bash` used to
// suppress our `Write|Edit` registration of the same script.
test('hasEquivalentHook distinguishes the same command under a different matcher', () => {
  const { settings } = addHookEntry({}, 'PostToolUse', ENTRY, 'Bash');
  assert.equal(hasEquivalentHook(settings, 'PostToolUse', ENTRY, 'Write|Edit'), false, 'theirs is under Bash; ours would be under Write|Edit');
  assert.equal(hasEquivalentHook(settings, 'PostToolUse', ENTRY, 'Bash'), true);
  // Reversed by the Tier 2 review fix pass: a narrower registration of a
  // match-all proposal counts — narrowing is the user's choice (see
  // matcherCovers). Our generators never propose PostToolUse without one.
  assert.equal(hasEquivalentHook(settings, 'PostToolUse', ENTRY), true, 'a narrower registration of a match-all proposal still counts');
  const { settings: unmatched } = addHookEntry({}, 'SessionStart', ENTRY);
  assert.equal(hasEquivalentHook(unmatched, 'SessionStart', ENTRY), true, 'an absent matcher on both sides is equivalent');
  assert.equal(hasEquivalentHook(unmatched, 'SessionStart', ENTRY, undefined), true);
});

// Tier 2 final review, Minor 7 (and the shared definition behind Important 1):
// a matcher is a SET of tool names, so order is irrelevant and a wider set
// covers; a narrower registration of a match-all proposal still counts.
test('normalizeMatcher: every-tool forms are null, a plain alternation is a sorted set, a regex is kept', () => {
  for (const all of [undefined, '', '*']) assert.equal(normalizeMatcher(all), null);
  assert.equal(normalizeMatcher('Write|Edit'), 'Edit|Write');
  assert.equal(normalizeMatcher('Edit, Write'), 'Edit|Write');
  assert.equal(normalizeMatcher('^Notebook.*'), '^Notebook.*');
});

test('matcherCovers: a wider or reordered list covers; a narrower one does not; a match-all proposal is covered by anything', () => {
  assert.equal(matcherCovers('Edit|Write', 'Write|Edit'), true);
  assert.equal(matcherCovers('Write|Edit|NotebookEdit', 'Write|Edit'), true);
  assert.equal(matcherCovers('*', 'Write|Edit'), true);
  assert.equal(matcherCovers('Bash', 'Write|Edit'), false);
  assert.equal(matcherCovers('Edit', 'Write|Edit'), false);
  assert.equal(matcherCovers('startup|resume', undefined), true, 'narrowing an event we need no matcher for is the user\'s choice');
  assert.equal(matcherCovers('^Edit.*', 'Write|Edit'), false, 'a regex is never assumed to cover a list');
});

test('hasEquivalentHook treats Edit|Write as Write|Edit and a wider list as covering', () => {
  const { settings: reordered } = addHookEntry({}, 'PostToolUse', ENTRY, 'Edit|Write');
  assert.equal(hasEquivalentHook(reordered, 'PostToolUse', ENTRY, 'Write|Edit'), true);
  const { settings: wider } = addHookEntry({}, 'PostToolUse', ENTRY, 'Write|Edit|NotebookEdit');
  assert.equal(hasEquivalentHook(wider, 'PostToolUse', ENTRY, 'Write|Edit'), true);
});

// --- Audit Tier 3, finding 11: exec-form registration, both forms one hook ----
//
// Claude Code documents the exec form — `"command": "node", "args": [...]`,
// spawned with no shell — and `${CLAUDE_PROJECT_DIR}` as the project root,
// and says to prefer that form for any path placeholder. Our hooks were
// registered as `node .claude/scripts/x.mjs`: a shell per invocation
// (~260 ms measured) and a cwd-relative path that breaks after `cd`.

test('hookPathTokens and hookScriptOf resolve shell form, exec form with ${CLAUDE_PROJECT_DIR}, quoted and ./-prefixed paths', () => {
  const execForm = { type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/.claude/scripts/lint-touched.mjs'] };
  assert.equal(hookScriptOf(execForm), '.claude/scripts/lint-touched.mjs');
  assert.deepEqual(hookPathTokens(execForm), ['.claude/scripts/lint-touched.mjs']);
  assert.equal(hookScriptOf({ type: 'command', command: 'node .claude/scripts/lint-touched.mjs' }), null, 'shell form cannot be resolved without the file list');
  assert.deepEqual(hookPathTokens({ command: 'node "./.claude/scripts/lint-touched.mjs" --fix' }), ['node', '.claude/scripts/lint-touched.mjs', '--fix']);
  assert.deepEqual(hookPathTokens({ command: 'node $CLAUDE_PROJECT_DIR\\.claude\\scripts\\x.mjs' }), ['node', '.claude/scripts/x.mjs']);
  assert.deepEqual(hookPathTokens({}), []);
});

test('hasEquivalentHook treats a shell-form and an exec-form registration of the same script under the same matcher as one hook', () => {
  const execForm = { type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/.claude/scripts/lint-touched.mjs'] };
  const shellForm = { type: 'command', command: 'node .claude/scripts/lint-touched.mjs' };
  const { settings: hasShell } = addHookEntry({}, 'PostToolUse', shellForm, 'Write|Edit');
  assert.equal(hasEquivalentHook(hasShell, 'PostToolUse', execForm, 'Write|Edit'), true, 'a user\'s shell-form registration is recognised');
  const { settings: hasExec } = addHookEntry({}, 'PostToolUse', execForm, 'Write|Edit');
  assert.equal(hasEquivalentHook(hasExec, 'PostToolUse', shellForm, 'Write|Edit'), true, 'and the other way round');
  assert.equal(hasEquivalentHook(hasExec, 'PostToolUse', execForm, 'Write|Edit'), true);
  const other = { type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/.claude/scripts/other.mjs'] };
  assert.equal(hasEquivalentHook(hasExec, 'PostToolUse', other, 'Write|Edit'), false);
  assert.equal(hasEquivalentHook(hasShell, 'PostToolUse', { command: 'node theirs.mjs' }, 'Write|Edit'), false, 'two shell forms compare as strings');
});

test('normalizeHookPath strips a quote that closes before the path, a real shell idiom', () => {
  // Tier 3 final review, Minor 8: `node "${CLAUDE_PROJECT_DIR}"/.claude/scripts/x.mjs`.
  assert.deepEqual(hookPathTokens({ command: 'node "${CLAUDE_PROJECT_DIR}"/.claude/scripts/x.mjs' }), ['node', '.claude/scripts/x.mjs']);
});

// --- optional matcher (PostToolUse needs one; SessionStart never has) -----

test('addHookEntry with no matcher argument omits the matcher key entirely (unchanged behaviour)', () => {
  const { settings } = addHookEntry({}, 'SessionStart', ENTRY);
  assert.equal('matcher' in settings.hooks.SessionStart[0], false);
});

test('addHookEntry with a matcher writes it alongside hooks on the SAME entry', () => {
  const postToolUseEntry = { type: 'command', command: 'node .claude/scripts/lint-touched.mjs' };
  const { settings, patch } = addHookEntry({}, 'PostToolUse', postToolUseEntry, 'Write|Edit');
  assert.deepEqual(settings.hooks.PostToolUse[0], { matcher: 'Write|Edit', hooks: [postToolUseEntry] });
  assert.match(patch.entrySha256, /^[0-9a-f]{64}$/);
});

test('a matcher changes the entry hash, so reverting without it does not find the matcher-bearing entry', () => {
  const entry = { type: 'command', command: 'x' };
  const withMatcher = addHookEntry({}, 'PostToolUse', entry, 'Write|Edit');
  const withoutMatcher = addHookEntry({}, 'PostToolUse', entry);
  assert.notEqual(withMatcher.patch.entrySha256, withoutMatcher.patch.entrySha256);
});

test('revertPatch removes a matcher-bearing entry by hash, same as any other', () => {
  const entry = { type: 'command', command: 'node .claude/scripts/lint-touched.mjs' };
  const { settings: s1, patch } = addHookEntry({}, 'PostToolUse', entry, 'Write|Edit');
  const { settings: s2, kept } = revertPatch(s1, patch, PRODUCIBLE);
  assert.deepEqual(kept, []);
  assert.equal(s2.hooks, undefined);
});

test('revertPatch removes by hash, not by index', () => {
  const { settings: s1, patch } = addHookEntry({}, 'SessionStart', ENTRY);
  // The user then adds their own hook ABOVE ours.
  s1.hooks.SessionStart.unshift({ hooks: [{ type: 'command', command: 'user-added' }] });
  const { settings: s2, kept } = revertPatch(s1, patch, PRODUCIBLE);
  assert.deepEqual(kept, []);
  assert.equal(s2.hooks.SessionStart.length, 1);
  assert.equal(s2.hooks.SessionStart[0].hooks[0].command, 'user-added', 'must remove OURS, not index 0');
});

test('revertPatch keeps a patch whose entry was changed but still runs the kit\'s script', () => {
  // A copy: the returned settings hold the entry object itself, and the edit
  // below must not reach ENTRY, which later tests revert.
  const { settings: s1, patch } = addHookEntry({}, 'SessionStart', { ...ENTRY });
  s1.hooks.SessionStart[0].matcher = 'startup';
  const r = revertPatch(s1, patch, PRODUCIBLE);
  assert.deepEqual(r.kept, [{ patch, reason: 'patch-modified' }], 'still registered, and no longer what was recorded');
  assert.equal(r.gone, false);
  assert.deepEqual(r.settings, s1, 'nothing is removed');
});

test('a hook patch whose entry was removed by hand is gone, not kept', () => {
  const { settings: s1, patch } = addHookEntry({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node mine.mjs' }] }] } }, 'SessionStart', { ...ENTRY });
  s1.hooks.SessionStart.pop();
  const r = revertPatch(s1, patch, PRODUCIBLE);
  assert.deepEqual([r.kept, r.gone], [[], true]);
  assert.deepEqual(r.settings, s1, 'the user\'s own hook on the event is untouched');

  const { patch: alone } = addHookEntry({}, 'SessionEnd', { ...ENTRY });
  assert.equal(revertPatch({}, alone, PRODUCIBLE).gone, true, 'with the whole event gone');
  assert.equal(revertPatch({ hooks: { SessionEnd: 'nonsense' } }, alone, PRODUCIBLE).gone, true, 'or not a list at all');
});

test('a hook patch whose entry was edited to run something else is gone: nothing of the kit\'s is registered there', () => {
  const { settings: s1, patch } = addHookEntry({}, 'SessionStart', { ...ENTRY });
  s1.hooks.SessionStart[0].hooks[0].command = 'edited by user';
  const r = revertPatch(s1, patch, PRODUCIBLE);
  assert.deepEqual([r.kept, r.gone], [[], true]);
  assert.deepEqual(r.settings, s1, 'the entry is the user\'s now, and stays');
});

const LOG_ENTRY = { type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/.claude/scripts/session-log.mjs'] };

test('revertPatches reverts what is there, drops what was removed by hand, and judges an unfound entry only after the rest', () => {
  // Two kit hooks on one event; the owner removed the first one's entry.
  const a = addHookEntry({}, 'SessionStart', { ...ENTRY });
  const b = addHookEntry(a.settings, 'SessionStart', LOG_ENTRY);
  const c = addDenyRules(b.settings, ['Edit(migrations/**)']);
  const settings = structuredClone(c.settings);
  settings.hooks.SessionStart.shift();
  for (const order of [[a.patch, b.patch, c.patch], [b.patch, a.patch, c.patch]]) {
    const r = revertPatches(settings, order, PRODUCIBLE);
    assert.deepEqual(r.gone, [a.patch], 'the hand-removed entry is gone whichever patch is tried first');
    assert.deepEqual(r.reverted, order.filter(p => p !== a.patch));
    assert.deepEqual(r.kept, []);
    assert.deepEqual(r.settings, {});
  }
});

test('revertPatches keeps an edited kit entry as modified and a forged one as not producible', () => {
  const a = addHookEntry({}, 'SessionStart', { ...ENTRY });
  const settings = structuredClone(a.settings);
  settings.hooks.SessionStart[0].matcher = 'startup';
  const forged = addHookEntry(settings, 'Stop', { type: 'command', command: 'node mine.mjs' });
  const r = revertPatches(forged.settings, [a.patch, forged.patch], PRODUCIBLE);
  assert.deepEqual(r.kept, [{ patch: forged.patch, reason: 'not-generator-producible' }, { patch: a.patch, reason: 'patch-modified' }]);
  assert.deepEqual([r.reverted, r.gone], [[], []]);
  assert.deepEqual(r.settings, forged.settings);
});

test('revertPatch prunes an emptied event but leaves other events', () => {
  const { settings: s1, patch } = addHookEntry({ hooks: { Stop: [{ hooks: [] }] } }, 'SessionStart', ENTRY);
  const { settings: s2 } = revertPatch(s1, patch, PRODUCIBLE);
  assert.equal(s2.hooks.SessionStart, undefined);
  assert.ok(s2.hooks.Stop);
});

// Whole-branch review, F16: this test's fixture was `{ entrySha256:
// 'abc123' }`, and `'abc123'` also fails the NEXT guard (the 64-hex-digit
// check), so the patch was refused whether or not the `container`
// type guard existed. Measured: removing that guard left the whole suite at
// 647/0 — the only production mutation of the nineteen planted that nobody
// noticed. The hash is a valid 64-hex string now, so the `container` guard
// is the only thing that can produce this result.
//
// The guard is genuinely load-bearing against a forged manifest, which is
// why the answer is to pin it rather than remove it: `planUninstall` is
// called UNWRAPPED in uninstall.mjs, so a manifest holding
// `{ container: 123, entrySha256: "<64 hex>" }` would reach
// `patch.container.startsWith('/hooks/')`, throw a TypeError and exit 1 —
// breaking the "the CLI contract is exit 0, 2 or 3 and nothing else" rule
// that file states in its own first comment.
const VALID_SHA = 'a'.repeat(64);

const reasons = r => r.kept.map(k => k.reason);

test('revertPatch keeps a patch missing its container, without throwing', () => {
  const settings = { hooks: { SessionStart: [{ hooks: [ENTRY] }] } };
  const r = revertPatch(settings, { entrySha256: VALID_SHA }, PRODUCIBLE);
  assert.deepEqual(reasons(r), ['patch-malformed'], 'the hash is valid, so only the missing container can refuse this');
});

test('F16: revertPatch keeps a patch with a NON-STRING container, without throwing', () => {
  // The shape that would actually crash: a forged manifest whose container
  // is a number, with a hash that passes the next guard. Without the type
  // guard this reaches `.startsWith` on a number and throws.
  const settings = { hooks: { SessionStart: [{ hooks: [ENTRY] }] } };
  for (const container of [123, null, {}, ['/hooks/SessionStart'], true]) {
    assert.doesNotThrow(() => revertPatch(settings, { container, entrySha256: VALID_SHA }, PRODUCIBLE),
      `a forged container of type ${typeof container} must never throw — the CLI contract is exit 0/2/3`);
    assert.deepEqual(reasons(revertPatch(settings, { container, entrySha256: VALID_SHA }, PRODUCIBLE)), ['patch-malformed']);
  }
});

test('revertPatch keeps a patch whose container does not start with /hooks/', () => {
  const patch = { container: '/unknown/container', entrySha256: 'abc123abc123abc123abc123abc123abc123abc123abc123abc123abc123abc1' };
  const settings = { hooks: { SessionStart: [{ hooks: [ENTRY] }] } };
  assert.deepEqual(reasons(revertPatch(settings, patch, PRODUCIBLE)), ['patch-malformed']);
});

test('revertPatch keeps a patch whose entrySha256 is malformed', () => {
  const patch = { container: '/hooks/SessionStart', entrySha256: 'not-a-valid-hex' };
  const settings = { hooks: { SessionStart: [{ hooks: [ENTRY] }] } };
  assert.deepEqual(reasons(revertPatch(settings, patch, PRODUCIBLE)), ['patch-malformed']);
});

test('revertPatch keeps a null patch without throwing', () => {
  const settings = { hooks: { SessionStart: [{ hooks: [ENTRY] }] } };
  assert.deepEqual(reasons(revertPatch(settings, null, PRODUCIBLE)), ['patch-malformed']);
});

test('revertPatch keeps an undefined patch without throwing', () => {
  const settings = { hooks: { SessionStart: [{ hooks: [ENTRY] }] } };
  assert.deepEqual(reasons(revertPatch(settings, undefined, PRODUCIBLE)), ['patch-malformed']);
});

// Provenance: a matching hash proves only that the settings still hold what
// the manifest claims, so producibility is checked independently of it.

test('revertPatch keeps a hook entry whose hash matches but whose script no generator registers', () => {
  const theirs = { type: 'command', command: 'node', args: ['${CLAUDE_PROJECT_DIR}/scripts/mine.mjs'] };
  const { settings: s1, patch } = addHookEntry({}, 'SessionStart', theirs);
  const { settings: s2, kept } = revertPatch(s1, patch, PRODUCIBLE);
  assert.deepEqual(kept, [{ patch, reason: 'not-generator-producible' }]);
  assert.deepEqual(s2, s1);
});

test('revertPatch credits the legacy shell form `node <script>` only as that exact string', () => {
  const legacy = addHookEntry({}, 'SessionStart', { type: 'command', command: 'node .claude/scripts/session-brief.mjs' });
  assert.deepEqual(revertPatch(legacy.settings, legacy.patch, PRODUCIBLE).kept, []);
  const more = addHookEntry({}, 'SessionStart', { type: 'command', command: 'node .claude/scripts/session-brief.mjs && ./mine.sh' });
  assert.deepEqual(reasons(revertPatch(more.settings, more.patch, PRODUCIBLE)), ['not-generator-producible']);
});

const OUR_SCRIPT = '${CLAUDE_PROJECT_DIR}/.claude/scripts/session-brief.mjs';

test('an exec-form hook exactly as the generator writes it is reverted', () => {
  const ours = addHookEntry({}, 'SessionStart', { type: 'command', command: 'node', args: [OUR_SCRIPT] });
  assert.deepEqual(revertPatch(ours.settings, ours.patch, PRODUCIBLE).kept, []);
});

test('an exec-form hook with an extra argument is kept', () => {
  const extra = addHookEntry({}, 'SessionStart', { type: 'command', command: 'node', args: [OUR_SCRIPT, '--flag'] });
  const { settings, kept } = revertPatch(extra.settings, extra.patch, PRODUCIBLE);
  assert.deepEqual(kept, [{ patch: extra.patch, reason: 'not-generator-producible' }]);
  assert.deepEqual(settings, extra.settings);
});

test('a recorded entry-script registration is reverted, and one carrying a second argument is kept', () => {
  const settings = { hooks: { PreToolUse: [{ hooks: [execEntry(DISPATCH_PRE_PATH)] }] } };
  const ours = addHookEntry({}, 'PreToolUse', execEntry(DISPATCH_PRE_PATH));
  assert.deepEqual(ours.settings, settings, 'fixture sanity: the patch writes exactly that registration');
  const reverted = revertPatch(settings, ours.patch, PRODUCIBLE);
  assert.deepEqual(reverted.kept, []);
  assert.deepEqual(reverted.settings, {});
  const entry = execEntry(DISPATCH_PRE_PATH);
  const extra = addHookEntry({}, 'PreToolUse', { ...entry, args: [...entry.args, '--flag'] });
  assert.equal(extra.settings.hooks.PreToolUse[0].hooks[0].args.length, 2);
  const { settings: after, kept } = revertPatch(extra.settings, extra.patch, PRODUCIBLE);
  assert.deepEqual(kept, [{ patch: extra.patch, reason: 'not-generator-producible' }]);
  assert.deepEqual(after, extra.settings);
});

test('an exec-form hook run by another command is kept', () => {
  const bun = addHookEntry({}, 'SessionStart', { type: 'command', command: 'bun', args: [OUR_SCRIPT] });
  const { settings, kept } = revertPatch(bun.settings, bun.patch, PRODUCIBLE);
  assert.deepEqual(kept, [{ patch: bun.patch, reason: 'not-generator-producible' }]);
  assert.deepEqual(settings, bun.settings);
});

test('revertPatch keeps a deny patch naming a rule no generator produces', () => {
  const before = { permissions: { deny: ['Bash(rm:*)'] } };
  const { patch } = addDenyRules({}, ['Bash(rm:*)']);
  const { settings: s2, kept } = revertPatch(before, patch, PRODUCIBLE);
  assert.deepEqual(kept, [{ patch, reason: 'not-generator-producible' }]);
  assert.deepEqual(s2, before);
});

test('revertPatch keeps a deny patch whose entrySha256 is not the hash of its rules', () => {
  const { settings: s1, patch } = addDenyRules({}, ['Edit(migrations/**)']);
  const forged = { ...patch, entrySha256: VALID_SHA };
  assert.deepEqual(reasons(revertPatch(s1, forged, PRODUCIBLE)), ['patch-malformed']);
  assert.deepEqual(reasons(revertPatch(s1, { ...patch, rules: [] }, PRODUCIBLE)), ['patch-malformed']);
});

test('revertPatch with valid patch still reverts correctly', () => {
  const { settings: s1, patch } = addHookEntry({}, 'SessionStart', ENTRY);
  s1.hooks.SessionStart.unshift({ hooks: [{ type: 'command', command: 'user-added' }] });
  const { settings: s2, kept } = revertPatch(s1, patch, PRODUCIBLE);
  assert.deepEqual(kept, [], 'valid patch must still revert');
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
  const { settings: s2, kept } = revertPatch(s1, patch, PRODUCIBLE);
  assert.deepEqual(kept, []);
  assert.deepEqual(s2.permissions.deny, ['Bash(rm:*)', 'Read(./.env)'], 'both of theirs survive');
});

test('a deny patch whose rules were all removed by hand is gone, not kept', () => {
  const { settings: s1, patch } = addDenyRules({ permissions: { deny: ['Bash(rm:*)'] } }, ['Edit(migrations/**)']);
  s1.permissions.deny = ['Bash(rm:*)'];
  const r = revertPatch(s1, patch, PRODUCIBLE);
  assert.deepEqual([r.kept, r.gone], [[], true]);
  assert.deepEqual(r.settings, s1);
  assert.equal(revertPatch({}, patch, PRODUCIBLE).gone, true, 'with no deny list at all');
});

test('a deny patch with one rule removed by hand still has the rest reverted', () => {
  const { settings: s1, patch } = addDenyRules({ permissions: { deny: ['Bash(rm:*)'] } }, ['Edit(migrations/**)', 'Edit(y)']);
  s1.permissions.deny = s1.permissions.deny.filter(rule => rule !== 'Edit(y)');
  const r = revertPatch(s1, patch, PRODUCIBLE);
  assert.deepEqual([r.kept, r.gone], [[], false]);
  assert.deepEqual(r.settings.permissions.deny, ['Bash(rm:*)'], 'the kit\'s remaining rule goes, the user\'s stays');
});

test('reverting the last deny rule prunes the empty structure', () => {
  const { settings: s1, patch } = addDenyRules({}, ['Edit(migrations/**)']);
  const { settings: s2 } = revertPatch(s1, patch, PRODUCIBLE);
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
  const { settings: s2 } = revertPatch(s1, patch, PRODUCIBLE);
  assert.equal(s2.permissions, undefined, 'permissions object must be pruned, not left as {}');
});

test('reverting the last deny rule leaves the user\'s other deny rules intact', () => {
  const before = { permissions: { deny: ['Edit(x)'], allow: ['Read(*)'], defaultMode: 'allow' } };
  const { settings: s1, patch } = addDenyRules(before, ['Edit(y)']);
  const { settings: s2 } = revertPatch(s1, patch, PRODUCIBLE);
  assert.ok(s2.permissions, 'permissions object must be preserved');
  assert.equal(s2.permissions.deny.length, 1);
  assert.deepEqual(s2.permissions.deny, ['Edit(x)']);
  assert.deepEqual(s2.permissions.allow, ['Read(*)'], 'allow key must survive');
  assert.equal(s2.permissions.defaultMode, 'allow', 'defaultMode must survive');
});

test('reverting the last deny rule prunes deny but keeps sibling keys', () => {
  const before = { permissions: { allow: ['Read(*)'], defaultMode: 'allow' } };
  const { settings: s1, patch } = addDenyRules(before, ['Edit(y)']);
  const { settings: s2 } = revertPatch(s1, patch, PRODUCIBLE);
  assert.ok(s2.permissions, 'permissions must survive because allow/defaultMode remain');
  assert.equal(s2.permissions.deny, undefined, 'the emptied deny array is pruned');
  assert.deepEqual(s2.permissions.allow, ['Read(*)'], 'allow must survive');
  assert.equal(s2.permissions.defaultMode, 'allow', 'defaultMode must survive');
});
