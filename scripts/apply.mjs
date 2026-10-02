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
import { buildGaps, countProposals } from './lib/gap-model.mjs';
import { gitInfo } from './lib/git-info.mjs';
import { buildProposals } from './lib/propose.mjs';
import { readManifestResult, emptyManifest, writeManifest, classify, MANIFEST_PATH } from './lib/manifest.mjs';
import { applyProposals, renderDiff, SETTINGS_PATH, settingsReformattedNote } from './lib/apply-lib.mjs';
import { parseArgv, warnUnknown, wantsHelp, APPLY_USAGE } from './lib/cli.mjs';

const KIT_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
const DEFAULT_BRANCHES = new Set(['main', 'master']);
const KNOWN_FLAGS = new Set(['--yes', '--allow-default-branch', '--allow-dirty', '--help', '-h']);

const argv = process.argv.slice(2);

if (wantsHelp(argv)) {
  process.stdout.write(APPLY_USAGE + '\n');
  process.exit(0);
}

const { flags, target, unknown } = parseArgv(argv, KNOWN_FLAGS);
const root = resolve(target ?? process.cwd());

warnUnknown(unknown);

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

// Task 9b, finding 3: moved above the dirty-tree gate (it used to be read
// afterward) so the gate can tell the user's own uncommitted work apart
// from the tool's own prior writes — see `ownedByUs` and the gate itself,
// immediately below.
//
// Coordinator finding (Major): a manifest file that EXISTS but cannot be
// read as our schema must refuse the run, not be silently treated as "no
// manifest" — acting on that assumption writes a fresh EMPTY manifest at
// the end of this run (see writeManifest below), permanently losing the
// record of every file a prior install wrote. Those files become
// invisible to `uninstall` forever, with no notice. Same contract as the
// default-branch and dirty-tree refusals above: exit 3, name the file,
// no automatic repair. A CORRUPT manifest cannot be trusted to name what
// is "ours" either, so `ownedByUs` stays empty in that case and the gate
// below falls back to its original, strict behaviour — the corrupt-
// manifest refusal a few lines down still fires regardless.
const manifestResult = readManifestResult(root);

/**
 * Paths the dirty-tree gate must not hold against the user: the tool's own
 * prior writes, per the manifest's own record of them — never re-derived
 * from the filesystem, which is exactly what a forged or stale record could
 * fool. `.claude/settings.json` counts only when the manifest actually
 * recorded a patch there; an untouched settings.json dirtied by something
 * else is not "ours" merely because it shares that path. The manifest file
 * itself is always ours: it is this tool's own bookkeeping, and a run that
 * updates it (new `installedAt`, a new file entry) is expected to leave it
 * modified if the user has ever committed it.
 */
function ownedByUs(manifest) {
  const owned = new Set([MANIFEST_PATH]);
  for (const f of manifest?.files ?? []) owned.add(f.path);
  if ((manifest?.settingsPatches ?? []).length > 0) owned.add(SETTINGS_PATH);
  return owned;
}
const ourPaths = manifestResult.state === 'ok' ? ownedByUs(manifestResult.manifest) : new Set();

/**
 * True only for changes to tracked files NOT already accounted for by
 * `ignorePaths` — new, untracked files are not this tool's problem either
 * way. Without `ignorePaths`, this tool's own first `apply --yes` dirties
 * any tracked `.claude/settings.json` it patches, so a plain second run
 * refused with no recourse but `--allow-dirty`, which waives the gate for
 * every OTHER uncommitted change too — the mechanism that protects the
 * legibility of a `git diff` of this tool's own work was forcing its own
 * blanket waiver. The gate still exists, and still refuses, for anything
 * genuinely not ours.
 */
/**
 * `-z` for the same reason `scan.mjs`'s `gitPaths` uses it, and this is the
 * third of the three places in the tool that asks git for a path (the other
 * two are both inside `gitPaths`). This one used to half-know about the
 * problem — it stripped the surrounding double quotes git adds without ever
 * un-escaping the octal inside them — which made `.claude/caf\303\251.md`
 * compare unequal to the `ourPaths` entry for the same file, so this tool's
 * OWN prior write looked like the user's uncommitted work and the dirty-tree
 * gate refused with no recourse but `--allow-dirty`. Un-escaping by hand was
 * never the fix; not asking for escaped output is.
 *
 * Porcelain v1 in `-z` mode: each record is `XY<space><path>`, NUL-
 * terminated, and a rename or copy emits the NEW path in its own record
 * followed immediately by the ORIGINAL path as a separate record — there is
 * no ` -> ` form here (verified against git directly on this branch, not
 * assumed). The status belongs to the pair, and the path that matters is the
 * new one, so the original-path record is consumed and never tested.
 */
function hasTrackedChanges(r, ignorePaths = new Set()) {
  try {
    const out = execFileSync('git', ['-C', r, 'status', '--porcelain', '-z', '--untracked-files=no'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const records = out.split('\0');
    for (let i = 0; i < records.length; i++) {
      const record = records[i];
      if (!record) continue;
      const status = record.slice(0, 2);
      const path = record.slice(3);
      // Rename/copy: skip the original-path record that follows this one.
      if (status.includes('R') || status.includes('C')) i += 1;
      if (!ignorePaths.has(path.split('\\').join('/'))) return true;
    }
    return false;
  } catch {
    return false;
  }
}

if (git.isRepo && hasTrackedChanges(root, ourPaths) && !flags.has('--allow-dirty')) {
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
if (manifestResult.state === 'corrupt') {
  process.stderr.write(
    `harness-kit: ${join(root, MANIFEST_PATH)} exists but could not be read as a valid harness-kit manifest. ` +
    `Continuing would overwrite it with a fresh, empty one and permanently lose the record of what this tool ` +
    `previously installed — refusing instead. Restore the file from git history (or from a backup) and re-run; ` +
    `there is no automatic repair.\n`,
  );
  process.exit(3);
}
const manifest = manifestResult.manifest ?? emptyManifest(KIT_VERSION);
const checks = buildGaps({ stack, harness, exposures, profile, git, files, root, manifest });

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
    process.stdout.write('harness-kit: no actions — this repository already satisfies every applicable step.\n');
  } else {
    process.stdout.write(`harness-kit: no actions for ${root}.\n`);
    reportDrift();
  }
  process.exit(0);
}

// Task 9b, finding 7: `proposals.length` (every file write and settings
// patch this run would make) and `detect`'s own "N proposals" (every
// CAPABILITY GAP with an actionable next step) count two different things
// for the same repository — one gap like P2.sensor expands into three
// writes here. Both used to be printed as "N proposals", inviting a reader
// to diff numbers that were never comparable. `countProposals` (gap-
// model.mjs) is the exact function `detect`'s own report reads, so the
// gap count named here can never drift from what `detect` would say; this
// run's own, larger number is named "actions" instead of reusing the word
// detect already owns.
const gapCount = countProposals(checks);
process.stdout.write(
  `harness-kit: ${proposals.length} action${proposals.length === 1 ? '' : 's'} to close ` +
  `${gapCount} capability gap${gapCount === 1 ? '' : 's'} (as detect reports them) for ${root}\n\n`,
);
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

// Coordinator finding (Minor): a settings-hook/deny write rewrites the
// WHOLE file via JSON.stringify(settings, null, 2) — if the user's own
// settings.json was not already in exactly that form (compact, a
// different indent width, a different key order, ...), applying a patch
// reformats everything else in the file too, not just what is listed
// above. Captured BEFORE applyProposals runs, since that call may rewrite
// the very file this checks. Ruled, not fixed (see docs/task-8b-report.md,
// finding 7): preserving the original formatting needs a format-preserving
// JSON editor — a dependency, or a parser this project would have to
// maintain — and that is a worse trade than disclosing a reformat.
function alreadyCanonical(path) {
  if (!existsSync(path)) return true; // nothing to reformat
  try {
    const raw = readFileSync(path, 'utf8');
    return raw === JSON.stringify(JSON.parse(raw), null, 2) + '\n';
  } catch {
    return true; // unreadable/unparseable — never reaches a settings write anyway
  }
}
const settingsWasCanonical = alreadyCanonical(join(root, SETTINGS_PATH));

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
if (result.patched.length > 0 && !settingsWasCanonical) {
  process.stdout.write(settingsReformattedNote('applying the patch above') + '\n');
}
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
