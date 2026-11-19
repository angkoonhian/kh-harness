// scripts/lib/hook-evidence.mjs
//
// Whether a kit hook is registered, judged once for every caller:
// gap-model.mjs's hook checks, propose.mjs's session-log generator (which
// must register exactly the events P5.sessionlog finds missing) and
// rules-evidence.mjs's hook pointers. The entry form every generator
// registers a hook in lives here too, because the install record is
// matched against it. A module of its own because gap-model.mjs imports
// propose.mjs, so propose.mjs cannot import gap-model.mjs.
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { hookEntrySha256, matcherCovers, normalizeMatcher } from './settings-merge.mjs';

/**
 * A hook entry in Claude Code's EXEC form (audit Tier 3, finding 11): the
 * executable and an argument vector, "spawned directly … with no shell
 * involved", with the script rooted at `${CLAUDE_PROJECT_DIR}` — "the
 * project root where the session started" — which the reference says to
 * prefer for any path placeholder. The shell form this replaced
 * (`node .claude/scripts/x.mjs`) paid ~260 ms of shell per invocation and
 * a cwd-relative path that stopped resolving after `cd`. A repository's
 * existing shell-form registration of the same script is still recognised
 * as ours (settings-merge.mjs's `sameHook`) and never duplicated.
 */
export const execEntry = scriptPath => ({ type: 'command', command: 'node', args: [`\${CLAUDE_PROJECT_DIR}/${scriptPath}`] });

/** The entry the kit wrote before the exec form. */
const shellEntry = scriptPath => ({ type: 'command', command: `node ${scriptPath}` });

/** The `entrySha256` of every entry this kit has ever recorded for a hook
 * running `scriptPath` under `matcher`: each patch's hash names the one
 * script it registered. */
function recordedHashes(scriptPath, matcher) {
  return new Set([execEntry, shellEntry].map(form => hookEntrySha256(form(scriptPath), matcher)));
}

/** True when `registration` (an entry of `hookRegistrations`) runs the kit's
 * `scriptPath`: by its resolved script, or, when that could not be
 * resolved, by its hash being one the kit writes for that script under
 * `matcher`. */
export function runsKitScript(registration, scriptPath, matcher) {
  if (registration.script !== null) return registration.script === scriptPath;
  return recordedHashes(scriptPath, matcher).has(registration.entrySha256);
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
 * — the script, under a matcher that fires whenever ours would
 * (`matcherCovers`, settings-merge.mjs; Tier 2 review, Important 1: crediting
 * by path alone read our per-edit sensor registered under `Bash` as in
 * place) — expressed against the representation THIS layer carries safely:
 * `hookRegistrations` resolves each hook's command to a script PATH (or
 * `null` when it can't) beside its normalised matcher, never the raw command
 * string, specifically so a credential embedded in a hook's arguments never
 * reaches `harness` — which is serialised wholesale into
 * docs/harness/detect.json on every run. Calling `hasEquivalentHook` itself
 * here would need the raw settings object threaded into this check, which
 * has nowhere safe to live: stashing it on `harness` would undo that
 * redaction for every hook on every event, not just the one this check
 * cares about.
 *
 * Does NOT suppress the proposal when the event is occupied by something
 * that isn't ours — the coordinator's ruling: their hook may do something
 * unrelated, and deciding for them is not this tool's place. It still
 * widens to `declared` only when ours is found (so the central
 * absent-only-may-propose invariant is untouched); otherwise it stays
 * `absent` + the proposal, with evidence naming what else is already there,
 * so adding a second entry to the same event is never a surprise. Each
 * occupant is named as another hook of this kit when its script is one of
 * `kitScripts` (the kit's hook scripts, propose.mjs's
 * `GENERATOR_SCRIPT_PATHS`), as not this kit's when it resolves to any other
 * script, and as unknown when it does not resolve.
 */
export function registeredHook(harness, event, ourPath, proposal, { manifest, root, matcher, kitScripts }) {
  if (!Array.isArray(kitScripts)) throw new TypeError('registeredHook: `kitScripts` is required, or another kit hook on the event would be named as not this kit\'s.');
  const registrations = harness.claudeDir.hookRegistrations?.[event] ?? [];
  const scripts = registrations.map(r => r.script);
  const ours = registrations.filter(r => r.script === ourPath);
  if (ours.length && !ours.some(r => matcherCovers(r.matcher, matcher))) {
    // Registered, but under a matcher that does not fire when ours would:
    // not the capability, and the user is told exactly why.
    return {
      state: 'absent', proposal,
      evidence: ours.map(r => `${event} hook: ${ourPath} is registered, but under matcher "${r.matcher}", which does not fire for ${normalizeMatcher(matcher)} — a registration that does is still needed`),
    };
  }
  if (ours.length) {
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
  //
  // Every kit hook shares its events with the logging hook, so an
  // unresolvable entry on the event says nothing about which hook it is.
  // The entry credited is the one whose hash is a recorded patch for THIS
  // script: a patch names its script only through that hash, matched
  // against each form the kit has registered the script in, and the entry
  // must still be on the event, or a hook deleted by hand would be credited
  // from its leftover record.
  const hashes = recordedHashes(ourPath, matcher);
  const recorded = new Set((manifest?.settingsPatches ?? []).filter(p => p.event === event && hashes.has(p.entrySha256)).map(p => p.entrySha256));
  if (root && registrations.some(r => r.script === null && recorded.has(r.entrySha256)) && existsSync(join(root, ourPath))) {
    return { state: 'declared', evidence: [`${event} hook: ${ourPath} (not visible to the file scan — .claude/ may be gitignored; confirmed via the install record and the file on disk)`] };
  }
  if (scripts.length === 0) return { state: 'absent', proposal, evidence: [] };
  return {
    state: 'absent', proposal,
    evidence: scripts.map(s => {
      if (s === null) return `${event} already holds a hook whose script could not be resolved, so it is not known whose it is`;
      if (kitScripts.includes(s)) return `${event} already holds another kh-harness hook: ${s}`;
      return `${event} already holds a hook that is not this kit's: ${s}`;
    }),
  };
}
