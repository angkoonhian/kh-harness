// Lockfile names are universal per package manager, so they belong in every
// profile — unlike migrations, which are an ORM/framework convention and
// live in propose.mjs's evidence-filtered candidate table instead (see its
// comment). Exported, rather than duplicated, because a fix made in one
// profile's own copy and not the others is exactly the kind of gap that
// slips through: `**/*.lock` etc. only match a NESTED lockfile — `**`
// requires a literal `/` before the final segment, so a root-level
// `yarn.lock` never matches `**/*.lock` (verified; this was latent until
// propose.mjs's evidence filter became the first thing to actually run
// these globs against a file list). The root-anchored forms below cover the
// common case: a lockfile sitting next to package.json. `pnpm-lock.yaml`
// needs its own entry either way — it doesn't end in
// `.lock`/`.lockb`/`-lock.json`.
export const LOCKFILE_GLOBS = [
  '**/*.lock', '**/*-lock.json', '**/*.lockb',
  '*.lock', '*-lock.json', '*.lockb',
  'pnpm-lock.yaml',
];

export const generic = {
  id: 'generic',
  confidence() { return 0.1; },
  commands() { return { install: null, build: null, test: null, lint: null, typecheck: null }; },
  protectedGlobs() { return [...LOCKFILE_GLOBS]; },
  // Language-agnostic steps only: no bootstrap, scripts, sensor, stop gate or language server.
  appliesToSteps() { return [1, 2, 3, 4, 6, 7, 11, 15, 16]; },
};
