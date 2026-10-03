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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * `bun`'s two entries are not an either/or guess: Bun wrote `bun.lockb`
 * (binary) through 1.1, and writes `bun.lock` (text) by default from 1.2
 * onward — a real review caught `bun.lockb`-only detection missing every
 * current-Bun repository entirely (verified against Bun 1.4.2). Both are
 * genuine lockfiles for the SAME command; `lockfiles` is therefore an array
 * everywhere in this table, even where (today) only one name is known, so a
 * second name never again requires widening a scalar field into an array
 * under review pressure.
 *
 * `yarn`'s `frozen` is deliberately `null`, not a string: Yarn Classic
 * (1.x) and Yarn Berry (2+) take DIFFERENT flags for the same guarantee —
 * `--frozen-lockfile` vs `--immutable` — and Classic silently IGNORES
 * `--immutable` and rewrites the lockfile anyway on drift (verified against
 * Yarn 1.22.5: the exact failure the flag exists to prevent, while `npm ci`
 * correctly refused on the same drift). There is no single verbatim string
 * for yarn; `yarnFrozenCommand` below picks one from the lockfile's own
 * content, which is real evidence the same way a lockfile's mere presence
 * is.
 *
 * `poetry`'s `frozen` and `plain` are now identical: `--sync` is deprecated
 * (slated for removal, confirmed against Poetry 2.5.1) and was never
 * load-bearing for THIS script's guarantee in the first place — `--sync`
 * only prunes packages that are installed but absent from the lockfile,
 * and a clean checkout has nothing installed to prune. Plain `poetry
 * install` already respects (and fails loudly on a stale) lockfile, which
 * is the actual guarantee a bootstrap needs. The general rule this
 * generalizes: `--frozen-lockfile`/`--immutable` make the install FAIL on
 * a stale lockfile — a real guarantee — while `--sync` only prunes
 * unrelated extras, which is moot here by construction.
 */
export const INSTALL_COMMANDS = {
  npm: { lockfiles: ['package-lock.json'], frozen: 'npm ci', plain: 'npm install' },
  pnpm: { lockfiles: ['pnpm-lock.yaml'], frozen: 'pnpm install --frozen-lockfile', plain: 'pnpm install' },
  yarn: { lockfiles: ['yarn.lock'], frozen: null, plain: 'yarn install' },
  bun: { lockfiles: ['bun.lock', 'bun.lockb'], frozen: 'bun install --frozen-lockfile', plain: 'bun install' },
  poetry: { lockfiles: ['poetry.lock'], frozen: 'poetry install', plain: 'poetry install' },
  uv: { lockfiles: ['uv.lock'], frozen: 'uv sync --frozen', plain: 'uv sync' },
  pip: { lockfiles: ['requirements.txt'], frozen: 'pip install -r requirements.txt', plain: null },
};

/**
 * Yarn Berry lockfiles open with a `__metadata:` block; Yarn Classic (v1)
 * lockfiles open with the comment `# yarn lockfile v1`. Reading the header
 * is evidence, exactly like a lockfile's mere presence is — not a guess.
 * Returns `null` (never a guess) when `root` is not given or the lockfile
 * cannot be read, so the caller falls through to the honest plain form
 * instead of picking a flag that might be wrong for the version in front
 * of it.
 */
function yarnFrozenCommand(root, lockRelPath) {
  if (!root) return null;
  let content;
  try {
    content = readFileSync(join(root, lockRelPath), 'utf8');
  } catch {
    return null;
  }
  return /^__metadata:/m.test(content) ? 'yarn install --immutable' : 'yarn install --frozen-lockfile';
}

/**
 * Returns `{ command, fallback, lockfiles, matchedLockfile }`, or `null`
 * when no install command can be derived at all — an undetected package
 * manager, or one (pip, with no requirements.txt) whose table entry has no
 * plain form to fall back to.
 *
 * A lockfile's PRESENCE in `files` — not `packageManager` alone — is what
 * licenses the deterministic form. The two happen to move together in real
 * detection (detect-stack.mjs only ever sets `packageManager` when it
 * already found a matching lockfile), but this function does not lean on
 * that coincidence: it re-checks `files` independently, so a caller that
 * (like a test fixture, or a future detector) sets `packageManager` without
 * the lockfile gets the honest answer rather than a command the evidence
 * does not actually support.
 *
 * `root`, when given, is used ONLY to read a yarn.lock's own header (see
 * `yarnFrozenCommand`) — every other package manager's frozen form is a
 * fixed string, needing no file content at all.
 *
 * This is the SINGLE source for "what installs this project" — no profile's
 * `commands()` carries its own `install` field (removed: it had no
 * production reader and quietly disagreed with this table). Do not add one
 * back in a profile; extend the table above instead.
 */
export function installCommand(packageManager, files, root) {
  const spec = INSTALL_COMMANDS[packageManager];
  if (!spec) return null;

  const matchedLockfile = spec.lockfiles.find(l => files.includes(l));
  if (matchedLockfile) {
    const command = packageManager === 'yarn' ? yarnFrozenCommand(root, matchedLockfile) : spec.frozen;
    if (command) return { command, fallback: false, lockfiles: spec.lockfiles, matchedLockfile };
    // yarn.lock is present but unreadable (or `root` was not given) — no
    // version evidence either way, so this falls through to the plain form
    // below rather than guessing which flag the installed Yarn understands.
  }

  if (spec.plain == null) return null; // no lockfile, and no plain form to guess (pip) — stay undecidable
  return { command: spec.plain, fallback: true, lockfiles: spec.lockfiles, matchedLockfile: null };
}
