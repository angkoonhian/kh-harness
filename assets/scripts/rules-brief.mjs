#!/usr/bin/env node
// UserPromptSubmit hook: puts this repository's rules registry — the
// owner's docs/harness/RULES.md and the kit's docs/harness/LEARNED.md — back
// in front of the model on EVERY prompt.
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
//     is counted in a notice in the text itself. The bound and the notice
//     cover both files together.
//   - The owner's `high` priority rules go first, then the owner's
//     `normal` ones, stable within each, then the learned rules.
//   - Superseded rules are skipped: they are a record, not a claim. So is
//     a learned rule whose entry says its gate blocks (`enforced-by: hook`
//     with `approved-action: block`): the call it forbids cannot run. A
//     learned rule whose gate warns or observes is told like any other.
//   - A rule's text is the user's prose and may carry anything, so it passes
//     `stripUnsafe` (controls, invisible and reordering characters, the tag
//     block), then `maskText` at the sweep's floors, then
//     `escapeDelimiters`, so no rule can close the block.
//   - The block is wrapped in `<project-rules source="…">` … `</project-rules>`,
//     so the model can tell the injected rules from the prompt they arrive
//     beside, and knows the files they come from.
//
// The parser (`parseRules`) and the registry's locations (`findRules`,
// `findLearned`) come from harness-redact.mjs, the one module shared with
// `detect` — so what this hook injects and what `detect` reports can never
// disagree about what a rule is.
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The shared module beside this hook can be older than the hook: `apply`
// leaves a hand-edited copy in place, and a static import of a name that copy
// lacks fails at link time with a stack trace on every prompt. Its shape is
// probed instead. Beside a stale or missing copy no rule is injected, and the
// person is told the fix in one `systemMessage`, with exit 0: a reminder
// that stopped arriving must be visible, and exit 2 would block the prompt.
// The notice is given once per session when the copy still has the marker
// helpers, and on every prompt when it does not. `uninstall --yes` then
// `apply --yes` is named as well, because `apply` alone keeps a copy that
// was edited by hand. The shared module cannot hold this text: it is the
// file that may be missing.
const NEEDED = ['escapeDelimiters', 'findLearned', 'findRules', 'heldByBlockingGate', 'maskText', 'parseRules', 'projectRoot', 'stripUnsafe'];
const MARKING = ['markerPath', 'projectRoot', 'safeSessionId'];
const REMEDY = 're-run `node scripts/apply.mjs <repo> --yes` from kh-harness to update the shared asset; if apply reports it kept/modified, run `uninstall --yes` and then `apply --yes`.';
let asset = {};
let assetProblem = null;
try {
  asset = await import('./harness-redact.mjs');
  if (NEEDED.some(name => !(name in asset))) assetProblem = 'is older than this hook and lacks what it needs';
} catch {
  assetProblem = 'is missing or cannot be loaded';
}

// A hard ceiling on how long reading stdin may block; see lint-touched.mjs's
// STDIN_TIMEOUT_MS for why the read is asynchronous.
const STDIN_TIMEOUT_MS = Number(process.env.HK_STDIN_TIMEOUT_MS) || 5_000;

function readStdin(timeoutMs) {
  return new Promise(resolve => {
    let data = '';
    let settled = false;
    const finish = value => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(data), timeoutMs);
    try {
      process.stdin.setEncoding('utf8');
      process.stdin.on('data', chunk => { data += chunk; });
      process.stdin.on('end', () => finish(data));
      process.stdin.on('error', () => finish(data));
    } catch {
      finish('');
    }
  });
}

/** The session id the prompt's payload carries, or undefined. The payload is
 * read only to mark a session as told. */
async function payloadSessionId() {
  try {
    return JSON.parse(await readStdin(STDIN_TIMEOUT_MS))?.session_id;
  } catch {
    return undefined;
  }
}

/** Whether the session `rawSessionId` names has not been told `sentence`
 * yet: true the first time, through a marker created exclusively, and every
 * time when no marker can be made. */
function firstTelling(rawSessionId, sentence) {
  const sessionId = asset.safeSessionId(rawSessionId);
  const tag = createHash('sha256').update(sentence, 'utf8').digest('hex').slice(0, 16);
  const path = sessionId === null ? null : asset.markerPath(asset.projectRoot(), sessionId, `rules-brief-notice-${tag}`);
  if (path === null) return true;
  try {
    writeFileSync(path, '', { flag: 'wx', mode: 0o600 });
    return true;
  } catch (error) {
    return error?.code !== 'EEXIST';
  }
}

if (assetProblem !== null) {
  const sentence = `kh-harness rules-brief: .claude/scripts/harness-redact.mjs ${assetProblem}, so the project rules are not re-told — ${REMEDY}`;
  const canMark = MARKING.every(name => name in asset);
  if (!canMark || firstTelling(await payloadSessionId(), sentence)) process.stdout.write(JSON.stringify({ systemMessage: sentence }) + '\n');
  process.exit(0);
}
const { escapeDelimiters, findLearned, findRules, heldByBlockingGate, maskText, parseRules, projectRoot, stripUnsafe } = asset;

export const RULES_BRIEF_MAX_BYTES = 1500;
// Overridable only so a test can exercise the truncation path cheaply;
// production never needs to change it.
const MAX_BYTES = Number(process.env.HK_RULES_BRIEF_MAX_BYTES) || RULES_BRIEF_MAX_BYTES;

const root = projectRoot();

/** The active rules of the registry file at `rel`; none when it is absent
 * or unreadable. */
function activeRules(rel) {
  if (!rel) return [];
  try {
    return parseRules(readFileSync(join(root, rel), 'utf8')).rules.filter(r => r.status !== 'superseded');
  } catch {
    return [];
  }
}

const ownerRel = findRules(root);
const learnedRel = findLearned(root);
const owner = activeRules(ownerRel);
// A learned rule whose gate blocks cannot be broken, so telling the model as
// well would spend every prompt's budget for nothing. One whose gate warns
// or observes can be, and is told like any other rule.
const learned = activeRules(learnedRel).filter(r => !heldByBlockingGate(r));

// The owner's rules first, `high` before the rest with document order kept
// within each group, then the learned rules in document order.
const ordered = [...owner.filter(r => r.priority === 'high'), ...owner.filter(r => r.priority !== 'high'), ...learned];
if (ordered.length === 0) process.exit(0);

// The files the injected rules come from, and no other.
const source = [owner.length > 0 ? ownerRel : null, learned.length > 0 ? learnedRel : null].filter(Boolean).join(', ');
const open = `<project-rules source="${source}">`;
const close = '</project-rules>';
const header = `Project rules (${source}):`;
const moreNotice = count => `… ${count} more rule(s) in ${source}`;
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
