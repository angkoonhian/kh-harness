# Profile: typescript-single

Selected when the detector finds TypeScript or JavaScript, at least one
package, and the repository is **not** a workspace. *Verified against
`scripts/lib/profiles/typescript.mjs`'s `typescriptSingle.confidence`:* a
single-package TS/JS repository scores 0.9; the identical repository
detected as a workspace scores only 0.4, which is why
[references/profiles/typescript-workspace.md](references/profiles/typescript-workspace.md)
wins instead once a workspace manifest resolves to more than one package.

## What this profile derives

**The install command.** Shared with
[references/profiles/typescript-workspace.md](references/profiles/typescript-workspace.md)
— both select the same lockfile-gated form, never a guess. *Verified
against `scripts/lib/bootstrap-install.mjs`'s `INSTALL_COMMANDS` table,*
which `gap-model.mjs`'s check and `propose.mjs`'s generator both import
and defer to, so detection and the written `scripts/bootstrap.sh` can
never independently disagree about what counts as derivable:

| package manager | lockfile(s) | install command |
|---|---|---|
| npm | `package-lock.json` | `npm ci` |
| pnpm | `pnpm-lock.yaml` | `pnpm install --frozen-lockfile` |
| yarn | `yarn.lock` | `yarn install --frozen-lockfile` (Classic) or `yarn install --immutable` (Berry) — read from the lockfile's own `__metadata:` header, not guessed |
| bun | `bun.lock` / `bun.lockb` | `bun install --frozen-lockfile` |

With no matching lockfile, the generated script falls back to the plain
install (`npm install`, and so on) and says so in its own comment, rather
than running a frozen flag against a lockfile that was never found.

**Build / test / lint / typecheck.** Derived from script **names**
declared in the package's own `package.json` only — never from a script's
body, and never invented when the name is absent. *Verified against
`scripts/lib/profiles/typescript.mjs`'s `make().commands`:* a script that
is not declared yields `null`.

The run form differs by package manager, and this is the trap a reader
reaches for instinctively and gets wrong: **`npm run build`, but bare
`pnpm build` and bare `yarn build`; `bun run build` — never bare `bun
build`**, because `bun build` invokes Bun's own bundler instead of running
the package's own script. *Verified against `scripts/lib/profiles/typescript.mjs`'s
`RUN` table* (`{ pnpm: 'pnpm', yarn: 'yarn', bun: 'bun run', npm: 'npm run' }`),
*which has itself been verified by executing the generated script for real
under all four package managers:*

```
pnpm: pnpm install --frozen-lockfile / pnpm build       / pnpm test
npm:  npm ci                         / npm run build    / npm run test
yarn: yarn install --immutable       / yarn build       / yarn test
bun:  bun install --frozen-lockfile  / bun run build    / bun run test
```

**Protected globs.** Every lockfile form, plus build output — `dist/**`,
`**/dist/**`, `build/**`, `**/build/**`. *Verified against
`scripts/lib/profiles/typescript.mjs`'s `protectedGlobs` and
`generic.mjs`'s `LOCKFILE_GLOBS`.* Both a root-anchored and a `**/`-anchored
form are listed for every one of these, deliberately: this project's own
glob matcher requires a literal `/` before the final segment, so without
the root-anchored form a root-level `dist/` would never be matched at all,
even though Claude Code's own permission matcher would have honoured it.

A glob here only becomes a real deny rule when the path it matches is
**visible to the detector's file scan — tracked by git, or, on the
dependency-free fallback walk, not excluded.** *Verified against
`scripts/lib/scan.mjs`'s `EXCLUDE_DIRS` (which always excludes `dist` and
`build` on that fallback walk) and `protected-evidence.mjs`'s
`protectedPathCandidates`,* which intersects every candidate glob against
the real file list before proposing anything. In the common case —
`dist/`/`build/` gitignored — neither form has evidence and nothing is
proposed; that is correct, not a gap, because a gitignored build directory
is regenerable and has nothing of the user's to protect. Only a build
directory that is actually tracked gets a deny rule.

## What this profile does not claim

- It never asserts a source layout (`src/`, `app/`, feature folders) or any
  framework or database convention. *Verified against
  `scripts/lib/profiles/index.test.mjs`'s forbidden-pattern check,* which
  tests every profile's output against a list of layout and framework
  words and fails if any appears.
- It does not derive whether a script actually works, only whether its
  **name** is declared — a `build` script that is broken, or a `test`
  script that does nothing, reads identically to a working one here.
- It cannot derive path-scoped rules: a single-package repository has no
  cross-package split to scope a glob to. That capability exists only in
  [references/profiles/typescript-workspace.md](references/profiles/typescript-workspace.md).
- It has no opinion on `requirements*.txt` or any Python convention — see
  [references/profiles/python.md](references/profiles/python.md) for that
  reasoning, which does not apply here.
