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

runUninstall({ root, manifest, plan });

// After applying, always print what was kept
if (plan.keep.length > 0 || plan.keepPatches.length > 0) {
  console.log('');
  console.log('Kept:');
  for (const k of plan.keep) {
    console.log(`  ${k.path}`);
  }
  for (const p of plan.keepPatches) {
    console.log(`  ${p.container}`);
  }
}

process.exit(0);
