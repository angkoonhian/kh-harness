// scripts/lib/extensions-evidence.mjs
//
// Evidence for `P5.extensions` (gap-model.mjs's check): the extensions
// `.claude/kh-harness/extensions.json` lists, each with whether its module
// matches the sha256 recorded for it. Read by the installed loader's own
// rules, so `detect` and the hook that runs the extensions cannot disagree
// about the file.
//
// A module is hashed, never imported: it is code from the repository, and
// detect runs it nowhere. What is kept is only what reaches the committed
// report safely: the fields the loader validated, the fixed state words and
// the loader's fixed problem text, never a module's bytes or its recorded
// hash.
import { moduleState, readExtensions } from '../../assets/scripts/harness-extensions.mjs';

/** `{ state: 'absent' }`, `{ state: 'malformed', problem }`, or
 * `{ state: 'ok', extensions }` with each entry's `id`, `version`, `module`
 * and `onFailure`, and its module's `hash` state: `matches`, `differs`,
 * `missing`, `outside` or `unreadable`. */
export function extensionsEvidence(root) {
  const file = readExtensions(root);
  if (file.state !== 'ok') return file;
  return {
    state: 'ok',
    extensions: file.entries.map(entry => ({
      id: entry.id, version: entry.version, module: entry.module, onFailure: entry.onFailure, hash: moduleState(root, entry).state,
    })),
  };
}
