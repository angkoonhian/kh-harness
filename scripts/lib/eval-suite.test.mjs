import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';

const EVALS = resolve(import.meta.dirname, '..', '..', 'evals');

// `claude plugin eval` writes its run output to <evals>/results/ by default —
// that is why .gitignore carries `evals/results/`. It is the tool's output, not
// a case, and enumerating it as one made this suite fail the moment anyone ran
// an eval locally. CI never caught it because the test job runs on a fresh
// checkout where results/ does not exist yet, so the breakage was invisible in
// the only place that was watching. Excluded by name rather than by "skip
// directories that look malformed": a case dir missing its case.yaml IS the
// defect the next test exists to catch, and inferring the exclusion would
// silently skip it.
const NOT_A_CASE = new Set(['results']);

const cases = () => readdirSync(EVALS, { withFileTypes: true })
  .filter(e => e.isDirectory() && !NOT_A_CASE.has(e.name))
  .map(e => e.name).sort();

test('the eval runner\'s own output directory is not mistaken for a case', () => {
  // Regression: running an eval locally created evals/results/, and case
  // enumeration treated it as a case with no case.yaml. Anyone who had run an
  // eval saw a red suite; anyone who had not saw green.
  assert.ok(!cases().includes('results'),
    'evals/results/ is the runner\'s output directory, not a case');

  // The exclusion is only legitimate because that path is tool output. If it
  // ever stops being gitignored, the premise is wrong and this should fail
  // rather than quietly hide a real directory.
  const ignore = readFileSync(resolve(import.meta.dirname, '..', '..', '.gitignore'), 'utf8');
  assert.match(ignore, /^\s*evals\/results\/?\s*$/m,
    'evals/results/ must stay gitignored, or excluding it from cases is unjustified');

  // And the exclusion must not have eaten the real cases.
  assert.ok(cases().length >= 2,
    `expected the real eval cases to survive enumeration, got: ${cases().join(', ') || '(none)'}`);
});

test('LOAD-BEARING: a failing eval job says WHY, and keeps its evidence', () => {
  // A first CI run of this job failed in 13 seconds reporting nothing but
  // "exit code 1". The result JSON — the only place the per-arm reason lives —
  // stayed on the runner and was deleted with it. Undiagnosable red is the
  // mirror of the green check that measured nothing; both have now shipped
  // here, so both get a test.
  const ci = readFileSync(
    resolve(import.meta.dirname, '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8');

  assert.match(ci, /\.cases\[\]\?/,
    'the job must print per-arm outcomes; the aggregate alone cannot distinguish an abort from a measured zero');
  assert.match(ci, /\.value\[0\]\.error/,
    'the per-arm error is the field that names the blocker — print it');
  assert.match(ci, /upload-artifact/,
    'the result JSON and report must outlive the runner, or a failure is unreproducible');
  assert.match(ci, /if:\s*always\(\)/,
    'the upload must run on failure too — that is the case it exists for');

  // The exit code has to survive the diagnostics, or a failing eval reports
  // success and the gate becomes decorative.
  //
  // Anchored to a line that is ONLY `exit $code`. A bare /exit \$code/ also
  // matched the validate step's error text `(exit $code)` in a different job,
  // so deleting the real statement left this assertion green — the same
  // duplicate-match flaw this suite already fixed once in the README tests.
  assert.match(ci, /^\s*exit \$code\s*$/m,
    'the eval must still fail the job after printing its diagnosis');
});

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

test('LOAD-BEARING: an unconfigured eval suite skips rather than reporting green', () => {
  // Measured on PR #4: the eval job exited 0 when ANTHROPIC_API_KEY was unset,
  // which rendered as "eval  pass  9s" in the checks list. A passing eval and
  // an eval that never ran looked identical to anyone scanning the PR.
  //
  // The fix is structural, so the test is structural: the eval job must gate on
  // a separate job's output so an unconfigured run shows as SKIPPED. Asserted
  // here because the tempting "simplification" — fold the check back into the
  // eval step and exit 0 — silently restores the lie while CI stays green.
  const ci = readFileSync(
    resolve(import.meta.dirname, '..', '..', '.github', 'workflows', 'ci.yml'), 'utf8');

  assert.match(ci, /^\s*eval-gate:/m,
    'the gate job is gone; without it the eval job cannot read a secret to gate on');
  assert.match(ci, /needs:\s*eval-gate/,
    'the eval job must depend on the gate, or it runs unconditionally');
  assert.match(ci, /if:\s*needs\.eval-gate\.outputs\.configured\s*==\s*'true'/,
    'the eval job must skip when the key is absent, not exit 0 inside the job');

  // The specific regression: a success exit inside the eval step's own guard.
  const evalJob = ci.slice(ci.indexOf('\n  eval:'));
  assert.doesNotMatch(evalJob, /ANTHROPIC_API_KEY:-\}"?\s*\]\s*;\s*then[\s\S]{0,400}?exit 0/,
    'exiting 0 on a missing key is what made a green check that measured nothing');
});

test('a grader asserts the original CLAUDE.md is untouched', () => {
  const dir = join(EVALS, 'existing-claude-md', 'graders');
  const bodies = readdirSync(dir).map(f => readFileSync(join(dir, f), 'utf8')).join('\n');
  assert.match(bodies, /CLAUDE\.proposed\.md/,
    'the proposal is the deliverable; the original must not be rewritten');
});
