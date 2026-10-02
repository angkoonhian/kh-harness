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
  // Root-anchored AND `**/`-anchored forms are both listed deliberately —
  // same two reasons as typescript.mjs's dist/build globs (see its
  // comment for the full explanation):
  //   1. This is about glob.mjs's OWN matcher, not Claude Code's. Our
  //      `globToRegExp` requires a literal `/` before `__pycache__`, so
  //      the evidence filter never proposes a rule for a root-level
  //      `__pycache__/` without the root-anchored form, even though
  //      Claude Code's own matcher is wider and would honour it once
  //      proposed.
  //   2. Either form only ever gets PROPOSED when `__pycache__/` is
  //      visible to `listFiles` — and on the fallback (non-git) walk it
  //      never is, because EXCLUDE_DIRS excludes it unconditionally. A
  //      gitignored `__pycache__/` (the overwhelmingly common case for
  //      Python) is correctly invisible too: it is regenerable, not the
  //      user's content.
  // Do not collapse this back to one form.
  protectedGlobs() { return [...LOCKFILE_GLOBS, 'requirements*.txt', '__pycache__/**', '**/__pycache__/**']; },
  appliesToSteps() { return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 16]; },
};
