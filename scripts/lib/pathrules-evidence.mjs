// scripts/lib/pathrules-evidence.mjs
//
// Shared by gap-model.mjs's P1.pathrules CHECK and propose.mjs's path-rule
// GENERATOR — same pattern as sensor-evidence.mjs, stopgate-evidence.mjs,
// protected-evidence.mjs and bootstrap-install.mjs: the check and the
// generator must agree on what counts as "a meaningful path split to
// scaffold" by construction, not by two people independently reaching the
// same answer twice.
//
// Decidable only for a genuine workspace. `stack.isWorkspace` (detect-
// stack.mjs) is already a real derived fact — a workspace-manifest glob
// (package.json's own `workspaces`, or pnpm-workspace.yaml) was found AND it
// resolved to more than one package — not a guess made here. A
// single-package repository has no sub-directory split worth a path-scoped
// rule file, so the check must ASK rather than propose one; see
// gap-model.mjs's P1.pathrules question.
//
// One target per NON-ROOT package (`dir !== '.'`): the root package, when a
// workspace has one, spans the whole repository — the same scope CLAUDE.md
// already covers — so a rule scoped to `.` would duplicate it, not narrow
// it. In a resolved workspace at least one non-root package always exists
// (isWorkspace requires packages.length > 1, and at most one of those can
// have dir === '.'), so this never returns an empty array for a genuine
// workspace.
//
// `glob` matches every file recursively under the package's own directory
// (`<dir>/**/*`) — the only pattern derivable from directory structure
// alone. VERIFIED against Claude Code's own documentation
// (https://code.claude.com/docs/en/memory, "Path-specific rules" table,
// fetched while implementing this module): "`src/**/*` -> All files under
// `src/` directory" is the documented example for exactly this shape.
// A narrower, per-extension glob (`<dir>/**/*.ts`, say) would be a guess
// about what belongs in a file whose CONTENT this tool deliberately never
// writes either — see pathRuleProposal's own comment in propose.mjs.
//
// `path` is the proposed file's location: `.claude/rules/<dir-with-/-as-->
// .md`, e.g. `packages/api` -> `.claude/rules/packages-api.md`. Slashes are
// replaced, not nested, so every target lands directly inside `.claude/
// rules/` (never a subdirectory) and two packages can never collide on a
// shared leaf name (`packages/api` and `apps/api` would otherwise both want
// `api.md`).
export function pathRuleTargets(stack) {
  if (!stack.isWorkspace) return [];
  return stack.packages
    .filter(p => p.dir !== '.')
    .map(p => ({
      name: p.name,
      dir: p.dir,
      glob: `${p.dir}/**/*`,
      path: `.claude/rules/${p.dir.replace(/\//g, '-')}.md`,
    }));
}
