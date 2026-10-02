import { LOCKFILE_GLOBS } from './generic.mjs';

const INSTALL = { uv: 'uv sync', poetry: 'poetry install', pip: 'pip install -r requirements.txt' };
const EXEC = { uv: 'uv run', poetry: 'poetry run', pip: '' };

export const python = {
  id: 'python',
  confidence(stack) { return stack.languages.includes('python') && stack.packages.length > 0 ? 0.9 : 0; },
  commands(pkg, stack) {
    const pm = stack?.packageManager ?? 'pip';
    return { install: INSTALL[pm] ?? INSTALL.pip, build: null, test: null, lint: null, typecheck: null };
  },
  typecheckCommand(_pkg, stack) { return null; },
  lintTouchedCommand(paths) {
    const py = paths.filter(p => p.endsWith('.py'));
    return py.length ? `ruff check ${py.join(' ')}` : null;
  },
  // `**/__pycache__/**` only matches a NESTED `__pycache__/` — same
  // root-anchor gap as LOCKFILE_GLOBS and typescript.mjs's dist/build
  // globs (see generic.mjs). A root-level `__pycache__/` needs its own
  // form; both are listed deliberately — do not collapse this back to one.
  protectedGlobs() { return [...LOCKFILE_GLOBS, 'requirements*.txt', '__pycache__/**', '**/__pycache__/**']; },
  appliesToSteps() { return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 16]; },
};
