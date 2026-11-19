// scripts/lib/integrity-evidence.mjs
//
// Evidence for `P5.integrity` (gap-model.mjs's check): whether the harness
// machinery the manifest records is still what the kit wrote, and whether
// every committed gate is one the learned registry approves, for its
// content and for the action it now has.
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
import { closeSync, existsSync, openSync, readFileSync, readSync } from 'node:fs';
import { join } from 'node:path';

import { classify, MANIFEST_PATH } from './manifest.mjs';
import { GATE_ID, gateSha256, parseGates } from '../../assets/scripts/harness-gates.mjs';
import { GATES_PATH } from '../../assets/scripts/harness-log.mjs';
import { LEARNED_PATH, parseRules } from '../../assets/scripts/harness-redact.mjs';
import { GATE_FILE_MAX_BYTES } from '../../assets/scripts/tool-gate.mjs';

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

/** As `readRepoFile`, or `{ tooLarge: true }` for a file of more than
 * `maxBytes`, of which no more than one byte past `maxBytes` is read. */
function readBoundedRepoFile(root, rel, maxBytes) {
  const p = join(root, rel);
  if (!existsSync(p)) return { absent: true };
  let fd;
  try {
    fd = openSync(p, 'r');
    const buf = Buffer.alloc(maxBytes + 1);
    let length = 0;
    while (length < buf.length) {
      const n = readSync(fd, buf, length, buf.length - length, null);
      if (n === 0) break;
      length += n;
    }
    return length > maxBytes ? { tooLarge: true } : { text: buf.toString('utf8', 0, length) };
  } catch {
    return { unreadable: true };
  } finally {
    if (fd !== undefined) closeSync(fd);
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
    // With the path recorded, `classify` answers `theirs` only when it
    // resolves outside the repository, and then reads nothing.
    const state = classify(root, manifest, path);
    if (state === 'theirs') problems.push(`the file at position ${i + 1} in ${MANIFEST_PATH} resolves outside the repository, so it was not read`);
    if (state === 'ours-unmodified') intact++;
    if (state !== 'ours-modified') return;
    const name = PLAIN_PATH.test(path) && !path.split('/').includes('..') ? path : `the file at position ${i + 1} in ${MANIFEST_PATH}`;
    problems.push(existsSync(join(root, path))
      ? `modified since kh-harness wrote it: ${name}`
      : `recorded in ${MANIFEST_PATH} but missing: ${name}`);
  });
  if (seen.size === 0) return `${MANIFEST_PATH} records no harness file`;
  return `${plural(intact, 'harness file')} recorded in ${MANIFEST_PATH} ${intact === 1 ? 'matches' : 'match'} it`;
}

/**
 * The committed gate file as the gate hook reads it, from one read of no
 * more than a byte past what the hook loads: `{ absent: true }`,
 * `{ tooLarge: true }`, `{ unreadable: true }`, or `{ parsed }`, what
 * `parseGates` makes of its text. Every kit-side reader of the committed
 * gates asks this.
 */
export function readCommittedGateFile(root) {
  const read = readBoundedRepoFile(root, GATES_PATH, GATE_FILE_MAX_BYTES);
  return read.text === undefined ? read : { parsed: parseGates(read.text) };
}

/** `{ gates, present }` for the committed gate file, or null when it exists
 * and cannot be read as one. Pushes a line for the file, or for each entry
 * that is not a gate. */
function committedGates(root, problems) {
  const read = readCommittedGateFile(root);
  if (read.absent) return { gates: [], present: false };
  if (read.tooLarge) {
    problems.push(`${GATES_PATH} is larger than ${GATE_FILE_MAX_BYTES} bytes, so the gate hook ignores it and none of its gates apply`);
    return null;
  }
  if (read.unreadable) {
    problems.push(`${GATES_PATH} exists but could not be read`);
    return null;
  }
  const { gates, suspended, rejected } = read.parsed;
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

/** The learned registry's entries, each with the action it records its gate
 * as approved at (`approvedAction`, null when it records none), or null
 * when the file exists and cannot be read. */
function registryEntries(root, problems) {
  const read = readRepoFile(root, LEARNED_PATH);
  if (read.absent) return [];
  if (read.unreadable) {
    problems.push(`${LEARNED_PATH} exists but could not be read`);
    return null;
  }
  return parseRules(read.text).rules;
}

/** Pushes a line for each gate no entry approves as it stands: its hash
 * must be an entry's `approved-sha256`, and its action the
 * `approved-action` of the entry under its id. The hash leaves the action
 * out, so a gate changed from warn to block, or back, keeps its hash; and
 * an entry written before the kit recorded the action approves none. */
function unapproved(gates, entries, problems) {
  const approvals = new Set(entries.map(e => e.approvedSha256));
  for (const gate of gates) {
    const own = entries.find(e => e.id === gate.id);
    if (!approvals.has(gateSha256(gate))) {
      problems.push(own !== undefined
        ? `${gate.id} in ${GATES_PATH}: changed since it was approved — its hash is not the approved-sha256 of ${gate.id} in ${LEARNED_PATH}`
        : `${gate.id} in ${GATES_PATH}: no entry in ${LEARNED_PATH} approves it`);
    } else if (own === undefined || own.approvedSha256 !== gateSha256(gate)) {
      problems.push(`${gate.id} in ${GATES_PATH}: not approved for its action — no entry ${gate.id} in ${LEARNED_PATH} approves its hash, so none records an action for it`);
    } else if (own.approvedAction === null) {
      problems.push(`${gate.id} in ${GATES_PATH}: not approved for its action — its entry in ${LEARNED_PATH} records no approved-action, as an entry landed by an older kh-harness does not; `
        + `\`learn revert ${gate.id} --yes\` then \`learn land ${gate.id} --yes\`, at a terminal on the machine that landed it, writes one`);
    } else if (own.approvedAction !== gate.action) {
      problems.push(`${gate.id} in ${GATES_PATH}: its action changed since it was approved — it is not the approved-action of ${gate.id} in ${LEARNED_PATH}`);
    }
  }
}

/** Pushes a line for each landed learning the manifest records, and each
 * approved learned entry, with no gate behind it. The manifest is one
 * `readManifestResult` accepted, so its `learnings`, where it has any, are
 * `{ id, gateSha256 }` records. */
function orphans(gates, entries, learnings, problems) {
  const hashes = new Map(gates.map(g => [g.id, gateSha256(g)]));
  for (const l of learnings) {
    if (hashes.get(l.id) !== l.gateSha256) problems.push(`landed learning ${l.id} in ${MANIFEST_PATH}: no gate in ${GATES_PATH} has its id and hash`);
  }
  const gateHashes = new Set(hashes.values());
  for (const e of entries ?? []) {
    if (e.origin?.toLowerCase() !== 'learned' || e.approvedSha256 === null || gateHashes.has(e.approvedSha256)) continue;
    problems.push(`${idOr(e.id, `the entry at line ${e.line}`)} in ${LEARNED_PATH}: approved, but no gate in ${GATES_PATH} has its approved-sha256`);
  }
}

/**
 * `{ problems, summary }` for the repository at `root` against `manifest`,
 * a manifest `readManifestResult` accepted: one line per integrity failure,
 * and, only when there is none, the lines that say what was found intact. A
 * cross-check that needs a file that could not be read is not made; that
 * file's own problem is reported instead.
 */
export function integrityEvidence(root, manifest) {
  const problems = [];
  const intact = machinery(root, manifest, problems);
  const committed = committedGates(root, problems);
  const entries = registryEntries(root, problems);
  const learnings = manifest.learnings ?? [];
  if (committed !== null && entries !== null) unapproved(committed.gates, entries, problems);
  if (committed !== null) orphans(committed.gates, entries, learnings, problems);
  if (problems.length) return { problems, summary: [] };

  const summary = [intact, committed.present
    ? `${GATES_PATH}: ${plural(committed.gates.length, 'gate')}, each approved in ${LEARNED_PATH} for its content and its action`
    : `${GATES_PATH}: no committed gate file`];
  if (learnings.length) summary.push(`${plural(learnings.length, 'landed learning')} recorded in ${MANIFEST_PATH}, each matched by its gate`);
  return { problems, summary };
}
