#!/usr/bin/env node
// The plugin's one hook, run at SessionStart in every session where the
// plugin is enabled. It tells Claude whether the repository the session
// opened in has the kit, so a repository without it is one "yes" away from
// it, and one installed by an older kit is offered the upgrade.
//
// Everything else the kit does at run time is installed into the repository
// by `apply`, where its commands come from the repository's own evidence.
// This hook is the exception because it is the one thing that has to happen
// BEFORE there is a repository install to carry it. It is held to that:
//
//   - It is silent wherever there is nothing to say: in an installed
//     repository at this kit's version, whose own session-brief already
//     speaks; outside a git repository, where the kit cannot be installed;
//     in the kit's own repository; and wherever the owner switched it off.
//     So a session never hears two kit hooks say the same thing.
//
//   - It writes nothing and installs nothing. Installing is `apply`'s, and
//     `apply` writes files and hooks that execute, so the notice asks Claude
//     to offer and leaves the yes to the user.
//
//   - It always exits 0. A SessionStart hook has nothing to block, and a
//     failure here must never stand between the user and their session.
import { join } from 'node:path';
import { readJsonFile } from './lib/read-json.mjs';
import { KIT_VERSION, MANIFEST_PATH, readManifestResult } from './lib/manifest.mjs';
import { git } from './lib/git-info.mjs';

const SKILL = '/kh-harness:harness-init';
const OFF = 'git config kh-harness.nudge off';
const ALL_OFF = 'KH_HARNESS_NUDGE=off';
// Each session start runs git twice at most, so a bound well under the
// hook's own timeout keeps a hung git from holding the session up.
const GIT_TIMEOUT_MS = 3_000;

/** -1, 0 or 1 as `a` is older than, the same as or newer than `b`, compared
 * field by field as numbers; a version that is not three numbers compares
 * as different from every version and older than none. */
function compareVersions(a, b) {
  const parse = v => (typeof v === 'string' && /^\d+\.\d+\.\d+$/.test(v) ? v.split('.').map(Number) : null);
  const [x, y] = [parse(a), parse(b)];
  if (!x || !y) return a === b ? 0 : -1;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  return 0;
}

/** The top of the git work tree holding `dir`, or null when there is none
 * or git cannot say. */
function workTreeTop(dir) {
  try {
    return git(dir, ['rev-parse', '--show-toplevel'], { timeout: GIT_TIMEOUT_MS }).trim() || null;
  } catch {
    return null;
  }
}

/** True when the owner set `kh-harness.nudge` to `off` for this repository
 * (or globally, through git's own config scopes). */
function switchedOff(top) {
  try {
    return git(top, ['config', '--get', 'kh-harness.nudge'], { timeout: GIT_TIMEOUT_MS }).trim().toLowerCase() === 'off';
  } catch {
    return false; // unset is exit 1
  }
}

/** True when `top` is the kit's own repository, which the kit is not
 * installed into. */
function isKitRepository(top) {
  const read = readJsonFile(join(top, '.claude-plugin', 'plugin.json'));
  return read.state === 'ok' && read.value?.name === 'kh-harness';
}

/** What to tell the session about the repository at `top`, or null for
 * nothing. The manifest is looked for at the project directory first, where
 * `apply` was most likely pointed, then at the work-tree top. */
function notice(projectDir, top) {
  const candidates = [...new Set([projectDir, top])];
  const results = candidates.map(dir => ({ dir, ...readManifestResult(dir) }));
  const found = results.find(r => r.state !== 'missing');

  if (!found) {
    return `kh-harness: this repository has no kh-harness harness installed (no ${MANIFEST_PATH} under ${top}). ` +
      `If the user's work here would benefit from one, offer once, briefly, to set it up with the ${SKILL} skill. ` +
      `It writes files and hooks that run commands into the repository, so run it only if the user agrees. ` +
      `To stop this notice in this repository: ${OFF}; everywhere: set ${ALL_OFF}.`;
  }
  if (found.state === 'corrupt') {
    return `kh-harness: ${join(found.dir, MANIFEST_PATH)} exists but cannot be read as a kh-harness manifest, ` +
      `so what the kit installed here is not known. Tell the user, and suggest running the kit's detect command on this repository to see what it finds.`;
  }
  const installed = found.manifest.kitVersion;
  const order = compareVersions(installed, KIT_VERSION);
  if (order === 0) return null;
  if (order > 0) {
    return `kh-harness: this repository's harness was installed by kit ${installed}, and the plugin is older (${KIT_VERSION}). ` +
      `Tell the user the plugin needs updating. Do not offer to set up or upgrade the harness here: the older plugin would propose its older files.`;
  }
  return `kh-harness: this repository's harness was installed by kit ${installed ?? 'of an unrecorded version'}; the plugin is ${KIT_VERSION}. ` +
    `Offer once, briefly, to upgrade it with the ${SKILL} skill, which shows what it would change before writing. ` +
    `Run it only if the user agrees. To stop this notice in this repository: ${OFF}; everywhere: set ${ALL_OFF}.`;
}

function main() {
  if (process.env.KH_HARNESS_NUDGE?.toLowerCase() === 'off') return;
  const projectDir = process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const top = workTreeTop(projectDir);
  if (!top || isKitRepository(top)) return;
  const text = notice(projectDir, top);
  if (text && !switchedOff(top)) process.stdout.write(text + '\n');
}

try {
  main();
} catch (err) {
  // Never block a session start, and never put a stack trace in its
  // context: one line on stderr, which Claude Code shows the user, not the
  // model, so a broken hook is still seen.
  process.stderr.write(`kh-harness session-nudge: ${err?.message ?? err}\n`);
}
process.exitCode = 0;
