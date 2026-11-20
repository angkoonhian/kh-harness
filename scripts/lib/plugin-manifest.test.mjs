import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..', '..');
const read = p => JSON.parse(readFileSync(resolve(ROOT, p), 'utf8'));

test('the manifest declares a kebab-case name and a version', () => {
  const m = read('.claude-plugin/plugin.json');
  assert.match(m.name, /^[a-z0-9]+(-[a-z0-9]+)*$/, 'kebab-case, no spaces, no @, no separators');
  assert.match(m.version, /^\d+\.\d+\.\d+$/);
  assert.ok(m.description && m.description.length > 0);
  assert.ok(m.author && m.author.name, 'validate warns without author, and CI runs --strict');
});

test('the plugin\'s hooks are found by convention, and none of them is a hook apply installs', () => {
  // Plugin hooks merge with a repository's with no deduplication, so a
  // plugin copy of an apply-installed hook would run twice in every
  // installed repository. The plugin's one hook (session-nudge.test.mjs
  // pins its shape) is its own script, silent where apply has installed.
  const m = read('.claude-plugin/plugin.json');
  assert.equal(m.hooks, undefined, 'hooks/hooks.json is loaded by convention; declaring it too would load it twice');
  const installed = readdirSync(resolve(ROOT, 'assets', 'scripts'));
  const text = readFileSync(resolve(ROOT, 'hooks', 'hooks.json'), 'utf8');
  for (const name of installed) assert.ok(!text.includes(name), `the plugin must not run ${name}, which apply installs`);
});

test('LOAD-BEARING: claude plugin validate --strict exits 0 on the shipped plugin', (t) => {
  // Invoked via a shell (execSync), not execFileSync: on Windows `claude` resolves
  // to a `claude.cmd` shim, and Node refuses to spawn .cmd/.bat files directly
  // without a shell (CVE-2024-27980 hardening) — execFileSync('claude', ...) fails
  // there with EINVAL/ENOENT even when claude is genuinely installed.
  try {
    execSync('claude --version', { encoding: 'utf8', stdio: 'pipe' });
  } catch (e) {
    t.skip(`\`claude\` binary not found on PATH — install it with \`npm install -g @anthropic-ai/claude-code\` to run \`claude plugin validate --strict\` (${String(e.message).split('\n')[0]})`);
    return;
  }

  let status = 0, out = '';
  try {
    // ROOT is passed via cwd, not interpolated into the command string: on cmd.exe,
    // double-quoting a path stops space/& expansion but NOT `%VAR%` expansion (e.g. a
    // path segment like `100%CI%dir` becomes `100truedir` under GitHub Actions' own
    // CI=true). Removing the interpolation removes the whole class of shell-expansion
    // bugs rather than escaping the one character found so far.
    out = execSync('claude plugin validate . --strict', { cwd: ROOT, encoding: 'utf8' });
  } catch (e) {
    status = e.status; out = String(e.stdout ?? '') + String(e.stderr ?? '');
  }
  assert.equal(status, 0, `validate --strict must pass. Output:\n${out}`);
});
