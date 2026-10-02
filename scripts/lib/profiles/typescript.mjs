import { LOCKFILE_GLOBS } from './generic.mjs';

const RUN = { pnpm: 'pnpm', yarn: 'yarn', bun: 'bun run', npm: 'npm run' };
const INSTALL = { pnpm: 'pnpm install', yarn: 'yarn install', bun: 'bun install', npm: 'npm ci' };

function runner(pm) { return RUN[pm] ?? 'npm run'; }

function make(id, extra) {
  return {
    id,
    commands(pkg, stack) {
      const pm = stack?.packageManager ?? 'npm';
      // `pkg.scripts` is a list of script NAMES; bodies are deliberately not
      // carried through detection (see detect-stack.mjs).
      const has = name => (pkg.scripts?.includes(name) ? `${runner(pm)} ${name}` : null);
      return { install: INSTALL[pm] ?? 'npm ci', build: has('build'), test: has('test'), lint: has('lint'), typecheck: has('typecheck') };
    },
    typecheckCommand(pkg) {
      // pkg.dir is repository-derived and heads for a shell in Plan 2: quote it.
      const tsconfig = pkg.dir === '.' ? 'tsconfig.json' : `${pkg.dir}/tsconfig.json`;
      return pkg.scripts?.includes('typecheck') ? null : `npx tsc --noEmit -p "${tsconfig}"`;
    },
    lintTouchedCommand(paths) {
      const js = paths.filter(p => /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p));
      return js.length ? `npx eslint --no-error-on-unmatched-pattern ${js.join(' ')}` : null;
    },
    protectedGlobs() {
      return [...LOCKFILE_GLOBS, '**/dist/**', '**/build/**'];
    },
    appliesToSteps() { return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 16]; },
    ...extra,
  };
}

export const typescriptSingle = make('typescript-single', {
  confidence(stack) {
    const ts = stack.languages.includes('typescript') || stack.languages.includes('javascript');
    if (!ts || stack.packages.length === 0) return 0;
    return stack.isWorkspace ? 0.4 : 0.9;
  },
});

export const typescriptWorkspace = make('typescript-workspace', {
  confidence(stack) {
    const ts = stack.languages.includes('typescript') || stack.languages.includes('javascript');
    return ts && stack.isWorkspace ? 0.95 : 0;
  },
});
