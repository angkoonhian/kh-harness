// scripts/lib/intent-evidence.mjs
//
// Shared evidence for `P3.intent` (gap-model.mjs). There is deliberately no
// generator for this check — like steps 6 and 7a, the intent document is
// written by the skill after reading the repository and gated on its full
// content — so this module has one consumer today. It is still a separate
// module, for the same reason every other `*-evidence.mjs` is: the section
// list is a FACT about what the kit considers a complete intent document,
// and the skill reference (phase-3-intent.md) names the same seven sections
// in prose. One place to read them from keeps the two from drifting.
//
// What is measured is the SHAPE — which level-2 sections exist — never the
// prose. A document with every heading and empty bodies is `declared`, and
// the check says so in its evidence. Judging whether a purpose statement is
// a good one is a human's job at the gate, not a regex's.
//
// Section names come from the 2026-11-02 research sweep across spec-kit
// (success criteria, open questions), Kiro product.md (purpose, users),
// BMAD (explicit non-goals, non-users), Shape Up (no-gos), SRE error budgets
// and FMEA (failure definitions). Aliases below accept the spellings those
// sources use, so a document written to any of them is recognised.
import { readIfPresent } from './scan.mjs';

export const INTENT_PATH = 'docs/INTENT.md';

/** The seven sections, in canonical order and spelling. */
export const INTENT_SECTIONS = Object.freeze([
  'Purpose', 'Users', 'How it works', 'Success', 'Failure', 'Non-goals', 'Open questions',
]);

// A heading matches a section when its normalised text STARTS with one of
// the section's keys. Normalisation: lower-case, hyphens/underscores to
// spaces, whitespace collapsed. "Success criteria", "Failure modes",
// "Users and non-users" all match by prefix; "Non-goals" must be checked
// before "Users" could ever see "non-users" — it cannot, because matching
// is on the heading's START.
const ALIASES = {
  'Purpose': ['purpose'],
  'Users': ['users', 'who it is for', 'audience'],
  'How it works': ['how it works', 'behaviour', 'behavior'],
  'Success': ['success'],
  'Failure': ['failure'],
  'Non-goals': ['non goals', 'nongoals', 'no gos', 'out of scope'],
  'Open questions': ['open questions', 'needs clarification'],
};

const normalise = s => s.toLowerCase().replace(/[-_]/g, ' ').replace(/\s+/g, ' ').trim();

/** Blank HTML comments and fenced code blocks, keeping newlines so nothing
 * else shifts — the same move parseRules makes in harness-redact.mjs. */
function stripNonContent(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ''))
    .replace(/^```[\s\S]*?^```[ \t]*$/gm, m => m.replace(/[^\n]/g, ''));
}

const LAST_REVIEWED = /^\s*[-*]\s*last[-_ ]?reviewed\s*:\s*(\d{4}-\d{2}-\d{2})\s*$/im;

/**
 * `{ found, missing, lastReviewed }` for the given text. `found` and
 * `missing` are both in canonical order and use canonical spellings,
 * whichever alias the document actually used. Never throws; non-string
 * input is an empty document.
 */
export function intentSections(text) {
  if (typeof text !== 'string' || text.length === 0) {
    return { found: [], missing: [...INTENT_SECTIONS], lastReviewed: null };
  }
  const body = stripNonContent(text);
  const headings = [...body.matchAll(/^##[ \t]+(.+?)[ \t]*$/gm)].map(m => normalise(m[1]));
  const present = new Set();
  for (const h of headings) {
    for (const [canonical, keys] of Object.entries(ALIASES)) {
      if (keys.some(k => h === k || h.startsWith(k + ' '))) { present.add(canonical); break; }
    }
  }
  const found = INTENT_SECTIONS.filter(s => present.has(s));
  const missing = INTENT_SECTIONS.filter(s => !present.has(s));
  const lr = body.match(LAST_REVIEWED);
  return { found, missing, lastReviewed: lr ? lr[1] : null };
}

/** The file-backed form: `null` when `docs/INTENT.md` does not exist,
 * otherwise `{ path, found, missing, lastReviewed }`. */
export function intentEvidence(root) {
  const text = readIfPresent(root, INTENT_PATH);
  if (text == null) return null;
  return { path: INTENT_PATH, ...intentSections(text) };
}
