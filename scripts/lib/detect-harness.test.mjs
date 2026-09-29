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
  assert.deepEqual(h.claudeDir.hookEvents.SessionStart, ['node docs/agent-context/inject.js']);
  // The file list is inventory only; it must not be what decides coverage.
  assert.deepEqual(h.claudeDir.hooks, []);
});

test('hookEvents groups several events and several commands per event', () => {
  const d = repo();
  write(d, '.claude/settings.json', JSON.stringify({
    hooks: {
      PostToolUse: [
        { matcher: 'Edit|Write', hooks: [{ type: 'command', command: 'bin/fmt.sh' }] },
        { matcher: 'Edit', hooks: [{ type: 'command', command: 'bin/lint.sh' }] },
      ],
      Stop: [{ hooks: [{ type: 'command', command: 'make verify' }] }],
    },
  }));
  const ev = run(d).claudeDir.hookEvents;
  assert.deepEqual(ev.PostToolUse, ['bin/fmt.sh', 'bin/lint.sh']);
  assert.deepEqual(ev.Stop, ['make verify']);
});

test('hookEvents also reads .claude/settings.local.json', () => {
  const d = repo();
  write(d, '.claude/settings.json', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: 'a' }] }] } }));
  write(d, '.claude/settings.local.json', JSON.stringify({ hooks: { PostToolUse: [{ hooks: [{ type: 'command', command: 'b' }] }] } }));
  const ev = run(d).claudeDir.hookEvents;
  assert.deepEqual(ev.Stop, ['a']);
  assert.deepEqual(ev.PostToolUse, ['b']);
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

test('a hook command carrying a credential is redacted before it reaches the report', () => {
  const d = repo();
  const SECRET = 'glpat-' + 'Q'.repeat(20);
  write(d, '.claude/settings.json', JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: `curl -H "PRIVATE-TOKEN: ${SECRET}" https://example.invalid` }] }] },
  }));
  const serialised = JSON.stringify(run(d));
  assert.equal(serialised.includes(SECRET), false, 'a hook command must not republish a credential');
  assert.ok(/redacted/.test(run(d).claudeDir.hookEvents.SessionStart[0]), 'the command should still be shown, with the value masked');
});
