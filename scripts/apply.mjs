#!/usr/bin/env node
// scripts/apply.mjs
//
// The default is always a dry run: without --yes this prints proposals and
// diffs and writes nothing. There is no --force — git is the escape hatch.
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
import { deriveCouldNotDerive, exposureSectionLines, stillOpen, worktreeLine } from './lib/report.mjs';
import { readManifestResult, emptyManifest, writeManifest, classify, displayPath, KIT_VERSION, MANIFEST_PATH } from './lib/manifest.mjs';
import { applyProposals, diffRenderer, SETTINGS_PATH, settingsReformattedNote, isCanonicalJson, unusableSettingsReason, writeGateRefusals } from './lib/apply-lib.mjs';
import { parseArgv, refuseExtraArguments, warnUnknown, wantsHelp, APPLY_USAGE, EXECUTION_DISCLOSURE } from './lib/cli.mjs';

const KNOWN_FLAGS = new Set(['--yes', '--allow-default-branch', '--allow-dirty']);

const argv = process.argv.slice(2);

if (wantsHelp(argv)) {
  process.stdout.write(APPLY_USAGE + '\n');
  process.exit(0);
}

const { flags, target, positionals, unknown } = parseArgv(argv, KNOWN_FLAGS);
const root = resolve(target ?? process.cwd());

warnUnknown(unknown);
refuseExtraArguments(positionals.slice(1), 'usage: apply <repo-path> [--yes] [--allow-dirty] [--allow-default-branch]   (--help for the full contract)');

if (!existsSync(root)) {
  process.stderr.write(`kh-harness: no such path: ${root}\n`);
  process.exit(2);
}

const git = gitInfo(root);

// The manifest is read before the gates, so the dirty-tree gate can tell
// the user's own uncommitted work apart from the tool's own prior writes —
// see `writeGateRefusals` in apply-lib.mjs.
//
// A manifest file that exists but cannot be read as our schema refuses the
// run, below, with or without --yes. Treated as "no manifest", the run
// would end by writing a fresh empty one, and the record of every file a
// prior install wrote would be lost: those files would be invisible to
// `uninstall` for good. Exit 3, the file named, no automatic repair.
const manifestResult = readManifestResult(root);

const refusals = writeGateRefusals({
  root, git, manifestResult, verb: 'apply',
  allowDefaultBranch: flags.has('--allow-default-branch'), allowDirty: flags.has('--allow-dirty'),
});
// Both gates waived over a git failure: the run proceeds, and the checks
// treat the directory as not under version control. Said once, as `detect`
// says it, so the waiver never makes the failure silent.
if (git.error && refusals.length === 0) {
  process.stderr.write(`kh-harness: ${git.error} — proceeding with both gates waived; the checks treat this directory as not under version control.\n`);
}
if (flags.has('--yes') && refusals.length) {
  for (const r of refusals) process.stderr.write(`kh-harness: ${r}\n`);
  process.exit(3);
}

// `nested` is kept and reported below: a run that omits it makes a partial
// scan look complete, and this run is about to write into the repository it
// scanned.
const { files, nested, worktrees, unreadableDirs } = listFiles(root);
const stack = detectStack(root, files);
const harness = detectHarness(root, files);
harness.reconPresent = files.includes('docs/harness/recon.md');
const exposures = detectExposures(root, files, harness, unreadableDirs);
const profile = selectProfile(stack);
if (manifestResult.state === 'corrupt') {
  process.stderr.write(
    `kh-harness: ${join(root, MANIFEST_PATH)} exists but could not be read as a valid kh-harness manifest. ` +
    `Continuing would overwrite it with a fresh, empty one and permanently lose the record of what this tool ` +
    `previously installed — refusing instead. Restore the file from git history (or from a backup) and re-run; ` +
    `there is no automatic repair.\n`,
  );
  process.exit(3);
}
const manifest = manifestResult.manifest ?? emptyManifest(KIT_VERSION);
// The checks are given the manifest as `detect` gives it, null when there
// is none, so the two commands report one repository the same way.
const checks = buildGaps({ stack, harness, exposures, profile, git, files, root, manifest: manifestResult.manifest, kitVersion: KIT_VERSION });

// This command does the detection `detect` does, and is usable without it,
// so it says what that detection found: a credential finding, the nested
// repositories it did not descend into, and the questions it could not
// answer. Printed before any write, and before the "no actions" early exit,
// so it reaches the user on every path. The exposure block comes from the
// renderer `detect` uses (`exposureSectionLines`, report.mjs) and the
// questions from the function it uses (`deriveCouldNotDerive`), so neither
// can differ from what `detect` would say.
const questions = deriveCouldNotDerive({ stack, checks, nested, profile });
function reportWhatDetectionFound() {
  const out = [];
  const exposureLines = exposureSectionLines(exposures, nested);
  if (exposureLines.length) {
    out.push('kh-harness: this run performed the same Phase-0 credential sweep `detect` does, and it is not clean.');
    out.push(...exposureLines);
  }
  if (nested.length) {
    const was = nested.length === 1 ? 'y was' : 'ies were';
    out.push(`kh-harness: ${nested.length} nested repositor${was} detected and NOT scanned (${nested.map(n => n.path).join(', ')}). Everything below covers this repository only; each nested repository must be assessed separately.`);
    out.push('');
  }
  if (worktrees.length) {
    out.push(`kh-harness: ${worktreeLine(worktrees)}`);
    out.push('');
  }
  if (questions.length) {
    const s = questions.length === 1 ? '' : 's';
    out.push(`kh-harness: ${questions.length} question${s} this run could not answer:`);
    for (const q of questions) out.push(`  - ${q}`);
    out.push('');
  }
  if (out.length) process.stdout.write(out.join('\n') + '\n');
}
reportWhatDetectionFound();

const proposals = buildProposals({ checks, manifest, kitVersion: KIT_VERSION, harness, root, stack, files });

// Files this kit wrote whose content on disk no longer matches what the
// manifest recorded. propose.mjs never proposes again a file the user has
// edited or deleted, even once its check looks absent: the edit or the
// deletion is a decision, not a gap to fill. Such a file never reaches
// `applyProposals`, so its drift is reported here, whatever else this run
// proposes.
//
// Computed before the apply and reported after it. That stays correct
// because the only recorded file propose.mjs writes is one that classifies
// `ours-unmodified`, as an update, and writing it records its new hash: no
// file can move into the modified set because of anything this run writes.
// An update path for modified files would have to move this below
// `applyProposals`.
const drift = (manifest.files ?? [])
  .filter(f => classify(root, manifest, f.path) === 'ours-modified')
  .map(f => f.path);

function reportDrift() {
  for (const path of drift) {
    // The path is the manifest's, so it is cleaned before it is printed.
    process.stdout.write(existsSync(join(root, path))
      ? `kept       ${displayPath(path)} (modified since kh-harness wrote it — left as-is)\n`
      : `gone       ${displayPath(path)} (deleted since kh-harness wrote it — not written again)\n`);
  }
}

if (proposals.length === 0) {
  process.stdout.write(`kh-harness: no actions for ${root} — nothing apply can write; ${stillOpen(checks, questions)}.\n`);
  reportDrift();
  process.exit(0);
}

// An action is one file write or settings patch, and one gap can need
// several, so the two counts are named apart. The gaps counted are the
// checks these actions belong to — not every gap `detect` proposes for,
// some of which only the skill or a human can close.
const gapCount = new Set(proposals.map(p => p.checkId)).size;
process.stdout.write(
  `kh-harness: ${proposals.length} action${proposals.length === 1 ? '' : 's'} to close ` +
  `${gapCount} capability gap${gapCount === 1 ? '' : 's'} for ${root}\n\n`,
);
// The preview is read-only, but it is wrapped like `applyProposals` below:
// it is the default path, the one a cautious user reaches for first, and it
// must never escape as a stack trace and exit 1. The CLI's contract is exit
// 0, 2 or 3.
//
// Under --yes the labels and reasons are printed and file diffs are not:
// the dry run is where those are, and --yes reports what it wrote, below. A
// settings patch — a hook entry or deny rules — is a few lines and the most
// security-relevant thing this tool writes, so it is still shown.
const showFileDiffs = !flags.has('--yes');
const preview = diffRenderer(root);
try {
  for (const p of proposals) {
    const label = p.kind === 'file' ? p.path
      : p.kind === 'settings-deny' ? '.claude/settings.json (deny rules)'
      : p.kind === 'settings-hook-replace' ? `.claude/settings.json (hook: ${p.event}, replacing ${p.remove.length} registration${p.remove.length === 1 ? '' : 's'})`
      : `.claude/settings.json (hook: ${p.event})`;
    process.stdout.write(`--- ${label}  [${p.checkId}]\n`);
    process.stdout.write(`    ${p.reason}\n`);
    if (showFileDiffs || p.kind !== 'file') process.stdout.write(preview(p) + '\n');
    process.stdout.write('\n');
  }
} catch (err) {
  process.stderr.write(`kh-harness: could not render the preview: ${err && err.message ? err.message : String(err)}\n`);
  process.exit(2);
}

if (!flags.has('--yes')) {
  // A hook runs by itself once registered, so what each one does is said
  // beside the dry run that would register it, not only under --help.
  if (proposals.some(p => p.kind === 'settings-hook' || p.kind === 'settings-hook-replace')) process.stdout.write(EXECUTION_DISCLOSURE + '\n\n');
  reportDrift();
  // What `--yes` would refuse, said now rather than after the diffs have
  // been read and acted on — see writeGateRefusals.
  for (const r of refusals) process.stdout.write(`note: --yes would be refused — ${r}\n`);
  process.stdout.write('Dry run — nothing written. Re-run with --yes to apply.\n');
  process.exit(0);
}

// A settings patch that cannot land leaves the hook scripts it registers
// installed and inert, so a batch that includes one writes nothing at all.
const settingsProblem = proposals.some(p => p.kind !== 'file') ? unusableSettingsReason(root) : null;
if (settingsProblem) {
  process.stderr.write(
    `kh-harness: ${SETTINGS_PATH} ${settingsProblem}, so the settings patches above cannot be applied — ` +
    `nothing was written. Fix the file and re-run.\n`,
  );
  reportDrift();
  process.exit(2);
}

// A settings write re-serialises the whole file (`serializeSettings`: the
// file's own BOM, indentation and trailing newline are kept). If the user's
// settings.json was not already in that form (compact, say), applying a
// patch normalises the rest of the file too, and that is disclosed below.
// Asked before `applyProposals` runs, since that call rewrites the file
// this reads. Keeping every byte of the original formatting would need a
// format-preserving JSON editor, a dependency or a parser to maintain, and
// disclosing the reformat is the better trade.
function readRawIfPresent(path) {
  if (!existsSync(path)) return null;
  try { return readFileSync(path, 'utf8'); } catch { return null; }
}
const settingsWasCanonical = isCanonicalJson(readRawIfPresent(join(root, SETTINGS_PATH)));

// `applyProposals` never throws on an I/O failure met while applying (see
// apply-lib.mjs): a partial batch is returned normally, with `failed` naming
// what stopped it, so the manifest below always describes what was written.
// This try/catch is for anything else: a proposal whose target fails the
// allowlist or containment check (pass 1) still throws, and that must not
// escape as a stack trace and exit 1.
let result;
try {
  result = applyProposals({ root, proposals, manifest, kitVersion: KIT_VERSION, persistManifest: staged => writeManifest(root, staged) });
} catch (err) {
  process.stderr.write(`kh-harness: apply failed: ${err && err.message ? err.message : String(err)}\n`);
  // Nothing was written: pass 1 validates the whole batch before pass 2
  // touches anything. The drift computed above is as true on this path as
  // on any other.
  reportDrift();
  process.exit(2);
}

// Written straight after the settings file, and even when a failure stopped
// the batch partway: the manifest must describe what is on disk, so the
// next run and `uninstall` can act on it.
//
// This is the one write that must not fail silently. If it throws (`.claude`
// present as a plain file, a full disk, a read-only tree) the files just
// written are on disk with no manifest entry, every later run classifies
// them `theirs`, and `uninstall` can never remove them. So the failure is
// reported by path and exits 2.
let manifestError = null;
try {
  writeManifest(root, result.manifest);
} catch (err) {
  manifestError = err && err.message ? err.message : String(err);
}

for (const w of result.written) {
  process.stdout.write(`wrote      ${w.path}\n`);
  // chmod is a no-op on Windows: the execute bit lives in git's index there,
  // and only the user can put it in.
  if (w.mode && process.platform === 'win32') {
    process.stdout.write(`note: Windows cannot record the execute bit — run \`git update-index --chmod=+x ${w.path}\` before committing\n`);
  }
}
for (const p of result.patched) {
  const removed = p.replaced ? `; ${p.replaced} separate registration${p.replaced === 1 ? '' : 's'} removed` : '';
  process.stdout.write(`patched    .claude/settings.json (${p.event}${removed})\n`);
}
if (result.patched.length > 0 && !settingsWasCanonical) {
  process.stdout.write(settingsReformattedNote('applying the patch above') + '\n');
}
for (const s of result.skipped) process.stdout.write(`skipped    ${s.path} (${s.why})\n`);
for (const f of result.failed) process.stderr.write(`failed     ${f.path}: ${f.error}\n`);
reportDrift();

if (manifestError) {
  process.stderr.write(`kh-harness: could not record what was written in ${join(root, MANIFEST_PATH)}: ${manifestError}\n`);
  if (result.written.length > 0) {
    process.stderr.write(
      `kh-harness: the following file(s) are on disk but NOT tracked, so \`uninstall\` cannot remove them — ` +
      `delete them by hand, or fix the problem above and re-run:\n`,
    );
    for (const w of result.written) process.stderr.write(`  ${w.path}\n`);
  }
  process.exit(2);
}

if (result.failed.length > 0) {
  process.stderr.write(
    `kh-harness: apply stopped after a write failure. ${result.written.length} item(s) were written and ` +
    `recorded in the manifest before the failure; nothing after it was attempted. Fix the underlying issue and re-run.\n`,
  );
  process.exit(2);
}

process.exit(0);
