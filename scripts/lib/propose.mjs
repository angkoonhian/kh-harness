import { readFileSync } from 'node:fs';
import { render, versionStamp } from './render.mjs';
import { selectProfile } from './profiles/index.mjs';
import { globToRegExp } from './glob.mjs';

const ASSETS = new URL('../../assets/', import.meta.url);
const read = rel => readFileSync(new URL(rel, ASSETS), 'utf8');

const BRIEF_PATH = '.claude/scripts/session-brief.mjs';
const LINT_TOUCHED_PATH = '.claude/scripts/lint-touched.mjs';
const VERIFY_TOUCHED_PATH = '.claude/scripts/verify-touched.mjs';
// Shared by lint-touched.mjs (PostToolUse) and verify-touched.mjs (Stop) —
// see harness-redact.mjs's own comment for why a shared chokepoint exists
// at all. Both scripts import it via a relative `./harness-redact.mjs`, so
// it must always land in the SAME directory as each of them.
const REDACT_PATH = '.claude/scripts/harness-redact.mjs';

/**
 * Evidence-based protected-path candidates for conventions that are NOT
 * universal to a language — migrations are an ORM/framework convention
 * (Prisma, Drizzle, Django, Alembic, ...), not a fact about every project
 * written in a given language. Plan 1 hardcoded `**\/migrations/**` into the
 * stack profiles and the review struck it for exactly that reason: a profile
 * asserting this is an opinion about layout it has no basis for (see
 * docs/plan-1-execution-log.md).
 *
 * Listing the known conventions HERE, instead, is not an opinion, because
 * every candidate below is filtered against the repository's actual file
 * list in `protectedPathProposal` — a candidate that matches nothing is
 * simply never proposed. Applied uniformly (not split per detected stack):
 * uniformity is safe precisely because the existence filter prunes whatever
 * is absent, and it avoids maintaining a second set of per-language guesses.
 *
 * Root-anchored and `**\/`-anchored forms are both listed deliberately, for
 * the same reason as typescript.mjs's dist/build globs (see its comment):
 * this is about OUR OWN matcher (glob.mjs's `globToRegExp`), not Claude
 * Code's. `globToRegExp` compiles `**` to `.*` with a required literal `/`
 * before the final segment, so `hasEvidence('**\/migrations/**', [...])` is
 * false for a root-level `migrations/` and the rule is never PROPOSED at
 * all — even though Claude Code's own `Edit(...)` matcher is wider (per its
 * docs, `**\/` also matches zero directory segments) and would have
 * honoured `Edit(**\/migrations/**)` against a root-level path just fine
 * once proposed. The duplication exists to satisfy OUR evidence filter, not
 * Claude Code's matcher.
 *
 * As with every candidate here, a rule is only ever PROPOSED when the path
 * is visible to `listFiles` (scan.mjs) — tracked by git, or not excluded on
 * the dependency-free fallback walk. Migration directories are typically
 * committed, so this rarely bites the way it does for build output (see
 * typescript.mjs/python.mjs), but the mechanism is the same: no evidence,
 * no proposal, by design.
 */
const PROTECTED_PATH_CANDIDATES = [
  'prisma/migrations/**',
  'src/migrations/**',
  'migrations/**',
  '**/migrations/**',
  'drizzle/**',
  'alembic/versions/**',
  // Root-anchored AND **-anchored, deliberately — same reason as this
  // file's migrations comment above and typescript.mjs's dist/build
  // comment: it is OUR `globToRegExp` that requires the literal `/`, not
  // Claude Code's matcher. `hasEvidence('**/__generated__/**', [...])` is
  // false for a root-level `__generated__/`, and likewise for
  // `**/*.generated.*` against a root-level `foo.generated.ts` (both
  // verified) — so without the root-anchored form, our evidence filter
  // never proposes a rule for either, regardless of what Claude Code
  // itself would have matched. Do not collapse this back to one form.
  '__generated__/**',
  '**/__generated__/**',
  '*.generated.*',
  '**/*.generated.*',
];

/** True if `glob` matches at least one path in `files`. */
function hasEvidence(glob, files) {
  const re = globToRegExp(glob);
  return files.some(f => re.test(f));
}

/**
 * Intersects `profile.protectedGlobs()` (the universal-per-stack candidates:
 * lockfiles, build output) with `PROTECTED_PATH_CANDIDATES` (the ORM/
 * framework conventions above), keeps only the globs with evidence in
 * `files`, and wraps each survivor as a Claude Code `Edit(...)` permission
 * pattern — the shape `.claude/settings.json`'s `permissions.deny` actually
 * takes (see settings-merge.mjs's tests). The candidate table holds RAW
 * globs and the filter matches RAW globs; wrapping happens only at the very
 * end, on survivors only, so nothing here ever has to parse a wrapped string
 * back apart.
 *
 * `Edit`, specifically — not `Read` — because the risk being guarded is
 * modification, not the agent reading context it legitimately needs.
 */
function protectedPathProposal({ stack, files }) {
  const profile = selectProfile(stack);
  const candidates = [...profile.protectedGlobs(), ...PROTECTED_PATH_CANDIDATES];
  const seen = new Set();
  const surviving = [];
  for (const glob of candidates) {
    if (seen.has(glob)) continue;
    seen.add(glob);
    if (hasEvidence(glob, files)) surviving.push(glob);
  }
  if (surviving.length === 0) return [];
  return [{
    kind: 'settings-deny', step: 11,
    globs: surviving.map(g => `Edit(${g})`),
    reason: 'deny edits to protected paths found in this repository',
  }];
}

/**
 * The shared redaction module both process-output hooks (lint-touched.mjs's
 * PostToolUse sensor and verify-touched.mjs's Stop gate) import — see
 * harness-redact.mjs's own comment for why a shared chokepoint exists at
 * all. Returned by EITHER sensorProposal or stopgateProposal's own
 * generator, independently — not only by whichever happens to run first —
 * so that satisfying just one of the two checks (the other already
 * `declared`, or installed by an earlier run) still brings this file along.
 * `buildProposals`' own dedupe (see its comment on `alreadyWritten`) is what
 * keeps it from being proposed twice when BOTH generators fire in the same
 * batch, and from being re-proposed once a prior run already recorded it in
 * the manifest.
 *
 * Review finding 7: `step` used to be whichever caller's own step number
 * (9 from the sensor, 10 from the gate) — so the SAME shared file had two
 * possible byte contents and two possible manifest `step` values
 * depending on which check happened to be absent first, and the "runbook
 * step" it claimed was wrong in whichever case didn't fire first. The
 * module belongs to neither step exclusively, so it gets a FIXED stamp
 * instead of either caller's own step — deterministic regardless of which
 * generator proposes it first. `REDACT_STEP` is still a real step number
 * (for sort ordering and the manifest's own bookkeeping), just never
 * exposed in the file's own comment as "the" step that owns it.
 */
const REDACT_STEP = 9;

function redactAssetProposal(kitVersion) {
  return {
    kind: 'file', path: REDACT_PATH, step: REDACT_STEP,
    contents: `// Generated by harness-kit ${kitVersion} (shared asset used by the PostToolUse and Stop hooks). ` +
      `Edit freely — harness-kit will report your changes rather than overwrite them.\n` +
      read('scripts/harness-redact.mjs'),
    reason: 'shared redaction module required by the PostToolUse/Stop hooks',
  };
}

/**
 * The per-edit sensor: a PostToolUse hook that lints the file an Edit/Write
 * tool just touched. Decidable only when at least one package in the
 * repository actually declares a `lint` script — `p.scripts` is a sorted
 * list of script NAMES, never bodies (see detect-stack.mjs), so this check
 * never risks echoing a credential-bearing script body. A sensor with
 * nothing to run is noise: when no package qualifies, this returns no
 * proposals at all, the same evidence-gated shape as `protectedPathProposal`
 * above, rather than proposing a hook that would always exit 0 unused.
 *
 * `matcher: 'Write|Edit'` scopes the hook to the tools that actually edit a
 * file — PostToolUse fires for every tool otherwise, and the hook has
 * nothing to say about a Bash or Read call.
 */
function sensorProposal({ kitVersion, stack }) {
  if (!stack.packages.some(p => p.scripts?.includes('lint'))) return [];
  return [{
    kind: 'file', path: LINT_TOUCHED_PATH, step: 9,
    contents: read('scripts/lint-touched.mjs').replace(
      '#!/usr/bin/env node\n',
      `#!/usr/bin/env node\n${versionStamp(kitVersion, 9, '//')}\n`,
    ),
    reason: 'no PostToolUse hook registered',
  }, redactAssetProposal(kitVersion), {
    kind: 'settings-hook', event: 'PostToolUse', step: 9,
    matcher: 'Write|Edit',
    entry: { type: 'command', command: `node ${LINT_TOUCHED_PATH}` },
    // Review finding 5: a hook must never be ACTIVATED (registered in
    // settings.json) unless the script it runs, and everything that
    // script imports, is actually present on disk — never merely
    // "was in this batch's plan". See applySettingsHookProposal in
    // apply-lib.mjs, which checks this against the real filesystem AFTER
    // the write phase, not against this list alone.
    requiresFiles: [LINT_TOUCHED_PATH, REDACT_PATH],
    reason: 'no PostToolUse hook registered in .claude/settings.json',
  }];
}

/**
 * The Stop gate: runs the repository's own verification command (its
 * `typecheck` script, falling back to `test`) when a turn ends, and blocks
 * once per distinct failure — see verify-touched.mjs's own header comment
 * for the full rationale.
 *
 * Decidable only when the ROOT package (`dir === '.'`) itself declares a
 * `typecheck` or `test` script — deliberately NOT "any package", unlike
 * `sensorProposal`'s looser gate. The two are not equivalent: lint-touched.mjs
 * resolves the OWNING package for whichever file was edited (see its
 * `findAncestorWith`), so a lint script declared anywhere in the tree is
 * real evidence that the sensor will find and run something. verify-touched.mjs
 * has no file to anchor on — a Stop event fires once per turn, not once per
 * file — so it only ever reads CLAUDE_PROJECT_DIR's own package.json. A
 * monorepo where only `packages/api` declares `typecheck` would otherwise
 * get a gate that reports `declared` and a hook that silently finds nothing
 * at root and exits 0 forever: the capability installs, reports as
 * present, and never fires — the same false-assurance shape a loose deny-
 * rule evidence filter already cost a round on. Running every package's
 * own command instead of widening the gate is not an option either: a
 * `Stop` hook is not tied to a file, so there is no single owning package
 * to resolve, and running N packages' worth of typecheck/test in sequence
 * is both ambiguous (which one explains the block?) and multiplies the
 * cost `reason` is supposed to be disclosing truthfully. If a monorepo has
 * no single repo-level verification command, the honest answer is not to
 * propose one.
 */
function stopgateProposal({ kitVersion, stack }) {
  const rootPkg = stack.packages.find(p => p.dir === '.');
  const hasTypecheck = rootPkg?.scripts?.includes('typecheck') ?? false;
  const hasTest = rootPkg?.scripts?.includes('test') ?? false;
  if (!hasTypecheck && !hasTest) return [];
  // Review's cost measurement: on a real 40-module TypeScript repo this
  // added ~2.8s per 3-edit turn and zero bytes when green — proportionate
  // there. But a whole-program `tsc --noEmit` (no `--incremental`, which
  // this deliberately never appends — see the comment on `reason` below)
  // scales with REPOSITORY size, not edit size: 10-30s per turn is the
  // measured range at ~1000 modules, and `test` as a fallback means the
  // whole suite, not just what changed. `reason` states this plainly so a
  // user on a large codebase accepts it knowingly rather than discovering
  // it as "turns got slower" with no visible cause.
  const costNote = 'cost scales with the size of the repository, not the size of the edit — a large codebase may see 10-30s added per turn';
  const reason = hasTypecheck
    ? `no Stop hook registered — runs the repository's typecheck script, bounded at 120s, at the end of every turn (${costNote})`
    : `no Stop hook registered — no typecheck script was found, so this falls back to the full test script, bounded at 120s, at the end of every turn (${costNote})`;
  return [{
    kind: 'file', path: VERIFY_TOUCHED_PATH, step: 10,
    contents: read('scripts/verify-touched.mjs').replace(
      '#!/usr/bin/env node\n',
      `#!/usr/bin/env node\n${versionStamp(kitVersion, 10, '//')}\n`,
    ),
    reason: 'no Stop hook registered',
  }, redactAssetProposal(kitVersion), {
    kind: 'settings-hook', event: 'Stop', step: 10,
    entry: { type: 'command', command: `node ${VERIFY_TOUCHED_PATH}` },
    // See the matching comment on P2.sensor's own settings-hook proposal —
    // this is review finding 5's fix, applied identically here.
    requiresFiles: [VERIFY_TOUCHED_PATH, REDACT_PATH],
    reason,
  }];
}

const BOOTSTRAP_PATH = 'scripts/bootstrap.sh';
const BOOTSTRAP_STEP = 5;

/**
 * Deterministic, lockfile-gated install forms ONLY — used verbatim. A
 * bootstrap script exists so a clean checkout reaches a working state
 * REPRODUCIBLY; the plain forms (`npm install`, `pnpm install`, ...) can
 * silently rewrite the lockfile on a clean checkout, which is exactly the
 * kind of surprise a script that "will be run and trusted" must not carry.
 *
 * `pip` is deliberately NOT in this table. `requirements.txt` has no
 * frozen/plain distinction the way a real lockfile does (there is no
 * `pip install --frozen` form), so there is no verbatim reproducible
 * command to use for it — inventing one would be exactly the guessed step
 * this generator exists to refuse. A pip-only stack therefore derives no
 * install command at all (see `installCommand` below) and gets no bootstrap
 * proposal, same as a stack with no package manager detected.
 */
const INSTALL_COMMANDS = {
  npm: { lockfile: 'package-lock.json', frozen: 'npm ci', plain: 'npm install' },
  pnpm: { lockfile: 'pnpm-lock.yaml', frozen: 'pnpm install --frozen-lockfile', plain: 'pnpm install' },
  yarn: { lockfile: 'yarn.lock', frozen: 'yarn install --immutable', plain: 'yarn install' },
  bun: { lockfile: 'bun.lockb', frozen: 'bun install --frozen-lockfile', plain: 'bun install' },
  poetry: { lockfile: 'poetry.lock', frozen: 'poetry install --sync', plain: 'poetry install' },
  uv: { lockfile: 'uv.lock', frozen: 'uv sync --frozen', plain: 'uv sync' },
};

/**
 * Returns `{ command, fallback }`, or `null` when no install command can be
 * derived at all (an undetected package manager, or one with no verbatim
 * reproducible form — see the table above).
 *
 * The lockfile's PRESENCE in `files` — not `stack.packageManager` alone —
 * is what licenses the deterministic form. The two happen to move together
 * in real detection (detect-stack.mjs only ever sets `packageManager` when
 * it already found the matching lockfile), but this function does not lean
 * on that coincidence: it re-checks `files` independently, so a caller that
 * (like a test fixture, or a future detector) sets `packageManager` without
 * the lockfile gets the honest fallback rather than a command the evidence
 * does not actually support.
 */
function installCommand(packageManager, files) {
  const spec = INSTALL_COMMANDS[packageManager];
  if (!spec) return null;
  if (files.includes(spec.lockfile)) return { command: spec.frozen, fallback: false, lockfile: spec.lockfile };
  return { command: spec.plain, fallback: true, lockfile: spec.lockfile };
}

/**
 * Build/test lines, derived from declared script NAMES only (never bodies —
 * see detect-stack.mjs), and only from the ROOT package (`dir === '.'`).
 * Same reasoning as `stopgateProposal`'s own root-only gate immediately
 * above: a bootstrap script is not tied to any one edited file, so there is
 * no per-file owning package to resolve the way lint-touched.mjs resolves
 * one — the root package is the only honest anchor for "the repository's
 * own" build/test step. A monorepo where only a NESTED package declares
 * `build`/`test` gets no line for either, same false-assurance concern the
 * Stop gate's own monorepo test already covers for a different hook.
 *
 * Deliberately does NOT consider `lint`: the brief's own proven-step list is
 * install (from the lockfile) and build/test (from script names) — nothing
 * else. `selectProfile(stack).commands(pkg)` is reused here rather than
 * reimplemented, so the exact `<pm> <script>` shape (bare for pnpm/yarn,
 * `run` for npm/bun) stays governed by ONE already-tested place
 * (profiles/typescript.mjs), not a second copy that could drift from it.
 */
function bootstrapScriptLines(stack) {
  const rootPkg = stack.packages.find(p => p.dir === '.');
  if (!rootPkg) return [];
  const commands = selectProfile(stack).commands(rootPkg);
  return [commands.build, commands.test].filter(Boolean);
}

/**
 * The bootstrap script: takes a clean checkout to a working state, written
 * from DETECTED facts only. Decidability is the whole point — see the
 * brief's own framing, echoed in gap-model.mjs's comment on `P1.bootstrap`:
 * a script with guessed steps is worse than none, because it will be run
 * and trusted. This generator's own gate below (no install command
 * derivable => no proposal) is a defensive SECOND check, independent of
 * the check-level `decidable` flag that `buildProposals` already enforces
 * centrally — belt-and-suspenders for exactly the case the brief names:
 * a generic stack, or no install command derivable at all.
 */
function bootstrapProposal({ kitVersion, stack, files }) {
  const install = installCommand(stack.packageManager, files);
  if (!install) return [];

  const lines = [];
  if (install.fallback) {
    lines.push(`# No ${install.lockfile} found — using the plain install form so this script never silently rewrites a lockfile that does not exist yet. Commit the lockfile it creates, then re-run harness-kit for the reproducible form.`);
  }
  lines.push(install.command);
  lines.push(...bootstrapScriptLines(stack));

  return [{
    kind: 'file', path: BOOTSTRAP_PATH, step: BOOTSTRAP_STEP,
    contents: render(read('templates/bootstrap.sh.tmpl'), {
      stamp: versionStamp(kitVersion, BOOTSTRAP_STEP, '#'),
      steps: lines.join('\n'),
    }),
    reason: 'no bootstrap script found',
  }];
}

/** Generators receive the full detection context and return proposals.
 * { kitVersion, harness, root, stack, checks, files } are available to all
 * generators. A generator yields nothing by returning an empty array or not
 * being registered. */
const GENERATORS = {
  'P4.handoff': ({ kitVersion }) => ([{
    kind: 'file', path: 'HANDOFF.md', step: 16,
    contents: render(read('templates/HANDOFF.md.tmpl'), { stamp: versionStamp(kitVersion, 16, '<!--') + ' -->' }),
    reason: 'no handoff file found',
  }]),
  'P4.sessionbrief': ({ kitVersion }) => [{
    kind: 'file', path: BRIEF_PATH, step: 16,
    contents: read('scripts/session-brief.mjs').replace(
      '#!/usr/bin/env node\n',
      `#!/usr/bin/env node\n${versionStamp(kitVersion, 16, '//')}\n`,
    ),
    reason: 'no SessionStart brief hook registered',
  }, {
    kind: 'settings-hook', event: 'SessionStart', step: 16,
    entry: { type: 'command', command: `node ${BRIEF_PATH}` },
    // session-brief.mjs has no shared dependency the way the other two
    // hooks do, but declaring this anyway means a write failure for its
    // OWN file (not just a missing shared module) is caught the same way,
    // by the same generic check — one rule, not two.
    requiresFiles: [BRIEF_PATH],
    reason: 'no SessionStart hook registered in .claude/settings.json',
  }],
  'P2.protected': protectedPathProposal,
  'P2.sensor': sensorProposal,
  'P2.stopgate': stopgateProposal,
  'P1.bootstrap': bootstrapProposal,
};

/**
 * `generators` lets a caller extend or override the production table for a
 * single call — this exists so tests can inject a probe generator (e.g. to
 * verify the full context is passed through) without that probe living in
 * the production table. A generator registered there is a live proposal
 * path: `TEST.contextcheck` used to live here and proposed `.context-verified`,
 * a path `assertAllowed` refuses — a crash waiting for a real check to reuse
 * that id, not just a dead test fixture.
 *
 * `files` has no default. A caller that forgets it would otherwise get
 * "no evidence, therefore no proposal" from `P2.protected` — silently, with
 * no error — which is exactly the failure shape this task's evidence filter
 * exists to eliminate, recreated one level up. Every caller must pass it
 * explicitly, including tests (see `args()` in propose.test.mjs); forgetting
 * it is now a loud `TypeError` inside `hasEvidence`, not a quiet empty
 * result that looks like "nothing protected here."
 *
 * `alreadyWritten` starts from the manifest (files a PRIOR run already
 * installed) but is also updated as THIS run's own proposals accumulate —
 * not only seeded once. Without that, `P2.sensor` and `P2.stopgate` (which
 * each independently propose the shared `harness-redact.mjs`, see
 * `redactAssetProposal`) would both add it to `out` whenever both checks
 * are absent in the same batch, writing the identical file twice. Checking
 * the growing set, not only the manifest snapshot, is what keeps a shared
 * asset proposed exactly once per run regardless of how many generators
 * want it.
 */
export function buildProposals({ checks, manifest, kitVersion, harness, root, stack, files, generators = {} }) {
  const registry = { ...GENERATORS, ...generators };
  const alreadyWritten = new Set((manifest?.files ?? []).map(f => f.path));
  const out = [];
  for (const c of checks) {
    // Both gates, read from the check — never re-derived here.
    if (c.state !== 'absent' || c.decidable === false) continue;
    const gen = registry[c.id];
    if (!gen) continue;
    for (const p of gen({ kitVersion, harness, root, stack, checks, files })) {
      if (p.kind === 'file' && alreadyWritten.has(p.path)) continue;
      out.push({ ...p, checkId: c.id });
      if (p.kind === 'file') alreadyWritten.add(p.path);
    }
  }
  return out;
}

export { BRIEF_PATH, LINT_TOUCHED_PATH, VERIFY_TOUCHED_PATH, REDACT_PATH, BOOTSTRAP_PATH };
