// scripts/lib/extensions-evidence.mjs
//
// Evidence for `P5.extensions` (gap-model.mjs's check): the extensions
// `.claude/kh-harness/extensions.json` lists, each with whether its module
// matches the sha256 recorded for it, and whether the three installed files
// that decide what the PreToolUse hook does with them (the entry script, the
// core it runs its halves through and the extensions loader) are what this
// kit installs today. The file is read by the installed loader's own rules,
// so `detect` and the hook cannot disagree about it.
//
// A module is hashed, never imported: it is code from the repository, and
// detect runs it nowhere. What is kept is only what reaches the committed
// report safely: the fields the loader validated, the fixed state words and
// the loader's fixed problem text, never a file's bytes or a recorded hash.
import { moduleState, readExtensions } from '../../assets/scripts/harness-extensions.mjs';
import { KIT_VERSION } from './manifest.mjs';
import { DISPATCH_PRE_PATH, HARNESS_DISPATCH_PATH, HARNESS_EXTENSIONS_PATH, installedScriptStatus } from './propose.mjs';

/** `{ state: 'absent' }`, `{ state: 'malformed', problem, installed }`, or
 * `{ state: 'ok', installed, extensions }` with each entry's `id`,
 * `version`, `module` and `onFailure`, and its module's `hash` state:
 * `matches`, `differs`, `missing`, `outside` or `unreadable`. `installed`
 * holds `current`, `other` or `missing` for the `entry` script, the `core`
 * and the `loader`. */
export function extensionsEvidence(root) {
  const file = readExtensions(root);
  if (file.state === 'absent') return file;
  const installed = {
    entry: installedScriptStatus(root, DISPATCH_PRE_PATH, KIT_VERSION),
    core: installedScriptStatus(root, HARNESS_DISPATCH_PATH, KIT_VERSION),
    loader: installedScriptStatus(root, HARNESS_EXTENSIONS_PATH, KIT_VERSION),
  };
  if (file.state === 'malformed') return { ...file, installed };
  return {
    state: 'ok',
    installed,
    extensions: file.entries.map(entry => ({
      id: entry.id, version: entry.version, module: entry.module, onFailure: entry.onFailure, hash: moduleState(root, entry).state,
    })),
  };
}
