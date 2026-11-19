#!/usr/bin/env node
// UserPromptSubmit hook: puts this repository's rules registry
// (docs/harness/RULES.md) back in front of the model on EVERY prompt.
//
// Why a hook, and why per prompt. A rule stated once in CLAUDE.md is a
// claim the model is told at session start; the 2026 studies the design
// cites (docs/superpowers/specs/2026-11-02-intent-and-rules-design.md, §3)
// measure compliance with told rules decaying as a session runs, and find
// that longer instruction files do not help. Re-stating the rules at each
// prompt is the one mechanism that counters the decay without a longer
// file — and `additionalContext` on UserPromptSubmit is exactly the slot
// Claude Code provides for it (verified against the hooks reference:
// nested under `hookSpecificOutput`, or it is silently ignored).
//
// What this hook is NOT: a guard. It injects context; it never blocks, never
// writes, never runs anything. So, unlike lint-touched.mjs and
// verify-touched.mjs, it fails OPEN on purpose — no registry, an unreadable
// one, or one that parses to zero rules all mean "say nothing and exit 0".
// A reminder that crashes the prompt would be worse than no reminder. It
// keeps no marker state either: there is nothing to dedupe or bound across
// turns, because every prompt is supposed to get the rules.
//
// Bounds and redaction:
//   - The output is capped at RULES_BRIEF_MAX_BYTES (1,500 by default — a
//     small fraction of Claude Code's 10,000-character hook cap, chosen so
//     the hook stays cheap on every single prompt). Whole rules are dropped,
//     never mid-line: a rule that does not fit is skipped and the next is
//     tried, so one long rule cannot starve the rest, and every skipped rule
//     is counted in a notice in the text itself.
//   - `high` priority rules go first, then `normal`, stable within each.
//   - Superseded rules are skipped: they are a record, not a claim.
//   - A rule's text is the user's prose and may carry anything, so it passes
//     `stripUnsafe` (controls, invisible and reordering characters, the tag
//     block), then `maskText` at the sweep's floors, then
//     `escapeDelimiters`, so no rule can close the block.
//   - The block is wrapped in `<project-rules source="…">` … `</project-rules>`,
//     so the model can tell the injected rules from the prompt they arrive
//     beside, and knows the file they come from.
//
// The parser (`parseRules`) and the registry's location (`findRules`,
// `RULES_PATH`) come from harness-redact.mjs, the one module shared with
// `detect` — so what this hook injects and what `detect` reports can never
// disagree about what a rule is.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// UPGRADE SKEW, found on a real repository: kh-harness 0.1.0's
// harness-redact.mjs was already installed beside this hook, and that copy
// has no `parseRules` — a static named import died at link time with a
// stack trace on every prompt. A dynamic import lets this hook probe the
// asset's shape and fail VISIBLY instead: one stderr line naming the fix,
// exit 1 (Claude Code shows a hook-error notice; exit 2 would BLOCK the
// prompt, which a reminder must never do), and nothing on stdout. Silent
// exit 0 was rejected: a reminder that quietly stopped arriving is the
// failure this whole phase exists to prevent.
//
// The remedy named below has a fallback for a reason (whole-branch review,
// Important 4): `apply` updates the shared asset only when it is still what
// the kit wrote (line endings aside — a CRLF checkout is tolerated since the
// Tier 1 audit fix). After a hand edit it is not — apply reports it
// `kept (modified)` and the notice would return on every prompt with a
// remedy that cannot work. `uninstall --yes` then `apply --yes` is the way
// through in that case, so the one line says both.
const NEEDED = ['escapeDelimiters', 'findRules', 'maskText', 'parseRules', 'projectRoot', 'RULES_PATH', 'stripUnsafe'];
const REMEDY = 're-run `node scripts/apply.mjs <repo> --yes` from kh-harness to update the shared asset; if apply reports it kept/modified, run `uninstall --yes` and then `apply --yes`.';
let asset;
try {
  asset = await import('./harness-redact.mjs');
} catch {
  // Missing or unloadable (review, Minor 6): the same one-line, exit-1 shape
  // as the stale case — never a stack trace on every prompt.
  process.stderr.write(`kh-harness rules-brief: .claude/scripts/harness-redact.mjs is missing or cannot be loaded — ${REMEDY}\n`);
  process.exit(1);
}
if (NEEDED.some(name => !(name in asset))) {
  process.stderr.write(`kh-harness rules-brief: .claude/scripts/harness-redact.mjs is older than this hook and lacks what it needs — ${REMEDY}\n`);
  process.exit(1);
}
const { escapeDelimiters, findRules, maskText, parseRules, projectRoot, RULES_PATH, stripUnsafe } = asset;

export const RULES_BRIEF_MAX_BYTES = 1500;
// Overridable only so a test can exercise the truncation path cheaply;
// production never needs to change it.
const MAX_BYTES = Number(process.env.HK_RULES_BRIEF_MAX_BYTES) || RULES_BRIEF_MAX_BYTES;

const root = projectRoot();
const rel = findRules(root);
if (!rel) process.exit(0);

let text;
try {
  text = readFileSync(join(root, rel), 'utf8');
} catch {
  process.exit(0);
}

const active = parseRules(text).rules.filter(r => r.status !== 'superseded');
if (active.length === 0) process.exit(0);

// Stable partition: `high` first, then everything else, document order
// preserved within each group.
const ordered = [...active.filter(r => r.priority === 'high'), ...active.filter(r => r.priority !== 'high')];

const open = `<project-rules source="${RULES_PATH}">`;
const close = '</project-rules>';
const header = `Project rules (${RULES_PATH}):`;
const moreNotice = count => `… ${count} more rule(s) in ${RULES_PATH}`;
const lines = [open, header];
// The closing tag is reserved up front so the bound holds with it in place.
let used = Buffer.byteLength(open, 'utf8') + 1 + Buffer.byteLength(header, 'utf8') + 1 + Buffer.byteLength(close, 'utf8');
let skipped = 0;
ordered.forEach((r, i) => {
  // Only the rule's text comes from the file as written: the parser limits
  // the id to word characters and the enforcer to `ENFORCERS`, and masking
  // the text alone keeps an unclosed quoted value from swallowing the suffix.
  // The sweep's floors, because the model is told to follow this text: a
  // starred word after `Bearer` would change the rule, a real token is still
  // long enough to be masked.
  const line = `- ${r.id}: ${escapeDelimiters(maskText(stripUnsafe(r.rule), { floors: 'sweep' }))} [enforced-by: ${r.enforcedBy}]`;
  // Admitting a line reserves room for the notice at the largest count it
  // could still reach, every rule skipped so far plus every rule after this
  // one, so the notice can never push the block over the bound.
  const mayYetSkip = skipped + ordered.length - i - 1;
  const notice = mayYetSkip > 0 ? 1 + Buffer.byteLength(moreNotice(mayYetSkip), 'utf8') : 0;
  const cost = 1 + Buffer.byteLength(line, 'utf8');
  if (used + cost + notice > MAX_BYTES) {
    skipped++;
    return;
  }
  lines.push(line);
  used += cost;
});
// Emitted even when no rule fit at all, so the block still says where the
// rules are.
if (skipped > 0) lines.push(moreNotice(skipped));
lines.push(close);

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'UserPromptSubmit',
    additionalContext: lines.join('\n'),
  },
}) + '\n');
