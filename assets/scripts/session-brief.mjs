#!/usr/bin/env node
// Printed at SessionStart. Reads this repository's handoff file and puts the
// top of it into the session, so the next session starts from what the last
// one wrote down rather than rediscovering it.
//
// Whole-branch review, F3 and F4 — the pair the review named as "the most
// likely way this tool hurts a real user", because this capability has no
// evidence gate (every repository gets it), both failures were silent, and
// both were self-concealing: `detect` went on reporting `P4.sessionbrief
// declared` while the brief stopped arriving, so the symptom a user actually
// meets is not "my handoff broke" but "Claude keeps repeating dead ends I
// wrote down" — the exact failure this capability exists to prevent.
//
//   F3. This bounded its output by LINES only, 60 of them, with no byte
//       bound — while `harness-redact.mjs`, the shared module the other two
//       hooks go through, has had one at exactly Claude Code's documented
//       10,000-character cap since it was written, and its own comment cited
//       THIS file's line bound as the model. Past that cap Claude Code
//       replaces a hook's stdout with a file path and a 2,000-character
//       preview, and does not ask Claude to read the file — so a handoff
//       whose first 60 lines run long (the shipped template's "What didn't
//       work" section explicitly invites pasting error text, and calls
//       itself the most valuable section) simply stopped arriving. It uses
//       `boundReport` now: one bound, three hooks.
//
//   F4. This read `join(process.cwd(), 'HANDOFF.md')` and nothing else,
//       while `detect` credited `P4.handoff` for `docs/HANDOFF.md` too — so
//       in such a repository every session opened with a sentence the same
//       tool had already proved false, three lines above the proposal that
//       installed this file. And a bare `process.cwd()` produced that same
//       false sentence for any invocation whose cwd was not the project
//       root, which its own comment documented as an assumption instead of
//       removing. Both answers now come from `harness-redact.mjs`
//       (`projectRoot`, `findHandoff`) — the same functions `detect` itself
//       reads, so the two cannot disagree again.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { boundReport, findHandoff, projectRoot, HANDOFF_CANDIDATES } from './harness-redact.mjs';

const root = projectRoot();
const rel = findHandoff(root);

if (!rel) {
  // Says what it looked for, not merely what is not there — the same rule
  // every `lookedFor` in the detection report follows. A reader who keeps
  // their handoff somewhere else can now tell that from a broken hook.
  process.stdout.write(`kh-harness: no handoff file yet (looked for ${HANDOFF_CANDIDATES.join(' and ')}, relative to ${root}).\n`);
  process.exit(0);
}

let text = '';
try {
  text = readFileSync(join(root, rel), 'utf8');
} catch {
  process.stdout.write(`kh-harness: ${rel} could not be read.\n`);
  process.exit(0);
}

const lines = text.split('\n');
// `boundReport` bounds by line count AND by bytes, and appends its own
// truncation notice inside the byte budget — so whatever it returns, plus
// the newline below, stays under Claude Code's 10,000-character cap and
// therefore actually reaches the session.
//
// The line-count notice it emits is deliberately kept as well as the byte
// one: "N more lines in the file" tells a user their handoff is longer than
// the brief, which is the actionable half ("prune it"), while "output
// exceeded the byte limit" tells them the brief itself was cut. Both are
// true and they are different facts.
process.stdout.write(boundReport(lines, `--- ${rel} ---\n`) + '\n');
