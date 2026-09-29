#!/usr/bin/env node

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readManifest } from './lib/manifest.mjs';
import { planUninstall, runUninstall } from './lib/uninstall-lib.mjs';

const root = process.argv[2];
const doYes = process.argv.includes('--yes');

if (!root) {
  console.error('usage: uninstall <repo-path> [--yes]');
  process.exit(1);
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
  console.log('Will keep (user-modified):');
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

if (result.failed.length > 0) {
  console.log('Failed to remove:');
  for (const f of result.failed) {
    console.log(`  ${f.path} (${f.reason})`);
  }
}

// Report settings failures and patches that couldn't be reverted (C1a, C1b)
if (result.settingsReadFailed) {
  console.log('Settings file could not be read: hooks remain registered');
}

if (result.settingsWriteFailed) {
  console.log('Settings file could not be written: hooks not reverted');
}

if (result.patchesNotReverted.length > 0) {
  console.log('Could not revert:');
  for (const p of result.patchesNotReverted) {
    console.log(`  ${p.container}`);
  }
}

if (plan.keep.length > 0 || plan.keepPatches.length > 0) {
  console.log('Kept (user-modified):');
  for (const k of plan.keep) {
    console.log(`  ${k.path}`);
  }
  for (const p of plan.keepPatches) {
    console.log(`  ${p.container}`);
  }
}

if (result.removed.length === 0 && result.failed.length === 0 && plan.keep.length === 0 && plan.keepPatches.length === 0 && !result.settingsReadFailed && !result.settingsWriteFailed && result.patchesNotReverted.length === 0) {
  console.log('nothing was left behind');
}

// Exit 2 if any removal failed, or if settings couldn't be handled (C1b)
if (result.failed.length > 0 || result.settingsReadFailed || result.settingsWriteFailed) {
  process.exit(2);
}

process.exit(0);
