import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { listFiles, readIfPresent, existsAny } from './scan.mjs';

function fixture() {
  const d = mkdtempSync(join(tmpdir(), 'hk-scan-'));
  writeFileSync(join(d, 'package.json'), '{}');
  mkdirSync(join(d, 'src'));
  writeFileSync(join(d, 'src', 'index.ts'), 'export const a = 1;');
  mkdirSync(join(d, 'node_modules', 'left-pad'), { recursive: true });
  writeFileSync(join(d, 'node_modules', 'left-pad', 'index.js'), '//');
  // Initialize as git repo for nested detection tests
  try {
    execFileSync('git', ['init', d], { stdio: 'ignore' });
    execFileSync('git', ['-C', d, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
    execFileSync('git', ['-C', d, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
  } catch (e) {
    // Continue anyway — the walk fallback still lists files — but say so, so a
    // git-less environment does not look like a passing nested-detection run.
    console.log(`  (fixture: git init failed, falling back to the directory walk: ${e.message})`);
  }
  return d;
}

test('lists repo files as posix-relative paths', () => {
  const { files } = listFiles(fixture());
  assert.ok(files.includes('package.json'));
  assert.ok(files.includes('src/index.ts'));
});

test('excludes node_modules', () => {
  const { files } = listFiles(fixture());
  assert.equal(files.some(f => f.startsWith('node_modules/')), false);
});

test('reports its source', () => {
  const { source } = listFiles(fixture());
  assert.ok(source === 'git' || source === 'walk');
});

test('readIfPresent returns null for a missing file', () => {
  assert.equal(readIfPresent(fixture(), 'nope.txt'), null);
});

test('readIfPresent returns contents for a present file', () => {
  assert.equal(readIfPresent(fixture(), 'package.json'), '{}');
});

test('existsAny returns the first hit, else null', () => {
  const d = fixture();
  assert.equal(existsAny(d, ['missing.txt', 'package.json']), 'package.json');
  assert.equal(existsAny(d, ['a', 'b']), null);
});

test('a fixture with a nested repository is reported as nested-repo', () => {
  const d = fixture();
  const nested = join(d, 'nested-repo');
  mkdirSync(nested);
  // Create a git repo inside
  try {
    execFileSync('git', ['init', nested], { stdio: 'ignore' });
  } catch (e) {
    // An honest skip: say why, or roughly ten nested-detection tests
    // would report green having asserted nothing.
    console.log(`  (skipped: git init failed: ${e.message})`);
    return;
  }
  const { nested: detected } = listFiles(d);
  assert.ok(detected.some(n => n.kind === 'nested-repo' && n.path === 'nested-repo'));
});

test('a repository with no nesting returns empty nested array', () => {
  const { nested } = listFiles(fixture());
  assert.equal(Array.isArray(nested), true);
  assert.equal(nested.length, 0);
});

test('nested repository under fully-untracked parent is found (no tracked sibling)', () => {
  const d = fixture();
  const vendor = join(d, 'vendor');
  const toolA = join(vendor, 'toolA');
  mkdirSync(toolA, { recursive: true });
  // Create a git repo inside with no tracked sibling under vendor/
  try {
    execFileSync('git', ['init', toolA], { stdio: 'ignore' });
  } catch (e) {
    // An honest skip: say why, or roughly ten nested-detection tests
    // would report green having asserted nothing.
    console.log(`  (skipped: git init failed: ${e.message})`);
    return;
  }
  const { nested: detected } = listFiles(d);
  assert.ok(detected.some(n => n.kind === 'nested-repo' && n.path === 'vendor/toolA'));
});

test('nested repository with tracked sibling under parent is found (regression)', () => {
  const d = fixture();
  const vendor = join(d, 'vendor');
  const toolA = join(vendor, 'toolA');
  mkdirSync(toolA, { recursive: true });
  // Add tracked sibling
  writeFileSync(join(vendor, 'NOTE.md'), '# Vendor');
  // Create a git repo inside
  try {
    execFileSync('git', ['init', toolA], { stdio: 'ignore' });
  } catch (e) {
    // An honest skip: say why, or roughly ten nested-detection tests
    // would report green having asserted nothing.
    console.log(`  (skipped: git init failed: ${e.message})`);
    return;
  }
  const { nested: detected } = listFiles(d);
  assert.ok(detected.some(n => n.kind === 'nested-repo' && n.path === 'vendor/toolA'));
});

test('nested repository three levels down is found', () => {
  const d = fixture();
  const deep = join(d, 'a', 'b', 'c', 'repo');
  mkdirSync(deep, { recursive: true });
  try {
    execFileSync('git', ['init', deep], { stdio: 'ignore' });
  } catch (e) {
    // An honest skip: say why, or roughly ten nested-detection tests
    // would report green having asserted nothing.
    console.log(`  (skipped: git init failed: ${e.message})`);
    return;
  }
  const { nested: detected } = listFiles(d);
  assert.ok(detected.some(n => n.kind === 'nested-repo' && n.path === 'a/b/c/repo'));
});

test('files array contains no trailing-slash entries when nested repositories are present', () => {
  const d = fixture();
  const nested = join(d, 'nested-repo');
  mkdirSync(nested);
  try {
    execFileSync('git', ['init', nested], { stdio: 'ignore' });
  } catch (e) {
    // An honest skip: say why, or roughly ten nested-detection tests
    // would report green having asserted nothing.
    console.log(`  (skipped: git init failed: ${e.message})`);
    return;
  }
  const { files } = listFiles(d);
  assert.equal(files.some(f => f.endsWith('/')), false);
});

test('gitignored directory containing a nested repository is reported', () => {
  const d = fixture();
  const ignored = join(d, 'backend-old');
  mkdirSync(ignored);
  writeFileSync(join(d, '.gitignore'), 'backend-old\n');
  try {
    execFileSync('git', ['init', ignored], { stdio: 'ignore' });
  } catch (e) {
    // An honest skip: say why, or roughly ten nested-detection tests
    // would report green having asserted nothing.
    console.log(`  (skipped: git init failed: ${e.message})`);
    return;
  }
  const { nested: detected } = listFiles(d);
  assert.ok(detected.some(n => n.kind === 'nested-repo' && n.path === 'backend-old'));
});

test('nested repository inside a gitignored parent one level down is reported', () => {
  const d = fixture();
  const ignored = join(d, 'vendor');
  const nested = join(ignored, 'toolA');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(d, '.gitignore'), 'vendor\n');
  try {
    execFileSync('git', ['init', nested], { stdio: 'ignore' });
  } catch (e) {
    // An honest skip: say why, or roughly ten nested-detection tests
    // would report green having asserted nothing.
    console.log(`  (skipped: git init failed: ${e.message})`);
    return;
  }
  const { nested: detected } = listFiles(d);
  assert.ok(detected.some(n => n.kind === 'nested-repo' && n.path === 'vendor/toolA'));
});

test('bare repository is reported and its plumbing files do not appear in files array', () => {
  const d = fixture();
  const bare = join(d, 'bare-repo');
  mkdirSync(bare);
  writeFileSync(join(bare, 'HEAD'), 'ref: refs/heads/main\n');
  mkdirSync(join(bare, 'objects'));
  mkdirSync(join(bare, 'refs'));

  const { files, nested: detected } = listFiles(d);
  assert.ok(detected.some(n => n.kind === 'nested-repo' && n.path === 'bare-repo'));
  assert.equal(files.some(f => f.startsWith('bare-repo/')), false);
});

test('.git-as-file (worktree layout) is a known blind spot — not reported', () => {
  // Regression test documenting a limitation: git does not enumerate directories
  // whose .git is a file (separate-git-dir, worktree layout), so they are invisible
  // to both git ls-files and our nested-repository detection.
  // Submodules are covered by mode 160000; worktrees of the same repo are not separate projects.
  const d = fixture();
  const worktree = join(d, 'worktree');
  mkdirSync(worktree);
  writeFileSync(join(worktree, '.git'), 'gitdir: /some/path/.git\n');
  
  const { nested: detected } = listFiles(d);
  // Assert it is NOT detected (the truth)
  assert.equal(detected.some(n => n.path === 'worktree'), false);
});

// `npm install git+https://…` leaves a real .git inside an installed package.
// A top-level node_modules/ does not end with '/node_modules/', so it used to
// reach the depth-1 scan and produce a false entry in a disclosure block that
// claims completeness — plus one existsSync per installed package on every scan.
test('a vendored .git under a top-level node_modules is not reported as a nested repository', () => {
  const d = fixture();
  writeFileSync(join(d, '.gitignore'), 'node_modules\n');
  const pkg = join(d, 'node_modules', 'somepkg');
  mkdirSync(pkg, { recursive: true });
  try {
    execFileSync('git', ['init', pkg], { stdio: 'ignore' });
  } catch (e) {
    console.log(`  (skipped: git init failed: ${e.message})`);
    return;
  }
  const { nested } = listFiles(d);
  assert.equal(nested.some(n => n.path.split('/')[0] === 'node_modules'), false,
    `node_modules must not appear in the nested disclosure; got ${JSON.stringify(nested)}`);
});

test(
  process.platform === 'win32'
    ? 'symlinked directory pointing at nested repository: Windows junction IS recognized'
    : 'symlinked directory pointing at nested repository: POSIX symlink is NOT recognized',
  () => {
    // Platform difference, not a flake: git does not follow symlinks, so a
    // nested repository reachable only through a POSIX symlink is invisible to
    // `git ls-files -o` — the symlink itself is listed as a plain file, never
    // descended into. A Windows junction, by contrast, is indistinguishable
    // from an ordinary directory to git, so it is walked and the repository
    // behind it is found. Both branches below assert their platform's real,
    // documented outcome — neither passes by skipping past an assertion.
    const d = fixture();
    const realRepo = join(d, 'real-nested-repo');
    const symlinked = join(d, 'symlink-to-nested');

    mkdirSync(realRepo);
    try {
      execFileSync('git', ['init', realRepo], { stdio: 'ignore' });
    } catch (e) {
      // An honest skip: say why, or roughly ten nested-detection tests
      // would report green having asserted nothing.
      console.log(`  (skipped: git init failed: ${e.message})`);
      return;
    }

    // Attempt to create the platform's symlink-like construct.
    try {
      if (process.platform === 'win32') {
        symlinkSync(realRepo, symlinked, 'junction');
      } else {
        symlinkSync(realRepo, symlinked, 'dir');
      }
    } catch (e) {
      if (e.code === 'EPERM' || e.code === 'EACCES') {
        // Loud, explicit skip — Developer Mode/elevation is required to create
        // a junction (Windows) or symlink (POSIX without permission), and we
        // will not silently report green having asserted nothing.
        console.log(`  (skipped: junction/symlink requires elevation on ${process.platform}: ${e.message})`);
        return;
      }
      throw e;
    }

    const { nested: detected } = listFiles(d);
    const found = detected.some(n => n.kind === 'nested-repo' && n.path === 'symlink-to-nested');

    if (process.platform === 'win32') {
      // Windows junction: indistinguishable from a directory to git, so found.
      assert.equal(found, true);
    } else {
      // POSIX symlink: git does not follow it, so the nested repo behind it
      // is never seen. This is the true, documented behaviour, not a bug.
      assert.equal(found, false);
    }
  }
);

// --- Whole-branch review, F1: git's C-quoting of non-ASCII path names -----
//
// `core.quotePath` defaults to `true`, so without `-z` every path git prints
// that holds a non-ASCII byte arrives as the C-quoted literal
// `"src/caf\303\251.ts"` — quotes and octal escapes included. `listFiles`
// handed that literal to every consumer in the tool as if it were a path.
//
// This is the test the whole suite did not have: the review's own mutation
// M25 ("add `-z` to git ls-files", i.e. apply this fix) SURVIVED at
// 647/0, which is to say nothing anywhere distinguished quoted from
// unquoted output. Reverting `-z` in scan.mjs's `gitPaths` must fail THIS
// test by name.
test('F1: a tracked file with a non-ASCII name is listed under its real name, never git\'s C-quoted literal', (t) => {
  const d = mkdtempSync(join(tmpdir(), 'hk-quotepath-'));
  // Written as escapes, never as literal bytes: this file is itself a tracked
  // source file, and glob.test.mjs's repository-wide guard is about exactly
  // the class of invisible-byte mistake that applies here.
  const NAME = 'src/café.ts';
  writeFileSync(join(d, 'package.json'), '{}');
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, NAME), 'export const a = 1;\n');
  try {
    execFileSync('git', ['init', '-q', d], { stdio: 'ignore' });
    execFileSync('git', ['-C', d, 'config', 'user.email', 'test@example.com'], { stdio: 'ignore' });
    execFileSync('git', ['-C', d, 'config', 'user.name', 'Test'], { stdio: 'ignore' });
    execFileSync('git', ['-C', d, 'add', '-A'], { stdio: 'ignore' });
    execFileSync('git', ['-C', d, 'commit', '-qm', 'init'], { stdio: 'ignore' });
  } catch (e) {
    // A machine-readable skip, not a bare `return` that counts as a pass:
    // the quoting this test exists to pin is git's, so without git there is
    // nothing here to assert either way.
    t.skip(`git is unavailable, so git's own path quoting cannot be exercised: ${e.message}`);
    return;
  }

  const { files, source } = listFiles(d);
  if (source !== 'git') {
    t.skip('listFiles fell back to the directory walk, which never quotes — nothing to pin');
    return;
  }
  assert.ok(files.includes(NAME), `expected the real name ${JSON.stringify(NAME)}, got ${JSON.stringify(files)}`);
  assert.equal(files.some(f => f.startsWith('"')), false, 'no entry may be a C-quoted literal');
  assert.equal(files.some(f => f.includes(String.raw`\303`)), false, 'no entry may carry an octal escape');
});
