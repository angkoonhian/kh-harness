import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const EVALS = resolve(import.meta.dirname, '..', '..', 'evals');
const cases = () => readdirSync(EVALS, { withFileTypes: true })
  .filter(e => e.isDirectory()).map(e => e.name).sort();

test('every eval case has a prompt and at least one grader', () => {
  for (const c of cases()) {
    const hasPrompt = existsSync(join(EVALS, c, 'prompt.md')) || existsSync(join(EVALS, c, 'case.yaml'));
    assert.ok(hasPrompt, `${c} has neither prompt.md nor case.yaml`);
    const graders = existsSync(join(EVALS, c, 'graders'))
      ? readdirSync(join(EVALS, c, 'graders')).filter(f => f.endsWith('.md')) : [];
    assert.ok(graders.length > 0, `${c} has no graders`);
  }
});

test('LOAD-BEARING: at least one grader provably cannot pass without the plugin', () => {
  // The runtime excludes such graders from without-arm scoring, which is what
  // makes the delta meaningful. A suite of only regex/file_exists graders can
  // pass both arms and report a delta of zero while measuring nothing.
  let discriminating = 0;
  for (const c of cases()) {
    const dir = join(EVALS, c, 'graders');
    if (!existsSync(dir)) continue;
    for (const g of readdirSync(dir).filter(f => f.endsWith('.md'))) {
      if (/^\s*type:\s*tool_used\b/m.test(readFileSync(join(dir, g), 'utf8'))) discriminating++;
    }
  }
  assert.ok(discriminating >= 1,
    'write at least one tool_used grader, or the baseline arm proves nothing');
});

test('the existing-CLAUDE.md case scaffolds a CLAUDE.md to protect', () => {
  const dir = join(EVALS, 'existing-claude-md');
  const text = existsSync(join(dir, 'case.yaml'))
    ? readFileSync(join(dir, 'case.yaml'), 'utf8')
    : readFileSync(join(dir, 'prompt.md'), 'utf8');
  assert.match(text, /CLAUDE\.md/,
    'the case must put a CLAUDE.md in the fixture, or it cannot test that we leave it alone');
});

test('a grader asserts the original CLAUDE.md is untouched', () => {
  const dir = join(EVALS, 'existing-claude-md', 'graders');
  const bodies = readdirSync(dir).map(f => readFileSync(join(dir, f), 'utf8')).join('\n');
  assert.match(bodies, /CLAUDE\.proposed\.md/,
    'the proposal is the deliverable; the original must not be rewritten');
});
