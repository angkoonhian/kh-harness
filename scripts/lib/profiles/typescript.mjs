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
    // Root-anchored AND `**/`-anchored forms are both listed deliberately,
    // and the reason is about OUR OWN matcher, not Claude Code's:
    // glob.mjs's `globToRegExp` compiles `**` to `.*` with a required
    // literal `/` before the final segment, so
    // `hasEvidence('**/dist/**', ['dist/a.js'])` is false and
    // propose.mjs's evidence filter never PROPOSES a rule for a root-level
    // `dist/` at all. Claude Code's own `Edit(...)` matcher is wider — per
    // its permissions docs, `**/` also matches zero directory segments, so
    // `Edit(**/dist/**)` would have matched a root-level file just fine
    // once proposed. The duplication exists to satisfy OUR filter, not
    // Claude Code's matcher. Do not "simplify" this back down to one form.
    //
    // Even with both forms present: a rule only gets PROPOSED when the
    // build output is visible to `listFiles` (scan.mjs) — tracked by git,
    // or (on the dependency-free fallback walk) not excluded, and that
    // walk excludes `dist`/`build` unconditionally regardless of this
    // list. In the common real case — `dist/`/`build/` gitignored, as
    // virtually every project does — neither form has evidence and no
    // deny rule is proposed. That is correct, not a bug: a gitignored
    // directory is regenerable scratch with nothing of the user's to
    // protect, and a rule with no evidence would be exactly the
    // opinion-without-basis Plan 1's review struck `**/migrations/**` for.
    // The root-anchored form is the only reason a *tracked* root-level
    // `dist/` or `build/` ever gets protected at all.
    protectedGlobs() {
      return [...LOCKFILE_GLOBS, 'dist/**', '**/dist/**', 'build/**', '**/build/**'];
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
