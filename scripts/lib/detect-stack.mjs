import { readIfPresent } from './scan.mjs';
import { globToRegExpSource, isRejectableGlob } from './glob.mjs';

// `bun.lock` (text) is Bun's default since 1.2; `bun.lockb` (binary) is the
// legacy format Bun wrote through 1.1. Both are tracked — a real review
// caught `bun.lockb`-only detection missing every current-Bun repository
// (verified against Bun 1.4.2, whose default `bun install` writes
// `bun.lock`, not `bun.lockb`).
const LOCKS = [
  ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'], ['uv.lock', 'uv'], ['poetry.lock', 'poetry'],
  ['requirements.txt', 'pip'],
];

const CI_PATTERNS = [/^\.github\/workflows\/.+\.ya?ml$/, /^\.gitlab-ci\.yml$/, /^azure-pipelines\.yml$/, /^\.circleci\/config\.yml$/];

function parseJson(text) {
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

function languages(files) {
  const out = new Set();
  if (files.includes('tsconfig.json') || files.some(f => f.endsWith('.ts') || f.endsWith('.tsx'))) out.add('typescript');
  if (files.some(f => f.endsWith('.js') || f.endsWith('.jsx') || f.endsWith('.mjs'))) out.add('javascript');
  if (files.includes('pyproject.toml') || files.some(f => f.endsWith('.py'))) out.add('python');
  if (files.includes('go.mod')) out.add('go');
  if (files.includes('Cargo.toml')) out.add('rust');
  return [...out];
}

/**
 * Expand a workspace glob like "packages/*" into the manifests it matches.
 *
 * `patterns` is REPOSITORY DATA — a `package.json`'s own `workspaces` array,
 * or a `pnpm-workspace.yaml`'s list — so it is the one input to `glob.mjs`
 * an attacker or a broken tool controls. `isRejectableGlob` refuses a
 * pattern containing a literal NUL (JSON's `\u0000` parses to one), which
 * would otherwise have been transformed into `.*` and matched EVERY
 * package.json in the tree — see that function's own comment for the
 * measurement and for why the refusal lives at the boundary rather than in
 * the transformation.
 *
 * Refused patterns are RETURNED, not swallowed: `globToRegExpSource` would
 * already fail closed on its own (a refused pattern compiles to a
 * never-matching source), but a workspace pattern that silently matches
 * nothing looks exactly like a workspace with no members, which is the
 * "confident and wrong" shape this project reports rather than absorbs.
 * `detectStack` carries them out on `stack.rejectedWorkspacePatterns`, and
 * report.mjs turns them into a question.
 */
function membersFor(patterns, files) {
  const manifests = files.filter(f => f.endsWith('package.json') && f !== 'package.json');
  const hits = new Set();
  const rejected = [];
  for (const pattern of patterns) {
    if (isRejectableGlob(pattern)) {
      // Never echoed verbatim: the value is repository-controlled and holds
      // a control character by definition. Its INDEX is enough to find it.
      rejected.push(patterns.indexOf(pattern));
      continue;
    }
    const re = new RegExp('^' + globToRegExpSource(pattern) + '/package\\.json$');
    for (const m of manifests) if (re.test(m)) hits.add(m);
  }
  return { manifests: [...hits], rejected };
}

function workspacePatterns(root, rootPkg) {
  if (Array.isArray(rootPkg?.workspaces)) return rootPkg.workspaces;
  if (Array.isArray(rootPkg?.workspaces?.packages)) return rootPkg.workspaces.packages;
  const ws = readIfPresent(root, 'pnpm-workspace.yaml');
  if (ws) {
    return ws.split('\n')
      .map(l => l.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*$/))
      .filter(Boolean).map(m => m[1].trim()).filter(Boolean);
  }
  return null;
}

export function detectStack(root, files) {
  const rootPkg = parseJson(readIfPresent(root, 'package.json'));
  const patterns = workspacePatterns(root, rootPkg);

  const manifestPaths = [];
  if (files.includes('package.json')) manifestPaths.push('package.json');
  let rejectedWorkspacePatterns = [];
  if (patterns) {
    const members = membersFor(patterns, files);
    manifestPaths.push(...members.manifests);
    rejectedWorkspacePatterns = members.rejected;
  }

  const packages = manifestPaths.map(manifestPath => {
    const pkg = parseJson(readIfPresent(root, manifestPath)) ?? {};
    const dir = manifestPath === 'package.json' ? '.' : manifestPath.slice(0, -'/package.json'.length);
    // Script NAMES only. No consumer reads a body, and a body is repository-
    // derived text that routinely embeds a token (`sentry-cli --auth-token …`).
    // Copying it here would republish it into detect.json and onto stdout.
    return { name: pkg.name ?? dir, dir, manifestPath, scripts: Object.keys(pkg.scripts ?? {}).sort() };
  });

  if (packages.length === 0 && files.includes('pyproject.toml')) {
    packages.push({ name: 'root', dir: '.', manifestPath: 'pyproject.toml', scripts: [] });
  } else if (packages.length === 0 && files.includes('requirements.txt')) {
    // Same reasoning as the pyproject.toml fallback immediately above: a
    // pip-only repository (requirements.txt, no pyproject.toml) must still
    // get a package entry, or `stack.packages.length` stays 0, python's own
    // `confidence()` (which requires packages.length > 0) returns 0, profile
    // selection falls back to `generic`, and P1.bootstrap — along with every
    // other phase-1/2 python-specific check — reports `n/a` even though an
    // install command is plainly derivable from requirements.txt's own
    // presence. `scripts: []` for the same reason as the pyproject.toml
    // case: there is no script-NAME convention to read here either.
    packages.push({ name: 'root', dir: '.', manifestPath: 'requirements.txt', scripts: [] });
  }

  let packageManager = null;
  for (const [lock, pm] of LOCKS) if (files.includes(lock)) { packageManager = pm; break; }

  return {
    languages: languages(files),
    packageManager,
    isWorkspace: Boolean(patterns) && packages.length > 1,
    packages,
    ci: files.filter(f => CI_PATTERNS.some(re => re.test(f))).sort(),
    // Workspace patterns refused before transformation — INDICES only, never
    // the values, which are repository-controlled and contain a control
    // character by definition. Empty on every ordinary repository.
    rejectedWorkspacePatterns,
  };
}
