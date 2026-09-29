export const generic = {
  id: 'generic',
  confidence() { return 0.1; },
  commands() { return { install: null, build: null, test: null, lint: null, typecheck: null }; },
  typecheckCommand() { return null; },
  lintTouchedCommand() { return null; },
  protectedGlobs() { return ['**/*.lock', '**/*-lock.json', '**/*.lockb']; },
  // Language-agnostic steps only: no bootstrap, scripts, sensor, stop gate or language server.
  appliesToSteps() { return [1, 2, 3, 4, 6, 7, 11, 15, 16]; },
};
