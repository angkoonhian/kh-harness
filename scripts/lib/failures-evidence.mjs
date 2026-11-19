// scripts/lib/failures-evidence.mjs
//
// Evidence for `P5.failures` (gap-model.mjs's check): what the failure
// taxonomy names, and how many of the recurrences in this machine's session
// log no failure kind names yet. The taxonomy is written by a person; the
// kit only parses it.
//
// Counts only. This output is serialised into docs/harness/detect.json,
// which is committed, while the session log is per machine and holds tool
// input and output: no error line, session id, path or other log content
// may cross from one to the other. A failure kind is named by count too,
// since its title is whatever its author wrote.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readIfPresent } from './scan.mjs';
import { findRecurrences } from './recurrence.mjs';
import { isEnabled } from '../../assets/scripts/harness-log.mjs';

export const FAILURES_PATH = 'docs/harness/FAILURES.md';

const SIGNATURE = /^[0-9a-f]{16}$/;

// `## F<n> — <title>`: the separator is an em-dash, en-dash or hyphen run;
// the title may be missing while a person is still writing the entry.
const FAILURE_HEADING = /^##\s+(F\d+)(?:\s+[—–-]+(?:\s+(.*?))?)?\s*$/;
const ANY_H2 = /^##(\s|$)/;
const SIGNATURES_LINE = /^\s*[-*]\s*signatures\s*:(.*)$/i;

/**
 * `{ kinds, malformedSignatures }`: the failure kinds in file order, each
 * `{ id, title, signatures }`, and how many items in their signature lists
 * were not signature ids and were dropped. HTML comments are blanked first,
 * so the scaffold's example is never a failure kind. A level-2 heading that
 * is not `F<n>` ends the entry above it and starts none. Never throws.
 */
function readTaxonomy(text) {
  const kinds = [];
  let malformedSignatures = 0;
  if (typeof text !== 'string') return { kinds, malformedSignatures };
  let current = null;
  for (const line of text.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    if (ANY_H2.test(line)) {
      const m = FAILURE_HEADING.exec(line);
      current = m ? { id: m[1], title: m[2] ?? '', signatures: [] } : null;
      if (current) kinds.push(current);
      continue;
    }
    const s = current && SIGNATURES_LINE.exec(line);
    if (!s) continue;
    for (const item of s[1].split(',').map(i => i.trim()).filter(i => i.length > 0)) {
      if (SIGNATURE.test(item)) current.signatures.push(item);
      else malformedSignatures++;
    }
  }
  return { kinds, malformedSignatures };
}

/** The failure kinds `text` names, `{ id, title, signatures }[]` in file
 * order; a heading with no signatures line has an empty list. */
export function parseFailures(text) {
  return readTaxonomy(text).kinds;
}

/**
 * What the session log says about the recurrences the taxonomy covers:
 * `{ read: false, why: 'disabled' | 'unlistable' }` when nothing was read,
 * else `{ read: true, sessionsRead, sessionsUnreadable, recurrences,
 * unlabelled }`. A log that is not enabled on this machine is never read,
 * whatever an earlier enablement left in it.
 */
function recurrenceCounts(root, labelled) {
  if (!isEnabled(root)) return { read: false, why: 'disabled' };
  let found;
  try {
    found = findRecurrences(root);
  } catch {
    return { read: false, why: 'unlistable' };
  }
  const { recurrences, sessionsRead, sessionsUnreadable } = found;
  return {
    read: true, sessionsRead, sessionsUnreadable,
    recurrences: recurrences.length,
    unlabelled: recurrences.filter(r => !labelled.has(r.signature)).length,
  };
}

/**
 * `null` when there is no taxonomy; otherwise `{ path, readable, kinds,
 * malformedSignatures, log }` where `kinds` is how many failure kinds are
 * named and `log` is `recurrenceCounts`. A file that exists but cannot be
 * read is `readable: false` and its log is not consulted, since nothing
 * could be said about which recurrences it labels.
 */
export function failuresEvidence(root) {
  if (!existsSync(join(root, FAILURES_PATH))) return null;
  const text = readIfPresent(root, FAILURES_PATH);
  if (text === null) return { path: FAILURES_PATH, readable: false, kinds: 0, malformedSignatures: 0, log: null };
  const { kinds, malformedSignatures } = readTaxonomy(text);
  const labelled = new Set(kinds.flatMap(k => k.signatures));
  return { path: FAILURES_PATH, readable: true, kinds: kinds.length, malformedSignatures, log: recurrenceCounts(root, labelled) };
}
