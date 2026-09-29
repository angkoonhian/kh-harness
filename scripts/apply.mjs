#!/usr/bin/env node
// scripts/apply.mjs
//
// The default is always a dry run: without --yes this prints proposals and
// diffs and writes nothing. There is no --force — git is the escape hatch.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { listFiles } from './lib/scan.mjs';
import { detectStack } from './lib/detect-stack.mjs';
import { detectHarness } from './lib/detect-harness.mjs';
import { detectExposures } from './lib/detect-exposure.mjs';
import { selectProfile } from './lib/profiles/index.mjs';
import { buildGaps } from './lib/gap-model.mjs';
import { gitInfo } from './lib/git-info.mjs';
import { buildProposals } from './lib/propose.mjs';
import { readManifest, emptyManifest, writeManifest } from './lib/manifest.mjs';
import { applyProposals, renderDiff } from './lib/apply-lib.mjs';

const KIT_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const DEFAULT_BRANCHES = new Set(['main', 'master']);
const KNOWN_FLAGS = new Set(['--yes', '--allow-default-branch', '--allow-dirty']);

const argv = process.argv.slice(2);
const flags = new Set(argv.filter(a => a.startsWith('--')));
const target = argv.find(a => !a.startsWith('--')) ?? process.cwd();
const root = resolve(target);

const unknownFlags = [...flags].filter(f => !KNOWN_FLAGS.has(f));
if (unknownFlags.length) {
  process.stderr.write(`harness-kit: ignoring unknown flag(s): ${unknownFlags.join(', ')}\n`);
}

if (!existsSync(root)) {
  process.stderr.write(`harness-kit: no such path: ${root}\n`);
  process.exit(2);
}

const git = gitInfo(root);

if (git.isRepo && DEFAULT_BRANCHES.has(git.branch) && !flags.has('--allow-default-branch')) {
  process.stderr.write(
    `harness-kit: refusing to apply on the default branch "${git.branch}". ` +
    `A user must be able to \`git diff\` exactly what this tool did — switch to a ` +
    `feature branch, or re-run with --allow-default-branch if this is intentional.\n`,
  );
  process.exit(3);
}

/** True only for changes to tracked files — new, untracked files are not this tool's problem. */
function hasTrackedChanges(r) {
  try {
    const out = execFileSync('git', ['-C', r, 'status', '--porcelain', '--untracked-files=no'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

if (git.isRepo && hasTrackedChanges(root) && !flags.has('--allow-dirty')) {
  process.stderr.write(
    `harness-kit: refusing to apply with uncommitted changes to tracked files. ` +
    `Commit or stash first so you can \`git diff\` what this tool did, or re-run with --allow-dirty.\n`,
  );
  process.exit(3);
}

const { files } = listFiles(root);
const stack = detectStack(root, files);
const harness = detectHarness(root, files);
harness.reconPresent = files.includes('docs/harness/recon.md');
const exposures = detectExposures(root, files, harness);
const profile = selectProfile(stack);
const checks = buildGaps({ stack, harness, exposures, profile, git });

const manifest = readManifest(root) ?? emptyManifest(KIT_VERSION);
const proposals = buildProposals({ checks, manifest, kitVersion: KIT_VERSION, harness, root, stack });

if (proposals.length === 0) {
  process.stdout.write('harness-kit: no proposals — this repository already satisfies every applicable step.\n');
  process.exit(0);
}

process.stdout.write(`harness-kit: ${proposals.length} proposal${proposals.length === 1 ? '' : 's'} for ${root}\n\n`);
for (const p of proposals) {
  const label = p.kind === 'file' ? p.path : `.claude/settings.json (hook: ${p.event})`;
  process.stdout.write(`--- ${label}  [${p.checkId}]\n`);
  process.stdout.write(`    ${p.reason}\n`);
  process.stdout.write(renderDiff(root, p) + '\n\n');
}

if (!flags.has('--yes')) {
  process.stdout.write('Dry run — nothing written. Re-run with --yes to apply.\n');
  process.exit(0);
}

const result = applyProposals({ root, proposals, manifest, kitVersion: KIT_VERSION });
writeManifest(root, result.manifest);

for (const w of result.written) process.stdout.write(`wrote     ${w.path}\n`);
for (const p of result.patched) process.stdout.write(`patched   .claude/settings.json (${p.event})\n`);
for (const r of result.redirected) process.stdout.write(`redirected ${r.from} -> ${r.to}\n`);
for (const s of result.skipped) process.stdout.write(`skipped   ${s.path} (${s.why})\n`);

process.exit(0);
