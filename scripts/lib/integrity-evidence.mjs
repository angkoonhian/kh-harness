// scripts/lib/integrity-evidence.mjs
//
// Evidence for `P5.integrity` (gap-model.mjs's check): whether the harness
// machinery the manifest records is still what the kit wrote, and whether
// every committed gate is one somebody approved.
//
// Machinery is every recorded file under `.claude/scripts/`, plus the gate
// file and the learned registry when recorded. The documents the kit
// scaffolds for the owner to write into (HANDOFF.md, the rules registry,
// the failure taxonomy, path-rule files) are left out: editing them is
// their intended use.
//
// Only what is in the repository is read. The ledger is per machine, and
// its chain is `log status`'s to report.
//
// Every line names a file or a gate id, never content: this output reaches a
// terminal and docs/harness/detect.json, and the manifest, the gate file and
// the registry are all files a pull request can edit. So an id is printed
// only when it is a gate id and a path only when it is plain; anything else
// is named by its position.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { classify, MANIFEST_PATH } from './manifest.mjs';
import { GATE_ID, gateSha256, parseGates } from '../../assets/scripts/harness-gates.mjs';
import { GATES_PATH } from '../../assets/scripts/harness-log.mjs';
import { LEARNED_PATH, parseRules } from '../../assets/scripts/harness-redact.mjs';

const SCRIPTS_DIR = '.claude/scripts/';
const PLAIN_PATH = /^[A-Za-z0-9._/-]{1,200}$/;

const isMachinery = path => path.startsWith(SCRIPTS_DIR) || path === GATES_PATH || path === LEARNED_PATH;
const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const idOr = (id, fallback) => (typeof id === 'string' && GATE_ID.test(id) ? id : fallback);

/** `{ text }`, `{ absent: true }`, or `{ unreadable: true }` for the file at
 * `rel`. */
function readRepoFile(root, rel) {
  const p = join(root, rel);
  if (!existsSync(p)) return { absent: true };
  try {
    return { text: readFileSync(p, 'utf8') };
  } catch {
    return { unreadable: true };
  }
}

/** Pushes a line for each recorded machinery file that is modified or
 * missing, and returns the line that counts the intact ones. */
function machinery(root, manifest, problems) {
  const seen = new Set();
  let intact = 0;
  manifest.files.forEach(({ path }, i) => {
    if (seen.has(path) || !isMachinery(path)) return;
    seen.add(path);
    // `theirs` here is a recorded path that resolves outside the
    // repository, which is not a file of this repository's harness.
    const state = classify(root, manifest, path);
    if (state === 'ours-unmodified') intact++;
    if (state !== 'ours-modified') return;
    const name = PLAIN_PATH.test(path) && !path.split('/').includes('..') ? path : `the file at position ${i + 1} in ${MANIFEST_PATH}`;
    problems.push(existsSync(join(root, path))
      ? `modified since kh-harness wrote it: ${name}`
      : `recorded in ${MANIFEST_PATH} but missing: ${name}`);
  });
  return `${plural(intact, 'harness file')} recorded in ${MANIFEST_PATH} ${intact === 1 ? 'matches' : 'match'} it`;
}

/** `{ gates, present }` for the committed gate file, or null when it exists
 * and cannot be read as one. Pushes a line for the file, or for each entry
 * that is not a gate. */
function committedGates(root, problems) {
  const read = readRepoFile(root, GATES_PATH);
  if (read.absent) return { gates: [], present: false };
  if (read.unreadable) {
    problems.push(`${GATES_PATH} exists but could not be read`);
    return null;
  }
  const { gates, suspended, rejected } = parseGates(read.text);
  const whole = rejected.find(r => r.index < 0);
  if (whole) {
    problems.push(`${GATES_PATH} cannot be parsed as a gate file: ${whole.reason}`);
    return null;
  }
  for (const { index, reason } of rejected) problems.push(`${GATES_PATH}: entry ${index + 1} is not a gate (${reason})`);
  // `tool-gate.mjs` applies a suspension only from this machine's file.
  for (const id of suspended) problems.push(`${GATES_PATH}: ${id} is a suspension, which only this machine's gate file may hold`);
  return { gates, present: true };
}

/** The learned registry's entries, or null when it exists and cannot be
 * read. */
function registryEntries(root, problems) {
  const read = readRepoFile(root, LEARNED_PATH);
  if (read.absent) return [];
  if (read.unreadable) {
    problems.push(`${LEARNED_PATH} exists but could not be read`);
    return null;
  }
  return parseRules(read.text).rules;
}

/** Pushes a line for each gate whose hash no entry's `approved-sha256`
 * equals. */
function unapproved(gates, entries, problems) {
  const approvals = new Set(entries.map(e => e.approvedSha256));
  for (const gate of gates) {
    if (approvals.has(gateSha256(gate))) continue;
    problems.push(entries.some(e => e.id === gate.id)
      ? `${gate.id} in ${GATES_PATH}: changed since it was approved — its hash is not the approved-sha256 of ${gate.id} in ${LEARNED_PATH}`
      : `${gate.id} in ${GATES_PATH}: no entry in ${LEARNED_PATH} approves it`);
  }
}

/** The manifest's landed learnings, `[{ id, gateSha256 }]`, or null when
 * the record is there and is not a list. Older manifests have none. */
function landedLearnings(manifest, problems) {
  if (manifest.learnings === undefined) return [];
  if (Array.isArray(manifest.learnings)) return manifest.learnings;
  problems.push(`${MANIFEST_PATH}: learnings is not a list`);
  return null;
}

/** Pushes a line for each landed learning, and each approved learned entry,
 * with no gate behind it. */
function orphans(gates, entries, learnings, problems) {
  const hashes = new Map(gates.map(g => [g.id, gateSha256(g)]));
  learnings?.forEach((l, i) => {
    const matched = l !== null && typeof l === 'object' && typeof l.id === 'string' && hashes.get(l.id) === l.gateSha256;
    if (!matched) problems.push(`landed learning ${idOr(l?.id, i + 1)} in ${MANIFEST_PATH}: no gate in ${GATES_PATH} has its id and hash`);
  });
  const gateHashes = new Set(hashes.values());
  for (const e of entries ?? []) {
    if (e.origin?.toLowerCase() !== 'learned' || e.approvedSha256 === null || gateHashes.has(e.approvedSha256)) continue;
    problems.push(`${idOr(e.id, `the entry at line ${e.line}`)} in ${LEARNED_PATH}: approved, but no gate in ${GATES_PATH} has its approved-sha256`);
  }
}

/**
 * `{ problems, summary }` for the repository at `root` against `manifest`:
 * one line per integrity failure, and, only when there is none, the lines
 * that say what was found intact. A cross-check that needs a file that
 * could not be read is not made; that file's own problem is reported
 * instead.
 */
export function integrityEvidence(root, manifest) {
  const problems = [];
  const intact = machinery(root, manifest, problems);
  const committed = committedGates(root, problems);
  const entries = registryEntries(root, problems);
  const learnings = landedLearnings(manifest, problems);
  if (committed !== null && entries !== null) unapproved(committed.gates, entries, problems);
  if (committed !== null) orphans(committed.gates, entries, learnings, problems);
  if (problems.length) return { problems, summary: [] };

  const summary = [intact, committed.present
    ? `${GATES_PATH}: ${plural(committed.gates.length, 'gate')}, each approved in ${LEARNED_PATH}`
    : `${GATES_PATH}: no committed gate file`];
  if (learnings.length) summary.push(`${plural(learnings.length, 'landed learning')} recorded in ${MANIFEST_PATH}, each matched by its gate`);
  return { problems, summary };
}
