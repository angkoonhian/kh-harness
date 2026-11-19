// scripts/lib/failures-evidence.mjs
//
// Evidence for `P5.failures` (gap-model.mjs's check): what the failure
// taxonomy names. The taxonomy is written by a person; the kit only parses
// it.
//
// `detect` never reads the session log: the log is unbounded in size, and
// `detect` and `apply` run this on every invocation. Which recurrences no
// failure kind labels is `log report`'s to say, from `parseFailures`.
//
// Counts only. This output is serialised into docs/harness/detect.json,
// which is committed, and a failure kind's title or a signature is
// whatever its author wrote.
import { OVER_DOCUMENT_LIMIT, readDocument } from './scan.mjs';

export const FAILURES_PATH = 'docs/harness/FAILURES.md';

const SIGNATURE = /^[0-9a-f]{16}$/;

// `## F<n> — <title>`: the separator is an em-dash, en-dash or hyphen run;
// the title may be missing while a person is still writing the entry.
const FAILURE_HEADING = /^##\s+(F\d+)(?:\s+[—–-]+(?:\s+(.*?))?)?\s*$/;
const ANY_H2 = /^##(\s|$)/;
const SIGNATURES_LINE = /^\s*[-*]\s*signatures\s*:(.*)$/i;

/**
 * `{ kinds, malformedSignatures, ignoredHeadings }`: the failure kinds in
 * file order, each `{ id, title, signatures }`; how many items in their
 * signature lists were not signature ids and were dropped; and how many
 * level-2 headings were not of the `F<n>` form. Such a heading ends the
 * entry above it and starts none. HTML comments are removed first, so the
 * scaffold's example is never a failure kind. Never throws.
 */
function readTaxonomy(text) {
  const kinds = [];
  let malformedSignatures = 0;
  let ignoredHeadings = 0;
  if (typeof text !== 'string') return { kinds, malformedSignatures, ignoredHeadings };
  let current = null;
  for (const line of text.replace(/<!--[\s\S]*?-->/g, '').split(/\r?\n/)) {
    if (ANY_H2.test(line)) {
      const m = FAILURE_HEADING.exec(line);
      current = m ? { id: m[1], title: m[2] ?? '', signatures: [] } : null;
      if (current) kinds.push(current);
      else ignoredHeadings++;
      continue;
    }
    const s = current && SIGNATURES_LINE.exec(line);
    if (!s) continue;
    for (const item of s[1].split(',').map(i => i.trim()).filter(i => i.length > 0)) {
      if (SIGNATURE.test(item)) current.signatures.push(item);
      else malformedSignatures++;
    }
  }
  return { kinds, malformedSignatures, ignoredHeadings };
}

/** The failure kinds `text` names, `{ id, title, signatures }[]` in file
 * order; a heading with no signatures line has an empty list. */
export function parseFailures(text) {
  return readTaxonomy(text).kinds;
}

/**
 * The taxonomy as it was read: `{ state, kinds }`, `state` one of
 * `absent`, `read`, `unreadable` (the path exists and cannot be read as a
 * file) or `over-limit` (the file is larger than `readDocument` reads).
 * `kinds` is what `parseFailures` gives for a taxonomy that was read, and
 * empty otherwise: a caller must not take an unread taxonomy for one that
 * names no failure kind, and `failuresNotRead` says why it was not read.
 */
export function readFailures(root) {
  const { state, text } = readDocument(root, FAILURES_PATH);
  return { state, kinds: state === 'read' ? parseFailures(text) : [] };
}

/** Why a taxonomy in `state` was not read, as a clause after its path, or
 * null for one that was read or is absent. */
export function failuresNotRead(state) {
  if (state === 'over-limit') return OVER_DOCUMENT_LIMIT;
  return state === 'unreadable' ? 'exists but could not be read' : null;
}

/**
 * `null` when there is no taxonomy; otherwise `{ path, readable, kinds,
 * signatures, malformedSignatures, ignoredHeadings }`, where `kinds` is how
 * many failure kinds are named and `signatures` how many signature ids they
 * list in all. A taxonomy that was not read is `readable: false` with every
 * count 0 and `overLimit`, whether that is because of its size.
 */
export function failuresEvidence(root) {
  const { state, text } = readDocument(root, FAILURES_PATH);
  if (state === 'absent') return null;
  if (state !== 'read') return { path: FAILURES_PATH, readable: false, overLimit: state === 'over-limit', kinds: 0, signatures: 0, malformedSignatures: 0, ignoredHeadings: 0 };
  const { kinds, malformedSignatures, ignoredHeadings } = readTaxonomy(text);
  return {
    path: FAILURES_PATH, readable: true,
    kinds: kinds.length,
    signatures: kinds.reduce((n, k) => n + k.signatures.length, 0),
    malformedSignatures, ignoredHeadings,
  };
}
