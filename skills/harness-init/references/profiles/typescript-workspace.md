# Profile: typescript-workspace

Selected when the detector finds TypeScript or JavaScript and the
repository resolves as a genuine workspace — a workspace manifest
(`package.json`'s own `workspaces` array, or `pnpm-workspace.yaml`) that
resolves to more than one package. *Verified against
`scripts/lib/profiles/typescript.mjs`'s `typescriptWorkspace.confidence`:*
scores 0.95 whenever `stack.isWorkspace` is true, which is why it wins over
[references/profiles/typescript-single.md](references/profiles/typescript-single.md)
(capped at 0.4 in the same case) rather than the two ever being ambiguous.

## What this profile derives

Everything typescript-single.md derives, unchanged by being a workspace:
the same lockfile-gated install command, the same per-manager build/test
lookup by script name only, and the same protected lockfile and build-
output globs. See
[references/profiles/typescript-single.md](references/profiles/typescript-single.md)
for the full table and the `npm run build` / bare `pnpm build` / `bun run
build` (never bare `bun build`) trap; it is not repeated here.

One difference in the derivation worth stating precisely, because the two
do NOT agree: `scripts/bootstrap.sh`'s build/test lines and the Stop gate
are both bound to the **root** package only — *verified against
`scripts/lib/propose.mjs`'s `bootstrapScriptLines`* (`stack.packages.find(p
=> p.dir === '.')`) *and `scripts/lib/stopgate-evidence.mjs`'s
`rootVerifyScript`.* A workspace where only a nested package declares
`build`/`test`/`typecheck` gets no bootstrap line and no Stop-gate
proposal for it — a bootstrap script and a Stop hook are each one
invocation per turn, with no single nested package to anchor on. The
detect report's own verification run (`scripts/lib/verify.mjs`'s
`verifyCommands`) is the one place that is NOT root-only: it runs this
profile's `commands(pkg)` for **every** package in the workspace, nested
or not. Read a `report.verification` entry for a nested package as
evidence about that package alone, not as something the bootstrap script
or the Stop gate also acted on.

**Path-scoped rules — decidable only here.** *Verified against
`scripts/lib/pathrules-evidence.mjs`'s `pathRuleTargets`:* one target per
non-root package (`dir !== '.'`), each with a glob derived purely from
that package's own directory (`<dir>/**/*`) — the only pattern derivable
from layout alone. This is genuinely workspace-only, not a preference: a
single-package repository has no cross-package split for a glob to scope
at all, and `pathRuleTargets` returns an empty list whenever
`stack.isWorkspace` is false. The generated file lands at
`.claude/rules/<slugified-dir>.md` with an empty body but for a heading
and a static comment — *verified against `propose.mjs`'s
`pathRuleProposal`* — because the conventions that belong in a path-scoped
rule are the user's to write; this profile supplies only the scope, never
the content. The root package, when a workspace has one, is excluded by
construction: it already spans the whole repository the way `CLAUDE.md`
does, so a rule scoped to `.` would duplicate that coverage, not narrow it.

## What this profile does not claim

- Everything typescript-single.md declines also applies here: no source
  layout, no framework or database convention, no opinion on whether a
  declared script actually works.
- It never derives a path rule's **body** — only the file's existence and
  its `paths` glob. An empty rule is not a finished one, and this profile
  does not pretend otherwise.
- It does not infer which packages are related or depend on one another;
  the only fact it uses per package is its own directory, read from the
  workspace manifest.
- It cannot derive a bootstrap or Stop-gate command from a nested
  package's scripts — only the root package's own declared `build`/`test`
  ever reaches `scripts/bootstrap.sh` or the Stop gate.
