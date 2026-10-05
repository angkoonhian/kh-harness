#!/usr/bin/env node
// scripts/detect.mjs
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { listFiles } from './lib/scan.mjs';
import { detectStack } from './lib/detect-stack.mjs';
import { detectHarness } from './lib/detect-harness.mjs';
import { detectExposures } from './lib/detect-exposure.mjs';
import { selectProfile } from './lib/profiles/index.mjs';
import { buildGaps } from './lib/gap-model.mjs';
import { buildReport, renderSummary } from './lib/report.mjs';
import { verifyCommands } from './lib/verify.mjs';
import { gitInfo } from './lib/git-info.mjs';
import { readManifest } from './lib/manifest.mjs';
import { parseArgv, warnUnknown, wantsHelp, DETECT_USAGE } from './lib/cli.mjs';

const KIT_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;

const KNOWN_FLAGS = new Set(['--verify', '--json', '--help', '-h']);

const argv = process.argv.slice(2);

if (wantsHelp(argv)) {
  process.stdout.write(DETECT_USAGE + '\n');
  process.exit(0);
}

// Parsed by the one shared parser all three entry points use — see cli.mjs
// for why three independent copies of this was itself a finding (F10).
const { flags, target, unknown } = parseArgv(argv, KNOWN_FLAGS);
const root = resolve(target ?? process.cwd());

// A typo like `--verfiy` used to be a silent no-op. Say so — on stderr, never
// on stdout, which --json callers parse.
warnUnknown(unknown);

if (!existsSync(root)) {
  process.stderr.write(`kh-harness: no such path: ${root}\n`);
  process.exit(2);
}

// listFiles also reports nested repositories (submodules, nested/bare repos)
// it deliberately did not descend into. That disclosure must reach the
// report — a report that omits it makes a partial scan look complete.
const { files, nested } = listFiles(root);
const git = gitInfo(root);
const stack = detectStack(root, files);
const harness = detectHarness(root, files);
harness.reconPresent = files.includes('docs/harness/recon.md');
const exposures = detectExposures(root, files, harness);
const profile = selectProfile(stack);
// Read-only here — detect never writes the manifest. Passed through so
// gap-model.mjs can confirm OUR OWN hook is present via the install record
// plus a direct file check when a gitignored `.claude/` makes it invisible
// to the file scan (see registeredHook's own comment).
const manifest = readManifest(root);
const checks = buildGaps({ stack, harness, exposures, profile, git, files, root, manifest });

const report = buildReport({ root, kitVersion: KIT_VERSION, git, stack, harness, exposures, profile, checks, nested });

if (flags.has('--verify')) {
  report.verification = verifyCommands({ root, stack, profile });
}

// The one and only write.
const outDir = join(root, 'docs', 'harness');
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'detect.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');

process.stdout.write(flags.has('--json') ? JSON.stringify(report, null, 2) + '\n' : renderSummary(report) + '\n');
