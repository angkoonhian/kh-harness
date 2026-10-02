import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { readIfPresent } from './scan.mjs';
import { installCommand } from './bootstrap-install.mjs';
import { hasLintScript } from './sensor-evidence.mjs';
import { rootVerifyScript } from './stopgate-evidence.mjs';
import { protectedPathCandidates } from './protected-evidence.mjs';
import { pathRuleTargets } from './pathrules-evidence.mjs';
import { setupTargetEvidence } from './bootstrap-target-evidence.mjs';
import { splitExposures, collapsedExposureNote } from './detect-exposure.mjs';
// Task 8b: the only three facts gap-model.mjs needs from propose.mjs — the
// exact resolved script path EACH hook generator registers, so a check can
// ask "is OURS here" instead of "is anything here". Importing the constant,
// not re-deriving it, is the same discipline as every other shared-evidence
// module in this file (bootstrap-install.mjs, sensor-evidence.mjs, ...):
// one source of truth, so the check and the generator cannot drift apart.
// propose.mjs does not import gap-model.mjs (or anything that does), so this
// is a one-directional import, not a cycle.
import { LINT_TOUCHED_PATH, VERIFY_TOUCHED_PATH, BRIEF_PATH } from './propose.mjs';

export const STATES = ['absent', 'declared', 'verified', 'failing', 'n/a'];

/**
 * Task 9b, finding 7: on one unchanged repository, `detect` reported
 * "7 proposals" and `apply` reported "10 proposals" for the very same run —
 * both internally consistent (detect counts CAPABILITY GAPS with an
 * actionable next step; apply counts the individual file WRITES and
 * settings PATCHES needed to close them — one gap like P2.sensor can
 * expand into three of those), but sharing the word "proposals" invites a
 * reader to diff two numbers that were never meant to be comparable.
 *
 * This is the one place that counts capability gaps, so report.mjs's
 * renderSummary and apply.mjs both read the SAME count from it rather than
 * two independent `.filter(...)` calls that could silently drift apart —
 * and apply.mjs names its own, larger number differently ("actions"), so
 * neither count is wrong and the relationship between them is explicit
 * instead of implied by a shared noun.
 */
export function countProposals(checks) {
  return checks.filter(c => c.proposal).length;
}

const MAX_INSTRUCTION_LINES = 150;

/**
 * P2.scripts advice: evidence-gated command derivation for the one capability
 * this kit deliberately reports but never applies (see this file's own
 * comment on the `P2.scripts` check, below, for why).
 *
 * Ruling (coordinator, Task 7): advice must not invent a command. A missing
 * `lint` or `typecheck` command gets a concrete derived command ONLY where a
 * config file in the PACKAGE'S OWN directory proves the tool is already in
 * use. The evidence consulted must come from the package's OWN ecosystem —
 * coordinator finding 1 caught `typecheckAdvice` consulting ONLY
 * `tsconfig.json`, so a Python package was told "no tsconfig.json was
 * found, so the command cannot be derived" — citing the absence of a
 * TypeScript artefact as the reason a Python project has no typecheck
 * command is a confidently WRONG sentence, not merely an unhelpful one.
 * `isJsPackage`, below, gates every check by the package's own
 * `manifestPath` (a real detected fact, never a guess) so each ecosystem is
 * only ever asked about its own tools:
 *   JS/TS (manifestPath ends in package.json):
 *     lint:      .eslintrc(.json|.js|.cjs|.yaml|.yml) or
 *                eslint.config.(js|mjs|cjs|ts) -> eslint .
 *     typecheck: tsconfig.json in the package's own directory OR at the
 *                repository root -> tsc --noEmit
 *   Python (anything else — pyproject.toml, requirements.txt):
 *     lint:      ruff.toml/.ruff.toml, or a [tool.ruff] table in
 *                pyproject.toml -> ruff check .
 *     typecheck: mypy.ini, a [tool.mypy] table in pyproject.toml, or a
 *                [mypy] section in setup.cfg -> mypy .
 *                [tool.pyright] in pyproject.toml, or pyrightconfig.json
 *                -> pyright
 * Where none of a package's OWN ecosystem's config files is found, the
 * advice names only the missing capability and says the command cannot be
 * derived — never a fabricated command (the brief's literal wording, "the
 * exact lines to add", would otherwise mean inventing `"lint": "eslint ."`
 * for a project that might not run ESLint at all), and never citing a
 * foreign ecosystem's missing artefact as the reason.
 *
 * Deliberately scoped to the package's OWN directory, not a shared root
 * config: a monorepo's root-level eslint.config.js might cover every
 * package, but crediting a NESTED package with a tool its own directory
 * shows no evidence of would be the same shape of guess this function
 * exists to refuse — under-deriving (asking the user to confirm something
 * real evidence would have proven) is the safe failure mode, not over-
 * claiming.
 *
 * Coordinator finding 2: `package.json` has a real `scripts` table, so
 * naming it as where a JS/TS line belongs is correct — but `pyproject.toml`
 * has no equivalent standard ( `[tool.poetry.scripts]` is console entry
 * points, `[tool.pdm.scripts]` is PDM-specific, neither is "a lint script").
 * So a JS/TS line still names `pkg.manifestPath` as where to add it; a
 * Python line names ONLY the derived command — the command is what
 * detection proved, the file is a guess, and this project does not ship
 * guesses.
 *
 * Coordinator finding (round 2): `PY_COMMAND_HOME`'s explanation of WHERE
 * to record a Python command used to repeat verbatim on every derived
 * Python line — eight copies of the same paragraph on a four-package repo,
 * which is how a report teaches a reader to skim past it. `lintAdvice`/
 * `typecheckAdvice` now return `{ text, pyDerived }` instead of a bare
 * string, carrying no explanation inline; the `P2.scripts` check below
 * appends `PY_COMMAND_HOME` exactly ONCE, only when at least one line in
 * THIS check's own advice actually derived a Python command (`pyDerived`),
 * never when every Python line was a "cannot be derived" fallback with no
 * command to record anywhere.
 */
const ESLINT_CONFIG_NAMES = [
  '.eslintrc', '.eslintrc.json', '.eslintrc.js', '.eslintrc.cjs', '.eslintrc.yaml', '.eslintrc.yml',
  'eslint.config.js', 'eslint.config.mjs', 'eslint.config.cjs', 'eslint.config.ts',
];
const RUFF_CONFIG_NAMES = ['ruff.toml', '.ruff.toml'];
const RUFF_TABLE_RE = /^\[tool\.ruff(\.[\w-]+)?\]/m;
const MYPY_TABLE_RE = /^\[tool\.mypy\]/m;
const MYPY_SETUP_CFG_RE = /^\[mypy\]/m;
const PYRIGHT_TABLE_RE = /^\[tool\.pyright\]/m;

const PY_COMMAND_HOME = 'a Python project has no standard script table for lint/typecheck commands — record them in CLAUDE.md, a Makefile, a justfile, or wherever this project already keeps such commands';

function atPkgDir(dir, name) { return dir === '.' ? name : `${dir}/${name}`; }
function hasAnyAt(files, dir, names) { return names.some(n => files.includes(atPkgDir(dir, n))); }

/** A package is JS/TS precisely when detect-stack.mjs gave it a package.json
 * manifest — the only other manifests it ever produces are pyproject.toml
 * and requirements.txt (both Python). A real detected fact, not a guess. */
function isJsPackage(pkg) { return pkg.manifestPath === 'package.json' || pkg.manifestPath.endsWith('/package.json'); }

/** `files` alone cannot show a TABLE inside a file — pyproject.toml's own
 * content must be read to tell a `[tool.ruff]`/`[tool.mypy]`/`[tool.pyright]`
 * project from any other pyproject.toml. `root` is the only thing in this
 * check's context that makes that possible (same reason bootstrap-
 * install.mjs's `yarnFrozenCommand` reads a yarn.lock's own header instead
 * of trusting presence alone); when `root` is not given, this stays
 * honestly `false` rather than guessing. */
function hasPyprojectTable(root, dir, re) {
  if (!root) return false;
  const content = readIfPresent(root, atPkgDir(dir, 'pyproject.toml'));
  return content != null && re.test(content);
}

function hasRuffConfig(files, root, dir) {
  return hasAnyAt(files, dir, RUFF_CONFIG_NAMES) || hasPyprojectTable(root, dir, RUFF_TABLE_RE);
}

function hasMypyConfig(files, root, dir) {
  if (hasAnyAt(files, dir, ['mypy.ini'])) return true;
  if (hasPyprojectTable(root, dir, MYPY_TABLE_RE)) return true;
  const setupCfg = root ? readIfPresent(root, atPkgDir(dir, 'setup.cfg')) : null;
  return setupCfg != null && MYPY_SETUP_CFG_RE.test(setupCfg);
}

function hasPyrightConfig(files, root, dir) {
  return hasAnyAt(files, dir, ['pyrightconfig.json']) || hasPyprojectTable(root, dir, PYRIGHT_TABLE_RE);
}

function lintAdvice(pkg, files, root) {
  if (isJsPackage(pkg)) {
    if (hasAnyAt(files, pkg.dir, ESLINT_CONFIG_NAMES)) {
      return { text: `${pkg.name}: add "lint": "eslint ." to ${pkg.manifestPath} — derived from the ESLint config found in this repository`, pyDerived: false };
    }
    return { text: `${pkg.name}: ${pkg.manifestPath} is missing a "lint" script — no ESLint config was found, so the command cannot be derived`, pyDerived: false };
  }
  if (hasRuffConfig(files, root, pkg.dir)) {
    return { text: `${pkg.name}: lint -> ruff check . — derived from the ruff config found in this repository`, pyDerived: true };
  }
  return { text: `${pkg.name}: no lint command declared for this package, and no ruff config was found, so the command cannot be derived`, pyDerived: false };
}

function typecheckAdvice(pkg, files, root) {
  if (isJsPackage(pkg)) {
    // Coordinator finding (round 3, Major): this used to check ONLY the
    // package's own directory, so the fallback said "no tsconfig.json was
    // found" for an ordinary monorepo where a SINGLE root tsconfig.json
    // covers every package (no per-package tsconfig at all) — false, not
    // merely incomplete: a root tsconfig.json IS real typecheck evidence
    // for a nested package in that common layout. Same wording defect
    // round 2 fixed for requirements.txt, now fixed at the SOURCE instead
    // of only in the sentence: look in both places, and say both were
    // checked.
    if (hasAnyAt(files, pkg.dir, ['tsconfig.json']) || files.includes('tsconfig.json')) {
      return { text: `${pkg.name}: add "typecheck": "tsc --noEmit" to ${pkg.manifestPath} — derived from a tsconfig.json found in this package's directory or at the repository root`, pyDerived: false };
    }
    return { text: `${pkg.name}: ${pkg.manifestPath} is missing a "typecheck" script — no tsconfig.json was found in this package's directory or at the repository root, so the command cannot be derived`, pyDerived: false };
  }
  if (hasMypyConfig(files, root, pkg.dir)) {
    return { text: `${pkg.name}: typecheck -> mypy . — derived from the mypy config found in this repository`, pyDerived: true };
  }
  if (hasPyrightConfig(files, root, pkg.dir)) {
    return { text: `${pkg.name}: typecheck -> pyright — derived from the pyright config found in this repository`, pyDerived: true };
  }
  return { text: `${pkg.name}: no typecheck command declared for this package, and neither a mypy nor a pyright config was found, so the command cannot be derived`, pyDerived: false };
}

/**
 * Credit an event from `.claude/settings.json`'s hook registry rather than from
 * a filename under `.claude/scripts/`. A hook's script may live anywhere in the
 * repository, so a filename check cannot be made adequate here — and does not
 * need to be, because settings.json is an exact record of what is wired up.
 *
 * Task 8b (the defect the coordinator found while this plan's own lifecycle
 * test was being written): this used to credit `declared` the moment the
 * event had ANYTHING registered on it — any hook at all, ours or not. A user
 * with their own unrelated `PostToolUse` hook was told the per-edit sensor
 * was already in place. The fix is `ourPath`: the resolved script path OUR
 * OWN generator registers for this event (propose.mjs's
 * `LINT_TOUCHED_PATH`/`VERIFY_TOUCHED_PATH`/`BRIEF_PATH` — the single source
 * of truth that generator also uses, so the two cannot drift). `declared`
 * now means OUR path is among what is registered, not merely that the event
 * is occupied.
 *
 * This is the same identification `apply-lib.mjs`'s `hasEquivalentHook` uses
 * (an exact command match against the real settings object), expressed
 * against the representation THIS layer already carries safely: `hookEvents`
 * resolves each hook's command to a script PATH (or `null` when it can't),
 * never the raw command string, specifically so a credential embedded in a
 * hook's arguments never reaches `harness` — which is serialised wholesale
 * into docs/harness/detect.json on every run. Calling `hasEquivalentHook`
 * itself here would need the raw settings object threaded into this check,
 * which has nowhere safe to live: stashing it on `harness` would undo that
 * redaction for every hook on every event, not just the one this check
 * cares about.
 *
 * Does NOT suppress the proposal when the event is occupied by something
 * that isn't ours — the coordinator's ruling: their hook may do something
 * unrelated, and deciding for them is not this tool's place. It still
 * widens to `declared` only when ours is found (so the central
 * absent-only-may-propose invariant is untouched); otherwise it stays
 * `absent` + the proposal, with evidence naming what else is already there,
 * so adding a second entry to the same event is never a surprise.
 */
function registeredHook(harness, event, ourPath, proposal, { manifest, root } = {}) {
  const scripts = harness.claudeDir.hookEvents?.[event] ?? [];
  if (scripts.includes(ourPath)) {
    // Coordinator finding (Minor): this used to list EVERY resolved script
    // on the event, presenting a user's own, unrelated hook as part of
    // OUR credit. List only ours — if theirs is worth mentioning, it is
    // mentioned as theirs, in the `absent` branches below, never folded
    // into what we are claiming as declared.
    return { state: 'declared', evidence: [`${event} hook: ${ourPath}`] };
  }
  // Major (coordinator, post-8b review): `commandScript` (detect-harness.mjs)
  // resolves a hook's script only against the SCAN list (listFiles —
  // tracked, or fallback-walk-visible) — so a repository that gitignores
  // `.claude/` makes OUR OWN hook's script permanently unresolvable there,
  // even though it is genuinely registered and genuinely on disk. Without
  // this branch, such a repository is told forever, on every run, that the
  // harness it just installed is absent and not its own.
  //
  // The manifest — OUR OWN record of what we installed, already the
  // authority `uninstall` trusts to decide what to remove — plus a direct
  // `existsSync` (never the scan list) is the right way to answer "is OURS
  // present" here. The scan list stays reserved for the USER's own
  // content (the `theirs` evidence below): naming a path the scan list
  // already surfaced is safe because the user chose to make it visible;
  // naming anything `existsSync` alone would admit risks naming a path
  // the user deliberately kept out of git.
  //
  // Coordinator finding (Major, this fix's own false `declared`): this
  // used to gate on `scripts.length > 0` — the event being OCCUPIED by
  // ANYTHING — not on whether the occupant could plausibly be ours. If a
  // user replaces our hook entry with an unrelated one that DOES resolve
  // (a real, different, tracked script), `scripts` is `['their/script']`
  // — a positive, certain answer that it is NOT ours — yet the manifest
  // and our old script file (never cleaned up, because nothing told it
  // to) would still make this branch fire. Gating on `scripts.includes(null)`
  // restricts this to the one case it exists for: the event has something
  // registered that COULD be ours, but the scan list cannot say either way
  // because it is unresolvable (gitignored) — never a registration we can
  // already positively identify as someone else's. This is the Task 8b
  // ruling itself ("ours", not "occupied"), applied to the branch THIS
  // fix added.
  if (scripts.includes(null) && root && manifest?.settingsPatches?.some(p => p.event === event) && existsSync(join(root, ourPath))) {
    return { state: 'declared', evidence: [`${event} hook: ${ourPath} (not visible to the file scan — .claude/ may be gitignored; confirmed via the install record and the file on disk)`] };
  }
  if (scripts.length === 0) return { state: 'absent', proposal, evidence: [] };
  return {
    state: 'absent', proposal,
    evidence: scripts.map(s => s
      ? `${event} hook already registered, but not ours: ${s}`
      : `${event} hook already registered, but not ours (its script could not be resolved)`),
  };
}

/**
 * Each entry describes one runbook step. `check` returns
 * { state, evidence, proposal? } — and the wrapper enforces the invariant that
 * only `absent` may carry a proposal, so no individual check can break it.
 */
// Runbook step 1 ("branch for the work") is deliberately NOT a check. Being on
// a branch is a precondition of the apply run, not a capability the repository
// lacks — modelling it as a gap makes every otherwise-complete repo on `main`
// report a proposal, which would defeat the load-bearing test. Plan 2 enforces
// it as an apply-time refusal instead.
const CHECKS = [
  {
    id: 'P0.inventory', step: 2, phase: 0,
    lookedFor: ['docs/harness/detect.json'],
    // Produced by this very run, so it is evidence by construction.
    check: () => ({ state: 'verified', evidence: ['produced by this run'] }),
  },
  {
    id: 'P0.security', step: 3, phase: 0,
    lookedFor: ['tokens in remotes, tracked files and .claude settings'],
    // Task 9b, finding 1: this used to fail on `exposures.length` alone and
    // list every one of them as evidence — on a real repository, 62 of 66
    // `credentials-in-doc` hits were a credential-shaped key whose value is
    // a code reference (`process.env.TOKEN`, `config.get('x')`, ...), not a
    // literal. Burying the one real `high` finding under 62 false alarms
    // trains a reader to stop reading this check at all, which is worse
    // than no check. `splitExposures` (detect-exposure.mjs, shared with
    // report.mjs's renderSummary so the two can never disagree) separates
    // the prominent class — everything that is NOT a reference-valued
    // `credentials-in-doc` hit — from the rest, which is reported here as a
    // single collapsed count, never suppressed and never dropped: every
    // individual finding, reference or literal, still lands in
    // exposures/detect.json unchanged. Only the PROMINENT class may fail
    // this check; a repository with nothing but reference-valued hits is
    // `verified`, with the collapsed count disclosed rather than hidden.
    check: ({ exposures }) => {
      const { prominent, collapsedCount } = splitExposures(exposures);
      const note = collapsedCount ? [collapsedExposureNote(collapsedCount)] : [];
      if (prominent.length) {
        return { state: 'failing', evidence: [...prominent.map(e => `${e.kind} at ${e.location}`), ...note] };
      }
      return { state: 'verified', evidence: collapsedCount ? note : ['no credential patterns matched'] };
    },
  },
  {
    id: 'P0.recon', step: 4, phase: 0,
    lookedFor: ['docs/harness/recon.md'],
    check: ({ harness }) => harness.reconPresent
      ? { state: 'declared', evidence: ['docs/harness/recon.md'] }
      : { state: 'absent', proposal: 'run the recon prompt to write docs/harness/recon.md' },
  },
  {
    id: 'P1.bootstrap', step: 5, phase: 1,
    // Review Minor: this used to name only the files `declared` evidence
    // comes from, omitting the lockfile/package-manager evidence the
    // question above actually asks about — a check reporting it looked in
    // one place while asking about another. Named both, so a reader does
    // not read the question as arbitrary.
    lookedFor: ['scripts/bootstrap.sh', 'scripts/setup.sh', 'Makefile', 'justfile', 'a lockfile or declared package manager (to derive the install command)'],
    // Coordinator finding (Major): this used to decide `absent` + a
    // proposal from `harness.bootstrap` alone, never checking whether an
    // install command was actually derivable — while propose.mjs's own
    // generator (correctly) refused to write anything without real
    // evidence. A pyproject-only Python repository (no requirements.txt, no
    // poetry.lock/uv.lock) fell exactly into that gap: this check advertised
    // "create scripts/bootstrap.sh from template", and apply silently wrote
    // nothing. `installCommand`, imported from bootstrap-install.mjs, is the
    // SAME derivation propose.mjs's generator uses — not a second
    // independent guess at the same question — so the two cannot drift
    // again. This is the detected-but-undeliverable branch of the three-way
    // split; see this file's own comment in `buildGaps`, at the `n/a`
    // branch, for the other two.
    check: ({ harness, stack, files, root }) => {
      // Task 8b (coordinator ruling): a Makefile or justfile is a
      // general-purpose build tool, unlike every OTHER name in
      // BOOTSTRAP_CANDIDATES (detect-harness.mjs) — `scripts/bootstrap.sh`,
      // `setup.sh`, etc. are purpose-named, so their mere existence is real
      // evidence of what they do, but a Makefile with only a `build:`
      // target is not evidence that dependencies get installed. Confirmed
      // live: that exact Makefile reported `declared` with evidence
      // `["Makefile"]`. `setupTargetEvidence` (bootstrap-target-evidence.mjs)
      // reads a TARGET NAME, never a target's body — the same "a name is
      // evidence, a body is a guess" rule this file already applies to
      // declared script names (detect-stack.mjs) and advice (see
      // lintAdvice/typecheckAdvice above).
      const isMakeOrJust = harness.bootstrap === 'Makefile' || harness.bootstrap === 'justfile';
      let occupantEvidence = null;
      if (harness.bootstrap && !isMakeOrJust) {
        return { state: 'declared', evidence: [harness.bootstrap] };
      }
      if (isMakeOrJust) {
        const kind = harness.bootstrap === 'justfile' ? 'just' : 'make';
        const target = setupTargetEvidence(root, harness.bootstrap, kind);
        if (target.found) {
          return { state: 'declared', evidence: [`${harness.bootstrap}: found a setup-shaped target ("${target.target}:")`] };
        }
        // Not found: fall through to the SAME derivation as "no bootstrap
        // file at all" (below) — the coordinator's ruling is a proposal
        // here, not a question, exactly like the hooks' own third row: we
        // still offer to write scripts/bootstrap.sh, and we say what of
        // theirs we saw, so the choice (keep the Makefile's own mechanism,
        // or also accept this one) is theirs, not assumed.
        occupantEvidence = `${harness.bootstrap} exists but declares no setup-shaped target (looked for setup:/bootstrap:/init:/install:)`;
      }
      if (installCommand(stack.packageManager, files, root)) {
        return {
          state: 'absent', proposal: 'create scripts/bootstrap.sh from template',
          evidence: occupantEvidence ? [occupantEvidence] : [],
        };
      }
      return {
        state: 'absent', decidable: false,
        evidence: [
          ...(occupantEvidence ? [occupantEvidence] : []),
          'no install command could be derived from stack.packageManager or any lockfile among the detected files',
        ],
        question: 'A bootstrap script applies here, but no install command could be derived from a lockfile or declared package manager — how are this project\'s dependencies installed?',
      };
    },
  },
  {
    id: 'P1.instructions', step: 6, phase: 1,
    lookedFor: ['CLAUDE.md', 'AGENTS.md'],
    check: ({ harness }) => {
      const { path, lines } = harness.instructions;
      if (!path) return { state: 'absent', proposal: 'run the instruction-file prompt to derive CLAUDE.md from recon' };
      const evidence = [`${path} (${lines} lines)`];
      if (lines > MAX_INSTRUCTION_LINES) evidence.push(`${lines} lines exceeds the ${MAX_INSTRUCTION_LINES}-line budget; prune rather than replace`);
      return { state: 'declared', evidence };
    },
  },
  {
    id: 'P1.architecture', step: 7, phase: 1,
    lookedFor: ['docs/ARCHITECTURE.md', 'documentation the instruction file points at'],
    // Three sources, in order of how directly they answer the question:
    //   1. a canonical path — decided;
    //   2. a path the repository's own instruction file points at — decided;
    //   3. nothing pointed at, but documentation exists SOMEWHERE in the
    //      repository (harness.projectDocs — not limited to docs/*.md; see
    //      detect-harness.mjs) — NOT decided. Decidability rests entirely on
    //      that collection being a true enumeration, not three filenames one
    //      happens to know; sniffing prose for architecture-ish content would
    //      only move the same error.
    check: ({ harness }) => {
      if (harness.architecture) return { state: 'declared', evidence: [harness.architecture] };

      const pointed = harness.docPointers ?? [];
      if (pointed.length) {
        const from = harness.instructions?.path ?? 'the instruction file';
        return { state: 'declared', evidence: pointed.map(p => `${from} points at ${p}`) };
      }

      const docs = harness.projectDocs ?? [];
      if (docs.length) {
        const shown = docs.slice(0, 3).join(', ') + (docs.length > 3 ? ', …' : '');
        return {
          state: 'absent',
          decidable: false,
          evidence: [`no canonical architecture path, and the instruction file points at none`],
          // Coordinator finding: this used to assert these files ARE
          // documentation ("the repository holds N documentation
          // file(s)") — but projectDocs only found files with a
          // documentation-SHAPED name (an extension .md/.rst/.adoc/.txt
          // conventionally used for docs); it never opened one to confirm
          // its content. Say what was actually measured, not what was
          // merely likely — the question still prompts the same answer.
          question: `No docs/ARCHITECTURE.md found, but the repository holds ${docs.length} file${docs.length === 1 ? '' : 's'} with a documentation-shaped name (${shown}). Is one of these the architecture document?`,
        };
      }

      return { state: 'absent', proposal: 'run the architecture prompt to write docs/ARCHITECTURE.md' };
    },
  },
  {
    id: 'P1.pathrules', step: 7, phase: 1,
    // Review Minor (same shape as P1.bootstrap/P2.sensor/P2.stopgate above):
    // name both the directory this check inspects for existing rules AND
    // the workspace layout the question below actually asks about, not
    // just the former.
    lookedFor: ['.claude/rules/', 'the workspace layout (stack.isWorkspace, stack.packages)'],
    // Ruling (coordinator, Task 6): decidable only for a genuine WORKSPACE.
    // `pathRuleTargets`, imported from pathrules-evidence.mjs, is the SAME
    // derivation propose.mjs's generator uses to build the actual rule
    // files — not a second independent guess at "is there a meaningful path
    // split here" (same discipline as P1.bootstrap/P2.sensor/P2.stopgate/
    // P2.protected above, each sharing its own evidence module with its own
    // generator). A single-package repository has no sub-directory split
    // worth scaffolding a rule file for, so the honest answer is to ASK,
    // not propose one.
    check: ({ harness, stack }) => {
      // Coordinator ruling (Major, reverting an 8b over-correction): a
      // brief attempt here narrowed `declared` to "every target THIS
      // workspace's own layout calls for is present", on the theory that a
      // user's rule file for a DIFFERENT package shouldn't satisfy this
      // one — the same shape as the P2.sensor/P2.stopgate/P4.sessionbrief
      // fix. It is not the same shape. For a hook, OUR artefact provides
      // BEHAVIOUR the user's own hook may lack, so the two coexist and we
      // propose alongside, disclosing what we found. For a path rule, OUR
      // artefact is an EMPTY SCAFFOLD — its only value is being a place
      // for the user to write conventions. A user who has already written
      // their OWN rule files under `.claude/rules/` has fully satisfied
      // that goal; proposing an empty stub beside real conventions would
      // be noise, not disclosure. So — restored — ANY file under
      // `.claude/rules/` credits this check, exactly as before 8b, with
      // the files found named as evidence. This is not an exception to the
      // 8b ruling; it is the ruling applied to an artefact whose value is
      // its CONTENT rather than its presence.
      if (harness.claudeDir.rules.length) {
        return { state: 'declared', evidence: harness.claudeDir.rules };
      }
      const targets = pathRuleTargets(stack);
      if (targets.length) {
        // Coordinator finding (round 3): "ship it, but say so" — the
        // reviewer's verdict was that these four near-identical stubs
        // still earn their place (right directory, the one key actually
        // read, the correct glob shape, the compaction caveat a person
        // reliably gets wrong unaided), but a reader skimming `/context`
        // would otherwise see N loaded rules files and assume they already
        // hold real conventions. Say plainly, in the proposal text itself
        // (which renderSummary prints verbatim after the `→`), that they
        // do not yet.
        return { state: 'absent', proposal: 'scaffold .claude/rules/ with globs derived from the workspace layout — each file is generated EMPTY; conventions are added by hand afterward' };
      }
      // Coordinator finding (round 3, Minor): this evidence/question used
      // to say "this is a single-package repository" — true for every
      // REAL input detect-stack.mjs produces when `pathRuleTargets` returns
      // empty, but not true of every input that reaches this branch: a
      // hand-built stack with exactly one package whose own `dir` is a
      // subdirectory (not '.') also lands here once `isWorkspace` is
      // false, and that repository plainly DOES have a subdirectory — the
      // one the lone package lives in. The actual criterion this branch
      // tests is `stack.isWorkspace`, not "how many packages", so the
      // sentence now describes THAT, true regardless of where the one
      // package (if any) happens to sit.
      return {
        state: 'absent', decidable: false,
        evidence: ['this repository is not detected as a multi-package workspace (stack.isWorkspace is false) — there is no cross-package split to scope a rule to'],
        question: 'Path-scoped rules apply here, but this repository is not detected as a multi-package workspace, so there is no cross-package split to derive a glob from — are there subdirectories with their own conventions that should each get their own .claude/rules/ file, and if so, what glob should scope each one?',
      };
    },
  },
  {
    id: 'P2.scripts', step: 8, phase: 2,
    lookedFor: ['a lint and typecheck script in every package', 'an ESLint, ruff or tsconfig.json config to derive a command from'],
    // Ruling (coordinator, Task 7): adding a missing lint/typecheck script
    // means writing to a package's own manifest (package.json,
    // pyproject.toml, ...) — deliberately OUTSIDE apply-lib.mjs's write
    // allowlist (see that module's own comment: a user's manifest is the
    // file most likely to be hand-tuned, and the one this tool must never
    // touch). So this capability is reported, never applied:
    // `decidable: false` keeps buildProposals' central gate (see its own
    // comment on that invariant) from ever turning this into a write, and —
    // independently — propose.mjs's GENERATORS table has, and must keep,
    // NO entry for this id at all. That second guard is deliberate, not an
    // oversight: the write allowlist must not be the only thing standing
    // between this check and package.json (propose.test.mjs's "SECRET:
    // P2.scripts has no registered generator..." pins it by forcing
    // `decidable: true` and proving the generator table alone still
    // refuses).
    //
    // `advice` (see lintAdvice/typecheckAdvice above) carries the concrete
    // line to add, per missing script, per package — but only where a
    // config file actually proves which tool to name; this is deliberately
    // not a `question`, because the gap itself is not a missing FACT (it is
    // fully known), only a write this tool will not make. `PY_COMMAND_HOME`
    // is appended at most ONCE, at the end — see this file's header comment
    // on `lintAdvice`/`typecheckAdvice` for why a per-line explanation was
    // wrong (coordinator, round 2).
    check: ({ stack, files, root }) => {
      // `p.scripts` is a sorted list of script NAMES — see detect-stack.mjs.
      const lacks = (p, name) => !p.scripts?.includes(name);
      const missing = stack.packages.filter(p => lacks(p, 'lint') || lacks(p, 'typecheck'));
      if (missing.length === 0) return { state: 'declared', evidence: ['every package has lint and typecheck'] };

      const evidence = missing.map(p => `${p.name}: missing ${[lacks(p, 'lint') && 'lint', lacks(p, 'typecheck') && 'typecheck'].filter(Boolean).join(' + ')}`);
      const advice = [];
      let anyPyDerived = false;
      for (const p of missing) {
        if (lacks(p, 'lint')) {
          const r = lintAdvice(p, files, root);
          advice.push(r.text);
          anyPyDerived ||= r.pyDerived;
        }
        if (lacks(p, 'typecheck')) {
          const r = typecheckAdvice(p, files, root);
          advice.push(r.text);
          anyPyDerived ||= r.pyDerived;
        }
      }
      if (anyPyDerived) advice.push(PY_COMMAND_HOME);
      return { state: 'absent', decidable: false, evidence, advice };
    },
  },
  {
    id: 'P2.sensor', step: 9, phase: 2,
    // Review Minor: this used to name only the hook registry, while the
    // question below asks about a declared `lint` SCRIPT — a check
    // reporting it looked in one place while asking about another makes
    // the question read as arbitrary. Named both.
    lookedFor: ['a PostToolUse hook in .claude/settings.json', 'a lint script declared in any package'],
    // Task 5b (coordinator-inserted correction): this used to decide
    // `absent` + a proposal purely from whether a PostToolUse hook was
    // registered, never checking whether propose.mjs's own generator
    // (sensorProposal) could actually produce anything — while that
    // generator (correctly) refuses to fire unless some package declares a
    // `lint` script. detect-stack.mjs has no Python script-name
    // convention, so `scripts` is always `[]` for Python: this mismatched
    // for EVERY real Python repository. `hasLintScript`, imported from
    // sensor-evidence.mjs, is the SAME derivation the generator uses — not
    // a second independent guess — so the two cannot drift again. The
    // capability still APPLIES whenever there is code to lint (contrast
    // P2.protected below, where the subject itself can be genuinely
    // absent), so the honest answer when no package declares `lint` is to
    // ASK, not propose.
    check: ({ harness, stack, manifest, root }) => {
      const hook = registeredHook(harness, 'PostToolUse', LINT_TOUCHED_PATH,
        'install scripts/lint-touched.mjs and register a PostToolUse hook', { manifest, root });
      if (hook.state === 'declared') return hook;
      if (hasLintScript(stack)) return hook;
      // Coordinator finding (Minor): occupant evidence (what registeredHook
      // found registered on this event that isn't ours) used to be dropped
      // here — the one place a confused user needs it most, since the
      // question below gives no other hint that something is ALREADY
      // registered on PostToolUse.
      return {
        state: 'absent', decidable: false,
        evidence: [...(hook.evidence ?? []), 'no package declares a lint script'],
        question: 'A sensor hook applies here, but no package declares a lint script — what command lints a single file in this repository?',
      };
    },
  },
  {
    id: 'P2.stopgate', step: 10, phase: 2,
    // Same Minor as P2.sensor immediately above: name the declared-script
    // evidence the question asks about, alongside the hook registry.
    lookedFor: ['a Stop hook in .claude/settings.json', 'a typecheck or test script declared in the root package'],
    // Same shape as P2.sensor immediately above, for the Stop gate:
    // `rootVerifyScript` (stopgate-evidence.mjs) is the SAME root-only
    // typecheck/test derivation propose.mjs's stopgateProposal uses.
    check: ({ harness, stack, manifest, root }) => {
      const hook = registeredHook(harness, 'Stop', VERIFY_TOUCHED_PATH,
        'install scripts/verify-touched.mjs and register a Stop hook', { manifest, root });
      if (hook.state === 'declared') return hook;
      if (rootVerifyScript(stack)) return hook;
      // Same Minor as P2.sensor immediately above: occupant evidence must
      // not be dropped just because this also needs to ask a question.
      return {
        state: 'absent', decidable: false,
        evidence: [...(hook.evidence ?? []), 'the root package declares neither a typecheck nor a test script'],
        question: 'A stop gate applies here, but the root package declares neither a typecheck nor a test script — what command verifies this repository?',
      };
    },
  },
  {
    id: 'P2.protected', step: 11, phase: 2,
    lookedFor: ['deny rules in .claude/settings.json'],
    // Existence of settings.json is not enough — an empty or rule-less file
    // must not be reported as protecting anything.
    //
    // Task 5b: this used to propose "create .claude/settings.json with deny
    // rules" purely from `denyRules` being zero, never checking whether
    // propose.mjs's own generator (protectedPathProposal, via the shared
    // `protectedPathCandidates`) had any protected-path EVIDENCE to act on
    // at all — so a repository with no lockfile, no tracked build output,
    // no migrations and no generated files was advertised a proposal
    // `apply` would silently decline. Unlike P2.sensor/P2.stopgate above,
    // there is no question to ask here: the capability's SUBJECT (something
    // worth protecting) genuinely does not exist in that case, so `n/a`
    // with no question is the honest answer — asking the user to name
    // protected paths that demonstrably are not there would be noise, not a
    // missing fact.
    check: ({ harness, stack, files }) => {
      const candidates = protectedPathCandidates({ stack, files });
      if (candidates.length === 0) {
        // Review Minor: this used to assert repository-WIDE absence
        // ("found in this repository"), but `files` is the TRACKED (or
        // fallback-walk-visible) list from scan.mjs — a gitignored
        // lockfile sitting on disk is invisible to it. Same error class
        // as Task 2's deny-rule evidence filter (which could not match
        // gitignored build output), same fix: say what was actually
        // checked, not what is actually true everywhere.
        return { state: 'n/a', evidence: ['no tracked protected-path evidence (lockfile, build output, migrations, generated files) found — an untracked or gitignored file of the same kind would not be visible here'] };
      }

      // Task 8b: this used to credit `declared` from `denyRules > 0` alone
      // — ANY existing deny rule, regardless of what it protected. A user
      // who denies edits to their own secrets directory was told their
      // lockfile and migrations were protected too. `ours` is exactly what
      // `protectedPathProposal` (propose.mjs) would write — the same
      // evidence-derived candidates, wrapped the same way — so `declared`
      // now means every one of OUR rules is already there, not merely that
      // the deny array is non-empty. `denyRuleList` (detect-harness.mjs) is
      // the safely-filtered rule list: an entry is verbatim when it is a
      // path-taking permission (`Edit`/`Read`/`Write`/`Glob`/`Grep`/
      // `NotebookEdit`, the shape every rule THIS tool ever writes takes),
      // `null` otherwise — a `Bash(...)` deny rule can embed a literal
      // credential as its argument (see apply-lib.mjs's own comment on
      // `renderSettingsDenyDiff`), and `harness` is serialised wholesale
      // into docs/harness/detect.json on every run. Our own rules are
      // always `Edit(...)`, so they are never the ones redacted to `null`;
      // the comparison below is exact either way.
      const ours = candidates.map(g => `Edit(${g})`);
      const denyList = harness.claudeDir.denyRuleList ?? [];
      if (ours.every(rule => denyList.includes(rule))) {
        return { state: 'declared', evidence: [`${ours.length} deny rule(s) matching protected-path evidence found in this repository: ${ours.join(', ')}`] };
      }

      // Do NOT suppress the proposal because something else is already
      // denied (the coordinator's ruling) — name what of theirs was found
      // instead, so adding rules alongside it is never a surprise.
      // `addDenyRules` (settings-merge.mjs) already adds only the rules
      // that are genuinely new when this is applied, so proposing here is
      // safe even when some of `ours` is already present.
      const theirs = denyList.filter(rule => rule !== null && !ours.includes(rule));
      const redactedCount = denyList.filter(rule => rule === null).length;
      const evidence = [];
      // Coordinator finding (Minor): silence here let a top-up (most of
      // our rules already present, one missing) look identical to a
      // fresh install — a user who has already added two of three rules
      // this repository needs gets no signal that the proposal below is
      // small, not the full set.
      const alreadyPresent = ours.filter(rule => denyList.includes(rule));
      if (alreadyPresent.length) {
        evidence.push(`${alreadyPresent.length} of ${ours.length} deny rule(s) this repository needs ${alreadyPresent.length === 1 ? 'is' : 'are'} already present: ${alreadyPresent.join(', ')}`);
      }
      if (theirs.length) evidence.push(`existing deny rule(s) that do not match a protected path this repository has evidence for: ${theirs.join(', ')}`);
      if (redactedCount) evidence.push(`plus ${redactedCount} existing deny rule(s) not shown here (not a path-taking permission)`);
      return { state: 'absent', evidence, proposal: 'create .claude/settings.json with deny rules for protected paths' };
    },
  },
  {
    id: 'P2.langserver', step: 12, phase: 2,
    lookedFor: ['a language server for the detected stack'],
    // Whether a language server is installed is machine state, not repo state,
    // so this genuinely does not apply to what this tool inspects — 'declared'
    // would claim an observation that was never made.
    check: () => ({ state: 'n/a', evidence: ['not determinable from the repository; verify by hand'] }),
  },
  {
    id: 'P4.remote', step: 15, phase: 4,
    lookedFor: ['at least one git remote'],
    check: ({ harness }) => harness.remotes.length
      ? { state: 'declared', evidence: harness.remotes.map(r => r.name) }
      : { state: 'absent', proposal: 'add a git remote so the harness is backed up off this machine' },
  },
  // Two capabilities, two checks. Conflating them is how a repository with a
  // working SessionStart hook was told to "install HANDOFF.md and session-brief
  // hook" — a proposal to install something it already had.
  {
    id: 'P4.handoff', step: 16, phase: 4,
    lookedFor: ['HANDOFF.md', 'docs/HANDOFF.md'],
    check: ({ harness }) => harness.handoff
      ? { state: 'declared', evidence: [harness.handoff] }
      : { state: 'absent', proposal: 'create HANDOFF.md from template' },
  },
  {
    id: 'P4.sessionbrief', step: 16, phase: 4,
    lookedFor: ['a SessionStart hook in .claude/settings.json'],
    check: ({ harness, manifest, root }) => registeredHook(harness, 'SessionStart', BRIEF_PATH,
      'install scripts/session-brief.mjs and register a SessionStart hook', { manifest, root }),
  },
];

// Review Minor: `files` used to default to `[]`, on the claim that
// P1.bootstrap was the only check that read it — false even when it was
// written (P2.protected already consulted it via `protectedPathCandidates`)
// and worse than it reads: a caller that merely forgot to pass `files`
// silently flipped P2.protected from whatever it should have reported to
// `n/a`, a wrong but confident-looking CAPABILITY STATE, not just a missing
// detail. That is exactly the failure shape propose.mjs's `buildProposals`
// was already fixed against (see that file's own comment) — `files` has no
// default there either, and omitting it is a loud `TypeError`, not a quiet
// wrong answer. `files` is required here for the same reason, consulted by:
//   - P1.bootstrap (via `installCommand`, below) — the install command.
//   - P2.protected (via `protectedPathCandidates`) — anything worth
//     protecting.
// `root` keeps its own default of `undefined`, deliberately: `installCommand`
// only ever uses it to read a yarn.lock's own header, falling back to the
// honest plain form when it is not given — never the dangerous direction of
// a false positive, so no caller is forced to supply it.
export function buildGaps({ stack, harness, exposures, profile, git, files, root, manifest = null, checkDefs = CHECKS }) {
  if (files === undefined) {
    throw new TypeError('buildGaps: `files` is required — P1.bootstrap and P2.protected both decide a capability\'s reported state from it, and a silently-defaulted `[]` used to flip P2.protected to `n/a` for a caller that merely forgot to pass it.');
  }
  const applicable = new Set(profile.appliesToSteps());
  return checkDefs.map(def => {
    if (!applicable.has(def.step)) {
      // The three-way split for P1.bootstrap (and, in principle, any future
      // check with the same shape):
      //
      //   generic, NOTHING to install anywhere        -> n/a (here)
      //   a stack IS detected, install derivable       -> absent + proposal
      //   a stack IS detected, install NOT derivable   -> absent + decidable:false + question
      //
      // A later review caught a FOURTH, unhandled input class this branch
      // used to collapse into `n/a` regardless: `profile.appliesToSteps()`
      // excludes step 5 (confidence fell below the profile threshold —
      // e.g. a config-only repository with a tracked package-lock.json but
      // no .js/.ts source file, so `languages()` is empty), YET an install
      // command genuinely IS derivable from the lockfile alone. Reported
      // "not applicable" there was not a lie (the text is still true of
      // what the PROFILE covers), but it was a missed proposal for a case
      // this check's own shared derivation could have proven. So: for
      // P1.bootstrap specifically, defer to `installCommand` even when the
      // profile says this step does not apply, and only fall through to
      // `n/a` when it genuinely has nothing to propose either. This is
      // scoped to P1.bootstrap alone, not a general override of
      // step-applicability — the python/pyproject-only case (a stack that
      // DOES select a non-generic profile, so this branch is never reached
      // for it at all) is handled separately, inside P1.bootstrap's own
      // `check` function below; conflating that case with this one, or
      // either with `n/a`, was the actual mistake across review rounds.
      if (def.id === 'P1.bootstrap') {
        const install = installCommand(stack.packageManager, files, root);
        if (install) {
          return { id: def.id, step: def.step, phase: def.phase, state: 'absent',
            lookedFor: def.lookedFor, evidence: [], decidable: true, question: null,
            proposal: 'create scripts/bootstrap.sh from template', advice: [] };
        }
      }
      return { id: def.id, step: def.step, phase: def.phase, state: 'n/a',
        lookedFor: def.lookedFor, evidence: [`not applicable to profile ${profile.id}`],
        decidable: true, question: null, proposal: null, advice: [] };
    }
    const r = def.check({ stack, harness, exposures, profile, git, files, root, manifest });
    // The second axis, enforced in the same place and for the same reason.
    // `absent` means two incompatible things: "I enumerated the complete space
    // and it is not there" (decidable — the bootstrap script, the deny rules,
    // the git remote) and "I checked a handful of names I happen to know"
    // (not decidable). Only the first may carry a proposal; the second asks a
    // question instead. A check declares which it is, but the dropping happens
    // here, never in the check — same as the proposal guard below.
    const decidable = r.decidable !== false;
    return {
      id: def.id, step: def.step, phase: def.phase,
      state: r.state, lookedFor: def.lookedFor, evidence: r.evidence ?? [],
      decidable,
      question: decidable ? null : (r.question ?? null),
      // `advice` is orthogonal to the proposal/question axis above: P2.scripts
      // is `decidable: false` (so it never proposes) yet the gap is fully
      // KNOWN, not a missing fact to ask about — `advice` is what a check
      // uses for that third shape ("I know exactly what's missing, but this
      // tool will not write it"). Defaults to `[]`, like `evidence`, so every
      // check's returned shape is uniform whether or not it ever sets this.
      advice: r.advice ?? [],
      // The invariant, enforced centrally: only a decidable `absent` may propose.
      proposal: (r.state === 'absent' && decidable) ? (r.proposal ?? null) : null,
    };
  });
}
