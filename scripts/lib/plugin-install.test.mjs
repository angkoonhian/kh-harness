import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { APPLY_USAGE, DETECT_USAGE, LEARN_USAGE, LOG_USAGE, UNINSTALL_USAGE } from './cli.mjs';

const ROOT = resolve(import.meta.dirname, '..', '..');
const readme = () => readFileSync(join(ROOT, 'README.md'), 'utf8');

test('README documents the install path that actually works', () => {
  const t = readme();

  // Pinned verbatim because the leading `./` is load-bearing: Claude Code
  // rejects `marketplace add .` with "Invalid marketplace source format",
  // measured, and `./` is the only accepted spelling. Tidying the `./` away
  // looks like a harmless cleanup and silently breaks the documented install.
  // Prose elsewhere in this repo is matched loosely on purpose; a command is
  // matched exactly, because here the exact characters ARE the fact.
  assert.match(t, /claude plugin marketplace add \.\/(?=\s|$)/,
    'the README must show `marketplace add ./` — bare `.` is rejected by Claude Code');
  assert.match(t, /claude plugin install kh-harness@kh-harness-local/,
    'the install command needs the marketplace-qualified name to resolve');

  // The skill is the front door, so the README has to name it.
  assert.match(t, /\/harness-init/);

  // This claim shipped once and was false: apply already worked when the
  // README said it did not. An honest README is the whole premise of this
  // tool, so the regression gets a test rather than a memory.
  assert.doesNotMatch(t, /cannot yet apply anything/i,
    'the README understated what apply does once already; it must not return');
});

test('README warns up front that apply can install code-executing hooks', () => {
  // apply writes hooks that run lint/typecheck/test on edits and turn ends.
  // Someone running `apply --yes` on a repo they do not own should not learn
  // that from the diff afterwards, so the warning sits beside the install
  // instructions, not only in the deep-dive section further down.
  //
  // Anchored on wording unique to that up-front warning. An earlier version
  // of this test asserted /apply --yes/ and /hooks/i, which the README's
  // pre-existing deep-dive sections already satisfied at lines 172 and 210 —
  // so the warning could be deleted with the test still green. The mutation
  // that "proved" it substituted every occurrence at once, which is why it
  // looked like it had teeth. Mutate only the thing you claim to pin.
  const t = readme();
  assert.match(t, /Before\s+you\s+run\s+`apply --yes`\s+anywhere/,
    'the up-front warning beside the install steps is gone; the deep-dive section further down does not replace it');
  assert.match(t, /install\s+hooks\s+that\s+execute/,
    'the warning must say that hooks execute code, not merely that hooks exist');
});

test('the plugin ships the skill and declares no hooks', () => {
  // The line and byte budgets live in skill-links.test.mjs, which every
  // change to the skill is already held to. They are deliberately not
  // repeated here: two places asserting one budget drift apart, and the copy
  // that is wrong is always the copy nobody is reading.
  const m = JSON.parse(readFileSync(join(ROOT, '.claude-plugin', 'plugin.json'), 'utf8'));

  // Not an omission. Plugin hooks merge with no deduplication, and the only
  // documented off switch (disableAllHooks) is global — so a plugin-declared
  // hook beside an apply-installed one double-fires with no per-plugin way to
  // stop it. apply owns hook installation; the plugin ships the skill alone.
  assert.equal(m.hooks, undefined,
    'declaring hooks here would double-fire against the ones apply installs');

  // The manifest declares no `skills` key: a declared component path must
  // exist or `validate --strict` exits 1 (measured). Convention scans
  // skills/, so this path on disk is the contract.
  assert.equal(m.skills, undefined,
    'the skill is found by convention; declaring the path adds a way to break validate');
  assert.ok(existsSync(join(ROOT, 'skills', 'harness-init', 'SKILL.md')),
    'convention-based discovery means this exact path is what makes the skill load');
});

/**
 * The subcommand names a usage text lists under SUBCOMMANDS: each line
 * indented by exactly two spaces, up to the first argument, flag or
 * two-space gap.
 */
function subcommandsOf(usage) {
  const block = usage.split('\nSUBCOMMANDS\n')[1].split(/\n(?=\S)/)[0];
  return [...block.matchAll(/^ {2}(\S.*)$/gm)].map(m => {
    const words = [];
    for (const word of m[1].split(/\s{2,}/)[0].split(' ')) {
      if (/^[<[-]/.test(word)) break;
      words.push(word);
    }
    return words.join(' ');
  });
}

const flagsOf = text => [...new Set(text.match(/--[a-z][a-z-]*[a-z]/g))];

test('the README documents the log and learn commands and every flag in their usage text', () => {
  const t = readme();
  const commands = { log: subcommandsOf(LOG_USAGE), learn: subcommandsOf(LEARN_USAGE) };
  assert.ok(commands.log.length >= 6 && commands.learn.length >= 14, 'the usage texts were read');
  for (const [command, names] of Object.entries(commands)) {
    for (const name of names) {
      const synopsis = new RegExp(`node scripts/${command}\\.mjs +<path-to-repo> +${name.replace(/ /g, ' +')}(?![\\w-])`);
      assert.ok(synopsis.test(t), `the README's ${command} synopsis lists \`${command} ${name}\``);
    }
  }
  for (const flag of flagsOf([DETECT_USAGE, APPLY_USAGE, UNINSTALL_USAGE, LOG_USAGE, LEARN_USAGE].join('\n'))) {
    assert.ok(new RegExp(`${flag}(?![a-z-])`).test(t), `the README names ${flag}`);
  }
});

test('the README names all five commands', () => {
  const t = readme();
  for (const script of ['detect', 'apply', 'uninstall', 'log', 'learn']) {
    assert.ok(existsSync(join(ROOT, 'scripts', `${script}.mjs`)), `scripts/${script}.mjs exists`);
    assert.ok(new RegExp(`node scripts/${script}\\.mjs +<path-to-repo>`).test(t), `the README shows \`${script}\``);
  }
});

test("the README's Limits section names the ledger, the local gate file, the deny rules and the terminal check", () => {
  const t = readme();
  const at = t.indexOf('\n## Limits\n');
  assert.ok(at >= 0, 'the README has a Limits section');
  const limits = t.slice(at + 1).split(/\n## /)[0];
  for (const [re, what] of [[/ledger/, 'the ledger'], [/gates\.local\.json/, 'the local gate file'], [/deny\s+rules/, 'the deny rules'], [/terminal/, 'the terminal check'], [/not\s+isolation/, 'that these controls are not isolation']]) {
    assert.ok(re.test(limits), `the Limits section names ${what}`);
  }
});
