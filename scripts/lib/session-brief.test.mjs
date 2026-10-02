import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import { MAX_REPORT_BYTES, MAX_REPORT_LINES, HANDOFF_CANDIDATES } from '../../assets/scripts/harness-redact.mjs';
import { detectHarness } from './detect-harness.mjs';

const SCRIPT = resolve(import.meta.dirname, '..', '..', 'assets', 'scripts', 'session-brief.mjs');
const run = (cwd, env = {}) => execFileSync(process.execPath, [SCRIPT], {
  cwd, encoding: 'utf8', env: { ...process.env, CLAUDE_PROJECT_DIR: '', ...env },
});
const repo = () => mkdtempSync(join(tmpdir(), 'hk-brief-'));

test('prints the handoff contents when present', () => {
  const d = repo();
  writeFileSync(join(d, 'HANDOFF.md'), '## Where I stopped\nMid-refactor of the parser.\n');
  assert.match(run(d), /Mid-refactor of the parser/);
});

test('says so plainly when there is no handoff, naming where it looked, and still exits 0', () => {
  const d = repo();
  const out = run(d);
  assert.match(out, /no handoff file yet/i);
  // Doctrine: say what was looked FOR, not merely what is not there — the
  // same rule every `lookedFor` in the detection report follows. A user who
  // keeps their handoff elsewhere can tell that from a broken hook.
  for (const c of HANDOFF_CANDIDATES) assert.ok(out.includes(c), `must name ${c}`);
});

test('truncates a very long handoff rather than flooding the session', () => {
  const d = repo();
  writeFileSync(join(d, 'HANDOFF.md'), Array.from({ length: 500 }, (_, i) => `line ${i}`).join('\n'));
  const out = run(d);
  assert.ok(out.split('\n').length < 80, 'a brief that floods the context defeats its own purpose');
  assert.match(out, /truncated/i);
  // Verify actual handoff content survived truncation at the boundary
  assert.match(out, /line 0/);
  assert.match(out, /line 59/);
  assert.doesNotMatch(out, /line 60\b/);
});

// --- Whole-branch review, F3 ----------------------------------------------
//
// Claude Code caps a hook's plain stdout at 10,000 characters. Over the cap
// it saves the output to a file and replaces it with the path plus a
// 2,000-character preview — and it does not ask Claude to read that file. So
// a handoff whose first 60 lines exceed the cap did not flood anything: it
// SILENTLY STOPPED ARRIVING, while `detect` went on reporting
// `P4.sessionbrief declared`. The shared `boundReport` has had this bound
// since it was written, and its neighbour's comment cited THIS file as the
// model for the line bound it does have.
//
// About 167 characters per line over 60 lines reaches the cap, which a real
// handoff with pasted error text does easily — the shipped template's "What
// didn't work … Error text if there was one" section invites exactly that
// and calls itself the most valuable section.
test('F3: a handoff whose first 60 lines exceed 10,000 characters is bounded to within the hook-output cap', () => {
  const d = repo();
  const long = Array.from({ length: MAX_REPORT_LINES }, (_, i) => `line ${i}: ` + 'E'.repeat(400)).join('\n');
  writeFileSync(join(d, 'HANDOFF.md'), long + '\n');
  assert.ok(long.length > MAX_REPORT_BYTES * 2, 'fixture sanity: the first 60 lines must genuinely exceed the cap');

  const out = run(d);
  assert.ok(Buffer.byteLength(out, 'utf8') <= MAX_REPORT_BYTES,
    `stdout must stay within Claude Code's 10,000-character cap, got ${Buffer.byteLength(out, 'utf8')} bytes`);
  assert.match(out, /truncated: output exceeded the byte limit/);
  // Still useful: the top of the handoff is what actually reaches the session.
  assert.match(out, /line 0:/);
});

test('F3: a single enormous line — no line-count bound can catch this — is still bounded', () => {
  const d = repo();
  writeFileSync(join(d, 'HANDOFF.md'), '# Handoff\n' + 'A'.repeat(2_000_000) + '\n');
  const out = run(d);
  assert.ok(Buffer.byteLength(out, 'utf8') <= MAX_REPORT_BYTES,
    `a 2 MB single line must not reach the session: got ${Buffer.byteLength(out, 'utf8')} bytes`);
  assert.match(out, /truncated: output exceeded the byte limit/);
});

// --- Whole-branch review, F4 ----------------------------------------------
//
// `detect` credited `P4.handoff` for `docs/HANDOFF.md`; the hook it installs
// read root `HANDOFF.md` and nothing else, so every session in such a
// repository opened with a sentence this same tool had already proved false
// — printed into the model's context, not a terminal, so a false PREMISE the
// agent starts from.

test('F4: the hook reads docs/HANDOFF.md — the other location detection credits', () => {
  const d = repo();
  mkdirSync(join(d, 'docs'), { recursive: true });
  writeFileSync(join(d, 'docs/HANDOFF.md'), '## Where I stopped\nThe migration is half-applied.\n');
  const out = run(d);
  assert.match(out, /The migration is half-applied/);
  assert.doesNotMatch(out, /no handoff file yet/i, 'the hook must never deny a file detection already credited');
  assert.match(out, /docs\/HANDOFF\.md/, 'and it must name which of the two it read');
});

test('F4: detection and the hook resolve the SAME path, in the same precedence order', () => {
  const d = repo();
  mkdirSync(join(d, 'docs'), { recursive: true });
  writeFileSync(join(d, 'docs/HANDOFF.md'), 'under docs\n');
  assert.equal(detectHarness(d, []).handoff, 'docs/HANDOFF.md');
  assert.match(run(d), /docs\/HANDOFF\.md/);

  // Root wins when both exist — one order, one function, both sides.
  writeFileSync(join(d, 'HANDOFF.md'), 'at root\n');
  assert.equal(detectHarness(d, []).handoff, 'HANDOFF.md');
  const out = run(d);
  assert.match(out, /at root/);
  assert.doesNotMatch(out, /under docs/);
});

test('F4: CLAUDE_PROJECT_DIR is honoured, like the other two hooks, so a non-root cwd is not a false "no handoff"', () => {
  const d = repo();
  writeFileSync(join(d, 'HANDOFF.md'), '## Where I stopped\nAt the edge of the parser.\n');
  mkdirSync(join(d, 'sub/deeper'), { recursive: true });
  // cwd is NOT the project root — exactly the case the old bare
  // `process.cwd()` documented as an assumption rather than removing.
  const out = run(join(d, 'sub/deeper'), { CLAUDE_PROJECT_DIR: d });
  assert.match(out, /At the edge of the parser/);
  assert.doesNotMatch(out, /no handoff file yet/i);
});
