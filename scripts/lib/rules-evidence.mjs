// scripts/lib/rules-evidence.mjs
//
// Shared evidence for `P3.rules` (gap-model.mjs's check) and `P3.reinject`
// (propose.mjs's generator). Same discipline as every other `*-evidence.mjs`
// module: the check and the generator must agree on what the registry
// holds by construction, not by two people independently getting the same
// answer twice. The PARSER itself lives one level further down, in
// assets/scripts/harness-redact.mjs, because the installed hook needs it
// too — see that module's own comment on the import direction.
//
// Two outputs, two disciplines:
//
//   rulesRegistryEvidence — what the registry says, and whether each
//   rule's `pointer` still resolves. A pointer that no longer resolves is
//   the drift signal this whole layer exists to produce: a rule whose
//   enforcer was deleted is a claim again, whatever its `enforced-by` line
//   still says. Reported by id and pointer, never by rule text.
//
//   ruleShapedLines — how many imperative sentences ("must", "never",
//   "always", ...) sit in the instruction file and `.claude/rules/*.md`
//   OUTSIDE the registry. Reported as line numbers per file, NEVER the
//   sentence: a line may carry anything, and this output is serialised
//   into docs/harness/detect.json, which is committed. Line numbers let a
//   user open the exact spot; echoing prose would let detect.json leak it.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readIfPresent } from './scan.mjs';
import { parseRules, findRules } from '../../assets/scripts/harness-redact.mjs';

/** Enforcers that need no pointer: `none` is a claim, `review` is a human. */
const POINTERLESS = new Set(['none', 'review']);

const SETTINGS_POINTER = /^settings:(permissions\.deny|hooks\.([A-Za-z]+))$/;

/**
 * Does `pointer` name something that exists? Three shapes:
 *   settings:permissions.deny     — iff the repository has any deny rule in effect
 *   settings:hooks.<Event>        — iff any hook is registered on that event
 *   <repository-relative path>    — iff the file or directory exists
 * An absolute path or any `..` segment is refused outright (reported as
 * missing, never resolved): a pointer is meant to name something INSIDE
 * this repository, and the containment rule apply-lib.mjs applies to
 * writes applies to what this report will vouch for too.
 */
function pointerResolves(root, harness, pointer) {
  const m = pointer.match(SETTINGS_POINTER);
  if (m) {
    if (m[1] === 'permissions.deny') return (harness?.claudeDir?.denyRules ?? 0) > 0;
    return (harness?.claudeDir?.hookEvents?.[m[2]]?.length ?? 0) > 0;
  }
  const p = pointer.split('\\').join('/');
  if (p.startsWith('/') || /^[A-Za-z]:/.test(p)) return false;
  if (p.split('/').includes('..')) return false;
  return existsSync(join(root, p));
}

/**
 * `null` when there is no registry; otherwise
 * `{ path, count, superseded, byEnforcer, unenforced, missingPointers, problems }`
 * where `count`, `byEnforcer`, `unenforced` and `missingPointers` cover
 * ACTIVE rules only (a superseded rule is a record, not a claim), and
 * `missingPointers` is `[{ id, pointer }]` — `pointer: null` when an
 * enforcer other than none/review was declared with no pointer at all.
 */
export function rulesRegistryEvidence(root, harness) {
  const rel = findRules(root);
  if (!rel) return null;
  const { rules, problems } = parseRules(readIfPresent(root, rel) ?? '');
  const active = rules.filter(r => r.status !== 'superseded');
  const byEnforcer = {};
  const unenforced = [];
  const missingPointers = [];
  for (const r of active) {
    byEnforcer[r.enforcedBy] = (byEnforcer[r.enforcedBy] ?? 0) + 1;
    if (r.enforcedBy === 'none') unenforced.push(r.id);
    if (POINTERLESS.has(r.enforcedBy)) continue;
    if (r.pointer == null) missingPointers.push({ id: r.id, pointer: null });
    else if (!pointerResolves(root, harness, r.pointer)) missingPointers.push({ id: r.id, pointer: r.pointer });
  }
  return {
    path: rel,
    count: active.length,
    superseded: rules.length - active.length,
    byEnforcer,
    unenforced,
    missingPointers,
    problems: [...problems],
  };
}

/** The imperative shapes a rule sentence takes. Word-bounded so "mustard"
 * and "trustworthy" do not match. */
export const RULE_SHAPED = /\b(must(?:\s+not)?|never|always|do\s+not|don['’]t|forbidden|required)\b/i;

/** Blank HTML comments and fenced blocks, keeping newlines — a rule shown
 * inside an example is not a rule the repository is telling Claude. */
function stripNonContent(text) {
  return text
    .replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ''))
    .replace(/^```[\s\S]*?^```[ \t]*$/gm, m => m.replace(/[^\n]/g, ''));
}

/**
 * `[{ file, lines }]` for the instruction file and every `.claude/rules/`
 * file, in that order, omitting files with no rule-shaped line. The
 * registry itself is never scanned — its rules are already where they
 * belong.
 */
export function ruleShapedLines(root, harness) {
  const files = [];
  if (harness?.instructions?.path) files.push(harness.instructions.path);
  for (const r of harness?.claudeDir?.rules ?? []) files.push(r);
  const out = [];
  for (const file of files) {
    const text = readIfPresent(root, file);
    if (text == null) continue;
    const lines = [];
    stripNonContent(text).split(/\r?\n/).forEach((line, i) => { if (RULE_SHAPED.test(line)) lines.push(i + 1); });
    if (lines.length) out.push({ file, lines });
  }
  return out;
}
