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
// `path` is the proposed file's location: `.claude/rules/<slug>.md`, where
// `slug` comes from `slugifyDir`, below — every target lands directly
// inside `.claude/rules/` (never a subdirectory), so slashes must be
// removed from `dir` somehow.
//
// Coordinator finding (round 3): a plain `dir.replace(/\//g, '-')` is NOT
// collision-free, and the comment that used to sit here claimed otherwise
// while describing the wrong pair (`packages/api` vs `apps/api` — those
// never collided). The real collision is a literal `-` in a directory name
// standing in for an encoded `/`: `packages/a` and a (differently-located)
// package literally named/dir'd `packages-a` both produce the plain-replace
// slug `packages-a` — and when two proposals in the same `buildProposals`
// call land on the identical `path`, `buildProposals`' own dedupe (see its
// comment on `alreadyWritten` in propose.mjs) silently treats the SECOND as
// "already written" — the loser is dropped with no error, no warning, and
// no evidence in the proposal list that it ever existed. `slugifyDir`
// doubles every literal `-` BEFORE replacing `/`, so a single `-` in the
// output can only ever have come from a real path separator: `packages/a`
// -> `packages-a`, but the literal directory `packages-a` -> `packages--a`
// — the two no longer collide. This is collision-free for every directory
// path a real file system can produce; the one input shape that could still
// collide is an EMPTY path segment (a literal double slash, `a//b`), which
// git and npm never produce as a package.json's own directory.
function slugifyDir(dir) {
  return dir.replace(/-/g, '--').replace(/\//g, '-');
}

export function pathRuleTargets(stack) {
  if (!stack.isWorkspace) return [];
  return stack.packages
    .filter(p => p.dir !== '.')
    .map(p => ({
      name: p.name,
      dir: p.dir,
      glob: `${p.dir}/**/*`,
      path: `.claude/rules/${slugifyDir(p.dir)}.md`,
    }));
}
