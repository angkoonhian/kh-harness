#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readManifest } from './lib/manifest.mjs';
import { planUninstall, runUninstall } from './lib/uninstall-lib.mjs';
import { settingsReformattedNote } from './lib/apply-lib.mjs';
import { parseArgv, warnUnknown, wantsHelp, UNINSTALL_USAGE } from './lib/cli.mjs';

// Whole-branch review, F10: this was `process.argv[2]` with no flag parsing
// at all, so `uninstall --yes .` reported `repository not found: --yes` and
// exited 2, and `uninstall . --yse` silently removed nothing of what was
// asked — in the one command of the three that deletes files. It uses the
// same parser and the same unknown-flag warning as `detect` and `apply` now.
const KNOWN_FLAGS = new Set(['--yes', '--help', '-h']);

const argv = process.argv.slice(2);

if (wantsHelp(argv)) {
  process.stdout.write(UNINSTALL_USAGE + '\n');
  process.exit(0);
}

const { flags, target, unknown } = parseArgv(argv, KNOWN_FLAGS);
warnUnknown(unknown);

const root = target;
const doYes = flags.has('--yes');

if (!root) {
  // The CLI contract is exit 0, 2 or 3 and nothing else. A missing argument
  // is a refusal to act, not a crash. Deliberately NOT defaulted to
  // `process.cwd()` the way detect/apply do: there is no safe default for a
  // command that removes files.
  console.error('usage: uninstall <repo-path> [--yes]   (--help for the full contract)');
  process.exit(2);
}

if (!existsSync(root)) {
  console.error(`error: repository not found: ${root}`);
  process.exit(2);
}

const manifest = readManifest(root);
if (!manifest) {
  console.error(`nothing to uninstall: no manifest found`);
  process.exit(3);
}

const plan = planUninstall({ root, manifest });

// Print the plan
if (plan.remove.length) {
  console.log('Will remove:');
  for (const r of plan.remove) {
    console.log(`  ${r.path}`);
  }
}

if (plan.revert.length) {
  console.log('Will revert settings patches:');
  for (const p of plan.revert) {
    console.log(`  ${p.container}`);
  }
}

if (plan.keep.length) {
  console.log('Will keep:');
  for (const k of plan.keep) {
    console.log(`  ${k.path} (${k.why})`);
  }
}

if (plan.keepPatches.length) {
  console.log('Will keep settings patches (modified):');
  for (const p of plan.keepPatches) {
    console.log(`  ${p.container} (${p.why})`);
  }
}

if (plan.gonePatches.length) {
  console.log('Settings file is absent — these recorded hook patches have nothing to revert:');
  for (const p of plan.gonePatches) {
    console.log(`  ${p.container}`);
  }
}

// Task 9b (coordinator round 2, finding 1): the preview is the path a
// cautious user reaches for first, and a preview that under-reports what
// --yes will actually do is worse than no preview — they approve one
// thing and get a different, larger one. These two predictions come from
// the exact same questions runUninstall's own real outcome asks (see
// planUninstall's own comments on `removeSettingsFile` and `removeDirs`),
// not a second, independently-reasoned guess at what the real run will do.
if (plan.removeSettingsFile) {
  console.log('Will remove (now empty, created by harness-kit):');
  console.log(`  ${plan.removeSettingsFile}`);
}

if (plan.removeDirs.length) {
  console.log('Will remove empty directories it created:');
  for (const dir of plan.removeDirs) {
    console.log(`  ${dir}`);
  }
}

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
    console.log(`  ${path}`);
  }
}

// Task 9b, finding 5: apply.mjs already discloses a settings.json reformat
// caused by its own JSON.stringify(x, null, 2) rewrite; uninstall rewrites
// the same file the same way while reverting a patch, and must disclose it
// the same way rather than leaving a user to discover the diff unannounced.
if (result.settingsReformatted) {
  console.log(settingsReformattedNote('reverting the patch(es) above'));
}

// Task 9b, finding 4: directories this tool itself created (never one that
// existed before it, and never one still holding anything) are cleaned up
// once uninstall leaves them empty — disclosed here the same way a removed
// file is.
if (result.removedDirs && result.removedDirs.length > 0) {
  console.log('Removed empty directories it created:');
  for (const dir of result.removedDirs) {
    console.log(`  ${dir}`);
  }
}

if (result.failed.length > 0) {
  console.log('Failed to remove:');
  for (const f of result.failed) {
    console.log(`  ${f.path} (${f.reason})`);
  }
}

// Report files that changed since plan (defect 1)
if (result.changedSincePlan.length > 0) {
  console.log('Changed since plan (kept):');
  for (const c of result.changedSincePlan) {
    console.log(`  ${c.path} (${c.why})`);
  }
}

// A manifest entry that is outside the write allowlist, or that resolves
// outside the repository through a symlink or junction, is never deleted.
if (result.refused.length > 0) {
  console.log('Refused to remove (kept):');
  for (const r of result.refused) {
    console.log(`  ${r.path} (${r.why})`);
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
  console.log(`Manifest file could not be updated: ${join(root, '.claude/harness-kit.manifest.json')}`);
}

if (result.manifestDeleteFailed) {
  console.log(`Manifest file could not be removed: ${join(root, '.claude/harness-kit.manifest.json')}`);
}

// The run re-derives the revertable set, so `result.patchesNotReverted` —
// not `plan.keepPatches` — is what was actually left registered. Reporting
// the plan's guess as well would double-count, and would name a patch this
// same run had just removed.
if (result.patchesNotReverted.length > 0) {
  console.log('Could not revert:');
  for (const p of result.patchesNotReverted) {
    console.log(`  ${p.container} (${p.why})`);
  }
}

if (plan.keep.length > 0) {
  console.log('Kept:');
  for (const k of plan.keep) {
    console.log(`  ${k.path} (${k.why})`);
  }
}

if (result.removed.length === 0 && result.failed.length === 0 && result.changedSincePlan.length === 0 && result.refused.length === 0 && plan.keep.length === 0 && !result.settingsReadFailed && !result.settingsWriteFailed && !result.manifestWriteFailed && !result.manifestDeleteFailed && result.patchesNotReverted.length === 0) {
  console.log('nothing was left behind');
}

// Exit 2 if any removal failed or was refused, a file changed since plan, or
// if settings/manifest couldn't be handled
if (result.failed.length > 0 || result.changedSincePlan.length > 0 || result.refused.length > 0 || result.settingsReadFailed || result.settingsWriteFailed || result.manifestWriteFailed || result.manifestDeleteFailed) {
  process.exit(2);
}

process.exit(0);
