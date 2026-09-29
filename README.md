# harness-kit

Inventories an existing repository against the harness runbook and proposes
only what is missing. Additive by design: it never overwrites, never deletes,
and never rewrites a file you authored.

## Status

Plan 1 of 3 — detection only. `harness-kit detect` reports gaps; it cannot yet
apply anything.

## Usage

    node scripts/detect.mjs <path-to-repo> [--verify] [--json]

Writes `docs/harness/detect.json` in the target repository and prints a
phase-by-phase summary.

Without `--verify`, nothing in the target repository is executed. `--verify`
runs the build, test, lint and typecheck commands it discovered, to turn claims
into evidence. There is no interactive confirmation gate in this version: the
flag itself is the consent. `install` is never run, because it mutates the tree.

## Development

    npm test
