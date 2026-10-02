import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listFiles } from './scan.mjs';
import { detectHarness } from './detect-harness.mjs';

function write(d, rel, content) {
  const p = join(d, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}
function repo() { return mkdtempSync(join(tmpdir(), 'hk-harness-')); }
function run(d) { return detectHarness(d, listFiles(d).files); }

test('bare repository reports nothing present', () => {
  const d = repo();
  write(d, 'README.md', '# x');
  const h = run(d);
  assert.equal(h.instructions.path, null);
  assert.equal(h.instructions.lines, 0);
  assert.equal(h.architecture, null);
  assert.equal(h.bootstrap, null);
  assert.deepEqual(h.claudeDir.agents, []);
});

test('counts instruction file lines', () => {
  const d = repo();
  write(d, 'CLAUDE.md', 'a\nb\nc\n');
  const h = run(d);
  assert.equal(h.instructions.path, 'CLAUDE.md');
  assert.equal(h.instructions.lines, 3);
});

test('prefers CLAUDE.md but records AGENTS.md separately', () => {
  const d = repo();
  write(d, 'CLAUDE.md', 'x\n');
  write(d, 'AGENTS.md', 'y\n');
  const h = run(d);
  assert.equal(h.instructions.path, 'CLAUDE.md');
  assert.equal(h.agentsMd, 'AGENTS.md');
});

test('falls back to AGENTS.md as the instruction file', () => {
  const d = repo();
  write(d, 'AGENTS.md', 'y\n');
  assert.equal(run(d).instructions.path, 'AGENTS.md');
});

test('enumerates .claude contents', () => {
  const d = repo();
  write(d, '.claude/settings.json', '{}');
  write(d, '.claude/agents/critic-a.md', '#');
  write(d, '.claude/agents/critic-b.md', '#');
  write(d, '.claude/scripts/hook.mjs', '//');
  write(d, '.claude/rules/api.md', '#');
  const h = run(d);
  assert.equal(h.claudeDir.settings, true);
  assert.equal(h.claudeDir.agents.length, 2);
  assert.equal(h.claudeDir.rules.length, 1);
});

test('finds a bootstrap script under any common name', () => {
  const d = repo();
  write(d, 'scripts/setup.sh', '#!/bin/sh\n');
  assert.equal(run(d).bootstrap, 'scripts/setup.sh');
});

test('detects other editors', () => {
  const d = repo();
  write(d, '.github/copilot-instructions.md', '#');
  write(d, '.cursor/rules/x.mdc', '#');
  const h = run(d);
  assert.ok(h.otherEditors.includes('.github/copilot-instructions.md'));
  assert.ok(h.otherEditors.some(p => p.startsWith('.cursor/rules')));
});

// --- Task 9b, finding 6: claudeDir.settings must agree with its siblings -

test('claudeDir.settings and localSettings are true even when the file list cannot see them (e.g. gitignored .claude/), matching the siblings that already read the real file', () => {
  const d = repo();
  write(d, '.claude/settings.json', JSON.stringify({ permissions: { deny: ['Edit(x)'] } }));
  write(d, '.claude/settings.local.json', JSON.stringify({ hooks: {} }));
  // The defect: a `files` list that does NOT include either settings file —
  // exactly what a gitignored `.claude/` produces from the real scan — must
  // not make `settings`/`localSettings` disagree with denyRules/denyRuleList,
  // which are read straight off disk regardless of what `files` says.
  const filesAsIfGitignored = ['README.md'];
  const h = detectHarness(d, filesAsIfGitignored);
  assert.equal(h.claudeDir.settings, true, 'settings must be read the SAME way denyRules was, not from the (gitignored) file list');
  assert.equal(h.claudeDir.localSettings, true);
  assert.equal(h.claudeDir.denyRules, 1, 'fixture sanity: the sibling field this one must agree with really is non-zero');
});

test('claudeDir.settings is false when no settings file exists at all', () => {
  const d = repo();
  write(d, 'README.md', '# x');
  assert.equal(run(d).claudeDir.settings, false);
  assert.equal(run(d).claudeDir.localSettings, false);
});

test('denyRules is 0 when there is no settings file', () => {
  const d = repo();
  write(d, 'README.md', '# x');
  assert.equal(run(d).claudeDir.denyRules, 0);
});

test('denyRules is 0 when settings.json has no permissions key', () => {
  const d = repo();
  write(d, '.claude/settings.json', JSON.stringify({ hooks: {} }));
  assert.equal(run(d).claudeDir.denyRules, 0);
});

test('denyRules is 0 when the deny array is empty', () => {
  const d = repo();
  write(d, '.claude/settings.json', JSON.stringify({ permissions: { deny: [] } }));
  assert.equal(run(d).claudeDir.denyRules, 0);
});

test('denyRules counts entries in permissions.deny', () => {
  const d = repo();
  write(d, '.claude/settings.json', JSON.stringify({ permissions: { deny: ['Read(./.env)', 'Write(./secrets/**)'] } }));
  assert.equal(run(d).claudeDir.denyRules, 2);
});

test('denyRules is 0 for malformed JSON, and detectHarness does not throw', () => {
  const d = repo();
  write(d, '.claude/settings.json', '{ this is not json');
  assert.doesNotThrow(() => run(d));
  assert.equal(run(d).claudeDir.denyRules, 0);
});

// --- denyRuleList: Task 8b's gap-model.mjs needs the actual rule STRINGS
// (not just a count) to tell "our own derived rules are present" from
// "something is present". Safely filtered the same way `hookEvents` is:
// `harness` is serialised wholesale into docs/harness/detect.json on every
// run, and a `Bash(...)` deny rule can embed a literal credential as its
// argument (see apply-lib.mjs's own comment on `renderSettingsDenyDiff`).

test('denyRuleList keeps a path-taking permission rule verbatim', () => {
  const d = repo();
  write(d, '.claude/settings.json', JSON.stringify({ permissions: { deny: ['Edit(secrets/**)', 'Read(./.env)'] } }));
  assert.deepEqual(run(d).claudeDir.denyRuleList, ['Edit(secrets/**)', 'Read(./.env)']);
});

test('denyRuleList redacts a Bash(...) rule to null, never the raw string', () => {
  const d = repo();
  write(d, '.claude/settings.json', JSON.stringify({ permissions: { deny: ["Bash(curl -H 'PRIVATE-TOKEN: ghp_SECRET')"] } }));
  const list = run(d).claudeDir.denyRuleList;
  assert.deepEqual(list, [null]);
  const full = JSON.stringify(run(d));
  assert.equal(full.includes('ghp_SECRET'), false, 'the credential must never reach the serialised harness');
});

test('denyRuleList is [] when there is no settings file, and does not throw on malformed JSON', () => {
  const d = repo();
  write(d, 'README.md', '# x');
  assert.deepEqual(run(d).claudeDir.denyRuleList, []);
  write(d, '.claude/settings.json', '{ not json');
  assert.doesNotThrow(() => run(d));
  assert.deepEqual(run(d).claudeDir.denyRuleList, []);
});

// --- hookEvents: the registry, not the filenames ---
//
// .claude/settings.json is an exact record of what is wired up. A hook's
// script may live anywhere in the repository, so the file list under
// .claude/scripts/ cannot answer whether an event is covered.

test('hookEvents records a SessionStart hook whose script lives outside .claude/scripts/', () => {
  const d = repo();
  write(d, '.claude/settings.json', JSON.stringify({
    hooks: { SessionStart: [{ matcher: 'startup|resume|compact', hooks: [{ type: 'command', command: 'node docs/agent-context/inject.js' }] }] },
  }));
  write(d, 'docs/agent-context/inject.js', '//');
  const h = run(d);
  assert.deepEqual(h.claudeDir.hookEvents.SessionStart, ['docs/agent-context/inject.js']);
  // The file list is inventory only; it must not be what decides coverage.
  assert.deepEqual(h.claudeDir.hooks, []);
});

test('hookEvents groups several events and several hooks per event', () => {
  const d = repo();
  write(d, 'bin/fmt.sh', '#');
  write(d, 'bin/lint.sh', '#');
  write(d, '.claude/settings.json', JSON.stringify({
    hooks: {
      PostToolUse: [
        { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'sh bin/fmt.sh --write' }] },
        { matcher: 'Edit', hooks: [{ type: 'command', command: 'sh bin/lint.sh' }] },
      ],
      // Nothing in `make verify` is a path in this repository, so no script
      // resolves and the entry is null: registered, but unnameable.
      Stop: [{ hooks: [{ type: 'command', command: 'make verify' }] }],
    },
  }));
  const ev = run(d).claudeDir.hookEvents;
  assert.deepEqual(ev.PostToolUse, ['bin/fmt.sh', 'bin/lint.sh']);
  assert.deepEqual(ev.Stop, [null]);
});

test('hookEvents also reads .claude/settings.local.json', () => {
  const d = repo();
  write(d, 'a.mjs', '//');
  write(d, 'b.mjs', '//');
  write(d, '.claude/settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'node a.mjs' }] }] } }));
  write(d, '.claude/settings.local.json', JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'node b.mjs' }] }] } }));
  const ev = run(d).claudeDir.hookEvents;
  assert.deepEqual(ev.Stop, ['a.mjs']);
  assert.deepEqual(ev.PostToolUse, ['b.mjs']);
});

test('hookEvents is empty for a missing, malformed or hook-less settings file', () => {
  const none = repo();
  write(none, 'README.md', '# x');
  assert.deepEqual(run(none).claudeDir.hookEvents, {});

  const bad = repo();
  write(bad, '.claude/settings.json', '{ this is not json');
  assert.doesNotThrow(() => run(bad));
  assert.deepEqual(run(bad).claudeDir.hookEvents, {});

  const shapeless = repo();
  write(shapeless, '.claude/settings.json', JSON.stringify({ hooks: { Stop: 'not-an-array', SessionStart: [{ hooks: [{ type: 'command' }] }] } }));
  assert.doesNotThrow(() => run(shapeless));
  assert.deepEqual(run(shapeless).claudeDir.hookEvents, {});
});

// --- Remote credential detection, at the producer ---
//
// Until now this was only ever tested through a hand-built fixture
// (`{ remotes: [{ hasCredential: true }] }`), which supplies the answer the
// code was supposed to compute: forcing hasCredential to false left the whole
// suite green. These run against real `git remote` configuration.

const SECRET = 'ghp_' + 'T'.repeat(36);

function repoWithRemote(url, name = 'origin') {
  const d = repo();
  write(d, 'README.md', '# x');
  execFileSync('git', ['init', '-q', d], { stdio: 'ignore' });
  execFileSync('git', ['-C', d, 'remote', 'add', name, url], { stdio: 'ignore' });
  return d;
}

// A false positive here is one line telling you to check a URL; a false
// negative is a live token left unreported.
for (const [label, url, expected] of [
  ['user:pass', `https://user:${SECRET}@host.invalid/o/r.git`, true],
  ['oauth2 userinfo', `https://oauth2:${SECRET}@gitlab.com/o/r.git`, true],
  ['x-access-token userinfo', `https://x-access-token:${SECRET}@github.com/o/r.git`, true],
  ['single-token userinfo — the commonest shape', `https://${SECRET}@github.com/o/r.git`, true],
  ['ssh git@ (not a credential)', 'ssh://git@github.com/o/r.git', false],
  ['scp-style git@ (not a credential)', 'git@github.com:o/r.git', false],
  ['clean https', 'https://github.com/o/r.git', false],
]) {
  test(`remote credential detection: ${label} -> ${expected}`, () => {
    const h = run(repoWithRemote(url));
    assert.deepEqual(h.remotes, [{ name: 'origin', hasCredential: expected }],
      `${url} should${expected ? '' : ' not'} be flagged`);
  });
}

test('NEVER records the remote URL itself, only whether a credential is present', () => {
  const h = run(repoWithRemote(`https://${SECRET}@github.com/o/r.git`));
  const serialised = JSON.stringify(h);
  assert.equal(serialised.includes(SECRET), false);
  assert.equal(serialised.includes('github.com'), false);
});

// --- docPointers: the repository's own pointer at its documentation ---
//
// The set of names people give an architecture document is unbounded; the set
// of ways a repository points at its own documentation is small and readable.
// Every candidate is resolved against the file list, so anything that is not a
// real path simply vanishes — no guessing, no content sniffing.

test('docPointers resolves an @path import in the instruction file', () => {
  const d = repo();
  write(d, 'CLAUDE.md', 'See @docs/agent-context/CONVENTIONS.md for the rules.\n');
  write(d, 'docs/agent-context/CONVENTIONS.md', '# conventions\n');
  assert.deepEqual(run(d).docPointers, ['docs/agent-context/CONVENTIONS.md']);
});

test('docPointers resolves a markdown link and an inline-code directory', () => {
  const d = repo();
  write(d, 'CLAUDE.md', 'Project structure lives in `docs/wiki/`, see also [the map](docs/map.md).\n');
  write(d, 'docs/wiki/README.md', '# wiki\n');
  write(d, 'docs/wiki/services.md', '# services\n');
  write(d, 'docs/map.md', '# map\n');
  assert.deepEqual(run(d).docPointers, ['docs/map.md', 'docs/wiki/README.md', 'docs/wiki/services.md']);
});

test('docPointers ignores URLs, anchors and paths that do not exist', () => {
  const d = repo();
  write(d, 'CLAUDE.md', [
    'See [upstream](https://example.invalid/docs/ARCHITECTURE.md).',
    'And [a section](#design).',
    'And [a ghost](docs/NOT-THERE.md).',
    'Run `npm test` before pushing.',
    'Mail @someone about it.',
  ].join('\n'));
  write(d, 'docs/real.md', '# real\n');
  assert.deepEqual(run(d).docPointers, []);
});

test('docPointers excludes the kit\'s own outputs — the harness pointing at itself is not evidence', () => {
  const d = repo();
  write(d, 'CLAUDE.md', 'See [handoff](HANDOFF.md), [inventory](docs/harness/recon.md) and @AGENTS.md.\n');
  write(d, 'HANDOFF.md', '# handoff\n');
  write(d, 'AGENTS.md', '# agents\n');
  write(d, 'docs/harness/recon.md', '# recon\n');
  assert.deepEqual(run(d).docPointers, []);
});

test('docPointers is empty when there is no instruction file', () => {
  const d = repo();
  write(d, 'docs/wiki/README.md', '# wiki\n');
  assert.deepEqual(run(d).docPointers, []);
});

test('projectDocs lists docs/ markdown that is not the kit\'s own output', () => {
  const d = repo();
  write(d, 'docs/wiki/README.md', '# wiki\n');
  write(d, 'docs/wiki/services.md', '# services\n');
  write(d, 'docs/harness/recon.md', '# recon\n');
  write(d, 'docs/diagram.png', 'x');
  assert.deepEqual(run(d).projectDocs, ['docs/wiki/README.md', 'docs/wiki/services.md']);
});

// --- F1: projectDocs must find documentation-shaped files anywhere in the
// repository, not only docs/*.md — see gap-model.mjs's P1.architecture,
// which trusts an empty projectDocs to mean "no documentation anywhere".
// docs/ + .md was three filenames' worth of assumption, not an enumeration.

test('projectDocs finds documentation living outside docs/, e.g. under wiki/', () => {
  const d = repo();
  write(d, 'wiki/overview.md', '# overview\n');
  write(d, 'wiki/api.md', '# api\n');
  const h = run(d);
  assert.deepEqual(h.projectDocs, ['wiki/api.md', 'wiki/overview.md']);
});

test('projectDocs recognizes non-markdown documentation shapes: .rst, .adoc, .txt', () => {
  const d = repo();
  write(d, 'docs/index.rst', 'index\n');
  write(d, 'docs/guide.adoc', 'guide\n');
  write(d, 'notes.txt', 'notes\n');
  const h = run(d);
  assert.deepEqual(h.projectDocs, ['docs/guide.adoc', 'docs/index.rst', 'notes.txt']);
});

test('projectDocs still excludes the kit\'s own outputs wherever they are found', () => {
  const d = repo();
  write(d, 'CLAUDE.md', '# instructions\n');
  write(d, 'HANDOFF.md', '# handoff\n');
  write(d, 'docs/harness/recon.md', '# recon\n');
  write(d, '.claude/skills/foo/SKILL.md', '# skill\n');
  const h = run(d);
  assert.deepEqual(h.projectDocs, []);
});

// Coordinator finding (round 2): the wide net for .txt stays wide — that
// is correct, see this file's own PROJECT_DOC_EXTENSIONS comment — but
// requirements.txt/constraints.txt are Python DEPENDENCY MANIFESTS, not
// documentation, a fact this codebase already holds elsewhere (gap-model.mjs's
// P1.bootstrap comment, protected-evidence.mjs's pairedRequirementsFiles).
// Excluding these two already-classified names is not guessing by
// extension — projectDocs still treats every OTHER .txt as documentation-
// shaped, proven by the NOTES.txt case right below.

test('projectDocs excludes requirements.txt and requirements-dev.txt — Python dependency manifests, not documentation', () => {
  const d = repo();
  write(d, 'requirements.txt', 'flask==3.0\n');
  write(d, 'requirements-dev.txt', 'pytest\n');
  // Fixture sanity: both files must actually exist on disk before asserting
  // they are excluded, or "excluded" would be true for the wrong reason.
  assert.ok(listFiles(d).files.includes('requirements.txt'), 'fixture sanity: requirements.txt must actually be present');
  assert.ok(listFiles(d).files.includes('requirements-dev.txt'), 'fixture sanity: requirements-dev.txt must actually be present');
  assert.deepEqual(run(d).projectDocs, []);
});

test('projectDocs excludes constraints.txt the same way, and the directory form requirements/base.txt', () => {
  const d = repo();
  write(d, 'constraints.txt', 'urllib3==2.0\n');
  write(d, 'requirements/base.txt', 'flask==3.0\n');
  assert.ok(listFiles(d).files.includes('constraints.txt'), 'fixture sanity: constraints.txt must actually be present');
  assert.ok(listFiles(d).files.includes('requirements/base.txt'), 'fixture sanity: requirements/base.txt must actually be present');
  assert.deepEqual(run(d).projectDocs, []);
});

test('projectDocs still includes a REAL .txt doc (NOTES.txt) alongside an excluded requirements.txt', () => {
  const d = repo();
  write(d, 'requirements.txt', 'flask==3.0\n');
  write(d, 'NOTES.txt', 'design notes\n');
  assert.deepEqual(run(d).projectDocs, ['NOTES.txt'], 'the wide net for .txt stays wide for anything not already classified as a dependency manifest');
});

// Never the command string, only the script it runs. Secrets live in
// arguments, and .claude/settings.local.json — one of the two files this
// registry is read from — is gitignored and on the credential scanner's
// always-probe list precisely because it holds machine-local secrets. Masking
// against a pattern list would leave the guarantee dependent on that list
// being complete; I1 in this same wave showed it was not.
test('hookEvents records the resolved script, never the command or its arguments', () => {
  const d = repo();
  const UNKNOWN = 'wobbegong-marker-7391-quenelle';   // matches no token pattern
  const KNOWN = 'glpat-' + 'Q'.repeat(20);            // matches one
  write(d, 'tools/inject.js', '//');
  write(d, '.claude/settings.json', JSON.stringify({
    hooks: {
      SessionStart: [{ hooks: [{ type: 'command', command: `node tools/inject.js --token ${UNKNOWN}` }] }],
      Stop: [{ hooks: [{ type: 'command', command: `curl -H "PRIVATE-TOKEN: ${KNOWN}" https://example.invalid` }] }],
    },
  }));
  const h = run(d);
  assert.deepEqual(h.claudeDir.hookEvents.SessionStart, ['tools/inject.js'], 'the script, with the argument list gone');
  assert.deepEqual(h.claudeDir.hookEvents.Stop, [null], 'no path in the command, so nothing is named');

  const serialised = JSON.stringify(h);
  assert.equal(serialised.includes(UNKNOWN), false, 'an unrecognised secret must not survive');
  assert.equal(serialised.includes(KNOWN), false, 'nor a recognised one');
  assert.equal(serialised.includes('example.invalid'), false, 'nor anything else from the command');
});

// --- Whole-branch review, F8: the deny-rule pair read ONE settings file
// --- while `hookEvents`, three fields away, read both ----------------------

test('F8: a deny rule that lives only in settings.local.json is seen, exactly as a hook there already was', () => {
  const d = repo();
  write(d, '.claude/settings.local.json', JSON.stringify({
    permissions: { deny: ['Edit(*-lock.json)'] },
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'node nope.mjs' }] }] },
  }));
  const h = detectHarness(d, listFiles(d).files);
  assert.equal(h.claudeDir.settings, false, 'fixture sanity: there is no settings.json at all');
  assert.equal(h.claudeDir.localSettings, true);
  // The asymmetry F8 measured: hookEvents saw the local file, the deny pair
  // did not, so P2.protected reported `absent` with EMPTY evidence and apply
  // wrote the identical rule a second time into the other file.
  assert.ok(h.claudeDir.hookEvents.SessionStart, 'fixture sanity: hookEvents always read this file');
  assert.equal(h.claudeDir.denyRules, 1, 'a rule in settings.local.json is in effect and must be counted');
  assert.deepEqual(h.claudeDir.denyRuleList, ['Edit(*-lock.json)']);
});

test('F8: denyRules and denyRuleList are the length and the contents of ONE list, merged across both files and deduped', () => {
  const d = repo();
  write(d, '.claude/settings.json', JSON.stringify({ permissions: { deny: ['Edit(a)', 'Edit(shared)'] } }));
  write(d, '.claude/settings.local.json', JSON.stringify({ permissions: { deny: ['Edit(shared)', 'Edit(b)'] } }));
  const h = detectHarness(d, listFiles(d).files);
  assert.deepEqual(h.claudeDir.denyRuleList, ['Edit(a)', 'Edit(shared)', 'Edit(b)'], 'settings.json order first, then the local file, deduped');
  assert.equal(h.claudeDir.denyRules, h.claudeDir.denyRuleList.length, 'the count and the list can never report different lengths');
});

// --- Whole-branch review, F2: claudeDir.rules is read off DISK -------------

test('F2: claudeDir.rules finds a rule file the file scan cannot see (a gitignored .claude/)', () => {
  const d = repo();
  write(d, '.claude/rules/packages-api.md', '---\npaths:\n  - "packages/api/**/*"\n---\n');
  // Exactly what a gitignored `.claude/` produces from the real scan.
  const h = detectHarness(d, ['README.md']);
  assert.deepEqual(h.claudeDir.rules, ['.claude/rules/packages-api.md'],
    'every sibling .claude/ field reads disk; this one used to read the scan list and was therefore permanently empty here');
});

test('F2: claudeDir.rules counts only .md, and finds one in a subdirectory', () => {
  const d = repo();
  write(d, '.claude/rules/.gitkeep', '');
  write(d, '.claude/rules/.DS_Store', 'junk');
  write(d, '.claude/rules/nested/web.md', '# web\n');
  const h = detectHarness(d, listFiles(d).files);
  assert.deepEqual(h.claudeDir.rules, ['.claude/rules/nested/web.md'],
    'Claude Code reads only .md under .claude/rules/, and reads it recursively');
});

test('F2: claudeDir.rules is [] when .claude/rules/ is absent, and never throws', () => {
  const d = repo();
  write(d, 'README.md', '# x');
  assert.doesNotThrow(() => detectHarness(d, listFiles(d).files));
  assert.deepEqual(detectHarness(d, listFiles(d).files).claudeDir.rules, []);
});

test('F2: claudeDir.rules is [] when .claude/rules is a plain FILE, not a directory', () => {
  const d = repo();
  write(d, '.claude/rules', 'not a directory');
  assert.doesNotThrow(() => detectHarness(d, listFiles(d).files));
  assert.deepEqual(detectHarness(d, listFiles(d).files).claudeDir.rules, []);
});
