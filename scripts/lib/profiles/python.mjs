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
  protectedGlobs() { return ['**/*.lock', 'requirements*.txt', '**/__pycache__/**']; },
  appliesToSteps() { return [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 15, 16]; },
};
