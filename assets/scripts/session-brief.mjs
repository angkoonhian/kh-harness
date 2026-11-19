#!/usr/bin/env node
// Printed at SessionStart. Reads this repository's handoff file and puts the
// top of it into the session, so the next session starts from what the last
// one wrote down rather than rediscovering it.
//
// This capability has no evidence gate: every repository gets it. A brief
// that stops arriving is silent, and `detect` goes on reporting
// `P4.sessionbrief declared`, so two things here are load-bearing:
//
//   - The output is bounded by `boundReport`, in lines AND in bytes, to
//     Claude Code's 10,000-character cap on a hook's output. Past that cap
//     Claude Code replaces stdout with a file path and a short preview, and
//     does not ask Claude to read the file; the shipped template's "What
//     didn't work" section invites pasted error text, so a handoff whose
//     first lines run long would otherwise simply not arrive.
//
//   - The file is found by `findHandoff` under `projectRoot`, the same
//     functions `detect` credits `P4.handoff` through, so the hook never
//     tells the model that a handoff `detect` found does not exist, and an
//     invocation whose working directory is not the project root still
//     reads the right file.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The shared asset beside this hook can be older than the hook: `apply`
// leaves a hand-edited copy in place. A static import of a name that copy
// lacks fails at link time with a stack trace at every session start, so the
// asset's shape is probed and a stale or missing one gets one line naming
// the fix, on stdout so it reaches the session, with exit 0, because a
// SessionStart hook has nothing to block. The asset cannot hold this text:
// it is the file that may be missing.
const NEEDED = ['boundReport', 'escapeDelimiters', 'findHandoff', 'HANDOFF_CANDIDATES', 'maskText', 'projectRoot', 'stripUnsafe'];
const REMEDY = 're-run `node scripts/apply.mjs <repo> --yes` from kh-harness to update the shared asset; if apply reports it kept/modified, run `uninstall --yes` and then `apply --yes`.';
let asset;
try {
  asset = await import('./harness-redact.mjs');
} catch {
  process.stdout.write(`kh-harness session-brief: .claude/scripts/harness-redact.mjs is missing or cannot be loaded — ${REMEDY}\n`);
  process.exit(0);
}
if (NEEDED.some(name => !(name in asset))) {
  process.stdout.write(`kh-harness session-brief: .claude/scripts/harness-redact.mjs is older than this hook and lacks what it needs — ${REMEDY}\n`);
  process.exit(0);
}
const { boundReport, escapeDelimiters, findHandoff, maskText, projectRoot, stripUnsafe, HANDOFF_CANDIDATES } = asset;

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

// The handoff reaches the model's context as written, and its "What didn't
// work" section invites pasted error output. Order matters: stripping first
// lets the mask see a token an invisible character split; masking before
// escaping keeps the `;` of `&lt;` from ending a masked value early.
const lines = escapeDelimiters(maskText(stripUnsafe(text))).split('\n');
// `boundReport` bounds by line count AND by bytes, and appends its own
// truncation notice inside the byte budget, with the closing delimiter after
// it — so whatever it returns, plus the newline below, stays under Claude
// Code's 10,000-character cap and therefore actually reaches the session.
//
// The line-count notice it emits is deliberately kept as well as the byte
// one: "N more lines in the file" tells a user their handoff is longer than
// the brief, which is the actionable half ("prune it"), while "output
// exceeded the byte limit" tells them the brief itself was cut. Both are
// true and they are different facts.
process.stdout.write(boundReport(lines, `<project-handoff source="${rel}">\n`, '</project-handoff>') + '\n');
