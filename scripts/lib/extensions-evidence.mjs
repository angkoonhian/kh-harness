// scripts/lib/extensions-evidence.mjs
//
// Evidence for `P5.extensions` (gap-model.mjs's check): the extensions
// `.claude/kh-harness/extensions.json` lists, each with whether its module
// matches the sha256 recorded for it, and whether the installed files that
// decide what the PreToolUse hook does with them (`EXTENSION_HOOK_FILES`)
// are what this kit installs today. The file is read by the installed
// loader's own rules, so `detect` and the hook cannot disagree about it.
//
// A module is hashed, never imported: it is code from the repository, and
// detect runs it nowhere. What is kept is only what reaches the committed
// report safely: the fields the loader validated, the fixed state words and
// the loader's fixed problem text, never a file's bytes or a recorded hash.
import { moduleState, readExtensions } from '../../assets/scripts/harness-extensions.mjs';
import { KIT_VERSION } from './manifest.mjs';
import { DISPATCH_PRE_PATH, HARNESS_DISPATCH_PATH, HARNESS_EXTENSIONS_PATH, everyLoadedSibling, installedScriptStatus } from './propose.mjs';

/** The installed files that decide what the PreToolUse entry script does
 * with an extensions file: the entry script; the core and what it loads,
 * without which no half runs; and the loader and what it loads, without
 * which the extensions half cannot run. The entry script's other siblings
 * are the gate and log halves, which have no part in it. */
export const EXTENSION_HOOK_FILES = Object.freeze({
  entry: [DISPATCH_PRE_PATH],
  core: [HARNESS_DISPATCH_PATH, ...everyLoadedSibling(HARNESS_DISPATCH_PATH)],
  loader: [HARNESS_EXTENSIONS_PATH, ...everyLoadedSibling(HARNESS_EXTENSIONS_PATH)],
});

/** `{ state: 'absent' }`, `{ state: 'malformed', problem, installed }`, or
 * `{ state: 'ok', installed, extensions }` with each entry's `id`,
 * `version`, `module` and `onFailure`, and its module's `hash` state:
 * `matches`, `differs`, `missing`, `outside` or `unreadable`. `installed`
 * maps each of `EXTENSION_HOOK_FILES`, in order, to its
 * `installedScriptStatus`. */
export function extensionsEvidence(root) {
  const file = readExtensions(root);
  if (file.state === 'absent') return file;
  const installed = Object.fromEntries(Object.values(EXTENSION_HOOK_FILES).flat().map(path => [path, installedScriptStatus(root, path, KIT_VERSION)]));
  if (file.state === 'malformed') return { ...file, installed };
  return {
    state: 'ok',
    installed,
    extensions: file.entries.map(entry => ({
      id: entry.id, version: entry.version, module: entry.module, onFailure: entry.onFailure, hash: moduleState(root, entry).state,
    })),
  };
}
