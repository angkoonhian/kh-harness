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
 * A hook entry in Claude Code's EXEC form: the executable and an argument
 * vector, "spawned directly … with no shell involved", with the script
 * rooted at `${CLAUDE_PROJECT_DIR}` — "the project root where the session
 * started" — which the reference says to prefer for any path placeholder.
 * The shell form (`node .claude/scripts/x.mjs`) costs a shell per
 * invocation and a cwd-relative path that stops resolving after `cd`. A
 * repository's existing shell-form registration of the same script is still
 * recognised as ours (settings-merge.mjs's `sameHook`) and never
 * duplicated.
 */
export const execEntry = scriptPath => ({ type: 'command', command: 'node', args: [`\${CLAUDE_PROJECT_DIR}/${scriptPath}`] });

/**
 * The entry script the kit registers on each tool-call event, and the
 * installed hooks it runs there. Each entry script runs its hooks in one
 * process through harness-dispatch.mjs, so an event it is registered on
 * carries none of these hooks separately.
 */
export const ENTRY_SCRIPTS = Object.freeze({
  PreToolUse: { path: '.claude/scripts/dispatch-pre-tool.mjs', halves: ['.claude/scripts/tool-gate.mjs', '.claude/scripts/session-log.mjs'] },
  PostToolUse: { path: '.claude/scripts/dispatch-post-tool.mjs', halves: ['.claude/scripts/session-log.mjs', '.claude/scripts/lint-touched.mjs'] },
  PostToolUseFailure: { path: '.claude/scripts/dispatch-tool-failure.mjs', halves: ['.claude/scripts/session-log.mjs', '.claude/scripts/loop-watch.mjs'] },
});

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

/** The entry script that runs `scriptPath` on `event`, or null when no
 * entry script runs it there. */
export function entryScriptFor(event, scriptPath) {
  const entry = ENTRY_SCRIPTS[event];
  return entry?.halves.includes(scriptPath) ? entry.path : null;
}

/** The registrations on `event` that run `scriptPath` itself, rather than
 * through an entry script. */
export function directRegistrations(harness, event, scriptPath, matcher) {
  return (harness.claudeDir.hookRegistrations?.[event] ?? []).filter(r => runsKitScript(r, scriptPath, matcher));
}

/**
 * Credits an event from `.claude/settings.json`'s hook registry, never from
 * a filename under `.claude/scripts/`: a hook's script may live anywhere in
 * the repository, and settings.json is the exact record of what is wired
 * up.
 *
 * `declared` means OUR script (`ourPath`, the path the generator in
 * propose.mjs registers for this event) is among what is registered, under
 * a matcher that fires whenever ours would (`matcherCovers`), itself or as
 * a hook its event's entry script runs (`entryScriptFor`): not merely
 * that the event is occupied, since a user's own unrelated hook on the
 * event is not the capability, and not our script under a matcher that
 * does not fire for ours. This is the identification `apply-lib.mjs`'s
 * `hasEquivalentHook` makes, expressed against what this layer carries
 * safely: `hookRegistrations` resolves each hook's command to a script PATH
 * (or `null` when it cannot) beside its normalised matcher, never the raw
 * command string, so that a credential in a hook's arguments never reaches
 * `harness`, which is serialised whole into docs/harness/detect.json.
 *
 * An event occupied by something that is not ours does not suppress the
 * proposal: their hook may do something unrelated, and deciding for them is
 * not this tool's place. The check stays `absent` with the proposal, and
 * its evidence names what else is there, so adding a second entry to the
 * event is never a surprise. Each occupant is named as another hook of this
 * kit when its script is one of `kitScripts` (propose.mjs's
 * `GENERATOR_SCRIPT_PATHS`), as not this kit's when it resolves to any other
 * script, and as unknown when it does not resolve. A user's hook is never
 * listed as part of what is credited as ours. The entry script that runs
 * ours is ours too, so it is never listed as an occupant.
 */
export function registeredHook(harness, event, ourPath, proposal, { manifest, root, matcher, kitScripts }) {
  if (!Array.isArray(kitScripts)) throw new TypeError('registeredHook: `kitScripts` is required, or another kit hook on the event would be named as not this kit\'s.');
  const registrations = harness.claudeDir.hookRegistrations?.[event] ?? [];
  const entry = entryScriptFor(event, ourPath);
  const ours = registrations.filter(r => r.script === ourPath);
  const viaEntry = entry === null ? [] : registrations.filter(r => r.script === entry);
  if (ours.some(r => matcherCovers(r.matcher, matcher))) return { state: 'declared', evidence: [`${event} hook: ${ourPath}`] };
  if (viaEntry.some(r => matcherCovers(r.matcher, matcher))) return { state: 'declared', evidence: [`${event} hook: ${ourPath}, run by ${entry}`] };
  if (ours.length || viaEntry.length) {
    // Registered, but under a matcher that does not fire when ours would:
    // not the capability, and the user is told exactly why.
    const under = r => `under matcher "${r.matcher}", which does not fire for ${normalizeMatcher(matcher)} — a registration that does is still needed`;
    return {
      state: 'absent', proposal,
      evidence: [
        ...ours.map(r => `${event} hook: ${ourPath} is registered, but ${under(r)}`),
        ...viaEntry.map(r => `${event} hook: ${ourPath} is run by ${entry}, but ${under(r)}`),
      ],
    };
  }
  // `commandScript` (detect-harness.mjs) resolves a hook's script only
  // against the scan list, which holds tracked files or what the fallback
  // walk sees, so a repository that gitignores `.claude/` makes our own
  // hook's script unresolvable there though it is registered and on disk.
  // The manifest, our record of what we installed and the authority
  // `uninstall` trusts, plus a direct `existsSync`, answers "is ours
  // present" for that case. The scan list stays reserved for the user's own
  // content: naming a path it surfaced is safe because the user made it
  // visible, while naming anything `existsSync` alone would admit risks
  // naming a path the user kept out of git.
  //
  // The branch applies only to an entry that could be ours: one the scan
  // list could not resolve. An entry that resolves to another script is
  // positively not ours, whatever the manifest and a leftover script file
  // say.
  //
  // Every kit hook shares its events with the logging hook, so an
  // unresolvable entry on the event says nothing about which hook it is.
  // The entry credited is the one whose hash is a recorded patch for THIS
  // script: a patch names its script only through that hash, matched
  // against each form the kit has registered the script in, and the entry
  // must still be on the event, or a hook deleted by hand would be credited
  // from its leftover record. The entry script that runs ours is credited
  // the same way, from the patch the kit records for it, which carries no
  // matcher.
  const unseen = '(not visible to the file scan — .claude/ may be gitignored; confirmed via the install record and the file on disk)';
  const confirmed = (script, hashes) => {
    if (!root) return false;
    const recorded = new Set((manifest?.settingsPatches ?? []).filter(p => p.event === event && hashes.has(p.entrySha256)).map(p => p.entrySha256));
    return registrations.some(r => r.script === null && recorded.has(r.entrySha256)) && existsSync(join(root, script));
  };
  if (confirmed(ourPath, recordedHashes(ourPath, matcher))) return { state: 'declared', evidence: [`${event} hook: ${ourPath} ${unseen}`] };
  if (entry !== null && confirmed(entry, new Set([hookEntrySha256(execEntry(entry))]))) {
    return { state: 'declared', evidence: [`${event} hook: ${ourPath}, run by ${entry} ${unseen}`] };
  }
  if (registrations.length === 0) return { state: 'absent', proposal, evidence: [] };
  return {
    state: 'absent', proposal,
    evidence: registrations.map(({ script: s }) => {
      if (s === null) return `${event} already holds a hook whose script could not be resolved, so it is not known whose it is`;
      if (kitScripts.includes(s)) return `${event} already holds another kh-harness hook: ${s}`;
      return `${event} already holds a hook that is not this kit's: ${s}`;
    }),
  };
}
