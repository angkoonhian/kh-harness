import { readIfPresent } from './scan.mjs';

const LOCKS = [
  ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lockb', 'bun'],
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

/** Expand a workspace glob like "packages/*" into the manifests it matches. */
function membersFor(patterns, files) {
  const manifests = files.filter(f => f.endsWith('package.json') && f !== 'package.json');
  const hits = new Set();
  for (const pattern of patterns) {
    const re = new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*') + '/package\\.json$');
    for (const m of manifests) if (re.test(m)) hits.add(m);
  }
  return [...hits];
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
  if (patterns) manifestPaths.push(...membersFor(patterns, files));

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
  }

  let packageManager = null;
  for (const [lock, pm] of LOCKS) if (files.includes(lock)) { packageManager = pm; break; }

  return {
    languages: languages(files),
    packageManager,
    isWorkspace: Boolean(patterns) && packages.length > 1,
    packages,
    ci: files.filter(f => CI_PATTERNS.some(re => re.test(f))).sort(),
  };
}
