# Final whole-branch review — `feat/capabilities` @ `bea3a3c`

Repository: `C:\Users\Dreambuilds\desktop\harness-kit`
Base: `master` @ `27fb27d` · 73 commits · 56 files · +15,468 / −129
Reviewer scope: whole-branch only. Per-task findings, their fixes and their mutation
tests were taken as settled and deliberately not re-derived.

---

## 0. Baseline and method

### Test suite, verbatim, before any change

```
$ cd /c/Users/Dreambuilds/desktop/harness-kit && npm test
...
ℹ tests 648
ℹ suites 0
ℹ pass 647
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 25416.7424
```

Matches the claim: 647 passing, 1 skipped.

### What I did

- Read every non-test source file on the branch in full (~5,400 lines across
  `scripts/`, `scripts/lib/`, `scripts/lib/profiles/`, `assets/scripts/`,
  `assets/templates/`). The 919 KB diff was read selectively, mostly as a map.
- Ran `detect`, `apply` and `uninstall` end to end against six purpose-built
  fixture repositories chosen for *composition*, not for one capability:
  a workspace that gitignores `.claude/`; a repo whose handoff file is
  `docs/HANDOFF.md`; a repo whose `settings.json` is canonical but has no
  trailing newline; a repo whose only source file has a non-ASCII name;
  and two controls.
- Mutation-tested 19 points in the production code, running the **full** suite
  after each and reverting with `git checkout --`. Two survived; see §6.
- Verified every load-bearing claim about Claude Code's own behaviour against
  `code.claude.com/docs` directly rather than from memory. One claim I was
  given by a research pass turned out to be wrong, and I dropped the finding
  that depended on it — see §2.

Everything below that is called a defect has a reproduction pasted verbatim.
Where I could not reproduce something, I say so.

---

## 1. Findings

### F1 — CRITICAL. A tracked file whose name contains any non-ASCII character is invisible to the credential scanner, and `P0.security` reports success anyway

`scripts/lib/scan.mjs` calls `git ls-files` with no `-z` and no
`-c core.quotePath=false`. With `core.quotePath` at its default (`true`), git
emits C-quoted, octal-escaped path names for anything non-ASCII — surrounding
double quotes included. `listFiles` then hands that literal string to every
consumer in the tool as if it were a path.

Reproduction. One repository, one source file, three plaintext credentials in it:

```
$ git ls-files
package.json
"\351\205\215\347\275\256.ts"

$ cat 配置.ts        # fixture values below redacted when this record was
                     # committed: they were fabricated, and the finding is
                     # that credential-SHAPED content went unexamined.
export const GITHUB_TOKEN = "ghp_<redacted-fixture-token>";
export const AWS = "AKIA<redacted-fixture-key>";
password = <redacted-fixture-literal>

$ node scripts/detect.mjs .
profile: generic   branch: feat/x

Phase 0 — Reconnaissance
  [x] P0.inventory       verified
        produced by this run
  [x] P0.security        verified
        no credential patterns matched
...
$ # detect.json
exposures: []
languages: []
```

The same bytes, renamed to ASCII, in the same repository:

```
$ git mv 配置.ts config.ts && git commit -qm rename
$ node scripts/detect.mjs .
  [!] P0.security        failing
        token-in-tracked-file at config.ts
        credentials-in-doc at config.ts
exposures: [{"kind":"token-in-tracked-file","location":"config.ts","severity":"high"},
            {"kind":"credentials-in-doc","location":"config.ts","severity":"medium","valueKind":"literal"}]
languages: ["typescript"]
```

Mechanism: `detect-exposure.mjs`'s `scannable()` calls
`statSync(join(root, '"\\351\\205\\215\\347\\275\\256.ts"'))`, which throws
ENOENT, which the `catch { return false }` turns into "not scannable" — so the
file is skipped with no record anywhere that it was skipped.

Two separate wrong answers follow from the one cause:

1. **`P0.security` says `verified / no credential patterns matched` for a
   repository holding a live token.** This is the single sentence in the whole
   tool a user is most likely to act on, and it is false. The project's own
   doctrine — "report only what is true" — is violated in the most load-bearing
   place it has.
2. **Stack detection misses the file**, because `languages()` tests
   `f.endsWith('.ts')` and the quoted form ends in `.ts"`. Confidence falls
   below 0.5, `profile` becomes `generic`, and every stack-specific capability
   reports `n/a — not applicable to profile generic`. Confident, wrong, and
   phrased as a fact about the repository rather than about what was read.

Blast radius is every consumer of `files`, not just these two: `under()` in
`detect-harness.mjs`, `docPointers`, `commandScript`, `projectDocs`,
`protectedPathCandidates`'s evidence filter, `harness.reconPresent`, the
`node_modules/` filter in `listFiles` itself, and the nested-repository sweep
(`gitLines(root, ['ls-files', ...])` has the identical problem).

Which names are affected, measured:

```
$ git ls-files        # files named "my file.ts", "tab<U+F009>file.ts", "émoji.ts"
my file.ts
"tab\357\200\211file.ts"
"\303\251moji.ts"

$ git ls-files -z | tr '\0' '\n'
my file.ts
tabfile.ts
émoji.ts
```

So: spaces are safe, non-ASCII and control characters are not. That is not an
exotic repository shape — i18n fixtures, CJK filenames, accented author names
and emoji in documentation trees all hit it.

`scan.mjs` carries a careful 30-line comment enumerating **three** "known blind
spots" (separate-git-dir, symlinked nested repos, `EXCLUDE_DIRS` on the
fallback walk). This is a fourth, it is the only one that silently disarms a
security check, and it is nowhere disclosed.

Fix is one flag — `-z` on both `execFileSync('git', [..., 'ls-files', ...])`
calls in `scan.mjs` (splitting on `\0` instead of `\n`), or
`-c core.quotePath=false`. `-z` is the better of the two: it also fixes a path
containing a literal newline. `apply.mjs`'s `hasTrackedChanges` needs the same
treatment — it already half-knows about this (`if (path.startsWith('"') &&
path.endsWith('"')) path = path.slice(1, -1);`), stripping the quotes but never
un-escaping the octal, which is the clearest single piece of evidence that this
was understood in one module and not carried to the other.

**I would not merge with F1 open.** It is cheap to fix and it is the one finding
on this list that makes the tool lie about a secret.

---

### F2 — MAJOR. `detect` and `apply` give flatly contradictory answers about `P1.pathrules` on any workspace that gitignores `.claude/`

Five times on this project, a check and its generator drifted: the check
advertised a proposal the generator silently declined. Each was fixed by
extracting the *derivation* into a shared evidence module
(`bootstrap-install.mjs`, `sensor-evidence.mjs`, `stopgate-evidence.mjs`,
`protected-evidence.mjs`, `pathrules-evidence.mjs`). `P1.pathrules` shares its
derivation correctly. What drifted is the other half of the question — *presence* —
and nobody looked there.

Every sibling `.claude/` question in `detect-harness.mjs` reads the file off disk:

```js
settings:      parseSettings(root, '.claude/settings.json') !== null,
localSettings: parseSettings(root, '.claude/settings.local.json') !== null,
denyRules:     denyRuleCount(root),
denyRuleList:  denyRuleList(root),
hookEvents:    hookEvents(root, files),
```

`rules` does not:

```js
rules: under(files, '.claude/rules/'),
```

`files` is the scan list, so under a gitignored `.claude/` it is permanently
empty. The three hook checks were given an explicit manifest + `existsSync`
fallback for exactly this repository shape (`registeredHook`'s "not visible to
the file scan — `.claude/` may be gitignored" branch). `P1.pathrules` was not.

Reproduction — a two-package npm workspace with `.gitignore` containing `.claude/`:

```
$ node scripts/apply.mjs . --yes
harness-kit: 12 actions to close 11 capability gaps (as detect reports them) for ...
wrote      .claude/rules/packages-api.md
wrote      .claude/rules/packages-web.md
...

$ ls .claude/rules/
packages-api.md
packages-web.md

$ node -e "...manifest.files..."
.claude/rules/packages-api.md
.claude/rules/packages-web.md

$ node scripts/detect.mjs .            # AFTER a successful apply
  [ ] P1.pathrules       absent
      → scaffold .claude/rules/ with globs derived from the workspace layout — each file is generated EMPTY; conventions are added by hand afterward

$ node scripts/detect.mjs . | grep -A2 -E 'P2.sensor|P4.sessionbrief'
  [~] P2.sensor          declared
        PostToolUse hook: .claude/scripts/lint-touched.mjs (not visible to the file scan — .claude/ may be gitignored; confirmed via the install record and the file on disk)
  [~] P4.sessionbrief    declared
        SessionStart hook: .claude/scripts/session-brief.mjs (not visible to the file scan — .claude/ may be gitignored; confirmed via the install record and the file on disk)

$ node scripts/apply.mjs .
harness-kit: no actions — this repository already satisfies every applicable step.
```

`detect` says the capability is absent and offers to install it; `apply`, run a
second later on the same tree, says the repository already satisfies every
applicable step; the files are on disk and in the manifest. The two hook checks
sitting three lines above it in the same report get this right. The proposal is
unsatisfiable — it will be printed on every run, forever.

Why no test caught it, and this is the more interesting half: there **is** a
test for the gitignored-`.claude/` shape (`lifecycle.test.mjs:863`, "a
repository that gitignores .claude/ still recognises its own hook as declared
after apply"), and it is a good test — but its fixture is
`{name:'app', scripts:{test:'vitest'}}`, a single-package repository, where
`P1.pathrules` is not decidable at all. **Workspace** is tested (LOAD-BEARING-2,
whose stage 4 "THE CLOSED LOOP" asserts every capability including
`P1.pathrules` is `declared` after apply) and **gitignored `.claude/`** is
tested, and the defect lives only in their intersection. That is precisely the
class of defect a per-task review cannot see.

Worse, the one assertion in that test aimed at this symptom cannot fail for the
reason its comment gives:

```js
// And it must not re-propose on every subsequent run either (the exact
// "re-proposes on every run" symptom the coordinator described).
assert.match(run(APPLY, d), /no proposals|already satisfies/i);
```

It reads **`apply`'s** output. `propose.mjs` never re-proposes a file already in
the manifest, so `apply` says "already satisfies" regardless of what `detect`
reports. Run verbatim against the broken repository above, that assertion
passes. The symptom it names lives in `detect`'s output, which it never reads.

Fix: give `rules` the same treatment as its siblings — read `.claude/rules/`
off disk (or add the manifest+`existsSync` fallback `registeredHook` already
has). Add the missing fixture: workspace **and** gitignored `.claude/`.

Smaller detail in the same line, worth fixing while it is open: `under(files,
'.claude/rules/')` passes no suffix, so it counts **any** file under
`.claude/rules/`. Claude Code only reads `.md` there, so a stray `.DS_Store` or
`.gitkeep` credits the capability as `declared`. Every other `under(...)` call
in that object does pass a suffix (`agents`, `skills`, `commands` all pass
`'.md'`); `rules` is the only one that does not.

---

### F3 — MAJOR. The SessionStart brief silently stops reaching the session once `HANDOFF.md` exceeds Claude Code's 10,000-character hook-output cap

`assets/scripts/harness-redact.mjs` — the shared chokepoint the other two hooks
go through — bounds output twice:

```js
/** Mirrors session-brief.mjs's own bound on what is printed to a session. */
export const MAX_REPORT_LINES = 60;
/**
 * A line-count bound alone cannot stop a single very long line (minified
 * output, a one-line stack trace, a JSON formatter run with no pretty-print)
 * from pushing megabytes into Claude's context at the default 10 MB spawn
 * buffer — measured: a single 50 000-character line reached stderr in full
 * before this existed. ...
 */
export const MAX_REPORT_BYTES = 10_000;
```

The line bound is explicitly described as mirroring `session-brief.mjs`'s. The
byte bound — added because the line bound alone was shown to be insufficient,
and set to exactly Claude Code's documented cap — was never carried back to
`session-brief.mjs`, which still has only:

```js
const MAX_LINES = 60;
const shown = lines.slice(0, MAX_LINES);
process.stdout.write('--- HANDOFF.md ---\n' + shown.join('\n') + '\n');
```

Measured:

```
$ node -e "writeFileSync('HANDOFF.md','# Handoff\n'+'A'.repeat(2000000)+'\n')"
HANDOFF.md bytes: 2000011
$ node .claude/scripts/session-brief.mjs | wc -c
2000031
$ # the bound the other two hooks use, on the same input:
boundReport bytes: 10050 | MAX_REPORT_LINES= 60 MAX_REPORT_BYTES= 10000
```

What that costs the user is not context flooding — Claude Code catches it — it
is the capability silently evaporating. From the hooks reference, verbatim:

> A hook's `additionalContext`, `systemMessage`, and `initialUserMessage`
> strings, and its plain stdout, are capped at 10,000 characters: … **Over the
> limit**: Claude Code saves the output to a file in the session directory and
> replaces it with the file path and a preview of up to the first 2,000
> characters. … **Reading the file**: Claude Code doesn't ask Claude to read the
> file, so keep anything Claude must always see within the cap.

So a `HANDOFF.md` whose first 60 lines exceed 10,000 characters — about 167
characters per line, which a real handoff with pasted error text reaches easily;
the "What didn't work" section of the shipped template explicitly invites
pasting "Error text if there was one" — is replaced by a file path Claude is
never told to open. The capability whose entire purpose is "the next session
starts from what is written here" stops working, and nothing anywhere reports
that it did.

Fix: `session-brief.mjs` should use `boundReport` (it is already installed
beside it, as `.claude/scripts/harness-redact.mjs`, by the shared-asset
proposal) or carry the same byte bound, and should say plainly when it
truncated.

---

### F4 — MAJOR. `detect` credits `docs/HANDOFF.md`, then installs a hook that can only read root `HANDOFF.md` — and the hook then states a falsehood at every session start

Two modules answer "where is this repository's handoff file" differently:

```js
// scripts/lib/detect-harness.mjs
handoff: existsAny(root, ['HANDOFF.md', 'docs/HANDOFF.md']),
```

```js
// assets/scripts/session-brief.mjs
// Assumes cwd is the repository root at SessionStart; does not walk upward to find it.
const path = join(process.cwd(), 'HANDOFF.md');
```

`P4.handoff` and `P4.sessionbrief` were deliberately split into two checks — the
comment above them says so, and the reason given is sound. But the split means a
repository can satisfy one and get the other installed, and the artefact that
gets installed does not know about the file the first one credited.

Reproduction — a repository whose handoff file is `docs/HANDOFF.md`:

```
$ node scripts/detect.mjs .
  [~] P4.handoff         declared
        docs/HANDOFF.md
  [ ] P4.sessionbrief    absent
      → install scripts/session-brief.mjs and register a SessionStart hook

$ node scripts/apply.mjs . --yes
wrote      .claude/scripts/session-brief.mjs
patched    .claude/settings.json (SessionStart)

$ node .claude/scripts/session-brief.mjs      # cwd = repository root
harness-kit: no HANDOFF.md in this repository yet.
=== exit code: 0 ===
```

Every session in that repository now opens with a sentence harness-kit's own
`detect` had already proved false, three lines above the proposal that installed
it. "Report only what is true" — and this one is printed into the model's
context, not a terminal, so it is a false *premise* the agent starts from.

Secondary, same function: three hooks, two conventions for finding the
repository root. `lint-touched.mjs` and `verify-touched.mjs` both use
`process.env.CLAUDE_PROJECT_DIR || process.cwd()`; `session-brief.mjs` uses a
bare `process.cwd()` and documents the assumption rather than removing it. Any
SessionStart invocation whose cwd is not the project root produces the same
false sentence.

Fix: `session-brief.mjs` should resolve its root the way its two siblings do,
and should look in both places `existsAny` looks — ideally by being handed the
path, since `detect` already knows it.

---

### F5 — MAJOR (comprehensibility). The only user-facing document on the branch says the tool cannot do what two of this branch's three plans built

`README.md`, unchanged on this branch, in full:

```
## Status

Plan 1 of 3 — detection only. `harness-kit detect` reports gaps; it cannot yet
apply anything.

## Usage

    node scripts/detect.mjs <path-to-repo> [--verify] [--json]
```

`grep -rn "apply.mjs\|uninstall.mjs" README.md` returns nothing. On this branch:

- `scripts/apply.mjs` (313 lines) and `scripts/uninstall.mjs` (204 lines) exist
  and are the point of the work.
- Neither has a `--help`. Neither is mentioned in any document a user would find:
  `docs/` contains two plan execution logs and a validation record, which are
  development artefacts.
- Nothing documents `--yes`, `--allow-dirty`, `--allow-default-branch`, the
  default-is-a-dry-run contract, the exit-code contract (0/2/3), the manifest at
  `.claude/harness-kit.manifest.json`, the write allowlist, the
  `CLAUDE.proposed.md` redirect, or that `apply` refuses on a default branch.
- Nothing documents that installing the two process hooks means **the
  repository's own `lint` script runs on every edit and its own
  `typecheck`/`test` script runs at the end of every turn**. The Stop gate's
  own proposal `reason` discloses this beautifully at proposal time; it exists
  nowhere a user can read before deciding to run the tool.

This is the answer to "is the branch comprehensible to someone who was not
here": the *code* is, remarkably so — the in-file commentary is the best I have
seen on a branch this size, and it is load-bearing rather than decorative. The
*product* is not. A reader arriving at this repository is told, by the only file
written for them, that `apply` does not exist.

Separately, the in-code commentary has drifted in three specific places; those
are F7, F8, F11 and F14 below, and §5.3 says what I think that pattern means.

---

### F6 — MAJOR. The two forged-manifest gates do not compose for `.claude/rules/*.md`

`uninstall-lib.mjs`'s header documents the Critical finding and its two fixes,
and enumerates what each catches:

> 1. `isGeneratorProducible` — the STRUCTURAL fix. A forged entry for a path no
>    generator ever targets (`CLAUDE.md` …) is refused regardless of content …
> 2. `carriesOurStamp` — the GENERAL fix. A forged entry for a path that
>    genuinely IS one of ours … but whose on-disk content is the USER's own,
>    unrelated file … is refused because that content does not carry the
>    `Generated by harness-kit` marker …
>
> Neither check is redundant with the other.

There is a third case the enumeration does not contain, and neither gate covers
it: **a path that is genuinely ours, holding content that genuinely descends
from our scaffold, into which the user has since written their own work.**

`.claude/rules/*.md` is the one path family where that is the designed
workflow. `GENERATOR_PRODUCIBLE_PREFIXES = ['.claude/rules/']` admits the whole
prefix (it has to — the slug is derived from layout, so no exact list can
enumerate it). The scaffold `pathRuleProposal` writes contains `{{stamp}}`, so
the file carries `Generated by harness-kit` *after* the user fills in their
conventions. The proposal text even tells them to: "each file is generated
EMPTY; conventions are added by hand afterward."

Reproduction. A two-package workspace; `apply --yes` writes the scaffold:

```
$ cat .claude/rules/packages-api.md
---
paths:
  - "packages/api/**/*"
---

<!-- Generated by harness-kit 0.1.0 (runbook step 7). Edit freely — harness-kit will report your changes rather than overwrite them. -->

# packages/api
```

The user does what the proposal told them to do:

```
$ cat >> .claude/rules/packages-api.md <<'EOF'

## Review checklist for this package
- Never call the billing API from a request handler; use the queue.
- All money values are integer minor units. There are no floats here.
- Migrations are reviewed by @alice before merge. This took us three outages to learn.
EOF

$ grep -c "Generated by harness-kit" .claude/rules/packages-api.md
1
```

Control — with the honest manifest, `uninstall` correctly keeps it:

```
$ node scripts/uninstall.mjs . --yes
  .claude/rules/packages-api.md (ours-modified)
Kept:
  .claude/rules/packages-api.md (ours-modified)
--- still on disk? ---
YES — kept, correct
```

Now the forgery — one field, the recorded hash set to the file's current content:

```
$ node -e "... e.sha256 = sha256(readFileSync('.claude/rules/packages-api.md')) ..."
forged sha256 -> 315f2a0783db5d9b62058e29a3561c84d69b11ce1badd97e6535983a546bc37c

$ tail -4 .claude/rules/packages-api.md
## Review checklist for this package
- Never call the billing API from a request handler; use the queue.
- All money values are integer minor units. There are no floats here.
- Migrations are reviewed by @alice before merge. This took us three outages to learn.

$ node scripts/uninstall.mjs . --yes
  .claude/rules/packages-api.md
Removed:
  .claude/rules/packages-api.md

--- is the user's filled-in rule file still there? ---
NO — DELETED, with the user's hand-written conventions in it
```

`guardRemoval` returns `null` (allowed, contained, generator-producible),
`classify` returns `ours-unmodified`, `carriesOurStamp` returns `true`, and the
file is reported as a plain `Removed:` — not kept, not refused, not flagged.

The legitimate path is safe: `classify` compares against the hash of the empty
scaffold, so an edited rule file is `ours-modified` and kept. Only a rewritten
hash defeats it — but "the manifest is a file in the repository, forgeable like
any other" is this module's own stated threat model, and the mitigation for it
is these two gates.

Honest framing of the severity: anyone who can rewrite the manifest can also
delete the file directly, so this is not a privilege escalation. It is the same
shape as the finding the project rated Critical, narrowed to one path family,
and the value of reporting it is that the module's own comment reads as though
the two gates are jointly exhaustive. If the answer is "accepted residual
risk", that belongs in the comment, because the next person to read it will
conclude the opposite.

---

### F7 — MINOR. `apply` and `uninstall` carry two copies of the "was this file already canonical" predicate, and they have drifted — `apply`'s prints a false reformat warning

Same question, two implementations, one of them wrong.

```js
// scripts/apply.mjs
function alreadyCanonical(path) {
  ...
  return raw === JSON.stringify(JSON.parse(raw), null, 2) + '\n';
}
```

```js
// scripts/lib/uninstall-lib.mjs
const wasCanonical = validated.raw === (JSON.stringify(validated.object, null, 2) + matchingNewline(validated.raw));
```

`matchingNewline` was added on this branch (Task 9b, finding 5) precisely so the
tool stops appending a trailing newline to a file that had none, and
`apply-lib.mjs` uses it on the write path. `apply.mjs`'s check never got it,
so a `settings.json` that is already in exactly the form this tool writes but
without a trailing newline is misclassified as non-canonical.

Reproduction — `.claude/settings.json` written as `JSON.stringify(x, null, 2)`
with no trailing `\n`:

```
$ od -c .claude/settings.json | tail -2
0000040   }  \n   }
0000043

$ node scripts/apply.mjs . --yes
patched    .claude/settings.json (Stop)
patched    .claude/settings.json (permissions.deny)
patched    .claude/settings.json (SessionStart)
note       .claude/settings.json was reformatted while applying the patch above — its content is
unchanged beyond what was listed, but whitespace/indentation may now differ throughout the file ...

$ git diff --stat -- .claude/settings.json
 .claude/settings.json | 27 +++++++++++++++++++++++++++
 1 file changed, 27 insertions(+)
```

27 insertions, zero deletions, zero lines reformatted. The note is false.

And the comment on the correct copy says:

> `settingsReformatted` mirrors apply.mjs's own `alreadyCanonical`

It does not mirror it; it corrects it. This is the branch's duplicated-predicate
pattern caught one iteration earlier than usual: the two copies have already
diverged, the comment asserts they have not, and the consequence is only a
false sentence rather than a wrong write.

Fix: export one predicate (next to `matchingNewline`, which both already
import) and have both callers use it.

---

### F8 — MINOR. Sibling fields of `harness.claudeDir` answer "what is configured here" from different file sets

`hookEvents` reads both settings files:

```js
const SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'];
```

`settings`, `localSettings`, `denyRules` and `denyRuleList` read only
`.claude/settings.json`. The asymmetry is uncommented, and it is the same shape
as Task 9b's finding 6 (which fixed `settings`/`localSettings` to read from the
same place as `hookEvents`, and left the deny-rule pair behind).

Reproduction. A repository whose own deny rule **and** own SessionStart hook
both live in `.claude/settings.local.json` (gitignored), with no
`settings.json` at all:

```
claudeDir.settings      (settings.json only): false
claudeDir.localSettings (settings.local.json): true
claudeDir.denyRules     (settings.json only): 0
claudeDir.denyRuleList  (settings.json only): []
claudeDir.hookEvents    (BOTH files):         {"SessionStart":[null]}
P2.protected    -> absent | proposal: create .claude/settings.json with deny rules for protected paths | evidence: []
P4.sessionbrief -> absent | proposal: install scripts/session-brief.mjs and register a SessionStart hook | evidence: ["SessionStart hook already registered, but not ours (its script could not be resolved)"]
```

The hook check *sees* the local file and says so. The deny-rule check does not,
so its evidence is empty — it cannot even name the user's existing rule, which
is the one thing `P2.protected`'s own comment says it must always do ("name what
of theirs was found instead, so adding rules alongside it is never a
surprise"). After `apply --yes`:

```
--- settings.json permissions.deny:        {"deny":["Edit(*-lock.json)"]}
--- settings.local.json permissions.deny:  {"deny":["Edit(*-lock.json)"]}
```

The identical rule now exists twice, in two files, and the user was never told
the first one was there.

Consequence: a user who keeps their deny rules in `settings.local.json` — which
is the gitignored, machine-local file, and a perfectly ordinary place to put
them — is told `P2.protected` is absent and gets a duplicate set written into
`settings.json`. Low harm; `addDenyRules` dedupes within the file it writes. But
it is a second answer to a question the module already answers one way three
fields earlier.

Related, same module, trivial: `detect-exposure.mjs` labels **any** finding
under `.claude/` as `token-in-local-settings`
(`const isLocalSettings = rel.startsWith('.claude/')`), so a token in, say,
`.claude/scripts/*.mjs` is reported under a kind that names the wrong file.

---

### F9 — MINOR. `apply` performs the full detection pass, including the credential scan, and prints none of it

`apply.mjs` runs `listFiles`, `detectStack`, `detectHarness`, `detectExposures`
and `buildGaps` — the same work `detect` does — and then prints only proposals
and diffs. A user who runs `apply --yes` without first running `detect` is never
told about:

- a live token the same run just found (`P0.security` is computed and discarded),
- the nested repositories `listFiles` returned (`apply` destructures only
  `{ files }`; `detect`'s own comment calls that disclosure load-bearing because
  "a report that omits it makes a partial scan look complete"),
- any of the `couldNotDerive` questions.

Defensible as a division of labour — `detect` reports, `apply` writes. But
nothing tells the user that, and `apply` is perfectly usable standalone. The
cheapest honest fix is one line in `apply`'s header output pointing at
`detect`, or echoing a `failing` `P0.security` before writing anything.

---

### F10 — MINOR. Three entry points, three argument conventions

| | flags anywhere | warns on unknown flag | path |
|---|---|---|---|
| `detect.mjs` | yes | yes | first non-flag argv |
| `apply.mjs` | yes | yes | first non-flag argv |
| `uninstall.mjs` | no | no | `process.argv[2]` |

```
$ node scripts/uninstall.mjs --yes .
error: repository not found: --yes
exit=2

$ node scripts/uninstall.mjs . --yse     # typo silently ignored, unlike detect/apply
nothing to uninstall: no manifest found
```

`detect.mjs`'s own comment explains why the unknown-flag warning exists ("A
typo like `--verfiy` used to be a silent no-op"). The reasoning applies to the
one command that deletes files at least as much, and it is the one command that
does not have it.

---

### F11 — MINOR. A comment overstates the sensor's tool coverage

```js
// `matcher: 'Write|Edit'` scopes the hook to the tools that actually edit a
// file — PostToolUse fires for every tool otherwise ...
```

From the hooks reference, verbatim, on matcher evaluation:

> | Only letters, digits, `_`, `-`, spaces, `,`, and `\|` | Exact string, or
> list of exact strings separated by `\|` or `,` … | `Bash` matches only the Bash
> tool; `Edit\|Write` and `Edit, Write` each match either tool exactly … |
>
> | Contains any other character | JavaScript regular expression, unanchored |

`Write|Edit` contains only letters and `|`, so it is matched as two exact
strings. It therefore does **not** fire for `NotebookEdit` or for the legacy
`MultiEdit`. In practice this costs almost nothing — `NotebookEdit` carries
`notebook_path`, not `file_path`, and the hook only covers
`.ts/.tsx/.js/.jsx/.mjs/.cjs/.py` anyway; `MultiEdit` is described in the
permissions reference as "the legacy `MultiEdit` tool". But "the tools that
actually edit a file" is not what the matcher selects, and a reader auditing
coverage from the comment would conclude it is.

---

### F12 — MINOR (reporting surface). The exposure list is printed twice, verbatim

`P0.security`'s evidence is `prominent.map(e => `${e.kind} at ${e.location}`)`;
the Exposures block is `prominent.map(e => `${e.severity} ${e.kind} at ${e.location}`)`.
On this very repository that is 14 lines carrying 7 facts:

```
  [!] P0.security        failing
        token-in-tracked-file at scripts/lib/apply-lib.test.mjs
        token-in-tracked-file at scripts/lib/detect-exposure.test.mjs
        credentials-in-doc at scripts/lib/detect-exposure.test.mjs
        token-in-tracked-file at scripts/lib/harness-redact.test.mjs
        credentials-in-doc at scripts/lib/harness-redact.test.mjs
        token-in-tracked-file at scripts/lib/lint-touched.test.mjs
        credentials-in-doc at scripts/lib/lint-touched.test.mjs
...
Exposures (7) — values are never printed; rotate by hand:
  ! high   token-in-tracked-file at scripts/lib/apply-lib.test.mjs
  ! high   token-in-tracked-file at scripts/lib/detect-exposure.test.mjs
  ! medium credentials-in-doc at scripts/lib/detect-exposure.test.mjs
  ! high   token-in-tracked-file at scripts/lib/harness-redact.test.mjs
  ! medium credentials-in-doc at scripts/lib/harness-redact.test.mjs
  ! high   token-in-tracked-file at scripts/lib/lint-touched.test.mjs
  ! medium credentials-in-doc at scripts/lib/lint-touched.test.mjs
```

The duplication is a consequence of the shared `splitExposures` fix (which is
right — the two sections can no longer disagree), not a bug. But the fix made
them identical, which is now an argument for the check to cite the Exposures
section rather than reproduce it. §4 has my overall read on volume.

---

### F13 — MINOR (test quality). Three `SECRET:` tests are unfalsifiable by construction

`report.test.mjs:128`, `gap-model.test.mjs:388` and `propose.test.mjs:974` each
build a `stack` fixture containing:

```js
scriptBodies: { build: leakedToken },
```

and assert the token does not appear in the rendered summary / the advice / the
generated bootstrap script.

```
$ grep -rn "scriptBodies" scripts/ assets/
scripts/lib/gap-model.test.mjs:396:      scriptBodies: { build: leakedToken },
scripts/lib/propose.test.mjs:381:// (see the SECRET tests' `scriptBodies`) to isolate one specific guard.
scripts/lib/propose.test.mjs:982:      scriptBodies: { build: leakedToken },
scripts/lib/report.test.mjs:134:      scriptBodies: { build: leakedToken },
scripts/lib/report.test.mjs:151:  // produces a real `scriptBodies` field in the first place.
```

Zero production readers. `detectStack` never emits such a field; nothing
consumes one. The tests assert that a token placed in a field no code reads does
not come out of code that does not read it. The `assert.ok(JSON.stringify(stack)
.includes(leakedToken), 'fixture sanity: ...')` guard they each carry makes this
harder to see, not easier: it proves the token is on the fixture object, never
that it reaches the function.

Measured, not argued. I made `detectStack` actually emit the field, which is
the only way a `scriptBodies` leak could ever happen:

```
### M20 detect-stack ALSO emits script BODIES (the field the three SECRET tests pretend to guard)
   -> pass 646 / fail 1
   KILLED BY: SECURITY: a package.json script body never reaches stdout or detect.json
   reverted: true
```

One test caught it, and it is **not** one of the three. It is
`detect-cli.test.mjs:403`, which writes a real `package.json` with
`sentry-cli --auth-token <marker>` in a script body, runs the real CLI, and
checks stdout, `detect.json` and the human summary — then asserts the script's
*presence* still survives, so the fix cannot be "stop reporting scripts". That
is a genuinely excellent test, and it is the entire reason this exposure is
guarded.

So the good news is that the guarantee holds; the finding is that three tests
carrying the project's strongest-looking label contribute nothing to it, and a
future reader auditing "is the script-body leak covered?" is three times more
likely to land on one of them than on the one that matters.

This is the 14th through 16th instance of the suite's known failure shape, and
the shape is slightly different from the previous thirteen in a way worth
naming: the fixture does not fail to *survive* to the branch under test, it
describes a data shape production never produces. §5.3 generalises.

---

### F14 — MINOR (test quality / comment drift). `bootstrap-target-evidence.mjs`'s doc comment misdescribes `readIfPresent`, and the two tests that would have caught it cannot

```js
/**
 * Never throws, and never reports `found: true` from a bad read — a
 * directory, an empty file, a binary file, or a file this process cannot
 * open all fall through to `{ found: false }` via `readIfPresent`, which
 * already treats every one of those as "nothing to read" ...
 */
```

`readIfPresent` (`scan.mjs`) is four lines and has no binary detection and no
empty-file handling:

```js
export function readIfPresent(root, rel) {
  const p = join(root, rel);
  if (!existsSync(p)) return null;
  try { return readFileSync(p, 'utf8'); } catch { return null; }
}
```

An empty file returns `''`, not `null`; a binary file returns mojibake, not
`null`. Only the directory case is true (`readFileSync` throws `EISDIR`). The
outcome is still `{found: false}`, so this is a wrong *explanation*, not a wrong
*result* — but it is exactly the kind of comment that gets trusted by the next
person to change `readIfPresent`, and the two tests named after the claim
(`bootstrap-target-evidence.test.mjs:99` "an empty Makefile is not found, never
a throw" and `:106` "a binary Makefile is not found, never a throw") pass
because those bytes happen not to match the target regex, not because the
`content == null` exit they name was taken.

Measured. Neutering the guard the comment is about:

```
### M24 bootstrap-target-evidence: remove the content == null guard the doc comment is about
   -> pass 645 / fail 2
   KILLED BY: a missing Makefile is simply not found, never a throw
   KILLED BY: a Makefile that is actually a directory is not found, never a throw
   reverted: true
```

Exactly the two cases where `readIfPresent` really does return `null`. The
"empty" and "binary" tests did not fire, because the exit they are named for was
never theirs to take.

---

### F15 — MINOR (legibility, not coverage). `glob.test.mjs` contains no test of `glob.mjs`

`glob.mjs` was extracted into its own module specifically so one glob matcher is
shared by `detect-stack.mjs`'s workspace expansion and `protected-evidence.mjs`'s
evidence filter. Its header says of the four-step transformation:

> The order of the four steps below is load-bearing … Reordering any of these
> silently breaks single- or double-star patterns.

`glob.test.mjs` is 60 lines and contains exactly one test:
`'no tracked file under scripts/ or assets/ contains a raw NUL byte'` — a
valuable repository-wide guard, and not a test of `globToRegExp`.

I filed this as a coverage hole and then measured it, and the measurement says
it is not one:

```
### M23 glob.mjs: reorder the four steps (expand single * BEFORE **) — the file calls this order load-bearing
   -> pass 346 / fail 69
   KILLED BY: writes detect.json into the target repo
   KILLED BY: LOAD-BEARING: a harnessed repo gets no proposals
   KILLED BY: END-TO-END: a pip repo with requirements.txt reports P1.bootstrap as absent, with a proposal
   ... (69 total)
   reverted: true
```

The ordering is densely covered — indirectly, through every end-to-end test
whose repository has a lockfile and therefore exercises `**/*-lock.json`
against a real file list. So the risk is low and I would not hold the merge for
it. The finding is narrower and is about §5.3's theme: a file named
`glob.test.mjs` that contains no test of `glob.mjs` tells the next reader that
this module is covered where it is not, and that the coverage it does have
lives somewhere they will not think to look. One direct table-driven test of
`globToRegExp` — eight lines — would make the real guarantee local to the
module, and would also pin the one thing the indirect tests do not: the
documented asymmetry that `**/dist/**` deliberately does *not* match a
root-level `dist/a.js`, which three separate profile comments depend on being
true.

---

### F16 — MINOR (test coverage). One live defensive guard in `revertPatch` cannot be detected by any test, and the test named for it cannot fail for it

```
### M22 settings-merge: remove revertPatch's container type guard
   -> pass 647 / fail 0
   *** SURVIVED: no test failed ***
   reverted: true
```

The guard is:

```js
if (typeof patch.container !== 'string') {
  return { settings: next, reverted: false };
}
```

`settings-merge.test.mjs:91` is named `'revertPatch returns reverted:false when
patch missing container without throwing'`, and its fixture is
`{ entrySha256: 'abc123' }`. `'abc123'` also fails the *next* guard (the
64-hex-digit check), so the test returns `reverted: false` either way. Its
sibling at `:98` does it correctly, with a valid 64-hex string, so the fix is
one fixture change.

Why it matters beyond tidiness: the guard is genuinely load-bearing against a
forged manifest. `planUninstall` is called *unwrapped* in `uninstall.mjs`
(line 30 — only `runUninstall` is inside a `try`), so a manifest with
`settingsPatches: [{ container: 123, entrySha256: "<64 hex>" }]` would, without
this guard, reach `patch.container.startsWith('/hooks/')`, throw a `TypeError`,
and exit **1** — breaking the "the CLI contract is exit 0, 2 or 3 and nothing
else" rule the file states in its own first comment. The guard is right. It is
simply unverified, which this project has an explicit rule about
(`bootstrap-target-evidence.mjs`: "this project does not keep code a mutation
cannot detect"). Here the answer is to pin it, not to remove it.

---

## 2. Not reproduced / dropped

Recorded because the review rules require it, and because one of these is a
finding I would otherwise have filed.

1. **"`Edit(...)` deny rules do not cover the `Write` tool, so `P2.protected`
   overclaims."** I was told this by a documentation research pass, with a
   plausible citation, and it would have been a Major finding. It is **wrong**,
   and `propose.mjs`'s choice of `Edit(` is **correct**. From the permissions
   reference, verbatim:

   > Claude Code checks file permissions against `Edit(path)` and `Read(path)`
   > rules only. If you write a path rule for `Write`, `NotebookEdit`, `Glob`,
   > or the legacy `MultiEdit` tool instead, Claude Code accepts the rule but
   > never consults it, and warns at startup … Use `Edit(docs/**)` in place of
   > `Write(docs/**)`, `NotebookEdit(docs/**)`, or `MultiEdit(docs/**)` …

   `Edit(glob)` is the only correct spelling, and per the same page output
   redirects (`> file`) are also checked against Edit rules. Dropped. Noting the
   near-miss deliberately: this is the shape of finding that has cost the
   project rounds before, and it only died because I fetched the page.

2. **`docs/harness/detect.json` survives a complete uninstall** (confirmed:
   `git status` after a full cycle shows `?? docs/`). Already disclosed in
   `docs/validation/2026-09-30-plan-3-capabilities.md` line 973. Not re-filed.

3. **`detect-exposure.test.mjs:278`, "skips genuinely binary file (NUL bytes,
   no BOM) without throwing (round 4)", is vacuous** — its fixture contains no
   token, no PEM header and no credential-shaped key, so nothing could have
   been found whether or not the NUL sniff ran. Confirmed by mutation (§6, M21:
   removing the sniff is caught by `:209`, which uses a token-bearing NUL file,
   and not by `:278`). Folded into F13's theme rather than filed separately,
   because the guard itself is covered.

4. **`detect --verify` executes repository-controlled build/test/lint/typecheck
   commands.** Real, but deliberate and documented in the README: "the flag
   itself is the consent." The command strings themselves come from closed sets
   (`profiles/typescript.mjs` builds `${runner(pm)} ${name}` with `name` from a
   four-element list and `pm` from a lockfile-keyed table), so there is no
   injection on top of the intended execution. Not a finding.

5. **A hostile `pkg.dir` injecting into the path-rule template.** I traced the
   whole path and could not break it. `sanitizeForYamlDoubleQuoted` escapes
   backslashes before quotes (correct order), the maintainer comment is fully
   static, and `pkg.dir` comes from the file list rather than file content. The
   round-3-through-5 redesign holds. A directory name containing `"` produces an
   unwritable filename on Windows, which fails closed through
   `applyProposals`'s `failed` path. Not a finding.

6. **A dependency's `scripts.lint` executing via the sensor.** `lint-touched.mjs`
   resolves the *owning* package of the edited file, so editing
   `node_modules/foo/bar.js` would run `node_modules/foo`'s own `scripts.lint`
   under a shell. I could not make this a finding worth filing: it requires
   Claude to edit a file inside `node_modules`, and a repository's own lint
   script is arbitrary code by design in every case. Recording it because it is
   the one place the sensor's "owning package" resolution reaches code the
   repository did not author.

---

## 3. Security posture, as a chain

Assessed as one chain rather than four links: three hooks that execute
repository-derived commands, a shared redaction module guarding their output, a
manifest that drives deletion, an allowlist that bounds writes.

**The links are sound.** Specifically, and I went looking for the opposite:

- **Nothing a hostile repository controls reaches a generated file as
  executable or instruction-shaped text.** `bootstrap.sh`'s steps come from a
  closed table (`INSTALL_COMMANDS`) plus `${runner(pm)} ${name}` where `name`
  is one of four literals and `pm` is lockfile-keyed — there is no repository
  string in it at all. The path-rule template's maintainer comment is fully
  static, `pkg.name` was removed from the heading entirely, and `pkg.dir` comes
  from the filesystem layout rather than from a file's contents.
  `sanitizeForYamlDoubleQuoted` escapes backslashes before quotes, which is the
  correct order. I tried to break this and could not.
- **Nothing a hostile repository controls can steer a write out of the
  allowlist.** `slugifyDir` cannot emit a `/`, `git ls-files` cannot emit a
  `..` segment, and `assertAllowed` + `assertContained` run over the whole
  batch before the first byte is written. The pass-1/pass-2 TOCTOU gap is
  documented in place and correctly judged not worth closing against an
  attacker who already has write access.
- **Command text never reaches an output surface.** `detect` records resolved
  script *paths*, never hook commands (`commandScript`), and script *names*,
  never bodies (`detect-stack.mjs`) — and omission, rather than masking, is the
  right choice and is the stated reason. `detect-cli.test.mjs:403` and `:433`
  verify both through the real CLI with real fixtures; those two are among the
  best tests on the branch.
- **The hooks' own output passes a two-layer filter and is bounded.** Verified
  by mutation: neutering either layer kills tests in both hooks (§6, M5/M6).

**The two weakest points are not code defects.**

1. **F6** is the one real residual: the two forged-manifest gates do not
   compose for `.claude/rules/*.md`, and the module's comment reads as though
   they are jointly exhaustive.
2. **The worst thing a hostile repository can make this tool do is the thing it
   is designed to do, and nothing durable says so.** With the sensor and the
   stop gate installed, a repository's own `scripts.lint` runs under a shell on
   every edit and its own `typecheck`/`test` runs on every turn end. That is the
   capability, not a defect — `npm run lint` is arbitrary code in every
   project — and the marginal risk harness-kit adds is *automation*: the user
   no longer has to type it, and a `git pull` that changes `scripts.lint` is
   now a change in what executes automatically. The Stop gate's proposal
   `reason` discloses its cost honestly at proposal time. Nothing discloses the
   execution itself, anywhere, ever — not in the sensor's `reason` (which says
   only "no PostToolUse hook registered"), not in a README, not in a `--help`
   (F5). The asymmetry is notable on its own: the stop gate explains what it
   will run and what it will cost; the sensor, which fires far more often,
   explains nothing.

Two smaller observations, neither a finding:

- `lint-touched.mjs` enforces its single-stderr-chokepoint invariant
  *structurally* — one `process.stderr.write`, in `writeReport`, with a comment
  saying so. `verify-touched.mjs` has five `process.stderr.write` call sites,
  four of which bypass `boundReport`. All four emit fixed strings interpolating
  only `picked.kind` (`'typecheck' | 'test'`), so nothing leaks today; but the
  invariant one hook makes impossible to violate, the other maintains by
  inspection.
- harness-kit deliberately does not consult the user's own
  `permissions.deny` before its own writes (the allowlist is in code "not a
  permission rule in settings.json", and the reasoning for that is right). A
  consequence worth knowing: a user with `Edit(scripts/**)` denied still gets
  `scripts/bootstrap.sh` created. It never *overwrites* — `classify` plus
  `!existsSync` guarantees that — so I do not think this is wrong, but it is a
  place where the tool's authority and the user's stated intent differ.

---

## 4. The accumulated reporting surface

I read a real run as a user. On this repository it is 65 lines, and it is
**usable** — the structure does real work: phase grouping, a one-glyph state
column, evidence indented under its claim, the `→` proposal on its own line,
and three genuinely distinct trailing sections (proposals / advice / questions)
whose distinction is explained and held.

Three specific things are right and worth protecting:

- The proposals-versus-advice split. "harness-kit will not write these" is the
  most useful line in the output, and `report.mjs`'s comment on why it is not
  folded into the `→` lines is correct.
- `splitExposures`. 62 of 66 findings on a real repository being
  reference-valued, collapsed to one disclosed count, is the difference between
  a check people read and a check people learn to skip.
- Every `n/a` and every question says what was *looked for*, not what *is*.
  `P2.protected`'s "an untracked or gitignored file of the same kind would not
  be visible here" is the model the rest of the output lives up to.

Where it is still overclaiming — all of these are findings above, gathered here
because this is the question they answer:

- `P0.security verified / no credential patterns matched` on a repository with
  a plaintext token (F1). This is the one that matters.
- `P1.pathrules absent → scaffold .claude/rules/` after a successful apply
  wrote exactly that (F2).
- `note .claude/settings.json was reformatted … whitespace/indentation may now
  differ throughout the file` on a 27-insertion, 0-deletion diff (F7).
- `harness-kit: no HANDOFF.md in this repository yet.` in a repository whose
  handoff file the same tool just credited (F4).

On volume: it is not yet the problem, but it is one capability away from being
one, and the growth is not linear in anything the report controls. Three
sections scale with repository size rather than with findings:
`P2.scripts`'s advice is up to two lines per package (eight on a four-package
workspace, plus `PY_COMMAND_HOME`); `couldNotDerive` emits one line per
undecidable check plus four unconditional ones; and the exposure list is
printed twice (F12). A ten-package Python monorepo with a few hundred
reference-valued credential hits would produce something closer to 120 lines, of
which about 25 are duplicated or near-duplicated. The cheap structural fix, if
it is ever needed, is to make the per-package advice collapse the way
`splitExposures` collapses — one line per *kind* with a count, expanded by
`--json` — rather than to trim any of the sections.

What I would not change: nothing in the output is *noise* in the sense of being
untrue or unactionable. The questions are good questions. That is rarer than it
sounds.

---

## 5. The three questions

### 5.1 Would you merge this?

**Not as it stands; yes after F1, and I would want F2, F3 and F4 in the same
pass.** The distance from here to mergeable is small and well-bounded.

What I would not ship:

- **F1.** A security check that reports success because it never read the file.
  One flag (`-z`) on two `git ls-files` calls, plus the matching fix in
  `apply.mjs`'s `hasTrackedChanges`. There is no version of this branch's own
  doctrine under which this ships.
- **F2.** Two commands of the same tool contradicting each other about the same
  repository, with an unsatisfiable proposal printed on every run. One line in
  `detect-harness.mjs`, plus the fixture that would have caught it.
- **F3** and **F4.** Both are "the capability installs, reports as present, and
  silently does nothing" — the exact false-assurance shape
  `stopgateProposal`'s own comment identifies as having cost this project a
  round. F4 additionally prints a falsehood into the model's context.

Everything else I would merge and file. F5 (the README) I would fix before
anyone outside the project touches this, but it blocks adoption rather than
correctness.

What I want to say plainly, because a finding list reads as a verdict and
should not here: this is unusually good work. The shared-evidence-module
pattern, the central enforcement of "only a decidable `absent` may propose", the
two independent forged-manifest gates, the single stderr chokepoint, the
allowlist-in-code-not-settings decision, and the per-finding comments explaining
what was tried and rejected — those are the artefacts of a project that actually
learned from its own defects. Five of my sixteen findings (F1, F2, F3, F7, F8)
exist *because* the project built a correct pattern and then applied it to all
but one call site. That is a much better failure mode than not having the
pattern, and it is a much cheaper one to finish.

### 5.2 What is the most likely way this tool hurts a real user?

Not F1 — that needs a non-ASCII filename. The most *likely* harm is **F3 and F4
together: the continuity capability installs, reports itself present forever,
and quietly stops delivering the handoff.**

The reasoning is about base rates, not severity:

- Every repository gets `P4.sessionbrief`. It has no evidence gate — no
  lockfile, no declared script, no workspace layout required. `registeredHook`
  returns `absent` whenever our path is not registered, and the generator always
  produces. It is the one capability that fires on literally every repository
  the tool is pointed at.
- `HANDOFF.md` exceeding 10,000 characters in its first 60 lines is not an edge
  case; it is what the shipped template asks for. "What didn't work … Error text
  if there was one" invites pasting a stack trace, and the section is described
  in the template as "The most valuable section".
- A handoff file at `docs/HANDOFF.md` is not unusual either — the tool's own
  `existsAny` lists it as one of the two conventional locations, which is an
  admission that real repositories put it there.
- And in both cases the failure is **silent and self-concealing**: `detect`
  reports `P4.sessionbrief declared`, the hook exits 0, and the only visible
  symptom is that sessions start without the context the user believes is being
  injected. A user does not discover "my handoff silently stopped arriving"; they
  discover "Claude keeps repeating dead ends I wrote down". Which is the exact
  failure the capability exists to prevent.

Second most likely, and worth naming for a different reason: the Stop gate on a
large repository. `reason` discloses "cost scales with the size of the
repository, not the size of the edit — a large codebase may see 10-30s added per
turn", which is honest and well-placed. But it is disclosed at proposal time, in
a dry-run preview a user may well skim, and it is documented nowhere else (F5).
A user who accepts it and then finds every turn 20 seconds slower has no path
back to the explanation — there is no README, no `--help`, and the proposal is
not re-shown once the capability is `declared`.

### 5.3 What did all the per-task reviews systematically miss?

Three things, in order of how much I think they matter.

**(1) Each review checked that a predicate was *shared*; none checked that both
halves of the question were shared.**

This project's signature fix is the shared evidence module: when a check and its
generator disagreed, the *derivation* was extracted so they could not drift. It
worked — `bootstrap-install.mjs`, `sensor-evidence.mjs`,
`stopgate-evidence.mjs`, `protected-evidence.mjs`, `pathrules-evidence.mjs`.
But every one of those checks asks two questions, not one:

> *Is this capability derivable here?* — now shared, five times over.
> *Is this capability already present here?* — never extracted, answered
> ad hoc by every check.

F2 is exactly that: `P1.pathrules` shares its derivation and answers presence
from the scan list while every sibling answers it from disk. F8 is the same
thing one level down, between two fields of one object. F4 is the same thing
across a module boundary: `detect-harness.mjs` and `session-brief.mjs` answer
"where is the handoff file" differently, and nothing shares it because one of
them is a shipped asset that cannot import. A per-task review sees "the
derivation is shared — good, this is the fixed pattern" and stops, because the
derivation is where the last five defects were.

**(2) A fix applied to N of N+1 call sites reads, in a single-task diff, as
complete.**

F3 is the clearest case. `MAX_REPORT_BYTES` was added because a line bound was
measured to be insufficient, and the constant's own neighbour says
`MAX_REPORT_LINES` "mirrors session-brief.mjs's own bound". Two hooks got the
byte bound; the third, whose bound the comment cites as the model, did not. In
the task diff that introduced `boundReport`, `session-brief.mjs` does not
appear — so there was nothing for that task's reviewer to look at. The same
structure produced F7 (`matchingNewline` applied to the write path and to
`uninstall`'s check, never to `apply`'s) and F1 (the quoted-path problem
half-handled in `apply.mjs`'s `hasTrackedChanges` and not at all in
`scan.mjs`). In every case the evidence that the fix was incomplete is a
*comment in a file the task never touched*.

The structural remedy is cheap and I would adopt it: when a task extracts or
shares something, grep for every other site that answers the same question and
list them in the task report, including the ones left alone and why.

**(3) The test suite's fixtures were reviewed per task; the *matrix* of
repository shapes never was.**

Each capability has a good fixture. The lifecycle test composes them all on one
workspace. The gitignored-`.claude/` test composes nothing — it is a
single-package repository. The validation record runs two real repositories,
and I checked: **neither is a multi-package workspace** (`P1.pathrules` reports
"not a workspace" in both) and **neither gitignores `.claude/`**. So the
capability whose check is broken was never exercised end-to-end against a real
repository at all, and the repository shape that breaks it was tested only
against the capability that handles it correctly.

This is also where the suite's green is least informative, and the shape has
shifted since the thirteen known instances. Those were fixtures whose data never
reached the branch under test. What I found is two newer variants:

- **An assertion aimed at the wrong command.** `lifecycle.test.mjs:889` is
  meant to pin "it must not re-propose on every subsequent run" and reads
  `apply`'s output, which structurally cannot re-propose. It passes verbatim
  against F2's broken repository. The test is not weakly written; it is pointed
  at the wrong surface, which a per-task review cannot see because the symptom
  is in the *other* command's output.
- **A fixture describing a data shape production never produces.** The three
  `SECRET: scriptBodies` tests (F13) assert that a token in a field with zero
  production readers does not escape. The real guarantee — `detect-stack.mjs`
  copying `Object.keys(pkg.scripts)` and never a body — *is* covered, by
  `detect-cli.test.mjs:403`, through the real CLI with a real `package.json`.
  So the exposure is guarded and three tests are theatre. Worth saying because
  the `SECRET:` prefix makes them look like the project's strongest tests.

On the other hand — and this is the part I most want on the record, because it
is the answer to "do you believe the green": **I planted 19 mutations in the
production code and 17 were killed, including all twelve aimed at the defences
the per-task reviews introduced.** Several were killed by five, nine or
nineteen tests at once. §6 has the table.

Of the two survivors, one is a one-line defensive guard nothing exercises (F16).
The other is the fix for F1 — adding `-z` to `git ls-files` changes the tool's
behaviour on an entire class of filename and **no test notices**. That pair is
the honest summary of this suite: it is informative, often densely so, about
everything it is pointed at; it has no way to tell you where it is not pointed.
And "which repository shapes exist" was never a property of any one task's diff,
so the per-task structure had no mechanism for asking.

---

## 6. Mutation testing

Every mutation was applied to production code (never to a test), the **full**
suite was run, and the file was restored with `git checkout --`. `reverted:
true` is asserted per mutation by reading the file back after restore.

Baseline: `pass 647 / fail 0`.

### Batch A — the twelve guards whose failure would alarm me most

These are the ten the brief asked for, plus two. Each is a defence introduced or
hardened by a per-task review; the question asked of each was "can this actually
fail?"

| # | Mutation (production code) | pass / fail | Verdict |
|---|---|---|---|
| M1 | `isGeneratorProducible` → always `true` | 645 / 2 | **killed** |
| M2 | `carriesOurStamp` → always `true` | 646 / 1 | **killed** |
| M3 | `assertAllowed` → no-op | 642 / 5 | **killed** |
| M4 | `assertContained` → no-op | 644 / 3 | **killed** |
| M5 | `dropCommandFragments` → pass-through (redaction layer 1 off) | 641 / 6 | **killed** |
| M6 | `maskCredentials` → identity (redaction layer 2 off) | 638 / 9 | **killed** |
| M7 | `safeSessionId` → returns any non-empty string unchanged | 641 / 6 | **killed** |
| M8 | `pathRuleProposal` → returns `[]` (generator drifts from its check) | 630 / 17 | **killed** |
| M9 | `missingDependencies` → always `[]` (hook activated without its script) | 646 / 1 | **killed** |
| M10 | `revertPatch` → removes index 0 instead of the hash match | 638 / 9 | **killed** |
| M11 | `registeredHook` → credits any occupant (pre-Task-8b behaviour) | 628 / 19 | **killed** |
| M12 | `countProposals` → counts every `absent` check | 646 / 1 | **killed** |

Every one reverted (`reverted: true`, asserted by reading the file back).
Named killers for the four with the narrowest margin — these are single points
of protection, so it is worth knowing exactly which test holds each:

```
### M1 isGeneratorProducible always true  -> pass 645 / fail 2
   KILLED BY: a forged manifest entry for CLAUDE.md does not delete it — kept, with a reason
   KILLED BY: CRITICAL: isGeneratorProducible catches a forged CLAUDE.md even when its content fakes our stamp

### M2 carriesOurStamp always true  -> pass 646 / fail 1
   KILLED BY: CRITICAL: carriesOurStamp catches a forged entry for a LEGITIMATE path whose real content is the user's own

### M9 missingDependencies always empty  -> pass 646 / fail 1
   KILLED BY: FINDING 5: a settings-hook is never registered when its shared dependency is missing from disk, even though the batch plan says otherwise

### M12 countProposals counts every absent check  -> pass 646 / fail 1
   KILLED BY: apply names its own count "actions" and discloses the capability-gap count detect would report, rather than reusing "proposals" for both
```

### Batch B — five probes aimed at specific suspicions

| # | Mutation | pass / fail | Verdict |
|---|---|---|---|
| M13 | `P1.pathrules` → always `declared` | 637 / 10 | killed (10 tests, incl. LOAD-BEARING-2) |
| M20 | `detectStack` also emits script **bodies** | 646 / 1 | killed — by `detect-cli.test.mjs:403`, **not** by the three `SECRET: scriptBodies` tests (F13) |
| M21 | remove the NUL-byte binary sniff in `detect-exposure` | 646 / 1 | killed — by `:209`, **not** by `:278`, whose fixture holds no credential |
| M23 | reorder `glob.mjs`'s four steps | 346 / 69 | killed, 69× — indirectly, so F15 is legibility, not coverage |
| M24 | remove `setupTargetEvidence`'s `content == null` guard | 645 / 2 | killed — by the *missing* and *directory* tests, not by the "empty"/"binary" tests named for it (F14) |
| M22 | remove `revertPatch`'s `container` type guard | **647 / 0** | **SURVIVED** (F16) |
| M25 | add `-z` to `git ls-files` — i.e. **apply F1's fix** | **647 / 0** | **SURVIVED** |

M25 is worth reading twice. It says two things at once: the fix for F1 is safe
to land (no test depends on git's quoted output), and **no test anywhere in the
suite distinguishes quoted from unquoted `git ls-files` output.** That absence
is why F1 could exist on a branch with 647 passing tests and two clean real-repo
validations.

### What "647 passing" does and does not mean

One more thing I checked, because it bears on how much the number is worth.
`scan.test.mjs` contains roughly ten tests that `return` early after printing
`  (skipped: git init failed: …)` or
`  (skipped: junction/symlink requires elevation …)`. The comments are explicit
and honest about why ("or roughly ten nested-detection tests would report green
having asserted nothing"), and printing a reason is far better than silence.
But a bare `return` still counts as a **pass**, so there is no machine-readable
signal when one of them asserts nothing.

On this machine none of them fired — I checked, and the only skip reported in
the final run is the single legitimate `t.skip()`:

```
$ npm test 2>&1 | grep "(skipped"
﹣ a proposal with mode: 0o755 actually gets real POSIX permission bits (skipped, with a reason, on win32) # Windows has no execute-bit concept Node's stat().mode can report — chmodSync(path, 0o755) followed by stat() still reports 0o666 on this machine (confirmed empirically), so this assertion is UNOBSERVABLE here, not merely unexercised. The call-level test above pins the production line on every platform, including this one.
```

That is a model skip: it names the reason, proves the reason empirically, and
points at the test that covers the same line portably. The ten in
`scan.test.mjs` would be too, if they used `t.skip('…')` rather than
`console.log(…); return` — which costs nothing and would make `skipped N`
tell the truth on a machine without git or without elevation.

---

## 7. Tree state — every mutation reverted, confirmed

All 19 mutations were applied with a scripted string replacement, verified
against the original text, and reverted with `git checkout -- <file>`; the
harness re-read each file after restore and asserted byte equality
(`reverted: true` on every one). All fixture repositories live in the session
scratchpad, never inside the repository under review.

```
$ cd /c/Users/Dreambuilds/desktop/harness-kit
$ git diff --stat
(empty)

$ rm -rf docs/harness          # the artefact my own `detect` runs wrote
$ git status --porcelain
(empty)

$ npm test
ℹ tests 648
ℹ suites 0
ℹ pass 647
ℹ fail 0
ℹ cancelled 0
ℹ skipped 1
ℹ todo 0
ℹ duration_ms 23040.134

$ git status --porcelain
(empty)
$ git rev-parse HEAD
bea3a3c892aa32c3c5492a28c1b66ea7a8c14914
$ git rev-parse --abbrev-ref HEAD
feat/capabilities
```

Working tree clean, `HEAD` unmoved at `bea3a3c`, suite at 647 passing / 1
skipped. Note for whoever runs this next: `docs/harness/detect.json` is written
into the repository by any `detect` run pointed at it, including the ones in
this review, so a `?? docs/harness/` in `git status` after exercising the tool
is expected rather than a leftover of mine — it is also the residue noted in
§2, item 2.

---

## 8. Summary table

| # | Sev | Finding | Where |
|---|---|---|---|
| F1 | **Critical** | Non-ASCII filename → `git ls-files` C-quoting → credential scan silently skips the file, `P0.security` reports `verified`; stack also misdetected | `scripts/lib/scan.mjs` |
| F2 | Major | `P1.pathrules` answers *presence* from the scan list; on a workspace with gitignored `.claude/`, `detect` says `absent` forever while `apply` says "already satisfies" | `detect-harness.mjs`, `gap-model.mjs` |
| F3 | Major | `session-brief.mjs` has a line bound but no byte bound; over Claude Code's 10,000-char cap the handoff is replaced by a file path Claude is never told to read | `assets/scripts/session-brief.mjs` |
| F4 | Major | `detect` credits `docs/HANDOFF.md`; the installed hook only reads root `HANDOFF.md` and prints "no HANDOFF.md in this repository yet" every session | `detect-harness.mjs` vs `session-brief.mjs` |
| F5 | Major | README says "detection only … cannot yet apply anything"; `apply`/`uninstall`, their flags, and the fact that repository scripts now auto-execute are documented nowhere | `README.md` |
| F6 | Major | The two forged-manifest gates do not compose for `.claude/rules/*.md`; a forged hash deletes the user's hand-written conventions | `uninstall-lib.mjs` |
| F7 | Minor | `alreadyCanonical` vs `wasCanonical` — duplicated predicate, drifted; false "was reformatted" note on a 27-insertion/0-deletion diff | `apply.mjs` vs `uninstall-lib.mjs` |
| F8 | Minor | `hookEvents` reads both settings files; `denyRules`/`denyRuleList`/`settings` read only one — duplicate deny rules, empty evidence | `detect-harness.mjs` |
| F9 | Minor | `apply` computes exposures, nested repos and questions, and prints none of them | `apply.mjs` |
| F10 | Minor | Three entry points, three argument conventions; `uninstall` alone has no flag parsing and no unknown-flag warning | `uninstall.mjs` |
| F11 | Minor | Comment claims `Write\|Edit` covers "the tools that actually edit a file"; matcher is exact-string, so `NotebookEdit`/legacy `MultiEdit` are excluded | `propose.mjs` |
| F12 | Minor | Exposure list printed twice verbatim — 14 lines for 7 facts | `gap-model.mjs`, `report.mjs` |
| F13 | Minor | Three `SECRET: scriptBodies` tests are unfalsifiable; the real guard is one other test | `report/gap-model/propose.test.mjs` |
| F14 | Minor | Doc comment misdescribes `readIfPresent` (no empty/binary handling); the two tests named for the claim cannot fail for it | `bootstrap-target-evidence.mjs` |
| F15 | Minor | `glob.test.mjs` contains no test of `glob.mjs`; real coverage is indirect (69 tests) and lives where nobody will look | `glob.test.mjs` |
| F16 | Minor | `revertPatch`'s `container` type guard survives removal with 0 failures; the test named for it cannot fail for it | `settings-merge.mjs/.test.mjs` |

Blocking: F1. Strongly recommended in the same pass: F2, F3, F4. Everything
else: merge and file.
