// scripts/lib/ledger.mjs
//
// The learning ledger: one line per event in a learning's life, and one per
// promotion policy the owner set, appended to `ledger.jsonl` in the
// repository's per-machine data directory and hash-chained, each line
// carrying the SHA-256 of the line before it. It is never committed, so no
// merge can break the chain. Only the kit's CLI writes it.
//
// A line is an entry once its newline is written, and each is written whole
// in one append. So bytes after the last newline are a step that never
// finished its line: every reader passes over them, and the next append
// removes them, under the lock, before it chains to the last whole line.
import { createHash } from 'node:crypto';
import { appendFileSync, mkdirSync, truncateSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJson, maxLogFileBytes, OVER_LIMIT, readBounded, repoDataDir } from '../../assets/scripts/harness-log.mjs';
import { safeSessionId } from '../../assets/scripts/harness-redact.mjs';
import { isProcessAlive, withFileLock } from './file-lock.mjs';

export const LEDGER_KINDS = Object.freeze(['proposed', 'replayed', 'rejected', 'trial', 'promoted', 'demoted', 'suspended', 'retired', 'landed', 'reverted', 'wrong', 'policy']);

const LEDGER_FILE = 'ledger.jsonl';

const NEWLINE = 0x0a;
const utf8 = new TextDecoder('utf-8', { fatal: true });

const sha256Hex = bytes => createHash('sha256').update(bytes).digest('hex');
const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const isNonEmptyString = v => typeof v === 'string' && v.length > 0;
const isTimestamp = v => typeof v === 'string' && !Number.isNaN(Date.parse(v));
/** Whether `v` is a SHA-256 as the kit writes one: 64 lowercase hex
 * characters. */
export const isSha256 = v => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

const POLICY_APPROVER = /^policy:[0-9a-f]{64}$/;

/** Whether `value` names who approved a step: exactly `owner`, or a policy
 * as `policy:` and the SHA-256 hex of its canonical JSON. */
export const isApprover = value => value === 'owner' || (typeof value === 'string' && POLICY_APPROVER.test(value));

// Evidence references what was seen, never what was said: a signature id,
// counts and a time span. Any other key is refused, so no excerpt can ride
// along.
const EVIDENCE_FIELDS = {
  signature: isNonEmptyString,
  sessions: v => Number.isSafeInteger(v) && v >= 0,
  firstTs: isTimestamp,
  lastTs: isTimestamp,
  external: v => typeof v === 'boolean',
};

// The kind that records a promotion policy rather than a learning's event.
const POLICY_KIND = 'policy';

const COMMON_FIELDS = {
  kind: v => LEDGER_KINDS.includes(v),
  base: isNonEmptyString,
  learned: isNonEmptyString,
};

const LEARNING_FIELDS = {
  learningId: isNonEmptyString,
  contentSha256: isSha256,
  approvedBy: v => v === null || isApprover(v),
};

// `contentSha256` is the hash of the learning's gate. `proseSha256` is the
// hash of what else the ledger vouches for, its title, why and evidence, as
// `learn-lib.mjs` computes it. An entry written before the kit recorded it
// has none, so it is optional; where present it is a hash.
const PROSE_FIELD = 'proseSha256';

// A policy entry names no learning and carries no evidence: only the hash of
// the policy the owner set, so a policy file nobody recorded promotes
// nothing, or null when the owner withdrew the policy, so restoring an old
// file brings none back.
const POLICY_FIELDS = {
  policySha256: v => v === null || isSha256(v),
  approvedBy: v => v === 'owner',
};

const FIRING_KEYS = ['sessionId', 'line'];

/** The kinds that record the action they grant: a promotion, and a landing
 * or a revert, each of which carries the promotion's approved action on. */
export const ACTION_KINDS = Object.freeze(['promoted', 'landed', 'reverted']);

// Fields only some kinds carry: each is required on those kinds and refused
// on every other. An `ACTION_KINDS` entry records the action it grants, so a
// learning's file cannot claim a stronger one; a wrong mark records the
// firing it marks, by session and 1-based event index, so a firing is marked
// once.
const KIND_FIELDS = {
  action: { kinds: ACTION_KINDS, valid: v => v === 'warn' || v === 'block' },
  firing: {
    kinds: ['wrong'],
    valid: v => isPlainObject(v) && Object.keys(v).length === FIRING_KEYS.length && FIRING_KEYS.every(k => Object.hasOwn(v, k))
      && safeSessionId(v.sessionId) === v.sessionId && Number.isSafeInteger(v.line) && v.line >= 1,
  },
};

// What `appendLedger` adds to every entry it stores.
const STAMP_FIELDS = {
  ts: isTimestamp,
  prev: v => v === null || isSha256(v),
};

function evidenceProblem(evidence) {
  if (!isPlainObject(evidence)) return 'evidence is not an object';
  for (const key of Object.keys(evidence)) {
    if (!Object.hasOwn(EVIDENCE_FIELDS, key)) return `evidence has unknown field "${key}"`;
  }
  for (const [field, valid] of Object.entries(EVIDENCE_FIELDS)) {
    if (!valid(evidence[field])) return `evidence.${field} is missing or invalid`;
  }
  return null;
}

/**
 * Why `value` is not a ledger entry, or null when it is one. A policy entry
 * is the common fields, `POLICY_FIELDS` and an optional string `detail`;
 * any other is the common fields, `LEARNING_FIELDS`, the `KIND_FIELDS` its
 * kind carries, `evidence` and an optional string `detail`. `stored` adds
 * the fields `appendLedger` stamps on.
 */
function entryProblem(value, { stored }) {
  if (!isPlainObject(value)) return 'entry is not an object';
  if (!COMMON_FIELDS.kind(value.kind)) return 'kind is missing or invalid';
  const policy = value.kind === POLICY_KIND;
  const fields = { ...COMMON_FIELDS, ...(policy ? POLICY_FIELDS : LEARNING_FIELDS), ...(stored ? STAMP_FIELDS : {}) };
  const optional = policy ? ['detail'] : ['evidence', 'detail', PROSE_FIELD, ...Object.keys(KIND_FIELDS)];
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(fields, key) && !optional.includes(key)) return `unknown field "${key}"`;
  }
  for (const [field, valid] of Object.entries(fields)) {
    if (!valid(value[field])) return `${field} is missing or invalid`;
  }
  if (value.detail !== undefined && typeof value.detail !== 'string') return 'detail is not a string';
  if (policy) return null;
  if (value[PROSE_FIELD] !== undefined && !isSha256(value[PROSE_FIELD])) return `${PROSE_FIELD} is invalid`;
  for (const [field, { kinds, valid }] of Object.entries(KIND_FIELDS)) {
    if (kinds.includes(value.kind)) {
      if (!valid(value[field])) return `${field} is missing or invalid for a ${value.kind} entry`;
    } else if (value[field] !== undefined) {
      const named = kinds.length === 1 ? kinds[0] : `${kinds.slice(0, -1).join(', ')} or ${kinds.at(-1)}`;
      return `${field} is carried only by a ${named} entry`;
    }
  }
  return evidenceProblem(value.evidence);
}

const ledgerPath = root => join(repoDataDir(root), LEDGER_FILE);

/** The ledger's bytes, or null when the file is absent; any other read
 * failure throws, and so does a ledger larger than `maxLogFileBytes()`
 * (code `OVER_LIMIT`), which is not read. */
function ledgerBytes(root) {
  try {
    return readBounded(ledgerPath(root), maxLogFileBytes());
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
}

/** `{ lines, whole }`: each terminated line's bytes without its newline, and
 * how many bytes they and their newlines take. Anything after is an
 * unterminated last line, which is no entry. */
function splitLines(buf) {
  const lines = [];
  let start = 0;
  for (let nl = buf.indexOf(NEWLINE); nl !== -1; nl = buf.indexOf(NEWLINE, start)) {
    lines.push(buf.subarray(start, nl));
    start = nl + 1;
  }
  return { lines, whole: start };
}

/** The ledger's terminated lines, none when the file is absent; any other
 * read failure throws, as `ledgerBytes` does. */
const ledgerLines = root => splitLines(ledgerBytes(root) ?? Buffer.alloc(0)).lines;

/** The fields of a valid `entry` the ledger stores, copied so nothing
 * beyond its schema rides along. */
function recordedFields(entry) {
  const { kind, base, learned, approvedBy, detail } = entry;
  if (kind === POLICY_KIND) return { kind, policySha256: entry.policySha256, base, learned, approvedBy, detail };
  const { learningId, contentSha256, proseSha256, evidence, action, firing } = entry;
  const { signature, sessions, firstTs, lastTs, external } = evidence;
  return {
    kind, learningId, contentSha256, proseSha256,
    evidence: { signature, sessions, firstTs, lastTs, external },
    base, learned, approvedBy, action,
    firing: firing === undefined ? undefined : { sessionId: firing.sessionId, line: firing.line },
    detail,
  };
}

/**
 * Appends one event to the ledger, adding `ts` (now) and `prev` (the
 * SHA-256 of the previous line's bytes, null for the first line). Throws,
 * writing nothing, when the entry is not the ledger's schema; the caller
 * supplies neither `ts` nor `prev`. An unterminated last line, left by an
 * append that stopped partway, is removed first. A ledger that cannot be
 * read, or is larger than is read, throws and is left as it is: an entry is
 * chained only to a line that was read. `now` is the clock for
 * `ts`, the lock wait and the age of an ownerless lock; `isAlive` says
 * whether a lock's writer is still running.
 */
export function appendLedger(root, entry, { now = Date.now, isAlive = isProcessAlive } = {}) {
  const problem = entryProblem(entry, { stored: false });
  if (problem !== null) throw new Error(`ledger entry refused: ${problem}`);
  const fields = recordedFields(entry);
  const dir = repoDataDir(root);
  mkdirSync(dir, { recursive: true });
  // The read of the last line and the append that chains to it are one step
  // across processes.
  withFileLock(join(dir, `${LEDGER_FILE}.lock`), { name: 'ledger', now, isAlive }, assertHeld => {
    const buf = ledgerBytes(root) ?? Buffer.alloc(0);
    const { lines, whole } = splitLines(buf);
    const prev = lines.length === 0 ? null : sha256Hex(lines.at(-1));
    const record = { ...fields, ts: new Date(now()).toISOString(), prev };
    assertHeld();
    if (whole < buf.length) truncateSync(ledgerPath(root), whole);
    appendFileSync(ledgerPath(root), `${canonicalJson(record)}\n`, 'utf8');
  });
}

/** Every ledger entry in order, without checking the chain; `verifyLedger`
 * does that. An absent ledger is empty; a line that does not parse throws,
 * and so does a ledger that cannot be read or is larger than is read. */
export function readLedger(root) {
  return ledgerLines(root).map((line, i) => {
    try {
      return JSON.parse(utf8.decode(line));
    } catch {
      throw new Error(`ledger line ${i + 1} does not parse`);
    }
  });
}

/** `{ brokenAt, entries }` for the ledger's lines: `brokenAt` as
 * `verifyLedger` gives it, and the parsed entries when it is null. */
function checkedLines(lines) {
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    let parsed;
    try {
      parsed = JSON.parse(utf8.decode(lines[i]));
    } catch {
      return { brokenAt: i + 1 };
    }
    if (entryProblem(parsed, { stored: true }) !== null) return { brokenAt: i + 1 };
    if (i === 0 && parsed.prev !== null) return { brokenAt: 1 };
    if (i > 0 && parsed.prev !== sha256Hex(lines[i - 1])) return { brokenAt: i };
    entries.push(parsed);
  }
  return { brokenAt: null, entries };
}

/** The ledger checked from one read: `{ brokenAt, entries }`, broken at
 * line 1 when it cannot be read at all, or `{ brokenAt: null, overLimit:
 * true }` for one larger than is read, of which no line is known. */
function checkedLedger(root) {
  try {
    return checkedLines(ledgerLines(root));
  } catch (error) {
    return error?.code === OVER_LIMIT ? { brokenAt: null, overLimit: true } : { brokenAt: 1 };
  }
}

/** What a reader is told of where a checked ledger stands, without its
 * entries. */
const standing = ({ brokenAt, entries, overLimit }) => ({ intact: entries !== undefined, brokenAt, ...(overLimit ? { overLimit } : {}) });

/**
 * Whether the ledger is one unbroken chain. `brokenAt` is the 1-based number
 * of the first line the chain cannot vouch for: one that is unreadable, does
 * not parse or is not the schema; the first line when its `prev` is not
 * null; or a line whose successor's `prev` is not its hash. An edit to the
 * last line leaves no successor to catch it. A ledger that cannot be read
 * at all is broken at line 1. One larger than `maxLogFileBytes()` is not
 * read: it is `{ intact: false, brokenAt: null, overLimit: true }`, neither
 * intact nor broken at a line. Never throws.
 */
export function verifyLedger(root) {
  return standing(checkedLedger(root));
}

/** What `verifyLedger` gives, with `entries`: the ledger's entries when its
 * chain is intact, else none, since a chain that is broken or was not read
 * vouches for nothing. One read of the file decides both. Never throws. */
export function readLedgerView(root) {
  const checked = checkedLedger(root);
  return { ...standing(checked), entries: checked.entries ?? [] };
}
