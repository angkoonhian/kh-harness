#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { displayPath, readManifestResult, MANIFEST_PATH } from './lib/manifest.mjs';
import { planUninstall, runUninstall } from './lib/uninstall-lib.mjs';
import { CONTRACT_PATH } from './lib/contract.mjs';
import { EXTENSIONS_PATH, readExtensions } from '../assets/scripts/harness-extensions.mjs';
import { CONTRACT_FILES } from './lib/propose.mjs';
import { settingsReformattedNote } from './lib/apply-lib.mjs';
import { parseArgv, refuseExtraArguments, warnUnknown, wantsHelp, UNINSTALL_USAGE } from './lib/cli.mjs';

// Parsed by the one parser every entry point uses (cli.mjs), with its
// unknown-flag warning: this is the command that deletes files.
const KNOWN_FLAGS = new Set(['--yes']);

const argv = process.argv.slice(2);

if (wantsHelp(argv)) {
  process.stdout.write(UNINSTALL_USAGE + '\n');
  process.exit(0);
}

const USAGE = 'usage: uninstall <repo-path> [--yes]   (--help for the full contract)';
const { flags, target, positionals, unknown } = parseArgv(argv, KNOWN_FLAGS);
warnUnknown(unknown);
refuseExtraArguments(positionals.slice(1), USAGE);

const root = target;
const doYes = flags.has('--yes');

if (!root) {
  // The CLI contract is exit 0, 2 or 3 and nothing else. A missing argument
  // is a refusal to act, not a crash. Deliberately NOT defaulted to
  // `process.cwd()` the way detect/apply do: there is no safe default for a
  // command that removes files.
  console.error(USAGE);
  process.exit(2);
}

if (!existsSync(root)) {
  console.error(`error: repository not found: ${root}`);
  process.exit(2);
}

const manifestResult = readManifestResult(root);
if (manifestResult.state === 'missing') {
  console.error(`nothing to uninstall: no manifest found`);
  process.exit(3);
}
if (manifestResult.state === 'corrupt') {
  console.error(
    `refusing to uninstall: ${join(root, MANIFEST_PATH)} exists but could not be read as a valid kh-harness manifest, ` +
    `so what this tool installed cannot be told apart from your own files. Restore it from git history and re-run.`,
  );
  process.exit(3);
}
const manifest = manifestResult.manifest;

const plan = planUninstall({ root, manifest });

/** Why a file is kept, as the plan and the result print it: the reason's
 * code, or for a learned file a sentence saying what would let it go. */
function keptWhy(k) {
  if (k.why === 'holds-landed-learnings') {
    const one = k.learnings === 1;
    return `holds ${k.learnings} landed learning${one ? '' : 's'}, which ${one ? 'is' : 'are'} yours: \`learn revert <id>\` takes each out of the repository, and uninstall removes this file once it holds none`;
  }
  if (k.why === 'learned-partner-kept') return `kept because ${k.partner} is: the learned registry and the gate file stay or go together`;
  if (k.why === 'hook-still-registered') {
    return k.settingsUnread
      ? `${k.why}: .claude/settings.json could not be read, so a hook entry in it may still run it, or a script that loads it; mend the file, then run uninstall again`
      : `${k.why}: a hook entry left in .claude/settings.json still runs it, or a script that loads it, and with the script gone that hook would fail on every event; put the entry back as kh-harness wrote it or delete it, then run uninstall again`;
  }
  return k.why;
}

/** Why a settings patch is kept: the reason's code, with a sentence for the
 * one whose remedy is in the settings file. */
function patchWhy(p) {
  if (p.why === 'patch-modified') {
    return `${p.why}: the entry kh-harness recorded is not there as written while one that runs a kit script is, so that one is taken to be it, edited, and is left registered with its script kept; put it back as written or delete it, then run uninstall again`;
  }
  return p.why;
}

// Every path and container printed below is the manifest's, a file in the
// repository, so each goes through `displayPath` first.

// A forged or malformed record can lack a container; it is still listed.
const patchLabel = p => (p.container === undefined ? '(no container)' : displayPath(p.container));

/** One line about another plugin's extensions file, or null when there is
 * none: removing the PreToolUse hook stops every extension it lists, and
 * the file and its modules are not the kit's to remove. */
function extensionsLine() {
  const file = readExtensions(root);
  if (file.state === 'absent') return null;
  const LEFT = 'The file and its modules are left in place: kh-harness did not write them.';
  if (file.state !== 'ok') return `${EXTENSIONS_PATH} could not be read as an extensions file, and nothing it lists runs once the PreToolUse hook is removed. ${LEFT}`;
  const n = file.entries.length;
  return `${EXTENSIONS_PATH} lists ${n} extension${n === 1 ? '' : 's'} another plugin registered, and ${n === 1 ? 'it does not run' : 'none of them runs'} once the PreToolUse hook is removed. ${LEFT}`;
}
// Print the plan
if (plan.remove.length) {
  console.log('Will remove:');
  for (const r of plan.remove) {
    console.log(`  ${displayPath(r.path)}`);
  }
}

if (plan.revert.length) {
  console.log('Will revert settings patches:');
  for (const p of plan.revert) {
    console.log(`  ${patchLabel(p)}`);
  }
}

if (plan.keep.length) {
  console.log('Will keep:');
  for (const k of plan.keep) {
    console.log(`  ${displayPath(k.path)} (${keptWhy(k)})`);
  }
}

if (plan.keepPatches.length) {
  console.log('Will keep settings patches:');
  for (const p of plan.keepPatches) {
    console.log(`  ${patchLabel(p)} (${patchWhy(p)})`);
  }
}

const patchesOfAbsentFile = plan.gonePatches.filter(p => p.why === 'settings-missing');
const patchesRemovedByHand = plan.gonePatches.filter(p => p.why !== 'settings-missing');

if (patchesOfAbsentFile.length) {
  console.log('Settings file is absent — these recorded hook patches have nothing to revert:');
  for (const p of patchesOfAbsentFile) {
    console.log(`  ${patchLabel(p)}`);
  }
}

/** What the manifest records that is no longer there, a file or a settings
 * entry: nothing is done to the repository for either, and --yes drops the
 * record. */
function printAlreadyGone(heading, paths, patches) {
  if (paths.length === 0 && patches.length === 0) return;
  console.log(heading);
  for (const path of paths) console.log(`  ${displayPath(path)}`);
  for (const p of patches) console.log(`  ${patchLabel(p)} (no longer in .claude/settings.json)`);
}
printAlreadyGone('Already gone, so only the record of it is dropped:', plan.gone.map(g => g.path), patchesRemovedByHand);

/** `detect`'s report is not recorded as installed, so uninstall never
 * removes it: said, so the directory it keeps is no surprise. */
function printLeftInPlace(heading, paths) {
  if (paths.length === 0) return;
  console.log(heading);
  for (const path of paths) console.log(`  ${path}`);
}
printLeftInPlace('Will leave in place (written by `detect`, which records nothing as installed; delete it by hand if you do not want it):', plan.leftInPlace);

// The preview is the path a cautious user reaches for first, and one that
// under-reports what --yes will do has them approve one thing and get a
// larger one. So the plan also predicts the settings file and the
// directories --yes removes, by the questions the real run asks of its own
// outcome (see `planUninstall`).
if (plan.removeSettingsFile) {
  console.log('Will remove (now empty, created by kh-harness):');
  console.log(`  ${plan.removeSettingsFile}`);
}

if (plan.removeDirs.length) {
  console.log('Will remove empty directories it created:');
  for (const dir of plan.removeDirs) {
    console.log(`  ${displayPath(dir)}`);
  }
}

if (plan.sessionLog) {
  const { location, bytes, unread } = plan.sessionLog;
  const notRead = unread ? `, not counting ${unread} entr${unread === 1 ? 'y' : 'ies'} that could not be read` : '';
  console.log("Will keep this machine's session log for this repository (data, outside the repository — uninstall never removes it):");
  console.log(`  ${location} (${bytes} byte${bytes === 1 ? '' : 's'}${notRead})`);
}

// Printed with the plan, so the dry run and --yes both say it.
const extensions = extensionsLine();
if (extensions !== null) console.log(extensions);

if (!doYes) {
  console.log('');
  console.log('Run with --yes to apply.');
  process.exit(0);
}

let result;
try {
  result = runUninstall({ root, manifest, plan });
} catch (e) {
  console.error(`error during uninstall: ${e?.message ?? 'unknown error'}`);
  process.exit(2);
}

// After applying, always report what was kept or failed
console.log('');
if (result.removed.length > 0) {
  console.log('Removed:');
  for (const path of result.removed) {
    console.log(`  ${displayPath(path)}`);
  }
}

// Reverting a patch parses and re-serialises settings.json as applying one
// does, and discloses a reformat in the same sentence.
if (result.settingsReformatted) {
  console.log(settingsReformattedNote('reverting the patch(es) above'));
}

// Directories this tool created (never one that existed before it, and
// never one still holding anything) are removed once uninstall leaves them
// empty, and listed as a removed file is.
if (result.removedDirs && result.removedDirs.length > 0) {
  console.log('Removed empty directories it created:');
  for (const dir of result.removedDirs) {
    console.log(`  ${displayPath(dir)}`);
  }
}

printAlreadyGone('Already gone (dropped from the record):', result.alreadyGone, result.patchesGone);

if (result.failed.length > 0) {
  console.log('Failed to remove:');
  for (const f of result.failed) {
    console.log(`  ${displayPath(f.path)} (${f.reason})`);
  }
}

if (result.changedSincePlan.length > 0) {
  console.log('Changed since plan (kept):');
  for (const c of result.changedSincePlan) {
    console.log(`  ${displayPath(c.path)} (${keptWhy(c)})`);
  }
}

// A manifest entry that is outside the write allowlist, or that resolves
// outside the repository through a symlink or junction, is never deleted.
if (result.refused.length > 0) {
  console.log('Refused to remove (kept):');
  for (const r of result.refused) {
    console.log(`  ${displayPath(r.path)} (${r.why})`);
  }
}

// Report settings failures and patches that couldn't be reverted
if (result.settingsReadFailed) {
  console.log('Settings file could not be read: hooks remain registered');
}

// Absent is not unreadable: there is no hook left to remain registered, so
// this is information, not a failure, and it must not block a clean exit.
if (result.settingsMissing) {
  console.log('Settings file is absent: nothing to revert, no hooks remain registered');
}

if (result.settingsWriteFailed) {
  console.log('Settings file could not be written: hooks not reverted');
}

if (result.manifestWriteFailed) {
  console.log(`Manifest file could not be updated: ${join(root, MANIFEST_PATH)}`);
}

if (result.manifestDeleteFailed) {
  console.log(`Manifest file could not be removed: ${join(root, MANIFEST_PATH)}`);
}

// The run re-derives the revertable set, so `result.patchesNotReverted` —
// not `plan.keepPatches` — is what was actually left registered. Reporting
// the plan's guess as well would double-count, and would name a patch this
// same run had just removed.
if (result.patchesNotReverted.length > 0) {
  console.log('Could not revert:');
  for (const p of result.patchesNotReverted) {
    console.log(`  ${patchLabel(p)} (${patchWhy(p)})`);
  }
}

// A patch declined for lack of provenance is kept the way a file is: listed
// with its reason, and never a failure.
if (plan.keep.length > 0 || result.patchesKept.length > 0) {
  console.log('Kept:');
  // A kept contract file still tells another plugin a contract holds here,
  // beside none, or only some, of the scripts it speaks for.
  const gone = CONTRACT_FILES.filter(path => !existsSync(join(root, path))).length;
  const removedScripts = gone === CONTRACT_FILES.length ? 'the scripts it speaks for were' : `${gone} of the ${CONTRACT_FILES.length} scripts it speaks for were`;
  for (const k of plan.keep) {
    const orphan = k.path === CONTRACT_PATH && gone > 0 ? `: it still declares a kh-harness contract, and ${removedScripts} removed; delete it by hand` : '';
    console.log(`  ${displayPath(k.path)} (${keptWhy(k)}${orphan})`);
  }
  for (const p of result.patchesKept) {
    console.log(`  ${patchLabel(p)} (${patchWhy(p)})`);
  }
}

// What was kept stays on record, so a later run can finish: said, since a
// manifest left in the repository is otherwise unexplained.
if (result.manifestRemains && !result.manifestDeleteFailed) {
  console.log(`${MANIFEST_PATH} remains: it records what was kept, and running uninstall again acts on it.`);
}

printLeftInPlace('Left in place (written by `detect`, which records nothing as installed; delete it by hand if you do not want it):', result.leftInPlace);

if (result.removed.length === 0 && result.failed.length === 0 && result.changedSincePlan.length === 0 && result.refused.length === 0 && plan.keep.length === 0 && result.patchesKept.length === 0 && !result.settingsReadFailed && !result.settingsWriteFailed && !result.manifestWriteFailed && !result.manifestDeleteFailed && result.patchesNotReverted.length === 0 && result.leftInPlace.length === 0) {
  console.log('nothing was left behind');
}

// Exit 2 if any removal failed or was refused, a file changed since the
// plan, a recorded settings patch is still registered and could not be
// reverted, or the settings file or the manifest could not be handled.
if (result.failed.length > 0 || result.changedSincePlan.length > 0 || result.refused.length > 0 || result.patchesNotReverted.length > 0 || result.settingsReadFailed || result.settingsWriteFailed || result.manifestWriteFailed || result.manifestDeleteFailed) {
  process.exit(2);
}

process.exit(0);
