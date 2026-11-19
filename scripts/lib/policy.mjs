// scripts/lib/policy.mjs
//
// The owner's promotion policy: the only way a learned gate moves past
// `observe` on this machine without the owner approving it by hand. It lives
// in the per-machine data directory, outside the repository, and its hash is
// what a promotion under policy records in the ledger. Without a policy file
// nothing is promoted automatically.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { canonicalJson, repoDataDir } from '../../assets/scripts/harness-log.mjs';
import { writeFileAtomic } from './atomic-write.mjs';
import { ABOVE_OBSERVE } from './ledger.mjs';

const POLICY_FILE = 'policy.json';

const isCount = v => Number.isSafeInteger(v) && v >= 0;

// A threshold of zero would promote a gate that never fired, for which
// "none marked wrong" proves nothing.
const isThreshold = v => Number.isSafeInteger(v) && v >= 1;

const FIELDS = {
  minTrialFirings: { valid: isThreshold, expected: 'an integer of at least 1' },
  minTrialSessions: { valid: isThreshold, expected: 'an integer of at least 1' },
  maxAction: { valid: v => ABOVE_OBSERVE.includes(v), expected: ABOVE_OBSERVE.map(a => `'${a}'`).join(' or ') },
};

/**
 * Null when `raw` is a valid policy, else the reason it is not. Every field
 * is required and no other field is allowed, so a misspelt key is reported
 * instead of silently ignored while the hash still covers it.
 */
function invalidReason(raw) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return 'the policy is not a JSON object';
  for (const key of Object.keys(raw)) {
    if (!Object.hasOwn(FIELDS, key)) return `unknown field ${JSON.stringify(key)}`;
  }
  for (const [field, { valid, expected }] of Object.entries(FIELDS)) {
    if (!Object.hasOwn(raw, field)) return `${field} is missing`;
    if (!valid(raw[field])) return `${field} must be ${expected}`;
  }
  return null;
}

const policyHash = policy => createHash('sha256').update(canonicalJson(policy), 'utf8').digest('hex');

/** `{ policy, sha256 }`, `raw` as a policy with the hash a promotion under
 * it records, or `{ reason }` when it is not a valid policy. */
export function checkedPolicy(raw) {
  const reason = invalidReason(raw);
  if (reason !== null) return { reason };
  const policy = { minTrialFirings: raw.minTrialFirings, minTrialSessions: raw.minTrialSessions, maxAction: raw.maxAction };
  return { policy, sha256: policyHash(policy) };
}

/** The repository's promotion policy on this machine. Never throws. */
export function readPolicy(root) {
  let text;
  try {
    text = readFileSync(join(repoDataDir(root), POLICY_FILE), 'utf8');
  } catch (error) {
    if (error?.code === 'ENOENT') return { state: 'absent' };
    return { state: 'unreadable', reason: `the policy file cannot be read (${error?.code ?? 'unknown error'})` };
  }
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return { state: 'unreadable', reason: 'the policy file is not valid JSON' };
  }
  const checked = checkedPolicy(raw);
  return checked.reason === undefined ? { state: 'ok', ...checked } : { state: 'unreadable', reason: checked.reason };
}

/**
 * Writes the policy and returns its SHA-256. The file is written beside its
 * destination and renamed over it, so a reader sees the old policy or the
 * new one, never a partial file. Throws on a policy `readPolicy` would
 * reject.
 */
export function writePolicy(root, policy) {
  const reason = invalidReason(policy);
  if (reason !== null) throw new Error(`invalid policy: ${reason}`);
  const dir = repoDataDir(root);
  mkdirSync(dir, { recursive: true });
  writeFileAtomic(join(dir, POLICY_FILE), JSON.stringify(policy, null, 2) + '\n');
  return policyHash(policy);
}

/** Removes the policy file, if there is one. Throws when it exists and
 * cannot be removed. */
export function removePolicy(root) {
  rmSync(join(repoDataDir(root), POLICY_FILE), { force: true });
}

/**
 * Whether `policy` authorises promoting a learning with this trial record.
 * It fails closed: anything other than a valid policy (null when there is no
 * policy file) authorises nothing, and so does a trial record whose counts
 * are not non-negative integers or whose `external` is not exactly `false`.
 * Both thresholds are inclusive. A learning with any firing marked wrong, or
 * whose evidence includes a session flagged for outside content, is never
 * promoted by policy. How far it may be promoted is `policy.maxAction`, the
 * caller's concern.
 */
export function policyAllows(policy, { firings, sessions, wrong, external } = {}) {
  if (invalidReason(policy) !== null) return false;
  if (![firings, sessions, wrong].every(isCount)) return false;
  if (wrong !== 0 || external !== false) return false;
  return firings >= policy.minTrialFirings && sessions >= policy.minTrialSessions;
}
