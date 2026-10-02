import { readFileSync } from 'node:fs';
import { render, versionStamp, STAMP_MARKER } from './render.mjs';
import { selectProfile } from './profiles/index.mjs';
import { installCommand } from './bootstrap-install.mjs';
import { hasLintScript } from './sensor-evidence.mjs';
import { rootVerifyScript } from './stopgate-evidence.mjs';
import { protectedPathCandidates } from './protected-evidence.mjs';
import { pathRuleTargets } from './pathrules-evidence.mjs';

const ASSETS = new URL('../../assets/', import.meta.url);
const read = rel => readFileSync(new URL(rel, ASSETS), 'utf8');

const BRIEF_PATH = '.claude/scripts/session-brief.mjs';
const LINT_TOUCHED_PATH = '.claude/scripts/lint-touched.mjs';
const VERIFY_TOUCHED_PATH = '.claude/scripts/verify-touched.mjs';
// Shared by ALL THREE installed hooks — lint-touched.mjs (PostToolUse),
// verify-touched.mjs (Stop) and, since the whole-branch review's F3/F4,
// session-brief.mjs (SessionStart). See harness-redact.mjs's own comment
// for why a shared module exists at all. Each script imports it via a
// relative `./harness-redact.mjs`, so it must always land in the SAME
// directory as each of them.
const REDACT_PATH = '.claude/scripts/harness-redact.mjs';

/**
 * Task 9b, finding 2: a settings-hook proposal's own `reason` used to be a
 * hardcoded "no <event> hook registered in .claude/settings.json" — true
 * only when the event is genuinely empty. When a user already has an
 * UNRELATED hook on the same event (the exact shape gap-model.mjs's
 * `registeredHook` exists to disclose, never suppress), that sentence is
 * printed immediately above apply-lib.mjs's own diff caveat
 * "(appended after N existing hooks.<event> entries, ...)" — two adjacent,
 * self-contradicting claims about the same file. `detect` already gets this
 * right (gap-model.mjs's `registeredHook`, evidence: "<event> hook already
 * registered, but not ours: <path>"); this reuses that EXACT text — the
 * check's own `evidence`, passed through from buildProposals, never a
 * second independently-worded copy that could drift from it — rather than
 * writing a third phrasing.
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
function protectedPathProposal({ stack, files }) {
  const surviving = protectedPathCandidates({ stack, files });
  if (surviving.length === 0) return [];
  return [{
    kind: 'settings-deny', step: 11,
    globs: surviving.map(g => `Edit(${g})`),
    reason: 'deny edits to protected paths found in this repository',
  }];
}

/**
 * The shared module every installed hook imports — lint-touched.mjs's
 * PostToolUse sensor, verify-touched.mjs's Stop gate and session-brief.mjs's
 * SessionStart brief — see harness-redact.mjs's own comment for why it
 * exists at all. Returned by EACH of the three generators independently —
 * not only by whichever happens to run first — so that satisfying just one
 * of the three checks (the others already `declared`, or installed by an
 * earlier run) still brings this file along.
 *
 * Whole-branch review, F3/F4: session-brief.mjs became the third importer
 * when it stopped carrying its own line-only bound and its own idea of where
 * the handoff file is. `P4.sessionbrief`'s generator therefore proposes this
 * file too, and lists it in `requiresFiles` — without BOTH, a repository
 * that qualifies for the brief and for neither process hook (no `lint`
 * script, no root `typecheck`/`test` script — which is every repository
 * with no declared scripts at all, and the brief has no evidence gate) would
 * get a SessionStart hook registered against a script that dies with
 * ERR_MODULE_NOT_FOUND on every session. That is review finding 5's exact
 * shape, and `missingDependencies` (apply-lib.mjs) is what enforces it
 * against the real filesystem.
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
    // Carries the same `STAMP_MARKER` every other generated file does
    // (via `versionStamp` elsewhere in this file), inline rather than
    // through that function because this comment's wording is bespoke —
    // see render.mjs's own comment on why uninstall-lib.mjs depends on
    // this literal text being present verbatim.
    contents: `// ${STAMP_MARKER} ${kitVersion} (shared asset used by the PostToolUse, Stop and SessionStart hooks). ` +
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
function sensorProposal({ kitVersion, stack, check }) {
  if (!hasLintScript(stack)) return [];
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
    lines.push(`# No ${install.lockfiles.join(' or ')} found — using the plain install form so this script never silently rewrites a lockfile that does not exist yet. Commit the lockfile it creates, then re-run harness-kit for the reproducible form.`);
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
 * Coordinator finding (round 3, Major, "the serious one"): `pkg.name` —
 * repository data a dependency or a contributor controls, not something
 * this tool derived — used to be interpolated unescaped INTO the template's
 * maintainer comment. A manifest name containing `-->` closes that HTML
 * comment early, turning everything after it into agent-loadable text:
 * exactly the "comments, not content" invariant this whole scaffold exists
 * to uphold, broken by the one piece of untrusted data it carried. The fix
 * is not escaping `-->` inside the comment — untrusted data inside a
 * comment delimiter is the wrong SHAPE of fix, because the next delimiter
 * nobody thought to escape (a stray `<!--` reopening, say) reintroduces the
 * same hole. Instead: the comment (see path-rule.md.tmpl) is now FULLY
 * STATIC — it contains no placeholder at all.
 *
 * Round 4 then capped the heading's `pkg.name` at 80 characters, reasoning
 * that a SHORT fragment reads as corrupt data rather than an instruction.
 * Round 5 (coordinator): that was still a BOUNDING fix on the same shape —
 * 80 characters is ample room for a complete hostile sentence; truncation
 * bounded the length and did nothing about legibility. The static-comment
 * redesign in round 3 held against an attack never explicitly anticipated
 * BECAUSE it removed the shape (untrusted data inside a delimiter)
 * entirely, rather than narrowing it. The same move applies here: `pkg.name`
 * — attacker-authored PROSE from a file's contents — is dropped from the
 * heading ENTIRELY. The heading now shows `pkg.dir` instead: the directory
 * identifies the package exactly as well (the file is already named after
 * it, and the frontmatter glob already IS it), and a directory comes from
 * the repository's own FILESYSTEM LAYOUT, not from parsing a string a
 * dependency or contributor chose freely inside a file's content — the
 * same reason a `path` or `dir` field is treated as real evidence
 * throughout this codebase while a `name`/script BODY never is (see
 * detect-stack.mjs's own comment on why `scripts` carries names, never
 * bodies). `pkg.name` is no longer passed to the template at all.
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
 * inventing them is the failure this project exists to avoid (brief, Task 6).
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
 * The heading shows `pkg.dir`, never `pkg.name` (coordinator, round 5): the
 * directory already identifies the package everywhere else in this file —
 * the proposal's own `path` is named after it, and the frontmatter `glob`
 * already IS it — so showing the package's declared NAME there adds a
 * second identifier for the one thing, and that name is attacker-authored
 * prose from a file's content in a way a directory, read off the
 * repository's own filesystem layout, structurally cannot be. One
 * identifier for one thing, taken from the one source that cannot carry a
 * sentence, closes the heading as an injection vector rather than merely
 * narrowing it — see `sanitizeForHeading`'s own comment for why the
 * character/length cap is kept on `dir` anyway, as insurance, not as the
 * fix.
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

/** Generators receive the full detection context and return proposals.
 * { kitVersion, harness, root, stack, checks, files, check } are available
 * to all generators — `check` is THIS generator's own entry from `checks`
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
  'P4.sessionbrief': ({ kitVersion, check }) => [{
    kind: 'file', path: BRIEF_PATH, step: 16,
    contents: read('scripts/session-brief.mjs').replace(
      '#!/usr/bin/env node\n',
      `#!/usr/bin/env node\n${versionStamp(kitVersion, 16, '//')}\n`,
    ),
    reason: 'no SessionStart brief hook registered',
  }, redactAssetProposal(kitVersion), {
    kind: 'settings-hook', event: 'SessionStart', step: 16,
    entry: { type: 'command', command: `node ${BRIEF_PATH}` },
    // Whole-branch review, F3/F4: session-brief.mjs now imports the shared
    // `harness-redact.mjs` (for `boundReport`, `projectRoot` and
    // `findHandoff`), so it has exactly the dependency the other two hooks
    // have and it is declared here the same way. See `redactAssetProposal`'s
    // own comment for why every generator that needs it proposes it, and
    // `missingDependencies` (apply-lib.mjs) for the filesystem check that
    // keeps the hook from being REGISTERED without it.
    requiresFiles: [BRIEF_PATH, REDACT_PATH],
    reason: hookRegistrationReason('SessionStart', check),
  }],
  'P2.protected': protectedPathProposal,
  'P2.sensor': sensorProposal,
  'P2.stopgate': stopgateProposal,
  'P1.bootstrap': bootstrapProposal,
  'P1.pathrules': pathRuleProposal,
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
    for (const p of gen({ kitVersion, harness, root, stack, checks, files, check: c })) {
      if (p.kind === 'file' && alreadyWritten.has(p.path)) continue;
      out.push({ ...p, checkId: c.id });
      if (p.kind === 'file') alreadyWritten.add(p.path);
    }
  }
  return out;
}

// Exported for propose.test.mjs's generic coherence test: "every check that
// advertises a proposal, and has a generator registered for its id, must
// actually produce something when applied." That test iterates over the
// CHECKS a real detection run produces and membership-tests each one's id
// against this table (`c.id in GENERATORS`), rather than a hand-maintained
// list of ids, so a capability added here later is automatically covered —
// a planted new drifting generator is caught with no test edit (see the
// coherence test's own comment). This is deliberately a review correction:
// coordinator finding that caught P1.bootstrap drifting from its own
// generator (a pyproject-only Python repo: `detect` advertised a proposal,
// `apply` produced nothing) without any test failing, because nothing
// checked the two against each other.
export { BRIEF_PATH, LINT_TOUCHED_PATH, VERIFY_TOUCHED_PATH, REDACT_PATH, BOOTSTRAP_PATH, GENERATORS };
