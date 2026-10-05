# Reading a detect report

Every phase starts from `docs/harness/detect.json`. This reference covers
running detection and reading what it produces — never guess at report shape
from memory; the shapes below are checked against the source, named per
section.

## Running it

```
node scripts/detect.mjs <path-to-repo>
node scripts/detect.mjs <path-to-repo> --json
```

Writes exactly one file, `docs/harness/detect.json`, and changes nothing
else in the target repository. Without `--json` it prints a human summary to
stdout; with `--json` it prints the full report instead, so a caller that
wants to parse it reliably should always pass `--json`.

*Verified against `scripts/detect.mjs` and `scripts/lib/cli.mjs`'s
`DETECT_USAGE` text, at package.json version 0.1.0 (commit `cca4d8f`).*

If `docs/harness/detect.json` does not exist yet, run this before reading
any phase reference — see the first-run rule in `SKILL.md`.

## The three report sections

*Verified against `scripts/lib/report.mjs` (`buildReport`, `renderSummary`,
`exposureSectionLines`) and `scripts/lib/gap-model.mjs` (`buildGaps`,
`countProposals`), at the same version.*

1. **Checks** (`report.checks`) — one entry per runbook step this version
   covers. Each entry carries:
   - `state` — one of `verified`, `declared`, `absent`, `failing`, `n/a`
     (`gap-model.mjs`'s `STATES`).
   - `evidence` — the exact paths or facts the check actually read. A check
     never claims more than what it read; if evidence is thin, the state
     reflects that rather than rounding up.
   - `proposal` — present only on a check that is `absent` AND decidable
     (see below): something `apply` can write once the user confirms it.
   - `question` — present only on a check that is `absent` AND NOT
     decidable: something detection could not derive and will not guess at.
   - `advice` — independent of the proposal/question split: a gap that is
     fully known but that this tool deliberately never writes itself (for
     example, a missing `lint` script — adding one means editing a
     package's own manifest, which is outside what `apply` will touch).
2. **Proposals** — the number `renderSummary` prints is `countProposals`:
   how many CHECKS carry a `proposal`. This is a count of capability gaps,
   not of individual file writes. `apply` may turn one gap into several
   writes, so do not expect this number to match anything `apply` reports.
3. **Advice and "Could not derive"** — printed as two further sections,
   after the phase-by-phase check listing and the Exposures section:
   every check's `advice`, and the questions collected in
   `report.couldNotDerive`. Read a `couldNotDerive` entry as something to
   put to the user before applying, not a gap you can silently skip.

## `n/a` vs. `absent` + not decidable

Both look like "nothing to propose here." They are not the same claim:

- **`state: 'n/a'`** — the capability genuinely does not apply to this
  repository or this profile (a language server is machine state, not repo
  state; a step a stack profile excludes outright). Nothing was left
  undecided.
- **`state: 'absent'`, `decidable: false`** — the capability DOES apply, but
  detection could not derive a concrete proposal from the evidence it has.
  This is what carries a `question` instead of a `proposal`.
  `gap-model.mjs`'s `buildGaps` enforces, centrally, that only a decidable
  `absent` check may ever carry a `proposal` — no individual check can
  bypass that, by construction.

Treat a `question` the same way you would treat a gate: something to put to
the user, not a detail to infer and move past.

## `file-unreadable`: a file that was never examined, not one found clean

*Verified against `scripts/lib/detect-exposure.mjs` (`UNREADABLE_KIND`,
`splitExposures`, `partitionProminent`) and `gap-model.mjs`'s `P0.security`
check, at the same version.*

`detect.json`'s `exposures` array can hold a finding of kind
`file-unreadable` — a file the credential sweep could not READ (a
permission error, a file removed mid-scan, and similar). This is distinct
from the skips the sweep makes ON PURPOSE (binaries, build output,
anything over 512 KB) — those are never reported this way, because skipping
them is the design, not a failure. A `file-unreadable` finding means that
one file was NEVER examined for credentials: it is not evidence that the
file is clean, and it is not evidence that it is not.

As implemented today, `P0.security` cannot report `verified` while any
`file-unreadable` finding exists — the check treats an unreadable file the
same as a real credential finding and reports `failing` instead, naming it
under "Not examined" in the rendered summary. So a `verified` P0.security
line, on its own, is a true claim about this version's behaviour — but
read the `exposures` list yourself before relying on it rather than
trusting the state label alone. The label is a summary; the list is the
evidence it was built from, and this reference exists because a prior,
unverified claim about a different report ended up believed in three places
before anyone checked it against the code.
