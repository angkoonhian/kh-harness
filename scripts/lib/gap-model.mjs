import { OVER_DOCUMENT_LIMIT, readIfPresent } from './scan.mjs';
import { installCommand } from './bootstrap-install.mjs';
import { hasLintScript } from './sensor-evidence.mjs';
import { rootVerifyScript } from './stopgate-evidence.mjs';
import { protectedPathCandidates, denyRuleCoverage } from './protected-evidence.mjs';
import { ENTRY_SCRIPTS, registeredHook } from './hook-evidence.mjs';
import { pathRuleTargets } from './pathrules-evidence.mjs';
import { setupTargetEvidence } from './bootstrap-target-evidence.mjs';
import { splitExposures, partitionProminent, collapsedExposureNote, unexaminedExposureNote, prominentExposureNote, fixtureExposureNote } from './detect-exposure.mjs';
// What gap-model.mjs takes from propose.mjs: the exact resolved script path
// each hook generator registers and the sensor's matcher, so a check can ask
// "is OURS here" instead of "is anything here"; the generator table, so a
// proposal's `via` follows from whether a generator exists; and `kitSkew`,
// so P0.kitskew judges installed files against what the generators write.
// Importing them, not re-deriving them, is the same discipline as every
// other shared-evidence module in this file (bootstrap-install.mjs,
// sensor-evidence.mjs, ...): one source of truth, so the check and the
// generator cannot drift apart.
// propose.mjs does not import gap-model.mjs (or anything that does), so this
// is a one-directional import, not a cycle.
import { LINT_TOUCHED_PATH, VERIFY_TOUCHED_PATH, BRIEF_PATH, RULES_BRIEF_PATH, LOOP_WATCH_PATH, SESSION_LOG_PATH, TOOL_GATE_PATH, SENSOR_MATCHER, GENERATORS, GENERATOR_SCRIPT_PATHS, heldHookEvidence, heldQuestion, heldScripts, kitSkew, mergePlan, missingToolGateDenyRules, sessionLogRegistrations, toolGateDenyRules } from './propose.mjs';
import { LOGGED_EVENTS } from '../../assets/scripts/session-log.mjs';
import { displayPath, MANIFEST_PATH, readManifestResult } from './manifest.mjs';
import { INTENT_PATH, INTENT_SECTIONS } from './intent-evidence.mjs';
import { LEARNED_PATH, RULES_PATH } from '../../assets/scripts/harness-redact.mjs';
import { FAILURES_PATH } from './failures-evidence.mjs';
import { integrityEvidence } from './integrity-evidence.mjs';
import { GATES_PATH } from '../../assets/scripts/harness-log.mjs';

export const STATES = ['absent', 'declared', 'verified', 'failing', 'n/a'];

/**
 * Counts CAPABILITY GAPS with a proposal, per `via` (see `buildGaps`): only
 * the `apply` share is something `apply` can write. This is not `apply`'s
 * "actions" count, which is file writes and settings patches — one gap like
 * P2.sensor needs three.
 *
 * A proposal without a known `via` throws: a count that guessed would print
 * a share nothing stands behind.
 */
export function countProposals(checks) {
  const counts = { apply: 0, skill: 0, human: 0 };
  for (const c of checks) {
    if (!c.proposal) continue;
    if (!Object.hasOwn(counts, c.via)) throw new TypeError(`countProposals: ${c.id} carries a proposal with via ${JSON.stringify(c.via)}`);
    counts[c.via] += 1;
  }
  return counts;
}

/** Who closes a decidable proposal: `apply` exactly when a generator is
 * registered for the check's id, so adding a generator moves a proposal to
 * `apply` with no edit to its check. Otherwise the check's own
 * `viaWithoutGenerator` names whether the skill drafts it or a human does it;
 * a check that proposes without one throws, rather than be counted as
 * something `apply` will write. */
function proposalVia(def) {
  if (Object.hasOwn(GENERATORS, def.id)) return 'apply';
  if (def.viaWithoutGenerator === 'skill' || def.viaWithoutGenerator === 'human') return def.viaWithoutGenerator;
  throw new TypeError(`buildGaps: ${def.id} proposes, but no generator is registered for it and it names no viaWithoutGenerator ('skill' or 'human')`);
}

const MAX_INSTRUCTION_LINES = 150;

/**
 * Why a check that reads the manifest was given none: `corrupt` when the
 * file is there and cannot be read as a manifest, `missing` when it is not
 * there, and `unread` when no `root` was given to look under. `manifest`
 * is null for all three, and a check must not report one as another.
 */
function manifestAbsence(root) {
  if (root === undefined) return 'unread';
  return readManifestResult(root).state === 'corrupt' ? 'corrupt' : 'missing';
}

/**
 * `hook`, a hook check's verdict, unless the hook is not registered and
 * `apply` will not install it because its script is held (`heldScripts`):
 * the check then stays absent, proposes nothing, and says which files hold
 * the script and what the owner can do about them.
 */
function unlessHeld(hook, scriptPath, heldScript) {
  if (hook.state === 'declared') return hook;
  const causes = heldScript(scriptPath);
  if (causes === null) return hook;
  return { state: 'absent', decidable: false, evidence: [...(hook.evidence ?? []), heldHookEvidence(scriptPath, causes)], question: heldQuestion(causes) };
}

/** A document name that says it states the application's purpose — what
 * P3.intent accepts from an instruction-file pointer in place of
 * docs/INTENT.md. Whole tokens of the file name (split on -, _, . and
 * space), never substrings: production.md, provisioning.md and
 * revision-history.md are not intent statements. */
const INTENT_WORDS = new Set(['intent', 'purpose', 'vision', 'product', 'prd']);
function namedForIntent(path) {
  return path.split('/').pop().toLowerCase().split(/[-_. ]+/).some(t => INTENT_WORDS.has(t));
}

/**
 * What `P0.security` says when it found nothing: a claim about the files
 * the sweep read, never about the repository. The sweep skips binary
 * extensions, build directories and anything over 512 KB by design (see
 * detect-exposure.mjs's SKIP_EXT/SKIP_DIRS/MAX_BYTES). A file it could NOT
 * read is an `UNREADABLE_KIND` finding, and this sentence is never reached
 * while one exists.
 */
const CLEAN_SWEEP_NOTE = 'no credential patterns matched in any file this sweep could read (binary, build-output and over-512 KB files are skipped by design; a file that could not be READ is reported, not skipped silently)';

/**
 * P2.scripts advice: evidence-gated command derivation for the one capability
 * this kit deliberately reports but never applies (see this file's own
 * comment on the `P2.scripts` check, below, for why).
 *
 * Advice must not invent a command. A missing `lint` or `typecheck`
 * command gets a concrete derived command ONLY where a config file in the
 * PACKAGE'S OWN directory proves the tool is already in use. The evidence
 * consulted must come from the package's OWN ecosystem: citing the absence
 * of a tsconfig.json as the reason a Python package has no typecheck
 * command would be a confidently wrong sentence. `isJsPackage`, below,
 * gates every check by the package's own
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
 * `package.json` has a real `scripts` table, so naming it as where a JS/TS
 * line belongs is correct — but `pyproject.toml`
 * has no equivalent standard ( `[tool.poetry.scripts]` is console entry
 * points, `[tool.pdm.scripts]` is PDM-specific, neither is "a lint script").
 * So a JS/TS line still names `pkg.manifestPath` as where to add it; a
 * Python line names ONLY the derived command — the command is what
 * detection proved, the file is a guess, and this project does not ship
 * guesses.
 *
 * `PY_COMMAND_HOME`, the explanation of WHERE to record a Python command,
 * is said once per report, not on every derived line: a paragraph repeated
 * per package teaches a reader to skim past it. So `lintAdvice` and
 * `typecheckAdvice` return `{ text, pyDerived }` with no explanation
 * inline, and the `P2.scripts` check below appends `PY_COMMAND_HOME` exactly
 * ONCE, only when at least one line in its own advice derived a Python
 * command (`pyDerived`), never when every Python line was a "cannot be
 * derived" fallback with no command to record anywhere.
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
    // Both the package's own directory and the repository root are
    // checked, and the sentence says so: in an ordinary monorepo a SINGLE
    // root tsconfig.json covers every package, and it is real typecheck
    // evidence for a nested package that has none of its own.
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
    // Only the PROMINENT class may fail this check. A credential-shaped
    // key whose value is a code reference (`process.env.TOKEN`,
    // `config.get('x')`, ...) is not a literal, and on a real codebase such
    // hits far outnumber real findings: listing each would bury the one
    // `high` finding and train a reader to stop reading this check.
    // `splitExposures` (detect-exposure.mjs, shared with report.mjs's
    // renderSummary so the two can never disagree) separates the prominent
    // class — everything that is NOT a reference-valued
    // `credentials-in-doc` hit — from the rest, which is reported here as a
    // single collapsed count, never suppressed and never dropped: every
    // individual finding, reference or literal, still lands in
    // exposures/detect.json unchanged. A repository with nothing but
    // reference-valued hits is `verified`, with the collapsed count
    // disclosed rather than hidden.
    //
    // Within the prominent class, a literal hit in a test or fixture path
    // arrives at severity `low` (detect-exposure.mjs's `pathRole`) and does
    // not fail the check either — it is counted and cited via
    // `fixtureExposureNote`, never hidden. A token is high wherever it sits
    // and always fails.
    //
    // A file the sweep could not read arrives here as an `UNREADABLE_KIND`
    // finding (detect-exposure.mjs), and this check cannot be `verified`
    // while one exists. The two classes are separated by the SHARED
    // `partitionProminent`, not by a second `kind` test written here.
    //
    // The evidence CITES the rendered sections instead of reproducing them
    // line for line — see `prominentExposureNote`'s own comment for which
    // test holds the collapse guarantee.
    check: ({ exposures, harness }) => {
      const { prominent, collapsedCount } = splitExposures(exposures);
      const { credentials, unreadable } = partitionProminent(prominent);
      const blocking = credentials.filter(e => e.severity !== 'low');
      const fixtures = credentials.length - blocking.length;
      // Said beside whatever else was found: a remote URL that could not be
      // listed was not swept.
      const unlisted = harness?.remotesError ? [`remote URLs were not checked for a token: git could not list the remotes (${harness.remotesError})`] : [];
      const notes = [
        ...(fixtures ? [fixtureExposureNote(fixtures)] : []),
        ...(collapsedCount ? [collapsedExposureNote(collapsedCount)] : []),
        ...unlisted,
      ];
      if (unreadable.length || blocking.length) {
        return {
          state: 'failing',
          evidence: [
            ...(unreadable.length ? [unexaminedExposureNote(unreadable.length)] : []),
            ...(blocking.length ? [prominentExposureNote(blocking.length)] : []),
            ...notes,
          ],
        };
      }
      return { state: 'verified', evidence: fixtures || collapsedCount ? notes : [CLEAN_SWEEP_NOTE, ...unlisted] };
    },
  },
  {
    id: 'P0.recon', step: 4, phase: 0,
    lookedFor: ['docs/harness/recon.md'],
    viaWithoutGenerator: 'skill',
    check: ({ harness }) => harness.reconPresent
      ? { state: 'declared', evidence: ['docs/harness/recon.md'] }
      : { state: 'absent', proposal: 'run the recon prompt to write docs/harness/recon.md' },
  },
  {
    id: 'P1.bootstrap', step: 5, phase: 1,
    // Names the files `declared` evidence comes from AND the
    // lockfile/package-manager evidence the question asks about, so a
    // reader does not read the question as arbitrary.
    lookedFor: ['scripts/bootstrap.sh', 'scripts/setup.sh', 'Makefile', 'justfile', 'a lockfile or declared package manager (to derive the install command)'],
    // A proposal is made only where an install command is derivable:
    // propose.mjs's generator writes nothing without that evidence, and a
    // check that advertised "create scripts/bootstrap.sh from template" for
    // a pyproject-only Python repository (no requirements.txt, no
    // poetry.lock/uv.lock) would promise what apply then declines.
    // `installCommand`, imported from bootstrap-install.mjs, is the SAME
    // derivation the generator uses — not a second independent guess at
    // the same question — so the two cannot drift. This is the
    // detected-but-undeliverable branch of the three-way split; see this
    // file's own comment in `buildGaps`, at the `n/a` branch, for the
    // other two.
    check: ({ harness, stack, files, root }) => {
      // A Makefile or justfile is a general-purpose build tool, unlike
      // every OTHER name in BOOTSTRAP_CANDIDATES (detect-harness.mjs) —
      // `scripts/bootstrap.sh`, `setup.sh`, etc. are purpose-named, so
      // their mere existence is real evidence of what they do, but a
      // Makefile with only a `build:` target is not evidence that
      // dependencies get installed.
      // `setupTargetEvidence` (bootstrap-target-evidence.mjs)
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
        // file at all" (below) — a proposal here, not a question, exactly
        // like the hooks' own third row: we
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
    viaWithoutGenerator: 'skill',
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
    viaWithoutGenerator: 'skill',
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
      const docCount = harness.projectDocCount ?? docs.length;
      if (docs.length) {
        const shown = docs.slice(0, 3).join(', ') + (docCount > 3 ? ', …' : '');
        return {
          state: 'absent',
          decidable: false,
          evidence: [`no canonical architecture path, and the instruction file points at none`],
          // "A documentation-shaped name", not "documentation":
          // projectDocs finds files by extension (.md/.rst/.adoc/.txt) and
          // never opens one to confirm its content, so the question says
          // what was read.
          question: `No docs/ARCHITECTURE.md found, but the repository holds ${docCount} file${docCount === 1 ? '' : 's'} with a documentation-shaped name (${shown}). Is one of these the architecture document?`,
        };
      }

      return { state: 'absent', proposal: 'run the architecture prompt to write docs/ARCHITECTURE.md' };
    },
  },
  {
    id: 'P1.pathrules', step: 7, phase: 1,
    // Names both the directory this check inspects for existing rules AND
    // the workspace layout the question below asks about, as
    // P1.bootstrap, P2.sensor and P2.stopgate do.
    lookedFor: ['.claude/rules/', 'the workspace layout (stack.isWorkspace, stack.packages)'],
    // Decidable only for a genuine WORKSPACE.
    // `pathRuleTargets`, imported from pathrules-evidence.mjs, is the SAME
    // derivation propose.mjs's generator uses to build the actual rule
    // files — not a second independent guess at "is there a meaningful path
    // split here" (same discipline as P1.bootstrap/P2.sensor/P2.stopgate/
    // P2.protected above, each sharing its own evidence module with its own
    // generator). A single-package repository has no sub-directory split
    // worth scaffolding a rule file for, so the honest answer is to ASK,
    // not propose one.
    check: ({ harness, stack, files }) => {
      // `declared` is not narrowed to "every target THIS workspace's own
      // layout calls for is present", as it is for P2.sensor, P2.stopgate
      // and P4.sessionbrief, because a path rule is not the same shape as
      // a hook. For a hook, OUR artefact provides
      // BEHAVIOUR the user's own hook may lack, so the two coexist and we
      // propose alongside, disclosing what we found. For a path rule, OUR
      // artefact is an EMPTY SCAFFOLD — its only value is being a place
      // for the user to write conventions. A user who has already written
      // their OWN rule files under `.claude/rules/` has fully satisfied
      // that goal; proposing an empty stub beside real conventions would
      // be noise, not disclosure. So ANY file under `.claude/rules/`
      // credits this check, with the files found named as evidence: the
      // artefact's value is its CONTENT rather than its presence.
      //
      // `harness.claudeDir.rules` is read off DISK (detect-harness.mjs's
      // `claudeRuleFiles`), like every other field a check decides from,
      // so a workspace that gitignores `.claude/` is not told that the
      // capability `apply` just installed is absent.
      //
      // What is NAMED as evidence is still only what the SCAN list already
      // surfaced. That is `registeredHook`'s own discipline
      // (hook-evidence.mjs), for the same reason: a path the scan list shows is one
      // the user chose to make visible, while a path found by a disk read
      // alone may be one they deliberately kept out of git — and this
      // evidence is serialised into `docs/harness/detect.json`, which IS
      // committed. So a disk-only rule file is COUNTED and DISCLOSED,
      // exactly as the hook branch discloses its own, and never named.
      const rules = harness.claudeDir.rules ?? [];
      if (rules.length) {
        const visible = new Set(files);
        const named = rules.filter(r => visible.has(r));
        const hidden = rules.length - named.length;
        const evidence = [...named];
        if (hidden) {
          evidence.push(`${hidden} rule file${hidden === 1 ? '' : 's'} under .claude/rules/ (not visible to the file scan — .claude/ may be gitignored; confirmed on disk, and not named here because the scan list is what the user chose to make visible)`);
        }
        return { state: 'declared', evidence };
      }
      const targets = pathRuleTargets(stack);
      if (targets.length) {
        // The stubs earn their place (right directory, the one key
        // actually read, the correct glob shape, the compaction caveat a
        // person reliably gets wrong unaided), but a reader skimming
        // `/context` would see N loaded rules files and assume they hold
        // real conventions. So the proposal text itself, which
        // renderSummary prints verbatim after the `→`, says they are
        // generated empty.
        return { state: 'absent', proposal: 'scaffold .claude/rules/ with globs derived from the workspace layout — each file is generated EMPTY; conventions are added by hand afterward' };
      }
      // The criterion this branch tests is `stack.isWorkspace`, not how many
      // packages there are or where the one package sits, and the evidence
      // says that. It is `n/a`, not a question: a repository that is not a
      // workspace has no cross-package split to scope a rule to, which is
      // a fact about it and not a gap, and a question no answer could
      // silence would be asked on every run. A user who wants path rules
      // anyway writes them under .claude/rules/, which the branch above
      // then credits.
      return {
        state: 'n/a',
        evidence: ['not a workspace (stack.isWorkspace is false) — no sub-directory split to scaffold a rule file for; any .claude/rules/*.md you write is credited above'],
      };
    },
  },
  // --- Phase 3: intent and rules ---------------------------------------
  //
  // Steps 26-28 are ADDENDA to the 25-step runbook, the same way step 7a
  // was a prompt the runbook lacked (see docs/superpowers/specs/2026-11-02-
  // intent-and-rules-design.md). They apply to every profile, generic
  // included: nothing here depends on language.
  //
  // Evidence for all three is computed once by detect-harness.mjs and
  // carried on `harness` (`intent`, `rulesRegistry`, `ruleShapedLines`) —
  // like `architecture`/`handoff`/`bootstrap` — so these checks are pure
  // functions of that object. A harness fixture that omits the fields is a
  // repository without them (`?? null`), never a crash.
  {
    id: 'P3.intent', step: 26, phase: 3,
    // See the docPointers branch below.
    lookedFor: [INTENT_PATH, 'documentation the instruction file points at', 'any documentation-shaped file'],
    viaWithoutGenerator: 'skill',
    // Mirrors P1.architecture's three-way split, for the same decidability
    // reason: the canonical path is decided; "docs exist somewhere, but
    // not there" is NOT — a repository whose statement of purpose lives in
    // README.md or docs/product.md would otherwise be told to create what
    // it already has. The evidence names which of the seven sections are
    // MISSING — presence of the shape is what was measured, never the
    // prose, and the all-present sentence says so in as many words so a
    // reader does not mistake `declared` for "the intent is good".
    //
    // No generator exists for this id, and must not: like steps 6 and 7a
    // the skill writes this file itself after reading the repository, and
    // gates on the full content (propose.test.mjs pins the absence).
    check: ({ harness }) => {
      const intent = harness.intent ?? null;
      if (intent) {
        const evidence = [];
        if (intent.missing.length) evidence.push(`${intent.path} (missing sections: ${intent.missing.join(', ')})`);
        else evidence.push(`${intent.path} (all ${INTENT_SECTIONS.length} sections present — presence of the shape is what was measured, not the quality of the prose)`);
        if (intent.lastReviewed) evidence.push(`last reviewed ${intent.lastReviewed}`);
        return { state: 'declared', evidence };
      }
      // Like P1.architecture, honour a pointer the instruction file
      // already makes — but only at a document whose NAME
      // says it states the purpose (intent, purpose, vision, product, PRD);
      // a pointer at an API reference is not an intent statement.
      const pointed = (harness.docPointers ?? []).filter(namedForIntent);
      if (pointed.length) {
        const from = harness.instructions?.path ?? 'the instruction file';
        return { state: 'declared', evidence: pointed.map(p => `${from} points at ${p} (named for intent; its sections were not measured)`) };
      }
      const docs = harness.projectDocs ?? [];
      const docCount = harness.projectDocCount ?? docs.length;
      if (docs.length) {
        const shown = docs.slice(0, 3).join(', ') + (docCount > 3 ? ', …' : '');
        return {
          state: 'absent', decidable: false,
          evidence: [`no ${INTENT_PATH}`],
          question: `No ${INTENT_PATH} found, but the repository holds ${docCount} file${docCount === 1 ? '' : 's'} with a documentation-shaped name (${shown}). Does one of these already state the application's purpose and its success and failure criteria?`,
        };
      }
      return { state: 'absent', proposal: `run the intent prompt to write ${INTENT_PATH}` };
    },
  },
  {
    id: 'P3.rules', step: 27, phase: 3,
    lookedFor: [RULES_PATH, LEARNED_PATH, 'rule-shaped lines in the instruction file and .claude/rules/'],
    // The registry is the kit's own claim/evidence split applied to a
    // sentence: a rule with `enforced-by: none` is a CLAIM (Claude is told
    // it), one with a resolving pointer is held by something. This check
    // can report `declared` and, with the counts, how much of the registry
    // is held — but NEVER `verified`: nothing here is executed. Stated in
    // the test "never reports verified" so nobody upgrades it later
    // without adding execution (a `--verify` that runs `enforced-by: test`
    // commands is the deferred design in the spec's §9).
    //
    // Decidable when absent: the path is ours, and the scaffold is empty
    // by construction — rules are added by hand afterward, each with the
    // enforcer that holds it (the proposal text says so, verbatim, because
    // renderSummary prints it after the `→`). The scaffold's only value is
    // being a place for the user to write, exactly like P1.pathrules.
    //
    // The learned registry is reported beside the owner's and never in
    // place of it: with learned rules and no owner's registry, the
    // owner's scaffold is still proposed. Nothing here creates the learned
    // file; the learning loop does, when a learning is committed.
    //
    // Advice (never a proposal): rule-shaped lines in CLAUDE.md and
    // `.claude/rules/*.md` are the registry's natural first entries. Named
    // by COUNT and LINE NUMBER, never by sentence — rules-evidence.mjs's
    // own comment on why: this reaches the committed detect.json.
    check: ({ harness }) => {
      // At most ten line numbers per file, so one advice line stays readable.
      const listed = lines => lines.length > 10 ? `${lines.slice(0, 10).join(', ')} … and ${lines.length - 10} more` : lines.join(', ');
      const advice = (harness.ruleShapedLines ?? []).map(({ file, lines }) =>
        `${file} holds ${lines.length} rule-shaped line${lines.length === 1 ? '' : 's'} (line${lines.length === 1 ? '' : 's'} ${listed(lines)}) not in ${RULES_PATH} — consider moving each there with an enforced-by line, so told rules and enforced rules can be told apart`);
      // One registry file's counts, superseded rules, dead pointers and
      // parser problems. The owner's rules and the learned rules are
      // reported apart, each in this shape. A file that was not read has
      // no counts to give: only its problem, which says so.
      const summarise = (file, noun, problemPrefix) => {
        if (file.notRead) return file.problems.map(p => `${problemPrefix}: ${p}`);
        const enforced = file.count - file.unenforced.length;
        const byEnforcer = Object.entries(file.byEnforcer).filter(([k]) => k !== 'none').map(([k, n]) => `${k} ${n}`).join(', ');
        const unenforced = file.unenforced.length ? `${file.unenforced.length} with enforced-by: none (${file.unenforced.join(', ')})` : 'none with enforced-by: none';
        const lines = [`${file.path}: ${file.count} ${noun}${file.count === 1 ? '' : 's'} — ${enforced} enforced${byEnforcer ? ` (${byEnforcer})` : ''}, ${unenforced}`];
        if (file.superseded) lines.push(`${file.superseded} superseded ${noun}${file.superseded === 1 ? '' : 's'} kept as a record, not counted`);
        for (const m of file.missingPointers) {
          lines.push(m.pointer == null
            ? `${m.id}: enforced-by names a mechanism but no pointer says where it is`
            : `${m.id}: pointer ${m.pointer} does not exist`);
        }
        for (const p of file.problems) lines.push(`${problemPrefix}: ${p}`);
        return lines;
      };
      const reg = harness.rulesRegistry ?? null;
      const learned = reg?.learned ? summarise(reg.learned, 'learned rule', 'learned registry') : [];
      if (!reg || reg.path === null) {
        return { state: 'absent', advice, evidence: learned, proposal: `scaffold ${RULES_PATH} — generated EMPTY; rules are added by hand, each with the enforcer that holds it` };
      }
      if (reg.count === 0 && !reg.notRead) {
        const evidence = [`${reg.path} (0 rules — scaffold not yet filled in)`];
        if (reg.superseded) evidence.push(`${reg.superseded} superseded rule${reg.superseded === 1 ? '' : 's'} kept as a record`);
        return { state: 'declared', advice, evidence: [...evidence, ...reg.problems.map(p => `registry: ${p}`), ...learned] };
      }
      return { state: 'declared', advice, evidence: [...summarise(reg, 'rule', 'registry'), ...learned] };
    },
  },
  {
    id: 'P3.reinject', step: 28, phase: 3,
    lookedFor: ['a UserPromptSubmit hook registered at ' + RULES_BRIEF_PATH, `${RULES_PATH} or ${LEARNED_PATH} with at least one rule to inject`],
    // Decidable only with something to inject — the same evidence-gated
    // shape as P2.sensor (no lint script, no sensor). Two undecidable
    // branches, deliberately different: with NO registry, P3.rules' own
    // proposal already says what to do, so this asks nothing (a second
    // question in couldNotDerive on every first run would be noise); with
    // a registry that parses to ZERO rules, the user has done the first
    // step and the next one is worth saying. Ruling recorded in the SDD
    // ledger for this plan.
    //
    // Why re-inject at all: the 2026 studies the spec cites (McMillan)
    // measure compliance with told rules decaying within a session; a
    // per-prompt `additionalContext` is the one mechanism that counters it
    // without a longer file. The hook is byte-bounded (1500) so it stays
    // cheap on every single prompt — the figure is named in the proposal so
    // the gate carries it.
    //
    // What there is to inject is `injectable`: the owner's rules and the
    // learned rules no blocking gate holds, as the hook selects them.
    check: ({ harness, manifest, root, heldScript }) => {
      const reg = harness.rulesRegistry ?? null;
      if (!reg || (reg.path === null && reg.injectable === 0)) return { state: 'absent', decidable: false, evidence: [`no ${RULES_PATH} yet — nothing to inject`] };
      if (reg.injectable === 0 && (reg.notRead || reg.learned?.notRead)) {
        return { state: 'absent', decidable: false, evidence: ['a rules registry was not read, so what there is to inject is unknown'] };
      }
      if (reg.injectable === 0) {
        return {
          state: 'absent', decidable: false,
          evidence: [`${reg.path} holds 0 rules — nothing to inject yet`],
          question: `The re-injection hook has nothing to inject until ${RULES_PATH} holds at least one rule — add rules, then re-run detect.`,
        };
      }
      return unlessHeld(registeredHook(harness, 'UserPromptSubmit', RULES_BRIEF_PATH,
        "register a UserPromptSubmit hook that re-injects the registry's rules into every prompt, bounded at 1500 bytes",
        { manifest, root, kitScripts: GENERATOR_SCRIPT_PATHS }), RULES_BRIEF_PATH, heldScript);
    },
  },
  {
    id: 'P5.failures', step: 29, phase: 5,
    lookedFor: [FAILURES_PATH],
    // Never `verified`: labels are a person's judgement and nothing here
    // executes. The evidence is counts only — failures-evidence.mjs's own
    // comment says why, and why the session log is not read here.
    check: ({ harness }) => {
      const f = harness.failures ?? null;
      if (!f) return { state: 'absent', proposal: `scaffold ${FAILURES_PATH} — generated EMPTY; each failure kind is named by hand, with the recurrence signatures it covers` };
      if (!f.readable) return { state: 'declared', evidence: [`${f.path} ${f.overLimit ? OVER_DOCUMENT_LIMIT : 'exists but could not be read'} — the failure kinds it names are unknown`] };
      const plural = (n, noun) => `${n} ${noun}${n === 1 ? '' : 's'}`;
      const evidence = [`${f.path}: ${plural(f.kinds, 'failure kind')} named, listing ${plural(f.signatures, 'signature id')}`];
      if (f.malformedSignatures) evidence.push(`${plural(f.malformedSignatures, 'malformed signature id')} ignored (a signature id is 16 lowercase hex characters)`);
      if (f.ignoredHeadings) evidence.push(`${plural(f.ignoredHeadings, 'level-2 heading')} ignored (a failure kind's heading is "## F<n> — <title>")`);
      evidence.push('`log report` shows which recurrences no failure kind labels');
      return { state: 'declared', evidence };
    },
  },
  {
    id: 'P5.sessionlog', step: 31, phase: 5,
    lookedFor: [`a hook running ${SESSION_LOG_PATH} on each of the ${LOGGED_EVENTS.length} logged events in .claude/settings.json`],
    // Decided from the hook registry alone. Whether the log is enabled on
    // this machine is not read, and nothing executes, so it is never
    // `verified`.
    check: ({ harness, manifest, root, heldScript }) => {
      const byEvent = sessionLogRegistrations(harness, { manifest, root });
      const missing = byEvent.filter(r => r.state !== 'declared');
      const total = LOGGED_EVENTS.length;
      if (missing.length === 0) {
        // An event credited other than through the file scan keeps its own
        // line, which says how it was confirmed.
        const qualified = byEvent.flatMap(r => r.evidence.filter(e => e !== `${r.event} hook: ${SESSION_LOG_PATH}`));
        return { state: 'declared', evidence: [`${SESSION_LOG_PATH} is registered on all ${total} logged events: ${LOGGED_EVENTS.join(', ')}`, ...qualified] };
      }
      const occupants = missing.flatMap(r => r.evidence);
      const held = unlessHeld({ state: 'absent', evidence: occupants }, SESSION_LOG_PATH, heldScript);
      if (held.decidable === false) return held;
      if (missing.length === total) {
        return {
          state: 'absent', evidence: occupants,
          proposal: `install scripts/session-log.mjs with the three modules it imports (harness-log.mjs, harness-seal.mjs and harness-redact.mjs), and register it on the ${total} logged events, through the entry script on an event that has one — it records nothing until the log is enabled for this repository on this machine`,
        };
      }
      const n = missing.length;
      return {
        state: 'absent',
        evidence: [`${SESSION_LOG_PATH} is registered on ${total - n} of the ${total} logged events; ${n} ${n === 1 ? 'is' : 'are'} missing: ${missing.map(r => r.event).join(', ')}`, ...occupants],
        proposal: `register ${SESSION_LOG_PATH} on the ${n} logged event${n === 1 ? '' : 's'} it is missing`,
      };
    },
  },
  {
    id: 'P5.toolgate', step: 30, phase: 5,
    lookedFor: ['a PreToolUse hook in .claude/settings.json', 'the deny rules the gate hook is installed with, in the settings in effect'],
    // Decided from the hook registry and the deny rules in effect. Which
    // gates exist is learned later, so neither the gate files nor the
    // session log is read here, and nothing executes, so it is never
    // `verified`. The hook without every deny rule it is installed with is
    // not the capability: those rules keep the model from editing what the
    // hook enforces, or running what approves it.
    check: ({ harness, manifest, root, heldScript }) => {
      const hook = registeredHook(harness, 'PreToolUse', TOOL_GATE_PATH,
        'install scripts/tool-gate.mjs, register a PreToolUse hook that applies learned gates before every tool call, deny edits to the whole .claude/scripts/ directory, the gate file, the manifest, the learned registry and this machine\'s kh-harness data directory, and deny running the learn subcommands that approve or weaken a gate and `log purge --yes`, which removes them',
        { manifest, root, kitScripts: GENERATOR_SCRIPT_PATHS });
      if (hook.state !== 'declared') return unlessHeld(hook, TOOL_GATE_PATH, heldScript);
      const missing = missingToolGateDenyRules(harness);
      if (missing.length === 0) return hook;
      const all = toolGateDenyRules().length;
      return {
        state: 'absent',
        evidence: [...hook.evidence, `${missing.length} of the ${all} deny rules the gate hook is installed with are missing: ${missing.join(', ')}`],
        proposal: `add the ${missing.length} missing deny rule${missing.length === 1 ? '' : 's'} beside the registered gate hook`,
      };
    },
  },
  {
    id: 'P5.integrity', step: 32, phase: 5,
    lookedFor: [`the harness files ${MANIFEST_PATH} records under .claude/scripts/, and ${GATES_PATH} and ${LEARNED_PATH} when it records them`, `each gate in ${GATES_PATH} against an approved-sha256 in ${LEARNED_PATH}`, `each learning ${MANIFEST_PATH} records as landed against ${GATES_PATH}`],
    // Files are compared with the manifest and gates with their approvals;
    // nothing executes, so it is never `verified`. Nothing is proposed:
    // restoring a file or approving a gate is the owner's decision.
    // With no manifest there is no recorded file to check, but the kit can
    // still be here: a gate file is checked against its approvals all the
    // same, and a registered kit hook whose script nothing records is a
    // finding, not an absence.
    check: ({ manifest, root, harness }) => {
      if (!manifest) {
        const absence = manifestAbsence(root);
        if (absence === 'corrupt') {
          return { state: 'failing', evidence: [`${MANIFEST_PATH} could not be read as a manifest, so the kit's files could not be checked against it`] };
        }
        if (absence === 'unread') return { state: 'n/a', evidence: ['no manifest was read, so nothing was checked'] };
        const registered = GENERATOR_SCRIPT_PATHS.filter(script =>
          Object.values(harness.claudeDir.hookRegistrations ?? {}).flat().some(r => r.script === script));
        const { problems, summary } = integrityEvidence(root, { files: [] });
        const unrecorded = registered.length === 0 ? [] : [
          `${registered.length} kh-harness hook script${registered.length === 1 ? ' is' : 's are'} registered in .claude/settings.json (${registered.join(', ')}), ` +
          `but no ${MANIFEST_PATH} records what kh-harness wrote, so ${registered.length === 1 ? 'it' : 'they'} could not be checked against it`,
        ];
        if (unrecorded.length || problems.length) return { state: 'failing', evidence: [...unrecorded, ...problems] };
        return {
          state: 'n/a',
          evidence: [`no ${MANIFEST_PATH}: no installed file is recorded, so none was checked`, 'no kh-harness hook is registered in .claude/settings.json', ...summary.slice(1)],
        };
      }
      if (root === undefined) throw new TypeError('buildGaps: P5.integrity needs `root` once there is a manifest — without it no recorded file can be read.');
      const { problems, summary } = integrityEvidence(root, manifest);
      return problems.length ? { state: 'failing', evidence: problems } : { state: 'declared', evidence: summary };
    },
  },
  {
    id: 'P2.scripts', step: 8, phase: 2,
    lookedFor: ['a lint and typecheck script in every package', 'an ESLint, ruff or tsconfig.json config to derive a command from'],
    // Adding a missing lint/typecheck script means writing to a package's own manifest (package.json,
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
    // on `lintAdvice`/`typecheckAdvice` for why it is not said per line.
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
    // Names the hook registry AND the declared `lint` SCRIPT the question
    // below asks about, so the question does not read as arbitrary.
    lookedFor: ['a PostToolUse hook in .claude/settings.json', 'a lint script declared in any package'],
    // A proposal is made only where propose.mjs's generator
    // (sensorProposal) can produce one, and it refuses to fire unless some
    // package declares a `lint` script. detect-stack.mjs has no Python
    // script-name convention, so `scripts` is always `[]` for Python.
    // `hasLintScript`, imported from sensor-evidence.mjs, is the SAME
    // derivation the generator uses — not a second independent guess — so
    // the two cannot drift. The
    // capability still APPLIES whenever there is code to lint (contrast
    // P2.protected below, where the subject itself can be genuinely
    // absent), so the honest answer when no package declares `lint` is to
    // ASK, not propose.
    check: ({ harness, stack, manifest, root, heldScript }) => {
      const hook = registeredHook(harness, 'PostToolUse', LINT_TOUCHED_PATH,
        'install scripts/lint-touched.mjs and register a PostToolUse hook', { manifest, root, matcher: SENSOR_MATCHER, kitScripts: GENERATOR_SCRIPT_PATHS });
      if (hook.state === 'declared') return hook;
      if (hasLintScript(stack)) return unlessHeld(hook, LINT_TOUCHED_PATH, heldScript);
      // Occupant evidence (what registeredHook found registered on this
      // event that isn't ours) is kept here, where a user needs it most:
      // the question below gives no other hint that something is ALREADY
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
    // As for P2.sensor above: names the declared-script evidence the
    // question asks about, alongside the hook registry.
    lookedFor: ['a Stop hook in .claude/settings.json', 'a typecheck or test script declared in the root package'],
    // Same shape as P2.sensor immediately above, for the Stop gate:
    // `rootVerifyScript` (stopgate-evidence.mjs) is the SAME root-only
    // typecheck/test derivation propose.mjs's stopgateProposal uses.
    check: ({ harness, stack, manifest, root, heldScript }) => {
      const hook = registeredHook(harness, 'Stop', VERIFY_TOUCHED_PATH,
        'install scripts/verify-touched.mjs and register a Stop hook', { manifest, root, kitScripts: GENERATOR_SCRIPT_PATHS });
      if (hook.state === 'declared') return hook;
      if (rootVerifyScript(stack)) return unlessHeld(hook, VERIFY_TOUCHED_PATH, heldScript);
      // As for P2.sensor above: occupant evidence is kept beside the
      // question.
      return {
        state: 'absent', decidable: false,
        evidence: [...(hook.evidence ?? []), 'the root package declares neither a typecheck nor a test script'],
        question: 'A stop gate applies here, but the root package declares neither a typecheck nor a test script — what command verifies this repository?',
      };
    },
  },
  {
    id: 'P2.loopwatch', step: 13, phase: 2,
    lookedFor: ['a PostToolUseFailure hook in .claude/settings.json'],
    // No repository evidence decides this: any session can loop on a failing
    // call, so the step applies under every profile and is always decidable.
    check: ({ harness, manifest, root, heldScript }) => unlessHeld(registeredHook(harness, 'PostToolUseFailure', LOOP_WATCH_PATH,
      'install scripts/loop-watch.mjs and register a PostToolUseFailure hook that warns when one call fails the same way three times with no different failure between them',
      { manifest, root, kitScripts: GENERATOR_SCRIPT_PATHS }), LOOP_WATCH_PATH, heldScript),
  },
  {
    id: 'P2.protected', step: 11, phase: 2,
    lookedFor: ['deny rules in .claude/settings.json'],
    // Existence of settings.json is not enough — an empty or rule-less file
    // must not be reported as protecting anything.
    //
    // A proposal is made only where propose.mjs's generator
    // (protectedPathProposal, via the shared `protectedPathCandidates`) has
    // protected-path EVIDENCE to act on: a repository with no lockfile, no
    // tracked build output, no migrations and no generated files must not
    // be advertised a proposal `apply` would decline. Unlike
    // P2.sensor/P2.stopgate above, there is no question to ask then: the
    // capability's SUBJECT (something worth protecting) does not exist, so
    // `n/a` with no question is the honest answer — asking the user to
    // name protected paths that demonstrably are not there would be noise,
    // not a missing fact.
    check: ({ harness, stack, files }) => {
      const candidates = protectedPathCandidates({ stack, files });
      if (candidates.length === 0) {
        // "No tracked evidence", not "none in this repository": `files`
        // is the TRACKED (or fallback-walk-visible) list from scan.mjs, so
        // a gitignored lockfile sitting on disk is invisible to it.
        return { state: 'n/a', evidence: ['no tracked protected-path evidence (lockfile, build output, migrations, generated files) found — an untracked or gitignored file of the same kind would not be visible here'] };
      }

      // `declared` means every protected path this repository has evidence
      // for is COVERED by a deny rule already there, not that some deny
      // rule exists: a user who denies edits to their own secrets directory
      // must not be told their lockfile and migrations are protected too.
      // Coverage is decided by what the globs match in the repository's own
      // files (`denyRuleCoverage`, in protected-evidence.mjs beside the
      // candidates it judges), not by exact string against what
      // `protectedPathProposal` would write, so a user's
      // `Edit(package-lock.json)` covers the lockfile. `denyRuleList`
      // (detect-harness.mjs) is the safely-filtered rule list: an entry is
      // verbatim when it is a path-taking permission (`Edit`/`Read`/
      // `Write`/`Glob`/`Grep`/`NotebookEdit`), `null` otherwise — a
      // `Bash(...)` deny rule can embed a literal credential as its argument
      // (see apply-lib.mjs's own comment on `settingsDenyPreview`), and
      // `harness` is serialised wholesale into docs/harness/detect.json.
      const denyList = harness.claudeDir.denyRuleList ?? [];
      const { covered, uncovered, unrelated } = denyRuleCoverage({ candidates, denyRuleList: denyList, files });
      const describe = c => `${c.glob} covered by ${c.by.join(', ')}`;
      if (uncovered.length === 0) {
        return { state: 'declared', evidence: [`${covered.length} protected path(s) already covered by deny rules in this repository: ${covered.map(describe).join('; ')}`] };
      }

      // Do NOT suppress the proposal because something else is already
      // denied — name what of theirs was found
      // instead, so adding rules alongside it is never a surprise.
      // `addDenyRules` (settings-merge.mjs) already adds only the rules
      // that are genuinely new when this is applied, so proposing here is
      // safe even when some of the paths are already covered.
      const redactedCount = denyList.filter(rule => rule === null).length;
      const evidence = [];
      // Said so a top-up (most of the paths already covered, one not) does
      // not look identical to a fresh install: a user who has covered two
      // of three paths is told the proposal below is small.
      if (covered.length) {
        evidence.push(`${covered.length} of ${candidates.length} protected path(s) already covered: ${covered.map(describe).join('; ')}`);
      }
      // "Could not relate", not "do not protect": this tool's matcher is
      // narrower than Claude Code's on `**/`.
      // The protected-surface rules are P5.toolgate's, not unrelated ones.
      const surface = new Set(toolGateDenyRules());
      const theirs = unrelated.filter(rule => !surface.has(rule));
      if (theirs.length) evidence.push(`existing deny rule(s) this tool's matcher could not relate to a protected path this repository has evidence for: ${theirs.join(', ')}`);
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
    // Adding a remote needs a URL and an account only the owner has.
    viaWithoutGenerator: 'human',
    check: ({ harness }) => {
      if (harness.remotes.length) return { state: 'declared', evidence: harness.remotes.map(r => r.name) };
      // A git that could not answer is not a repository without a remote.
      if (harness.remotesError) {
        return {
          state: 'absent', decidable: false,
          evidence: [`git could not list this repository's remotes (${harness.remotesError}), so it is not known whether it has one`],
          question: 'git could not list this repository\'s remotes. Does it have one, so the harness is backed up off this machine?',
        };
      }
      return { state: 'absent', proposal: 'add a git remote so the harness is backed up off this machine' };
    },
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
    check: ({ harness, manifest, root, heldScript }) => unlessHeld(registeredHook(harness, 'SessionStart', BRIEF_PATH,
      'install scripts/session-brief.mjs and register a SessionStart hook', { manifest, root, kitScripts: GENERATOR_SCRIPT_PATHS }), BRIEF_PATH, heldScript),
  },
  {
    id: 'P0.hookmerge', step: 2, phase: 0,
    lookedFor: [`the kh-harness hooks registered on PreToolUse, PostToolUse and PostToolUseFailure in .claude/settings.json, against the registrations ${MANIFEST_PATH} records`],
    // Decided from the hook registry and the manifest's records, one line
    // per event (`mergePlan`); nothing executes, so it is never `verified`.
    // An event whose plan is `single`, or `mergeable` with a hook missing,
    // has no line: that hook's own check speaks for it, and its generator
    // registers the entry script.
    check: ({ harness, manifest, root, stack, heldScript }) => {
      const evidence = [];
      // The events `apply` can fix, in event order: `merge` to move to the
      // entry script, `undouble` to take the separate registrations out.
      const fixable = [];
      for (const event of Object.keys(ENTRY_SCRIPTS)) {
        const plan = mergePlan(event, { harness, manifest, root, stack });
        if (plan.state === 'merged') evidence.push(`${event}: one process — ${plan.entry} runs its hooks`);
        else if (plan.state === 'separate') evidence.push(`${event}: left on separate registrations — ${plan.why}`);
        else if (plan.state === 'mergeable' && plan.missing.length === 0) {
          evidence.push(`${event}: ${plan.remove.length} kh-harness hooks are registered separately, one process each`);
          fixable.push({ event, entry: plan.entry, fix: 'merge' });
        } else if (plan.state === 'doubled') {
          const line = `${event}: ${plan.entry} runs its hooks, and some of them are also registered by themselves, so those run twice`;
          if (plan.why !== null) {
            evidence.push(`${line}; left as it is — ${plan.why}`);
          } else {
            evidence.push(line);
            fixable.push({ event, entry: plan.entry, fix: 'undouble' });
          }
        }
      }
      if (fixable.length) {
        const events = fix => fixable.filter(e => e.fix === fix).map(e => e.event).join(', ');
        const proposal = [
          ...(events('merge') ? [`replace the separate kh-harness registrations on ${events('merge')} with one entry script each, so each of those events starts one process`] : []),
          ...(events('undouble') ? [`take out the separate kh-harness registrations on ${events('undouble')} beside the entry script already registered there, so each hook runs once`] : []),
        ].join('; and ');
        return unlessHeld({ state: 'absent', evidence, proposal }, fixable[0].entry, heldScript);
      }
      if (evidence.length) return { state: 'declared', evidence };
      return { state: 'n/a', evidence: ['no tool-call event holds two kh-harness hooks'] };
    },
  },
  // Last, so the generators it runs are given every other check, as
  // `buildProposals` gives them.
  {
    id: 'P0.kitskew', step: 2, phase: 0,
    lookedFor: [`the files ${MANIFEST_PATH} records, against what this kit generates for them`],
    check: ({ manifest, kitVersion, harness, root, stack, checks, files }) => {
      if (!manifest) {
        const absence = manifestAbsence(root);
        if (absence === 'corrupt') {
          return { state: 'failing', evidence: [`${MANIFEST_PATH} could not be read as a manifest, so no installed file was compared with what this kit generates`] };
        }
        return { state: 'n/a', evidence: [absence === 'missing' ? `no ${MANIFEST_PATH}: no file is recorded as installed` : 'no manifest was read, so no installed file was compared'] };
      }
      if (!manifest.files.length) return { state: 'n/a', evidence: [`${MANIFEST_PATH} records no installed file`] };
      if (kitVersion === undefined || root === undefined) {
        throw new TypeError('buildGaps: P0.kitskew needs `kitVersion` and `root` once the manifest records a file — without them every recorded file would be judged against a kit that was never named.');
      }
      const skew = kitSkew({ kitVersion, harness, root, stack, checks, files, manifest });
      const atKit = version => (version === null ? '' : ` at kit ${version}`);
      const evidence = [
        skew.versions,
        ...skew.updates.map(p => `out of date: ${displayPath(p.path)}`),
        ...skew.added.map(p => `missing: ${displayPath(p.path)} (an updated script loads it)`),
        ...skew.heldBack.map(h => `held back${atKit(h.version)}: ${displayPath(h.path)} (out of date, but kh-harness keeps ${h.causes.map(c => c.path).join(', ')} as ${h.causes.length === 1 ? 'it is' : 'they are'}, and its hook scripts are updated together or not at all)`),
        ...skew.kept.map(k => `kept${atKit(k.version)}: ${displayPath(k.path)} (${k.why === 'edited' ? 'edited or deleted since kh-harness wrote it' : 'does not carry the kh-harness stamp'} — never overwritten)`),
        ...skew.unproduced.map(path => `left alone: ${displayPath(path)} (this kit no longer generates it for this repository)`),
        ...(skew.current.length ? [`${skew.current.length} kit-owned file${skew.current.length === 1 ? '' : 's'} match what this kit generates`] : []),
      ];
      if (!skew.updates.length) return { state: 'declared', evidence };
      const n = skew.updates.length;
      return { state: 'absent', evidence, proposal: `update ${n} unmodified kit-owned file${n === 1 ? '' : 's'} to kit ${kitVersion}` };
    },
  },
];

// `files` has no default: with `[]`, a caller that merely forgot to pass
// it would have P2.protected report `n/a`, a wrong but confident-looking
// CAPABILITY STATE, not just a missing detail. propose.mjs's
// `buildProposals` requires it for the same reason (see that file's own
// comment), and omitting it is a loud `TypeError`, not a quiet wrong
// answer. It is consulted by:
//   - P1.bootstrap (via `installCommand`, below) — the install command.
//   - P2.protected (via `protectedPathCandidates`) — anything worth
//     protecting.
// `root` keeps its own default of `undefined`, deliberately: `installCommand`
// only ever uses it to read a yarn.lock's own header, falling back to the
// honest plain form when it is not given — never the dangerous direction of
// a false positive, so no caller is forced to supply it.
export function buildGaps({ stack, harness, exposures, profile, git, files, root, manifest = null, kitVersion, checkDefs = CHECKS }) {
  if (files === undefined) {
    throw new TypeError('buildGaps: `files` is required — P1.bootstrap and P2.protected both decide a capability\'s reported state from it, and a defaulted `[]` would report P2.protected as `n/a` for a caller that merely forgot to pass it.');
  }
  const applicable = new Set(profile.appliesToSteps());
  // Each check is given the checks evaluated before it.
  const checks = [];
  // Which installed scripts are held, read once and only when a hook check
  // asks. Without `root` or `kitVersion` it cannot be read, and no check
  // says a script is held.
  let held;
  const heldScript = path => {
    if (root === undefined || kitVersion === undefined) return null;
    held ??= heldScripts(root, manifest, kitVersion);
    return held.get(path) ?? null;
  };
  const gapFor = def => {
    if (!applicable.has(def.step)) {
      // The three-way split for P1.bootstrap (and, in principle, any future
      // check with the same shape):
      //
      //   generic, NOTHING to install anywhere        -> n/a (here)
      //   a stack IS detected, install derivable       -> absent + proposal
      //   a stack IS detected, install NOT derivable   -> absent + decidable:false + question
      //
      // There is a FOURTH input class: `profile.appliesToSteps()` excludes
      // step 5 (confidence fell below the profile threshold — e.g. a
      // config-only repository with a tracked package-lock.json but no
      // .js/.ts source file, so `languages()` is empty), YET an install
      // command IS derivable from the lockfile alone. "Not applicable"
      // would be true of what the PROFILE covers and still a missed
      // proposal for a case this check's own shared derivation can prove.
      // So: for P1.bootstrap specifically, defer to `installCommand` even
      // when the
      // profile says this step does not apply, and only fall through to
      // `n/a` when it genuinely has nothing to propose either. This is
      // scoped to P1.bootstrap alone, not a general override of
      // step-applicability — the python/pyproject-only case (a stack that
      // DOES select a non-generic profile, so this branch is never reached
      // for it at all) is handled separately, inside P1.bootstrap's own
      // `check` function; that case, this one and `n/a` are three
      // different answers.
      if (def.id === 'P1.bootstrap') {
        const install = installCommand(stack.packageManager, files, root);
        if (install) {
          return { id: def.id, step: def.step, phase: def.phase, state: 'absent',
            lookedFor: def.lookedFor, evidence: [], decidable: true, question: null,
            proposal: 'create scripts/bootstrap.sh from template', via: proposalVia(def), advice: [] };
        }
      }
      return { id: def.id, step: def.step, phase: def.phase, state: 'n/a',
        lookedFor: def.lookedFor, evidence: [`not applicable to profile ${profile.id}`],
        decidable: true, question: null, proposal: null, via: null, advice: [] };
    }
    const r = def.check({ stack, harness, exposures, profile, git, files, root, manifest, kitVersion, checks, heldScript });
    // The second axis, enforced in the same place and for the same reason.
    // `absent` means two incompatible things: "I enumerated the complete space
    // and it is not there" (decidable — the bootstrap script, the deny rules,
    // the git remote) and "I checked a handful of names I happen to know"
    // (not decidable). Only the first may carry a proposal; the second asks a
    // question instead. A check declares which it is, but the dropping happens
    // here, never in the check — same as the proposal guard below.
    const decidable = r.decidable !== false;
    // The invariant, enforced centrally: only a decidable `absent` may propose.
    const proposal = (r.state === 'absent' && decidable) ? (r.proposal ?? null) : null;
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
      proposal,
      via: proposal ? proposalVia(def) : null,
    };
  };
  for (const def of checkDefs) checks.push(gapFor(def));
  return checks;
}
