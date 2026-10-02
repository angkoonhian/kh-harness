#!/usr/bin/env node
// scripts/apply.mjs
//
// The default is always a dry run: without --yes this prints proposals and
// diffs and writes nothing. There is no --force — git is the escape hatch.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listFiles } from './lib/scan.mjs';
import { detectStack } from './lib/detect-stack.mjs';
import { detectHarness } from './lib/detect-harness.mjs';
import { detectExposures } from './lib/detect-exposure.mjs';
import { selectProfile } from './lib/profiles/index.mjs';
import { buildGaps } from './lib/gap-model.mjs';
import { gitInfo } from './lib/git-info.mjs';
import { buildProposals } from './lib/propose.mjs';
import { readManifest, emptyManifest, writeManifest, classify, MANIFEST_PATH } from './lib/manifest.mjs';
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
const checks = buildGaps({ stack, harness, exposures, profile, git, files, root });

const manifest = readManifest(root) ?? emptyManifest(KIT_VERSION);
const proposals = buildProposals({ checks, manifest, kitVersion: KIT_VERSION, harness, root, stack, files });

// Files this kit previously wrote whose content on disk no longer matches
// what the manifest recorded. propose.mjs deliberately never re-proposes a
// file already in the manifest — even once its check looks 'absent' again,
// e.g. because the user deleted it — a user's edit or deletion is a
// decision, not a gap to re-fill (see "a file already in the manifest is
// not re-proposed" in propose.test.mjs). That file therefore never reaches
// applyProposals, so its drift must be surfaced here instead, independent
// of whatever else this run does or doesn't propose. Silent drift is drift
// the user never finds out about.
//
// This is computed BEFORE the apply and reported after it. That is only
// correct because propose.mjs never re-proposes a file already in the
// manifest, so nothing this run writes can change any of these
// classifications. If that rule ever changes, this must move below
// applyProposals — it would otherwise report a pre-apply snapshot as though
// it were the state the user is left with.
const drift = (manifest.files ?? [])
  .filter(f => classify(root, manifest, f.path) === 'ours-modified')
  .map(f => f.path);

function reportDrift() {
  for (const path of drift) {
    process.stdout.write(`kept       ${path} (modified since harness-kit wrote it — left as-is)\n`);
  }
}

if (proposals.length === 0) {
  if (drift.length === 0) {
    process.stdout.write('harness-kit: no proposals — this repository already satisfies every applicable step.\n');
  } else {
    process.stdout.write(`harness-kit: no proposals for ${root}.\n`);
    reportDrift();
  }
  process.exit(0);
}

process.stdout.write(`harness-kit: ${proposals.length} proposal${proposals.length === 1 ? '' : 's'} for ${root}\n\n`);
// renderDiff is read-only, but it is not infallible by construction — it is
// a backstop, not the primary defence (readSettingsResult's shape checks
// are), for the same reason applyProposals is wrapped below: the preview is
// the DEFAULT path, the one a cautious user reaches for first, and it must
// never escape as a raw stack trace and exit 1. The CLI's contract is exit
// 0/2/3, nothing else.
try {
  for (const p of proposals) {
    const label = p.kind === 'file' ? p.path
      : p.kind === 'settings-deny' ? '.claude/settings.json (deny rules)'
      : `.claude/settings.json (hook: ${p.event})`;
    process.stdout.write(`--- ${label}  [${p.checkId}]\n`);
    process.stdout.write(`    ${p.reason}\n`);
    process.stdout.write(renderDiff(root, p) + '\n\n');
  }
} catch (err) {
  process.stderr.write(`harness-kit: could not render the preview: ${err && err.message ? err.message : String(err)}\n`);
  process.exit(2);
}

if (!flags.has('--yes')) {
  reportDrift();
  process.stdout.write('Dry run — nothing written. Re-run with --yes to apply.\n');
  process.exit(0);
}

// applyProposals itself never throws on an I/O failure encountered while
// applying (see apply-lib.mjs) — a partial batch is returned normally, with
// `failed` naming what stopped it, so the manifest below always reflects
// reality. This try/catch is the backstop for anything else: a proposal
// whose target fails the allowlist or containment check (pass 1) still
// throws, and that must never escape as a raw stack trace and exit 1 — the
// CLI's contract is exit 0/2/3, nothing else.
let result;
try {
  result = applyProposals({ root, proposals, manifest, kitVersion: KIT_VERSION });
} catch (err) {
  process.stderr.write(`harness-kit: apply failed: ${err && err.message ? err.message : String(err)}\n`);
  // Nothing was written — pass 1 validates the whole batch before pass 2
  // touches anything — but drift was already computed above and is just as
  // true on this path as on any other. Dropping it here would contradict the
  // reason it is reported independently of what this run proposes.
  reportDrift();
  process.exit(2);
}

// Written even when a failure stopped the batch partway through: the
// manifest must always describe exactly what is actually on disk, so the
// next run (and uninstall) can act on it correctly.
//
// This is the one write in the whole tool that must not fail silently, and
// it is therefore the one that must not be left unguarded. If it throws
// (`.claude` present as a plain file, a full disk, a read-only tree) the
// files just written are on disk with no manifest entry — which means every
// later run classifies them `theirs` and `uninstall` can never remove them.
// That is exactly the un-installability trap this tool exists to avoid, so
// the failure is reported loudly, by path, and exits 2 rather than escaping
// as a raw stack trace and exit 1.
let manifestError = null;
try {
  writeManifest(root, result.manifest);
} catch (err) {
  manifestError = err && err.message ? err.message : String(err);
}

for (const w of result.written) process.stdout.write(`wrote      ${w.path}\n`);
for (const p of result.patched) process.stdout.write(`patched    .claude/settings.json (${p.event})\n`);
for (const r of result.redirected) process.stdout.write(`redirected ${r.from} -> ${r.to}\n`);
for (const s of result.skipped) process.stdout.write(`skipped    ${s.path} (${s.why})\n`);
for (const f of result.failed) process.stderr.write(`failed     ${f.path}: ${f.error}\n`);
reportDrift();

if (manifestError) {
  process.stderr.write(`harness-kit: could not record what was written in ${join(root, MANIFEST_PATH)}: ${manifestError}\n`);
  if (result.written.length > 0) {
    process.stderr.write(
      `harness-kit: the following file(s) are on disk but NOT tracked, so \`uninstall\` cannot remove them — ` +
      `delete them by hand, or fix the problem above and re-run:\n`,
    );
    for (const w of result.written) process.stderr.write(`  ${w.path}\n`);
  }
  process.exit(2);
}

if (result.failed.length > 0) {
  process.stderr.write(
    `harness-kit: apply stopped after a write failure. ${result.written.length} item(s) were written and ` +
    `recorded in the manifest before the failure; nothing after it was attempted. Fix the underlying issue and re-run.\n`,
  );
  process.exit(2);
}

process.exit(0);
