# Profile: python

Selected when the detector finds Python and at least one package.
*Verified against `scripts/lib/profiles/python.mjs`'s `python.confidence`:*
scores 0.9 whenever `stack.languages.includes('python')` and
`stack.packages.length > 0`. There is no `python-workspace` variant — a
Python monorepo still selects this single profile; `pathrules-evidence.mjs`'s
`pathRuleTargets` is language-agnostic and still scaffolds a path rule per
non-root package when `stack.isWorkspace` is true, but every other
derivation below is unaffected by workspace-ness.

## What this profile derives

**The install command.** From the lockfile for `uv` or `poetry`, or from
`requirements.txt` for plain pip — the same table
[references/profiles/typescript-single.md](references/profiles/typescript-single.md)
documents for JavaScript's package managers, shared by both the detector's
check and the proposal that writes `scripts/bootstrap.sh`. *Verified
against `scripts/lib/bootstrap-install.mjs`'s `INSTALL_COMMANDS` table:*

| package manager | evidence | install command |
|---|---|---|
| uv | `uv.lock` | `uv sync --frozen` |
| poetry | `poetry.lock` | `poetry install` |
| pip | `requirements.txt` | `pip install -r requirements.txt` |

A bare `pyproject.toml`, with no `uv.lock`, no `poetry.lock`, and no
`requirements.txt`, derives **no install command at all** — this profile
asks rather than guesses. *Verified against `bootstrap-install.mjs`'s own
comment on pip's table entry:* `pip install -e .` would be a guess about
whether the project is a library or an application, and a bare manifest
carries no evidence to settle that either way. Unlike every other package
manager in the table, pip's `plain` form is `null` — meaning "stay
undecidable," not "fall back to a plain guess."

**Build / test / lint / typecheck.** None of these are derived for Python
at all: `python.mjs`'s `commands()` returns `null` for all four, always,
regardless of what evidence exists on disk. *Verified against
`scripts/lib/profiles/python.mjs`'s `commands`.* This project has no
reading of a `pyproject.toml`'s own tool configuration (ruff, pytest,
mypy, or similar) today, so there is no script-name convention to look
for the way there is for `package.json`.

**Protected globs.** Every lockfile form, plus tracked `__pycache__/` —
root-anchored and `**/`-anchored, for the same glob-matcher reason given
in [references/profiles/typescript-single.md](references/profiles/typescript-single.md)'s
own protected-globs section. *Verified against
`scripts/lib/profiles/python.mjs`'s `protectedGlobs`.*

**`requirements*.txt` is protected only when its own `requirements*.in`
sibling exists — per file, not per glob.** *Verified against
`scripts/lib/protected-evidence.mjs`'s `pairedRequirementsFiles`:* for each
tracked `requirements*.txt`, the function checks whether the identically
named `.in` file (same directory, same basename, extension swapped) is
also present, and protects only that one file when it is — never a glob
covering every `requirements*.txt` in the repository. State the reasoning,
not just the rule: `requirements.txt` is normally **hand-edited** —
Python's rough analogue of `package.json`, which this project deliberately
does not protect either, because a deny rule there blocks "add a
dependency," a legitimate and frequent edit. Under pip-tools, though,
`requirements.txt` is **compiled output** of `requirements.in`, and a hand
edit to the compiled file is silently lost the next time `pip-compile`
runs — exactly the kind of file this project's deny rules exist to guard.
Gating per file rather than "any `.in` anywhere in the repo" matters for
the same reason: a `requirements.in` that backs `requirements.txt` must
never sweep in an unrelated, genuinely hand-edited `requirements-dev.txt`
that has no `.in` of its own.

## The sensor and the Stop gate ask, rather than fire, for Python

Say this plainly, because a user who expects a working lint sensor or
verification gate will otherwise discover the gap only when nothing fires
on an edit. *Verified against `scripts/lib/detect-stack.mjs`:* a package's
`scripts` list is populated only by reading a `package.json`'s own
`scripts` object; a Python package — whether its manifest is
`pyproject.toml` or the `requirements.txt` fallback — always gets
`scripts: []`. *Verified against `scripts/lib/sensor-evidence.mjs`'s
`hasLintScript` and `scripts/lib/stopgate-evidence.mjs`'s
`rootVerifyScript`:* both read exactly that `scripts` list and nothing
else, so `hasLintScript` is always `false` and `rootVerifyScript` is
always `null` for a Python repository today. Phase 2's per-edit sensor and
Stop gate correctly report a **question** rather than a silent `n/a` or a
proposal that would install a hook guaranteed to find nothing to run.
This is a real limitation of this version, not a deliberate Python-
specific design choice: the hooks read `package.json` scripts, full stop,
and there is currently no equivalent reading of a Python tool's own
configuration to derive the same capability.

## What this profile does not claim

- It never derives a build, test, lint, or typecheck command — `commands()`
  returns `null` for all four, always, because this project has no reading
  of a `pyproject.toml`'s tool configuration today.
- It does not guess at library-versus-application intent for a bare
  `pyproject.toml`; it asks instead of writing `pip install -e .`.
- It never protects a `requirements*.txt` on the strength of lockfile-like
  naming alone — only a proven pip-compile pair (its own `.in` sibling)
  earns a deny rule, and a hand-edited manifest with no sibling stays
  fully editable.
- It has no opinion on source layout, package structure, or any ORM or
  migration convention — those are evidence-filtered centrally in
  `protected-evidence.mjs`'s own candidate list, never asserted by this
  profile.
