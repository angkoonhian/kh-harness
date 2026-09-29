// scripts/lib/detect-cli.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const CLI = resolve(import.meta.dirname, '..', 'detect.mjs');

function write(d, rel, content) {
  const p = join(d, rel);
  mkdirSync(join(p, '..'), { recursive: true });
  writeFileSync(p, content);
}
function bare() {
  const d = mkdtempSync(join(tmpdir(), 'hk-cli-'));
  write(d, 'package.json', JSON.stringify({ name: 'app', scripts: { test: 'vitest' } }));
  write(d, 'package-lock.json', '{}');
  write(d, 'tsconfig.json', '{}');
  write(d, 'src/index.ts', 'export const a = 1;');
  return d;
}
function harnessed() {
  const d = bare();
  write(d, 'package.json', JSON.stringify({ name: 'app', scripts: { test: 'vitest', lint: 'eslint .', typecheck: 'tsc --noEmit' } }));
  write(d, 'CLAUDE.md', 'rule\n');
  write(d, 'docs/ARCHITECTURE.md', '# arch\n');
  write(d, 'docs/harness/recon.md', '# recon\n');
  write(d, 'HANDOFF.md', '# handoff\n');
  write(d, 'scripts/bootstrap.sh', '#!/bin/sh\n');
  // P2.protected requires at least one entry under permissions.deny — an empty
  // settings.json is indistinguishable from "no deny rules" and must NOT be
  // treated as protection.
  write(d, '.claude/settings.json', JSON.stringify({ permissions: { deny: ['Edit(migrations/**)'] } }));
  write(d, '.claude/rules/api.md', '#');
  write(d, '.claude/scripts/lint-touched.mjs', '//');
  write(d, '.claude/scripts/verify-touched.mjs', '//');
  write(d, '.claude/scripts/session-brief.mjs', '//');
  // P4.remote is satisfied by having a remote at all; the URL is never contacted.
  execFileSync('git', ['init', '-q', d]);
  execFileSync('git', ['-C', d, 'remote', 'add', 'origin', 'https://example.invalid/x.git']);
  return d;
}
const cli = (d, ...args) => execFileSync(process.execPath, [CLI, d, ...args], { encoding: 'utf8' });

test('writes detect.json into the target repo', () => {
  const d = bare();
  cli(d);
  assert.ok(existsSync(join(d, 'docs', 'harness', 'detect.json')));
  const r = JSON.parse(readFileSync(join(d, 'docs', 'harness', 'detect.json'), 'utf8'));
  assert.equal(r.schema, 1);
  assert.equal(r.profile, 'typescript-single');
});

test('writes NOTHING else', () => {
  const d = bare();
  // Must COMMIT, not just stage: `git add -A` leaves every file as "A " in
  // porcelain output, which would swamp the assertion.
  execFileSync('git', ['init', '-q', d]);
  execFileSync('git', ['-C', d, 'add', '-A']);
  execFileSync('git', ['-C', d, '-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-q', '-m', 'init']);
  cli(d);
  // --untracked-files=all: without it, git collapses a wholly-new directory
  // like "docs/" into a single porcelain line instead of listing the file
  // inside it, which would make this assertion compare against the wrong
  // granularity rather than the actual path written.
  const status = execFileSync('git', ['-C', d, 'status', '--porcelain', '--untracked-files=all'], { encoding: 'utf8' });
  const touched = status.split('\n').map(s => s.slice(3).trim()).filter(Boolean);
  assert.deepEqual(touched, ['docs/harness/detect.json'], `unexpected writes: ${touched}`);
});

test('prints a summary with proposals for a bare repo', () => {
  const out = cli(bare());
  assert.ok(/proposal/.test(out));
  assert.ok(/P1.bootstrap/.test(out));
});

test('LOAD-BEARING: a harnessed repo gets no proposals', () => {
  const out = cli(harnessed());
  assert.match(out, /no proposals/i);
});

test('--json emits the report', () => {
  const r = JSON.parse(cli(bare(), '--json'));
  assert.equal(r.schema, 1);
  assert.ok(Array.isArray(r.checks));
});

test('an empty repo falls back to the generic profile and does not crash', () => {
  const d = mkdtempSync(join(tmpdir(), 'hk-empty-'));
  write(d, 'README.md', '# x\n');
  const r = JSON.parse(cli(d, '--json'));
  assert.equal(r.profile, 'generic');
  assert.ok(r.checks.some(c => c.state === 'n/a'));
});

test('a missing target exits 2', () => {
  assert.throws(
    () => execFileSync(process.execPath, [CLI, join(tmpdir(), 'does-not-exist-hk')], { encoding: 'utf8', stdio: 'pipe' }),
    e => e.status === 2,
  );
});
