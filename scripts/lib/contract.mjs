// scripts/lib/contract.mjs
//
// The contract number another plugin reads before it installs into a
// repository: `.claude/kh-harness/contract.json`, written by `apply` only
// beside the installed files whose behaviour the number promises
// (`CONTRACT_FILES` in propose.mjs), and listing each of them with the LF
// SHA-256 of what this kit installs there, so a reader with no kit code can
// tell a stale, partial or leftover install from this one. The number says
// what those files do when they run, never whether anything registers them.
//
// It is read as the extensions file is read (`readKitDirFile`): a link at
// it, at `.claude/kh-harness`, or at a `.claude` through which it is reached
// is no contract number.
import { lstatSync } from 'node:fs';
import { join } from 'node:path';

import { lfSha256 } from '../../assets/scripts/harness-log.mjs';
import { readKitDirFile } from '../../assets/scripts/harness-extensions.mjs';
import { STAMP_MARKER } from './render.mjs';

export const CONTRACT = 1;
const CONTRACT_NAME = 'contract.json';
export const CONTRACT_PATH = `.claude/kh-harness/${CONTRACT_NAME}`;

const MAX_BYTES = 65536;

/** The contract file this kit writes, listing `files`, each installed path
 * it speaks for mapped to the LF SHA-256 of what this kit installs there, in
 * the order given. The version is followed by a space so `stampVersion`
 * reads it. */
export function contractFileText(kitVersion, files) {
  return JSON.stringify({
    contract: CONTRACT,
    generatedBy: `${STAMP_MARKER} ${kitVersion} (the contract number another plugin reads). Do not edit: kh-harness stops updating an edited copy and keeps it on uninstall.`,
    files,
  }, null, 2) + '\n';
}

const UNREADABLE = Object.freeze({ state: 'unreadable' });

/** True when `root`'s `.claude` is a link. Another plugin refuses a
 * contract file reached through one, so contract 1 is not available to such
 * a repository and `apply` writes no contract file there. False when it
 * cannot be looked at. */
export function claudeIsLink(root) {
  try {
    return lstatSync(join(root, '.claude'), { throwIfNoEntry: false })?.isSymbolicLink() === true;
  } catch {
    return false;
  }
}

/**
 * What the contract file under `root` says: `absent`, with `link: '.claude'`
 * when `.claude` is a link through which no contract file is reached; `ok` with its
 * `contract`, a safe integer of 1 or more, and `kitWritten`, whether its
 * bytes are `kitText` line endings aside; or `unreadable`, with `link`, the
 * path that is a link, when it is reached through one, and `notDirectory`,
 * the path that is not a directory, when there is no contract file to read.
 * Never throws.
 */
export function contractEvidence(root, kitText) {
  let file;
  try {
    file = readKitDirFile(root, CONTRACT_NAME, MAX_BYTES);
  } catch (error) {
    return error?.code === 'ELOOP' || error?.code === 'EMLINK' ? { state: 'unreadable', link: CONTRACT_PATH } : UNREADABLE;
  }
  if (file.state === 'absent') return claudeIsLink(root) ? { state: 'absent', link: '.claude' } : { state: 'absent' };
  if (file.state === 'link') return { state: 'unreadable', link: file.path };
  if (file.state === 'not-a-directory') return { state: 'unreadable', notDirectory: file.path };
  if (file.state !== 'ok') return UNREADABLE;
  let value;
  try {
    value = JSON.parse(file.bytes.toString('utf8'));
  } catch {
    return UNREADABLE;
  }
  const ok = value !== null && typeof value === 'object' && !Array.isArray(value) && Number.isSafeInteger(value.contract) && value.contract >= 1;
  return ok ? { state: 'ok', contract: value.contract, kitWritten: lfSha256(file.bytes) === lfSha256(Buffer.from(kitText)) } : UNREADABLE;
}
