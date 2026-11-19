import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { render, versionStamp, machineryStamp, stampVersion, carriesStamp } from './render.mjs';
import { classify, contentMatches, MANIFEST_PATH, sha256 } from './manifest.mjs';
import { selectProfile } from './profiles/index.mjs';
import { installCommand } from './bootstrap-install.mjs';
import { hasLintScript } from './sensor-evidence.mjs';
import { rootVerifyScript } from './stopgate-evidence.mjs';
import { protectedPathCandidates } from './protected-evidence.mjs';
import { pathRuleTargets } from './pathrules-evidence.mjs';
// The registry's location is owned by the shared hook asset (see its own
// comment on why the parser lives there); re-exported below so uninstall-
// lib.mjs reads every producible path from this one module, as it does for
// the other five.
import { LEARNED_PATH, RULES_PATH } from '../../assets/scripts/harness-redact.mjs';
import { FAILURES_PATH } from './failures-evidence.mjs';
import { execEntry, registeredHook } from './hook-evidence.mjs';
import { LOGGED_EVENTS } from '../../assets/scripts/session-log.mjs';
import { GATES_PATH } from '../../assets/scripts/harness-log.mjs';

const ASSETS = new URL('../../assets/', import.meta.url);
const read = rel => readFileSync(new URL(rel, ASSETS), 'utf8');

// Where every hook script and module is installed. Each script loads its
// siblings by a relative `./name.mjs`, so they all land in this one
// directory.
const SCRIPTS_DIR = '.claude/scripts/';
const BRIEF_PATH = '.claude/scripts/session-brief.mjs';
const LINT_TOUCHED_PATH = '.claude/scripts/lint-touched.mjs';
const VERIFY_TOUCHED_PATH = '.claude/scripts/verify-touched.mjs';
const REDACT_PATH = '.claude/scripts/harness-redact.mjs';
const RULES_BRIEF_PATH = '.claude/scripts/rules-brief.mjs';
const LOOP_WATCH_PATH = '.claude/scripts/loop-watch.mjs';
const SESSION_LOG_PATH = '.claude/scripts/session-log.mjs';
const TOOL_GATE_PATH = '.claude/scripts/tool-gate.mjs';
const HARNESS_GATES_PATH = '.claude/scripts/harness-gates.mjs';
const HARNESS_LOG_PATH = '.claude/scripts/harness-log.mjs';
const HARNESS_SEAL_PATH = '.claude/scripts/harness-seal.mjs';

/**
 * A settings-hook proposal's `reason`: the check's own evidence, which is
 * what `detect` printed for it, or "no <event> hook registered" when there
 * is none. A fixed sentence would be false whenever the event already holds
 * a hook of the user's, and would sit directly above the preview's own
 * "(appended after N existing hooks.<event> entries, ...)". Reusing the
 * evidence text means the proposal cannot word it differently from
 * `registeredHook` (hook-evidence.mjs).
 */
function hookRegistrationReason(event, check) {
  const evidence = check?.evidence ?? [];
  return evidence.length ? evidence.join('; ') : `no ${event} hook registered in .claude/settings.json`;
}

/**
 * The protected-path candidate list and its evidence filter now live in
 * protected-evidence.mjs, shared with gap-model.mjs's P2.protected CHECK —
 * see that module's own header comment for why: the check and this
 * generator must agree on what counts as "something worth protecting" by
 * construction, not by two people independently getting the same answer
 * twice. This generator wraps each survivor as a Claude Code `Edit(...)`
 * permission pattern — the shape `.claude/settings.json`'s
 * `permissions.deny` actually takes (see settings-merge.mjs's tests).
 *
 * `Edit`, specifically — not `Read` — because the risk being guarded is
 * modification, not the agent reading context it legitimately needs.
 */
export function protectedDenyRules({ stack, files }) {
  return protectedPathCandidates({ stack, files }).map(g => `Edit(${g})`);
}

function protectedPathProposal({ stack, files }) {
  const globs = protectedDenyRules({ stack, files });
  if (globs.length === 0) return [];
  return [{
    kind: 'settings-deny', step: 11,
    globs,
    reason: 'deny edits to protected paths found in this repository',
  }];
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
 * `matcher: 'Write|Edit'` scopes the hook to the `Write` and `Edit` tools
 * EXACTLY — PostToolUse fires for every tool otherwise, and the hook has
 * nothing to say about a Bash or Read call.
 *
 * From the hooks reference, on matcher evaluation: a matcher containing only
 * letters, digits, `_`, `-`, spaces, `,` and `|` is an exact string or a
 * `|`/`,`-separated list of exact strings; only a matcher containing some
 * other character is treated as an unanchored regular expression.
 * `Write|Edit` is letters and a pipe, so it is two exact strings, and it
 * does not fire for `NotebookEdit` or for the legacy `MultiEdit`.
 *
 * That costs almost nothing: `NotebookEdit` carries `notebook_path`, not
 * `file_path`, so lint-touched.mjs would read `undefined` and exit 0, and
 * the hook only covers `.ts/.tsx/.js/.jsx/.mjs/.cjs/.py`, none of which is
 * a notebook. If notebook linting is ever wanted, the matcher and
 * `lint-touched.mjs`'s payload reading must change together: the matcher
 * alone would register a hook that fires and does nothing.
 */
/** The tools the per-edit sensor fires for — see the comment above. Named
 * so `P2.sensor` (gap-model.mjs) judges a registration against exactly what
 * this generator writes. */
const SENSOR_MATCHER = 'Write|Edit';

function sensorProposal({ kitVersion, stack, check }) {
  if (!hasLintScript(stack)) return [];
  const files = hookFiles(LINT_TOUCHED_PATH, kitVersion);
  return [...files, {
    kind: 'settings-hook', event: 'PostToolUse', step: 9,
    matcher: SENSOR_MATCHER,
    entry: execEntry(LINT_TOUCHED_PATH),
    // A hook is registered only when the script it runs and everything that
    // script loads are on disk holding this kit's bytes: apply-lib.mjs's
    // `unmetDependencies` reads the files themselves, after the write phase.
    requiresFiles: requiredFiles(files),
    reason: hookRegistrationReason('PostToolUse', check),
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
function stopgateProposal({ kitVersion, stack, check }) {
  const script = rootVerifyScript(stack);
  if (!script) return [];
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
  const registration = hookRegistrationReason('Stop', check);
  const reason = script === 'typecheck'
    ? `${registration} — runs the repository's typecheck script, bounded at 120s, at the end of every turn (${costNote})`
    : `${registration} — no typecheck script was found, so this falls back to the full test script, bounded at 120s, at the end of every turn (${costNote})`;
  const files = hookFiles(VERIFY_TOUCHED_PATH, kitVersion);
  return [...files, {
    kind: 'settings-hook', event: 'Stop', step: 10,
    entry: execEntry(VERIFY_TOUCHED_PATH),
    requiresFiles: requiredFiles(files),
    reason,
  }];
}

const LOOP_WATCH_STEP = 13;

/**
 * The loop warning: a PostToolUseFailure hook that tells Claude when one call
 * has failed the same way three times with no different failure between
 * them (see loop-watch.mjs). No evidence gate, since any repository's
 * session can loop on a failing call, and no `matcher`, since a failure of
 * any tool counts.
 */
function loopWatchProposal({ kitVersion, check }) {
  const files = hookFiles(LOOP_WATCH_PATH, kitVersion);
  return [...files, {
    kind: 'settings-hook', event: 'PostToolUseFailure', step: LOOP_WATCH_STEP,
    entry: execEntry(LOOP_WATCH_PATH),
    requiresFiles: requiredFiles(files),
    reason: hookRegistrationReason('PostToolUseFailure', check),
  }];
}

const SESSION_LOG_STEP = 31;

/**
 * `registeredHook`'s verdict on each event in `LOGGED_EVENTS`, with the
 * event's name: whether our logging hook is registered there, and what else
 * is. P5.sessionlog decides from this, and its generator registers exactly
 * the events it finds missing, each with that event's own evidence as its
 * reason.
 */
export function sessionLogRegistrations(harness, { manifest, root } = {}) {
  return LOGGED_EVENTS.map(event => ({ event, ...registeredHook(harness, event, SESSION_LOG_PATH, null, { manifest, root, kitScripts: GENERATOR_SCRIPT_PATHS }) }));
}

/**
 * The logging hook: `session-log.mjs` on every logged event, with no
 * `matcher`, so the tool events fire for every tool. No evidence gate: the
 * hook records nothing until the log is enabled for the repository on this
 * machine, which no file in the repository can say. An install that
 * predates an event is given only the events it lacks.
 */
function sessionLogProposal({ kitVersion, harness, manifest, root }) {
  const files = hookFiles(SESSION_LOG_PATH, kitVersion);
  const missing = sessionLogRegistrations(harness, { manifest, root }).filter(r => r.state !== 'declared');
  return [...files, ...missing.map(r => ({
    kind: 'settings-hook', event: r.event, step: SESSION_LOG_STEP,
    entry: execEntry(SESSION_LOG_PATH),
    requiresFiles: requiredFiles(files),
    reason: hookRegistrationReason(r.event, r),
  }))];
}

export const TOOL_GATE_STEP = 30;

/**
 * The deny rules for the kit's protected surface: the whole `.claude/scripts/`
 * directory (the hook scripts, the gate interpreter, and any script of the
 * owner's kept there), the committed gate file, the manifest, the learned
 * registry, and this machine's data directory (the session log, the ledger,
 * the policy file and the machine-local gates).
 *
 * The repository paths are `/path` rules: in the project's
 * `.claude/settings.json` that resolves against the session's primary
 * working directory and matches only there, where a bare `path` deny rule
 * would match at any depth. The data directory is a `~/path` rule, from the
 * home directory, and covers only the default data root: an owner who sets
 * `KH_DATA_DIR` must add a rule for that location themselves. `Edit(...)`
 * also covers Write and the Bash file commands Claude Code recognises, but
 * not a program the agent runs that writes these files itself.
 *
 * They end with `commandDenyRules`, which keep the agent from running what
 * approves, weakens or removes a learned gate.
 */
export function toolGateDenyRules() {
  const inRepository = [`${SCRIPTS_DIR}**`, `${dirname(GATES_PATH)}/**`, MANIFEST_PATH, LEARNED_PATH].map(p => `Edit(/${p})`);
  return [...inRepository, 'Edit(~/.claude/kh-harness/**)', ...commandDenyRules()];
}

// The `learn` subcommands that approve a gate, weaken one, or change the
// repository's. `land` and `revert` are denied whole, their dry runs too:
// the owner runs both.
export const LEARN_TERMINAL_SUBCOMMANDS = Object.freeze(['approve', 'wrong', 'demote', 'retire', 'land', 'revert', 'policy set', 'policy clear']);

/** A deny rule for running `subcommand` of the kit script `script`, in the
 * Bash and in the PowerShell tool. A rule's `*` stands for any text, so
 * `*learn.mjs* approve*` matches the command with any path to the script,
 * quoted or not, and any repository path before the subcommand; a deny rule
 * applies to each part of a compound command. */
const COMMAND_TOOLS = Object.freeze(['Bash', 'PowerShell']);
const denyRunning = (script, subcommand) => COMMAND_TOOLS.map(tool => `${tool}(*${script}* ${subcommand}*)`);

/**
 * Deny rules for running the `learn` subcommands that approve a gate,
 * weaken one or change the repository's. They match the command text Claude
 * writes and not the same program reached another way, so they are a second
 * barrier: the subcommand's own terminal check is the one that holds then.
 */
export function learnCommandDenyRules() {
  return LEARN_TERMINAL_SUBCOMMANDS.flatMap(name => denyRunning('learn.mjs', name));
}

/**
 * Deny rules for running `log purge --yes`, which removes this machine's
 * ledger, learnings, policy and local gates, and with them every gate
 * promoted here and every local suspension. `log.mjs` takes a flag before
 * or after the subcommand, so each tool has a rule for either order. The dry
 * run, which carries no `--yes` and removes nothing, matches neither.
 */
function purgeDenyRules() {
  return COMMAND_TOOLS.flatMap(tool => [`${tool}(*log.mjs* purge*--yes*)`, `${tool}(*log.mjs*--yes* purge*)`]);
}

/**
 * Every command deny rule the kit installs, the one list `detect` keeps
 * verbatim, `P5.toolgate` requires, an older install is topped up from and
 * `uninstall` may revert: the `learn` rules and the `log purge --yes` ones.
 */
export function commandDenyRules() {
  return [...learnCommandDenyRules(), ...purgeDenyRules()];
}

/** The deny rules the gate hook is installed with that the settings in
 * effect, as `detect` read them, do not hold. */
export function missingToolGateDenyRules(harness) {
  const present = new Set(harness?.claudeDir?.denyRuleList ?? []);
  return toolGateDenyRules().filter(rule => !present.has(rule));
}

/** Whether our gate hook is registered on PreToolUse, as `P5.toolgate`
 * decides it. */
export const toolGateHookRegistered = ({ harness, manifest, root }) =>
  registeredHook(harness, 'PreToolUse', TOOL_GATE_PATH, '', { manifest, root, kitScripts: GENERATOR_SCRIPT_PATHS }).state === 'declared';

/**
 * The gate hook: a PreToolUse hook that interprets the learned gates (see
 * tool-gate.mjs), with no `matcher`, since a gate may name any tool, and the
 * deny rules that keep the model from editing what enforces it. No evidence
 * gate: which gates exist is learned later, and until one is the hook reads
 * two absent files and does nothing. With the hook already registered, only
 * the deny rules it lacks are proposed, as for an install made before a rule
 * existed.
 */
function toolGateProposal({ kitVersion, check, harness, manifest, root }) {
  const missing = missingToolGateDenyRules(harness);
  const deny = missing.length === 0 ? [] : [{
    kind: 'settings-deny', step: TOOL_GATE_STEP,
    globs: missing,
    reason: "deny edits to the whole .claude/scripts/ directory (the kit's hooks and any script of yours kept there), the gate file, the manifest, the learned registry and this machine's kh-harness data directory under ~/.claude/kh-harness/, and deny running the learn subcommands that approve or weaken a gate and \`log purge --yes\`, which removes this machine's ledger, learnings, policy and local gates: a second barrier behind their own terminal check",
  }];
  if (toolGateHookRegistered({ harness, manifest, root })) return deny;
  const files = hookFiles(TOOL_GATE_PATH, kitVersion);
  return [...files, {
    kind: 'settings-hook', event: 'PreToolUse', step: TOOL_GATE_STEP,
    entry: execEntry(TOOL_GATE_PATH),
    requiresFiles: requiredFiles(files),
    reason: hookRegistrationReason('PreToolUse', check),
  }, ...deny];
}

const BOOTSTRAP_PATH = 'scripts/bootstrap.sh';
const BOOTSTRAP_STEP = 5;

// `installCommand` (and the verbatim command table behind it) lives in
// bootstrap-install.mjs, shared with gap-model.mjs's P1.bootstrap CHECK —
// see that module's own header comment for why: the check and this
// generator must agree on what counts as "derivable" by construction, not
// by two people independently getting the same answer twice.

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
 *
 * `root` is passed through to `installCommand` for exactly one reason: a
 * Yarn lockfile's OWN header is what distinguishes Classic from Berry (see
 * bootstrap-install.mjs) — no other package manager in the table needs
 * file content, only presence.
 *
 * `mode: 0o755` — this file has a shebang and is meant to be executed
 * directly (`./scripts/bootstrap.sh`), not just read; the three shipped
 * hook scripts are invoked via `node <path>`, where the bit is cosmetic,
 * but nothing runs this one except by executing it.
 */
function bootstrapProposal({ kitVersion, stack, files, root }) {
  const install = installCommand(stack.packageManager, files, root);
  if (!install) return [];

  const lines = [];
  if (install.fallback) {
    lines.push(`# No ${install.lockfiles.join(' or ')} found — using the plain install form so this script never silently rewrites a lockfile that does not exist yet. Commit the lockfile it creates, then re-run kh-harness for the reproducible form.`);
  }
  lines.push(install.command);
  lines.push(...bootstrapScriptLines(stack));

  return [{
    kind: 'file', path: BOOTSTRAP_PATH, step: BOOTSTRAP_STEP, mode: 0o755,
    contents: render(read('templates/bootstrap.sh.tmpl'), {
      stamp: versionStamp(kitVersion, BOOTSTRAP_STEP, '#'),
      steps: lines.join('\n'),
    }),
    reason: 'no bootstrap script found',
  }];
}

const PATH_RULE_STEP = 7;

/**
 * What of a package reaches a path-rule file, and why its name does not.
 *
 * `pkg.name` is repository data a dependency or a contributor controls, not
 * something this tool derived. Inside the template's maintainer comment, a
 * name containing `-->` would close that HTML comment early and turn
 * everything after it into text an agent loads. Escaping `-->` is the wrong
 * shape of fix, since the next delimiter nobody thought to escape reopens
 * the hole: the comment (see path-rule.md.tmpl) is fully static and holds
 * no placeholder at all.
 *
 * The heading does not show the name either, at any length: 80 characters
 * is ample room for a complete hostile sentence. It shows `pkg.dir`, which
 * identifies the package as well (the file is named after it, and the
 * frontmatter glob is it) and comes from the repository's own filesystem
 * layout, not from a string chosen freely inside a file's content: the
 * reason a `path` or `dir` field is treated as evidence throughout this
 * codebase while a `name` or a script body never is. `pkg.name` is not
 * passed to the template.
 */

/** Markdown ATX headings are single physical lines; a newline in `dir`
 * would end the heading and let whatever came after it become ordinary
 * (loadable) markdown body text. `<`/`>` are stripped too: Markdown passes
 * raw HTML through, so a value containing `<!--` would open a NEW,
 * genuinely unterminated HTML comment right there in the heading.
 *
 * The 80-character cap is KEPT here even though `dir` is filesystem layout,
 * not free-text prose, and so cannot carry a full hostile sentence the way
 * `pkg.name` could — this is belt-and-suspenders, not the primary defence
 * (dropping the name entirely is), cheap insurance against a directory name
 * unusual enough to be hard to read, never load-bearing for injection
 * safety by itself. Kept deliberately, not left behind by accident: say so
 * here so it is not later read as dead caution and removed. */
function sanitizeForHeading(text) {
  const HEADING_MAX = 80;
  let cleaned = String(text).replace(/[\r\n]+/g, ' ').replace(/[<>]/g, '').trim();
  if (!cleaned.length) cleaned = '(unknown)';
  if (cleaned.length > HEADING_MAX) cleaned = cleaned.slice(0, HEADING_MAX) + '…';
  return cleaned;
}

/** The glob is embedded as a double-quoted YAML scalar (`paths:\n  - "<glob>"`).
 * YAML double-quoted scalars use C-style escapes: an unescaped `"` ends the
 * scalar early (letting whatever follows be parsed as new YAML — a second
 * key, say) and an unescaped `\` starts an escape sequence that may consume
 * the following character unexpectedly. Backslashes are escaped FIRST, so
 * escaping the quote next can never double-escape a quote that was itself
 * introduced by the backslash step. A literal newline inside a double-quoted
 * scalar is also significant to a YAML parser, so it is collapsed to a
 * space, the same defensive choice `sanitizeForHeading` makes. */
function sanitizeForYamlDoubleQuoted(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
}

/**
 * The path-rule scaffold: one file per non-root workspace package, with the
 * glob `pathRuleTargets` (pathrules-evidence.mjs, shared with gap-model.mjs's
 * P1.pathrules CHECK — see that module's own header for why) derives purely
 * from the workspace's own directory layout. The body is deliberately left
 * for the user to fill: the conventions a package needs are theirs, and
 * inventing them is the failure this project exists to avoid.
 *
 * VERIFIED against Claude Code's own documentation
 * (https://code.claude.com/docs/en/memory, sections "Organize rules with
 * .claude/rules/", "Path-specific rules" and "Rule frontmatter reference" —
 * fetched directly while implementing this generator, superseding an
 * earlier, wrong assumption elsewhere in this plan about a different Stop-
 * hook limit):
 *   - the directory is `.claude/rules/`; `.md` files are discovered
 *     recursively;
 *   - the ONLY frontmatter field Claude Code reads from a rule is `paths`
 *     (a YAML list, or a comma-separated string, of glob patterns) — any
 *     other key is ignored without error, and Claude Code strips the
 *     frontmatter entirely before the file reaches context;
 *   - a rule WITHOUT `paths` loads unconditionally every session; one WITH
 *     it loads only when Claude reads a file matching the glob — this is
 *     what makes the file genuinely empty-by-default safe to scaffold;
 *   - `src/**\/* -> All files under src/ directory` is the documented
 *     example for "everything under a directory", the only pattern
 *     derivable from layout alone — this generator never guesses a
 *     narrower, extension-specific glob;
 *   - per the documentation's own "Instructions seem lost after /compact"
 *     section: a project-root CLAUDE.md is re-read from disk and
 *     re-injected after compaction, but a path-scoped rule is NOT —
 *     it returns to context only the next time Claude reads a matching
 *     file. That is the verified fact behind the compaction comment this
 *     template carries, not a guess.
 * NOT separately verified, and therefore stated as inference, not fact, in
 * the template's own comment: whether an empty-of-prose rule body (just a
 * heading and an HTML comment, no actual "rule" sentence) is accepted.
 * Nothing in the documentation suggests a non-empty body is required — a
 * rule file is ordinary markdown loaded as context — but this was not
 * independently confirmed against a running Claude Code session.
 *
 * The body is deliberately NOT a rule: a real heading and everything else
 * inside a single, FULLY STATIC HTML comment (see the sanitization comment
 * immediately above this one for why no interpolation happens inside it) —
 * a prompt for the human maintaining this file, not content a future read
 * of it could mistake for an instruction. Same discipline as
 * protectedPathProposal and bootstrapProposal above, applied to prose
 * instead of deny rules or install steps: write only what detection
 * proved, and say so.
 *
 * The heading shows `pkg.dir`, never `pkg.name`: see the comment above
 * `sanitizeForHeading`, and that function's own comment for why the
 * character and length cap is kept on `dir` anyway.
 */
function pathRuleProposal({ kitVersion, stack }) {
  return pathRuleTargets(stack).map(t => ({
    kind: 'file', path: t.path, step: PATH_RULE_STEP,
    contents: render(read('templates/path-rule.md.tmpl'), {
      stamp: versionStamp(kitVersion, PATH_RULE_STEP, '<!--') + ' -->',
      glob: sanitizeForYamlDoubleQuoted(t.glob),
      dir: sanitizeForHeading(t.dir),
    }),
    reason: `scaffold a path-scoped rule file for ${t.name} (${t.dir})`,
  }));
}

const RULES_STEP = 27;

/**
 * The rules-registry scaffold (Phase 3, step 27): `docs/harness/RULES.md`
 * from a template whose entire body — schema, enforcer list, one worked
 * example — sits inside a single static HTML comment under one heading.
 * Same discipline as `pathRuleProposal`: the kit scaffolds the SHAPE and
 * never a rule, because a rule it invented would be exactly the opinion-
 * without-basis this project refuses, loaded into the model's context as
 * if the repository had stated it.
 *
 * Two properties other modules rely on, both pinned in propose.test.mjs:
 *   - `parseRules(contents)` yields zero rules — harness-redact.mjs blanks
 *     HTML comments before parsing, so the example is inert until a human
 *     writes a rule OUTSIDE the comment;
 *   - `markdownRemainder(contents)` is empty and equals the raw template's
 *     — uninstall-lib.mjs's `hasUserAuthoredBody` compares the on-disk file
 *     against the RAW template to decide whether the user has written into
 *     it, and the only placeholder is `{{stamp}}`, which renders to a
 *     comment. A filled registry is therefore always kept on uninstall.
 */
function rulesScaffoldProposal({ kitVersion }) {
  return [{
    kind: 'file', path: RULES_PATH, step: RULES_STEP,
    contents: render(read('templates/RULES.md.tmpl'), { stamp: versionStamp(kitVersion, RULES_STEP, '<!--') + ' -->' }),
    reason: 'no rules registry found',
  }];
}

const FAILURES_STEP = 29;

/**
 * The failure taxonomy scaffold (Phase 5, step 29): `docs/harness/FAILURES.md`
 * from a template whose schema and worked example sit inside one static HTML
 * comment under one heading. The kit scaffolds the shape and never a failure
 * kind: naming what kind of failure a recurrence is belongs to a person.
 * `rulesScaffoldProposal`'s two properties hold here for the same reasons,
 * with `parseFailures` in place of `parseRules`; both are pinned in
 * propose.test.mjs.
 */
function failuresScaffoldProposal({ kitVersion }) {
  return [{
    kind: 'file', path: FAILURES_PATH, step: FAILURES_STEP,
    contents: render(read('templates/FAILURES.md.tmpl'), { stamp: versionStamp(kitVersion, FAILURES_STEP, '<!--') + ' -->' }),
    reason: 'no failure taxonomy found',
  }];
}

const REINJECT_STEP = 28;

/**
 * The re-injection hook (Phase 3, step 28): `rules-brief.mjs`, the module
 * it loads and a `UserPromptSubmit` registration, the same shape as
 * `P4.sessionbrief` (see `hookFiles`, and `unmetDependencies` in
 * apply-lib.mjs on how `requiresFiles` keeps the hook from being registered
 * before what it loads is on disk).
 *
 * No `matcher`: UserPromptSubmit has no tool to match on, and
 * `buildMatcherEntry` omits the key entirely when none is passed.
 *
 * Gated on the registry holding at least one rule to inject — its
 * `injectable` count, read from `harness.rulesRegistry`, the SAME evidence
 * gap-model.mjs's P3.reinject check decides from, so check and generator
 * agree by construction. This
 * is the defensive SECOND gate, independent of the check-level `decidable`
 * flag `buildProposals` enforces centrally — `bootstrapProposal` keeps the
 * same belt-and-braces for the same reason: a hook with nothing to inject
 * is noise on every prompt, and no forced check may produce one.
 */
function reinjectProposal({ kitVersion, harness, check }) {
  if (!(harness?.rulesRegistry?.injectable > 0)) return [];
  const files = hookFiles(RULES_BRIEF_PATH, kitVersion);
  return [...files, {
    kind: 'settings-hook', event: 'UserPromptSubmit', step: REINJECT_STEP,
    entry: execEntry(RULES_BRIEF_PATH),
    requiresFiles: requiredFiles(files),
    reason: hookRegistrationReason('UserPromptSubmit', check),
  }];
}

/**
 * Every script a generator registers as a hook, with the kit asset it copies
 * and the runbook step its stamp names. uninstall reverts a hook patch only
 * when the entry runs one of these, and deletes only the scripts and modules
 * listed here and in `HOOK_MODULES`, so a hook script a generator registers
 * must be listed here or neither its registration nor its file can ever be
 * removed.
 */
const HOOK_SCRIPTS = Object.freeze({
  [LINT_TOUCHED_PATH]: { asset: 'scripts/lint-touched.mjs', step: 9, reason: 'no PostToolUse hook registered' },
  [VERIFY_TOUCHED_PATH]: { asset: 'scripts/verify-touched.mjs', step: 10, reason: 'no Stop hook registered' },
  [BRIEF_PATH]: { asset: 'scripts/session-brief.mjs', step: 16, reason: 'no SessionStart brief hook registered' },
  [RULES_BRIEF_PATH]: { asset: 'scripts/rules-brief.mjs', step: REINJECT_STEP, reason: 'no UserPromptSubmit re-injection hook registered' },
  [LOOP_WATCH_PATH]: { asset: 'scripts/loop-watch.mjs', step: LOOP_WATCH_STEP, reason: 'no PostToolUseFailure loop-warning hook registered' },
  [SESSION_LOG_PATH]: { asset: 'scripts/session-log.mjs', step: SESSION_LOG_STEP, reason: 'no session-log hook registered' },
  [TOOL_GATE_PATH]: { asset: 'scripts/tool-gate.mjs', step: TOOL_GATE_STEP, reason: 'no PreToolUse gate hook registered' },
});
const GENERATOR_SCRIPT_PATHS = Object.freeze(Object.keys(HOOK_SCRIPTS));

/**
 * The modules the hook scripts load. Each is a verbatim copy of its asset
 * under a stamp that names no step, so its bytes are the same whichever
 * hook proposes it; `step` is the manifest's bookkeeping alone. Which hook
 * needs which module is not listed here: it is read from the scripts (see
 * `loadedSiblings`).
 */
const HOOK_MODULES = Object.freeze({
  [HARNESS_GATES_PATH]: { asset: 'scripts/harness-gates.mjs', step: TOOL_GATE_STEP, reason: 'the gate language the PreToolUse gate hook interprets' },
  [HARNESS_LOG_PATH]: { asset: 'scripts/harness-log.mjs', step: TOOL_GATE_STEP, reason: 'the session log library the logging hook writes with and the gate hook records firings with' },
  [HARNESS_SEAL_PATH]: { asset: 'scripts/harness-seal.mjs', step: SESSION_LOG_STEP, reason: 'the module the logging hook loads at session start to seal closed sessions and expire old content' },
  [REDACT_PATH]: { asset: 'scripts/harness-redact.mjs', step: 9, reason: 'the redaction and shared-path module every hook script loads' },
});
const HOOK_MODULE_PATHS = Object.freeze(Object.keys(HOOK_MODULES));

/** Everything the kit installs under `.claude/scripts/`: the hook scripts,
 * then the modules. */
const INSTALLED_SCRIPTS = Object.freeze({ ...HOOK_SCRIPTS, ...HOOK_MODULES });
const INSTALLED_SCRIPT_PATHS = Object.freeze(Object.keys(INSTALLED_SCRIPTS));

const siblingsByPath = new Map();

/**
 * The installed scripts the one at `path` loads, read from its asset: every
 * quoted `./<name>.mjs` in its text, which covers a static import, a
 * dynamic one and a table of specifiers alike. A quoted name in a comment
 * counts too; counting one that is not loaded only ties two scripts' versions
 * together, the safe direction. A name the kit does not install throws: a
 * script that loads a file `apply` never writes dies on every event.
 */
export function loadedSiblings(path) {
  if (!siblingsByPath.has(path)) {
    const { asset } = INSTALLED_SCRIPTS[path];
    const siblings = [];
    for (const [, , name] of read(asset).matchAll(/(['"])\.\/([\w.-]+\.mjs)\1/g)) {
      const sibling = SCRIPTS_DIR + name;
      if (!Object.hasOwn(INSTALLED_SCRIPTS, sibling)) throw new Error(`assets/${asset} names ./${name}, which the kit does not install`);
      if (sibling !== path && !siblings.includes(sibling)) siblings.push(sibling);
    }
    siblingsByPath.set(path, siblings);
  }
  return siblingsByPath.get(path);
}

/** Every installed script `path` loads, directly or through another, in
 * `INSTALLED_SCRIPT_PATHS` order. */
export function everyLoadedSibling(path) {
  const seen = new Set([path]);
  const pending = [path];
  while (pending.length) {
    for (const sibling of loadedSiblings(pending.pop())) {
      if (seen.has(sibling)) continue;
      seen.add(sibling);
      pending.push(sibling);
    }
  }
  return INSTALLED_SCRIPT_PATHS.filter(p => p !== path && seen.has(p));
}

/** What the kit writes at the installed path `path`: its asset under the
 * machinery stamp, after the shebang for a hook script and first for a
 * module. */
function installedScriptProposal(path, kitVersion) {
  const { asset, step, reason } = INSTALLED_SCRIPTS[path];
  const contents = Object.hasOwn(HOOK_SCRIPTS, path)
    ? read(asset).replace('#!/usr/bin/env node\n', `#!/usr/bin/env node\n${machineryStamp(kitVersion, `runbook step ${step}`, '//')}\n`)
    : `${machineryStamp(kitVersion, "shared module loaded by the kit's hook scripts", '//')}\n${read(asset)}`;
  return { kind: 'file', path, step, contents, assetSource: asset, reason };
}

/**
 * The files a hook script needs on disk: the script itself and every
 * installed script it loads, directly or through another. Built from the
 * kit's assets alone, with no repository fact, so what the kit would write
 * for an installed copy never depends on whether the hook's evidence gate is
 * on today. A hook's settings proposal requires exactly these files, each
 * holding exactly these bytes (`requiredFiles`).
 */
function hookFiles(scriptPath, kitVersion) {
  return [scriptPath, ...everyLoadedSibling(scriptPath)].map(path => installedScriptProposal(path, kitVersion));
}

/** What a settings-hook proposal carries as `requiresFiles`: each file the
 * hook loads, with the hash of what this kit writes there. `apply` registers
 * the hook only when every one is on disk holding that. */
const requiredFiles = files => files.map(f => ({ path: f.path, sha256: sha256(f.contents) }));

const KITSKEW_ID = 'P0.kitskew';

/** What this kit generates at each path. The installed scripts are all
 * there, whatever the hooks' evidence gates say today; every other file
 * comes from every generator but the skew check's own, called with the
 * context `buildProposals` gives them. */
function currentKitFiles({ kitVersion, harness, root, stack, checks, files, manifest }) {
  const byPath = new Map(INSTALLED_SCRIPT_PATHS.map(path => [path, installedScriptProposal(path, kitVersion)]));
  for (const [id, gen] of Object.entries(GENERATORS)) {
    if (id === KITSKEW_ID) continue;
    const check = checks.find(c => c.id === id);
    for (const p of gen({ kitVersion, harness, root, stack, checks, files, manifest, check })) {
      if (p.kind === 'file' && !byPath.has(p.path)) byPath.set(p.path, p);
    }
  }
  return byPath;
}

/** The kit version the stamp in the file at `relPath` names, or null when
 * the file cannot be read or carries no stamp. */
function versionOnDisk(root, relPath) {
  try {
    return stampVersion(readFileSync(join(root, relPath), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The first evidence line of the skew check, from the versions the recorded
 * files themselves carry (`versions`, one per stamped file on disk): the
 * one version when every file is this kit's, "installed kit 0.1.0, current
 * kit 0.2.0" when every file is another's, and each other version with its
 * count when they are mixed. The manifest's own `kitVersion` is the version
 * that last wrote anything, which says nothing about a file that run left
 * alone.
 */
function kitVersions(versions, current) {
  const counts = new Map();
  for (const v of versions) if (v !== current) counts.set(v, (counts.get(v) ?? 0) + 1);
  if (counts.size === 0) return `kit ${current}`;
  if (counts.size === 1 && [...counts.values()][0] === versions.length) return `installed kit ${[...counts.keys()][0]}, current kit ${current}`;
  const others = [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([v, n]) => `${n} from kit ${v}`).join(', ');
  return `current kit ${current}; of ${versions.length} installed files that carry a stamp, ${others}`;
}

/** Why a file the kit now generates differently is out of date. A file this
 * kit version wrote can only differ because the repository's detected facts
 * moved. */
function updateReason(installed, current) {
  return installed === current
    ? `kit ${current}; this repository's detected facts changed since it was written`
    : `installed kit ${installed}, current kit ${current}`;
}

/** The installed scripts in groups that load one another, directly or
 * through others: each group is written at one kit version or not at all. */
function versionUnits() {
  const unitOf = new Map(INSTALLED_SCRIPT_PATHS.map(path => [path, new Set([path])]));
  for (const path of INSTALLED_SCRIPT_PATHS) {
    for (const sibling of loadedSiblings(path)) {
      const a = unitOf.get(path);
      const b = unitOf.get(sibling);
      if (a === b) continue;
      for (const member of b) {
        a.add(member);
        unitOf.set(member, a);
      }
    }
  }
  return new Set(unitOf.values());
}

/** True when the file at `relPath` holds exactly `contents`, line endings
 * aside. A file that cannot be read does not. */
function holdsExactly(root, relPath, contents) {
  try {
    return contentMatches(readFileSync(join(root, relPath)), sha256(contents));
  } catch {
    return false;
  }
}

/** Why the file on disk at an installed script's path will not hold what
 * this kit writes there after an `apply`, or null when it will: it is
 * absent, already holds it, or is recorded, unmodified and stamped, so it is
 * updated. */
function keptAs(root, manifest, entry, path, contents) {
  if (!existsSync(join(root, path)) || holdsExactly(root, path, contents)) return null;
  if (!entry) return 'unrecorded';
  const status = recordedFileStatus(root, manifest, entry, contents);
  return status === 'edited' || status === 'unstamped' ? status : null;
}

const KEPT_WHY = Object.freeze({
  edited: 'edited since kh-harness wrote it',
  unstamped: 'does not carry the kh-harness stamp',
  unrecorded: 'not recorded in the manifest as written by kh-harness',
});

/**
 * The installed scripts that must not be written, each mapped to the files
 * that hold it, `[{ path, why }]`. Scripts that load one another are one
 * version unit, because a script written by one kit can die at import next
 * to a module written by another. A file on disk in a unit that `apply`
 * will not bring to this kit's version (edited, not carrying the stamp, or
 * not recorded at all) holds every member of the unit, itself included: none
 * is written, updated or newly registered. A deleted file holds nothing.
 */
export function heldScripts(root, manifest, kitVersion) {
  const recorded = new Map((manifest?.files ?? []).map(f => [f.path, f]));
  const kept = INSTALLED_SCRIPT_PATHS.flatMap(path => {
    const why = keptAs(root, manifest, recorded.get(path), path, installedScriptProposal(path, kitVersion).contents);
    return why === null ? [] : [{ path, why }];
  });
  const held = new Map();
  for (const unit of versionUnits()) {
    const causes = kept.filter(k => unit.has(k.path));
    if (causes.length) for (const path of INSTALLED_SCRIPT_PATHS) if (unit.has(path)) held.set(path, causes);
  }
  return held;
}

/** "a (edited since kh-harness wrote it), b (…)" for the files that hold a
 * unit. */
const keptList = causes => causes.map(c => `${c.path} (${KEPT_WHY[c.why]})`).join(', ');

/** What the owner can do about the files that hold a unit, as an
 * imperative clause. */
function releaseAdvice(causes) {
  const advice = [];
  if (causes.some(c => c.why === 'edited')) advice.push('restore each edited file to what kh-harness wrote (git holds it, in the commit that installed it)');
  if (causes.some(c => c.why !== 'edited')) advice.push('move each file kh-harness did not write out of .claude/scripts/');
  return advice.join(', and ');
}

/** The evidence line of a hook check whose script is held: the files that
 * hold it, why, and the owner's two choices. */
export function heldHookEvidence(scriptPath, causes) {
  return `${scriptPath} is not written or registered while kh-harness keeps ${keptList(causes)} as ${causes.length === 1 ? 'it is' : 'they are'}: ` +
    `its hook scripts load one another, so they are installed at one kit version or not at all. ` +
    `To install this hook, ${releaseAdvice(causes)}, then run apply again; left as it is, this hook stays off.`;
}

/** The one question every hook check held by `causes` asks, so the reports
 * that list questions state the hold once. */
export function heldQuestion(causes) {
  return `kh-harness keeps ${keptList(causes)} as ${causes.length === 1 ? 'it is' : 'they are'}, and so writes and updates none of its hook scripts. ` +
    `${releaseAdvice(causes).replace(/^./, c => c.toUpperCase())}, then run apply again; or leave ${causes.length === 1 ? 'it' : 'them'}, and the hooks not yet installed stay off. Which?`;
}

/**
 * Every file the manifest records, against what this kit generates for it
 * today. `updates` are proposals for the files `recordedFileStatus` calls
 * `update`; `heldBack` the files it calls `update` that `heldScripts`
 * holds, each with the `causes` that hold it; `kept` names the files that
 * are not the kit's to write, with the status that says why; `unproduced`
 * the recorded paths no generator produces for this repository any more,
 * which are left alone. A `heldBack` or `kept` entry carries `version`,
 * the kit version its stamp names on disk, or null.
 */
export function kitSkew({ kitVersion, harness, root, stack, checks, files, manifest }) {
  const produced = currentKitFiles({ kitVersion, harness, root, stack, checks, files, manifest });
  const held = heldScripts(root, manifest, kitVersion);
  const skew = { versions: '', current: [], updates: [], heldBack: [], kept: [], unproduced: [] };
  const carried = [];
  for (const entry of manifest.files) {
    const p = produced.get(entry.path);
    if (!p) {
      skew.unproduced.push(entry.path);
      continue;
    }
    const version = versionOnDisk(root, entry.path);
    if (version !== null) carried.push(version);
    const status = recordedFileStatus(root, manifest, entry, p.contents);
    if (status === 'current') skew.current.push(entry.path);
    else if (status !== 'update') skew.kept.push({ path: entry.path, why: status, version });
    else if (held.has(entry.path)) skew.heldBack.push({ path: entry.path, causes: held.get(entry.path), version });
    else skew.updates.push({ ...p, reason: updateReason(version, kitVersion) });
  }
  skew.versions = kitVersions(carried, kitVersion);
  return skew;
}

/** Generators receive the full detection context and return proposals.
 * { kitVersion, harness, root, stack, checks, files, manifest, check } are
 * available to all generators — `check` is THIS generator's own entry from `checks`
 * (buildProposals passes it alongside the full array), carrying the exact
 * `evidence` detect's own report already printed for it (see
 * `hookRegistrationReason`, above, which is why a settings-hook proposal's
 * `reason` can reuse detect's wording instead of a second, driftable copy).
 * A generator yields nothing by returning an empty array or not being
 * registered. */
const GENERATORS = {
  'P4.handoff': ({ kitVersion }) => ([{
    kind: 'file', path: 'HANDOFF.md', step: 16,
    contents: render(read('templates/HANDOFF.md.tmpl'), { stamp: versionStamp(kitVersion, 16, '<!--') + ' -->' }),
    reason: 'no handoff file found',
  }]),
  'P4.sessionbrief': ({ kitVersion, check }) => {
    const files = hookFiles(BRIEF_PATH, kitVersion);
    return [...files, {
      kind: 'settings-hook', event: 'SessionStart', step: 16,
      entry: execEntry(BRIEF_PATH),
      requiresFiles: requiredFiles(files),
      reason: hookRegistrationReason('SessionStart', check),
    }];
  },
  'P2.protected': protectedPathProposal,
  'P2.sensor': sensorProposal,
  'P2.stopgate': stopgateProposal,
  'P2.loopwatch': loopWatchProposal,
  'P1.bootstrap': bootstrapProposal,
  'P1.pathrules': pathRuleProposal,
  'P3.rules': rulesScaffoldProposal,
  'P3.reinject': reinjectProposal,
  'P5.failures': failuresScaffoldProposal,
  'P5.sessionlog': sessionLogProposal,
  'P5.toolgate': toolGateProposal,
  // Each update goes through `buildProposals`' recorded-path branch like any
  // other proposal for a recorded file.
  [KITSKEW_ID]: ctx => kitSkew(ctx).updates,
  // No entry for 'P3.intent', deliberately and permanently: like steps 6
  // and 7a, docs/INTENT.md is written by the skill after reading the
  // repository and gated on its full content (propose.test.mjs's "SECRET:
  // P3.intent has no registered generator" pins this).
};

/**
 * Where a recorded file stands against `contents`, what the kit generates
 * for it now. Only `update` permits a write, and it needs all three: the
 * file is still what we wrote, line endings aside (`edited` covers a
 * user's edit and a deletion); the generated content differs (`current`
 * otherwise, so `current` is also true of the bytes on disk); and the bytes
 * on disk carry the kit's stamp, because the manifest is a file in the
 * repository and a forged entry naming a user's own file with its real
 * hash also classifies `ours-unmodified` (`unstamped`; `uninstall` refuses
 * the same shape before deleting).
 */
function recordedFileStatus(root, manifest, entry, contents) {
  if (classify(root, manifest, entry.path) !== 'ours-unmodified') return 'edited';
  if (sha256(contents) === entry.sha256) return 'current';
  if (!carriesStamp(root, entry.path)) return 'unstamped';
  return 'update';
}

/**
 * The proposals for every check that is `absent` and decidable, each from
 * the generator registered for the check's id.
 *
 * `generators` extends or overrides the production table for one call, so a
 * test can inject a probe generator without it living in the table every
 * run reads.
 *
 * `files` has no default: a caller that forgot it would get "no evidence,
 * therefore no proposal" from `P2.protected`, silently. Omitting it is a
 * `TypeError` inside the evidence filter instead.
 *
 * A file is proposed once per run however many generators want it:
 * `alreadyWritten` starts from the manifest and grows with this run's own
 * proposals, and every hook generator proposes the modules its script loads.
 *
 * A path the manifest records is proposed again only as an update: when the
 * file is still what the kit wrote (line endings aside), still carries the
 * stamp, and the generated content has changed. `P0.kitskew`'s generator
 * proposes every such file, whatever its owning check's state. A recorded
 * file the owner edited or deleted is never proposed again: the edit or the
 * deletion is a decision, not a gap to fill.
 *
 * A script `heldScripts` holds is not written, and a hook that loads one is
 * not registered, whatever the hook's check says: `root` is what lets that
 * be read, and without it nothing is held.
 */
export function buildProposals({ checks, manifest, kitVersion, harness, root, stack, files, generators = {} }) {
  const registry = { ...GENERATORS, ...generators };
  const recorded = new Map((manifest?.files ?? []).map(f => [f.path, f]));
  const held = root ? heldScripts(root, manifest, kitVersion) : new Map();
  const alreadyWritten = new Set(recorded.keys());
  const out = [];
  for (const c of checks) {
    // Both gates, read from the check — never re-derived here.
    if (c.state !== 'absent' || c.decidable === false) continue;
    const gen = registry[c.id];
    if (!gen) continue;
    for (const p of gen({ kitVersion, harness, root, stack, checks, files, manifest, check: c })) {
      if (p.kind === 'file' && held.has(p.path)) continue;
      if (p.kind === 'settings-hook' && (p.requiresFiles ?? []).some(f => held.has(f.path))) continue;
      if (p.kind === 'file' && alreadyWritten.has(p.path)) {
        // Once per run: the first generator to want a stale file gets the
        // update; later ones find it in `recorded` no longer and in
        // `alreadyWritten` still, so they skip. The `reason` says why,
        // because it is printed at the gate.
        const entry = recorded.get(p.path);
        const upgradable = root && entry && recordedFileStatus(root, manifest, entry, p.contents) === 'update';
        if (!upgradable) continue;
        recorded.delete(p.path);
        out.push({ ...p, checkId: c.id, reason: `update ${p.path} — unmodified since kh-harness wrote it, and the generated content has changed (${p.reason})` });
        continue;
      }
      out.push({ ...p, checkId: c.id });
      if (p.kind === 'file') alreadyWritten.add(p.path);
    }
  }
  return out;
}

// `GENERATORS` is exported for propose.test.mjs's coherence test: every
// check that advertises a proposal and has a generator registered for its id
// must produce something when applied. The test membership-tests each real
// check's id against this table, not a hand-kept list of ids, so a
// capability added here later is covered with no test edit.
export { BRIEF_PATH, LINT_TOUCHED_PATH, VERIFY_TOUCHED_PATH, REDACT_PATH, BOOTSTRAP_PATH, RULES_BRIEF_PATH, LOOP_WATCH_PATH, SESSION_LOG_PATH, TOOL_GATE_PATH, HARNESS_GATES_PATH, HARNESS_LOG_PATH, HARNESS_SEAL_PATH, RULES_PATH, SENSOR_MATCHER, GENERATORS, GENERATOR_SCRIPT_PATHS, HOOK_MODULE_PATHS, INSTALLED_SCRIPT_PATHS };
