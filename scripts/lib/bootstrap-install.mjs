// scripts/lib/bootstrap-install.mjs
//
// Shared by gap-model.mjs's P1.bootstrap CHECK and propose.mjs's bootstrap
// GENERATOR, so the two can never independently drift on what counts as
// "an install command is derivable". They used to: gap-model.mjs decided
// `absent` + a proposal from `harness.bootstrap` being falsy alone, never
// looking at the stack or the files at all, while propose.mjs's generator
// correctly looked at the real evidence (stack.packageManager AND the
// lockfile's presence in `files`) and produced nothing when that evidence
// was missing. A pyproject-only Python repository (no requirements.txt, no
// poetry.lock/uv.lock) fell into the gap between the two: detect advertised
// "create scripts/bootstrap.sh from template", apply silently wrote
// nothing. A check that reasons independently about what its own generator
// will do is a defect waiting to recur the next time either side changes —
// so there is exactly ONE place this decision is made, imported by both.
//
// Deterministic, lockfile-gated install forms ONLY — used verbatim. A
// bootstrap script exists so a clean checkout reaches a working state
// REPRODUCIBLY; the plain forms (`npm install`, `pnpm install`, ...) can
// silently rewrite the lockfile on a clean checkout, which is exactly the
// kind of surprise a script that "will be run and trusted" must not carry.
//
// `pip` IS included, but it is not a frozen/plain PAIR the way the other
// six are — `plain: null` marks that there is no `pip install --frozen`
// form and no reasonable plain guess either (`pip install -e .` from a
// bare pyproject.toml would be a guess about library-vs-application
// intent). Without requirements.txt there is no evidence for ANY pip
// install form, so `plain: null` here means "stay undecidable", not
// "fall back".
export const INSTALL_COMMANDS = {
  npm: { lockfile: 'package-lock.json', frozen: 'npm ci', plain: 'npm install' },
  pnpm: { lockfile: 'pnpm-lock.yaml', frozen: 'pnpm install --frozen-lockfile', plain: 'pnpm install' },
  yarn: { lockfile: 'yarn.lock', frozen: 'yarn install --immutable', plain: 'yarn install' },
  bun: { lockfile: 'bun.lockb', frozen: 'bun install --frozen-lockfile', plain: 'bun install' },
  poetry: { lockfile: 'poetry.lock', frozen: 'poetry install --sync', plain: 'poetry install' },
  uv: { lockfile: 'uv.lock', frozen: 'uv sync --frozen', plain: 'uv sync' },
  pip: { lockfile: 'requirements.txt', frozen: 'pip install -r requirements.txt', plain: null },
};

/**
 * Returns `{ command, fallback, lockfile }`, or `null` when no install
 * command can be derived at all — an undetected package manager, or one
 * (pip, with no requirements.txt) whose table entry has no plain form to
 * fall back to.
 *
 * The lockfile's PRESENCE in `files` — not `packageManager` alone — is what
 * licenses the deterministic form. The two happen to move together in real
 * detection (detect-stack.mjs only ever sets `packageManager` when it
 * already found the matching lockfile), but this function does not lean on
 * that coincidence: it re-checks `files` independently, so a caller that
 * (like a test fixture, or a future detector) sets `packageManager` without
 * the lockfile gets the honest answer rather than a command the evidence
 * does not actually support.
 */
export function installCommand(packageManager, files) {
  const spec = INSTALL_COMMANDS[packageManager];
  if (!spec) return null;
  if (files.includes(spec.lockfile)) return { command: spec.frozen, fallback: false, lockfile: spec.lockfile };
  if (spec.plain == null) return null; // no lockfile, and no plain form to guess (pip) — stay undecidable
  return { command: spec.plain, fallback: true, lockfile: spec.lockfile };
}
