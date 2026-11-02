import { sha256 } from './manifest.mjs';

const clone = o => JSON.parse(JSON.stringify(o ?? {}));

/** Canonical form so the hash does not depend on key order. */
function canon(entry) {
  return JSON.stringify(entry, function(key, value) {
    if (typeof value === 'object' && value !== null && !Array.isArray(value)) {
      const sorted = {};
      Object.keys(value).sort().forEach(k => sorted[k] = value[k]);
      return sorted;
    }
    return value;
  });
}

/**
 * `matcher` is optional and omitted by default — SessionStart (the only
 * event this shipped against until now) never needed one, since omitting
 * it means "match everything" and that is exactly what a session-brief
 * hook wants. PostToolUse is different: without a matcher it fires for
 * every tool, not just an edit, so the per-edit sensor passes one
 * ('Write|Edit') explicitly. Passing it changes `matcherEntry` and
 * therefore its hash — by design, since a matcher-bearing entry and a
 * matcher-less one for the same command are different objects on disk.
 *
 * Exported so `apply-lib.mjs`'s settings-hook preview can build the exact
 * same object `addHookEntry` is about to push, rather than a second,
 * independent copy of this ternary — a preview that silently drifted from
 * what apply actually writes is exactly the shape this is meant to rule
 * out structurally, not just by comment.
 */
export function buildMatcherEntry(entry, matcher) {
  return matcher === undefined ? { hooks: [entry] } : { matcher, hooks: [entry] };
}

export function addHookEntry(settings, event, entry, matcher) {
  const next = clone(settings);
  next.hooks ??= {};
  next.hooks[event] ??= [];
  const matcherEntry = buildMatcherEntry(entry, matcher);
  next.hooks[event].push(matcherEntry);
  return {
    settings: next,
    patch: { container: `/hooks/${event}`, entrySha256: sha256(canon(matcherEntry)) },
  };
}

/**
 * A matcher, normalised. Claude Code treats an omitted matcher, `""` and
 * `"*"` alike — every tool (or every source) — so those become `null`. A
 * plain alternation of names (`Write|Edit`, `Edit, Write`) is a SET: it is
 * returned sorted and `|`-joined, so order cannot tell two equal sets apart.
 * Anything holding another character is a regular expression and is kept as
 * written. Shared with detect-harness.mjs (`hookRegistrations`) so detection
 * and the write-time dedupe cannot disagree about what a matcher means.
 */
export function normalizeMatcher(matcher) {
  if (matcher === undefined || matcher === null || matcher === '' || matcher === '*') return null;
  const m = String(matcher).trim();
  if (m === '' || m === '*') return null;
  if (/^[\w\s|,-]+$/.test(m)) return [...new Set(m.split(/[|,]/).map(s => s.trim()).filter(Boolean))].sort().join('|');
  return m;
}

const PLAIN_LIST = /^[\w-]+(?:\|[\w-]+)*$/;

/**
 * True when a hook registered under `theirs` fires whenever one registered
 * under `ours` would: ours needs no matcher (then any registration of the
 * script counts — narrowing a SessionStart brief to `startup|resume` is the
 * user's choice, not a missing hook), theirs is every tool, the two sets are
 * equal, or theirs is a superset. A regular expression is never assumed to
 * cover a list. Tier 2 review, Important 1: `registeredHook` credited by
 * script path alone, so our per-edit sensor registered under `Bash` — a
 * hook that never fires on an edit — read as `declared`.
 */
export function matcherCovers(theirs, ours) {
  const o = normalizeMatcher(ours);
  if (o === null) return true;
  const t = normalizeMatcher(theirs);
  if (t === null || t === o) return true;
  if (PLAIN_LIST.test(t) && PLAIN_LIST.test(o)) {
    const have = new Set(t.split('|'));
    return o.split('|').every(name => have.has(name));
  }
  return false;
}

/**
 * A path token as it may appear in a hook command, normalised: surrounding
 * quotes, a `${CLAUDE_PROJECT_DIR}/` or `$CLAUDE_PROJECT_DIR/` root, a
 * `./` prefix and backslashes are removed, so `"./.claude/scripts/x.mjs"`
 * and `${CLAUDE_PROJECT_DIR}/.claude/scripts/x.mjs` are the same path.
 */
export function normalizeHookPath(token) {
  // Quotes go wherever they sit: `"${CLAUDE_PROJECT_DIR}"/x` closes the
  // quote before the path, a real shell idiom (Tier 3 review, Minor 8).
  return String(token)
    .replace(/["']/g, '')
    .replace(/^\$\{CLAUDE_PROJECT_DIR\}[\\/]|^\$CLAUDE_PROJECT_DIR[\\/]/, '')
    .split('\\').join('/')
    .replace(/^\.\//, '');
}

/**
 * The candidate script tokens of a hook entry, normalised. Claude Code's two
 * forms (audit Tier 3, finding 11): exec form — `command` is the executable
 * and `args[0]` the script, spawned with no shell — yields that one token;
 * shell form — `command` is a shell string — yields every whitespace token,
 * for a caller that can tell which one is a path (detect-harness.mjs checks
 * them against the file list). Never resolves beyond what the entry says.
 */
export function hookPathTokens(entry) {
  if (Array.isArray(entry?.args) && entry.args.length > 0) return [normalizeHookPath(entry.args[0])];
  if (typeof entry?.command === 'string') return entry.command.split(/\s+/).map(normalizeHookPath).filter(Boolean);
  return [];
}

/** The script an exec-form entry runs; null for shell form, which cannot be
 * resolved without the file list. */
export function hookScriptOf(entry) {
  return Array.isArray(entry?.args) && entry.args.length > 0 ? normalizeHookPath(entry.args[0]) : null;
}

/**
 * Two entries are the same hook when they run the same script: two exec
 * forms by their script, an exec form and a shell form when the shell
 * string names that script, two shell forms when their strings are equal.
 * So a user's existing `node .claude/scripts/x.mjs` and our exec-form
 * registration of `x.mjs` are one hook — recognised, never duplicated.
 */
function sameHook(a, b) {
  const sa = hookScriptOf(a);
  const sb = hookScriptOf(b);
  if (sa !== null && sb !== null) return sa === sb;
  if (sa !== null) return hookPathTokens(b).includes(sa);
  if (sb !== null) return hookPathTokens(a).includes(sb);
  return typeof a?.command === 'string' && a.command === b?.command;
}

/**
 * True when `entry` (or one that runs the same script — see sameHook) is
 * already registered on `event` under a matcher that covers `matcher` (see
 * matcherCovers). Audit Tier 2, finding 7: the matcher used to be ignored,
 * so a user's own `node x.mjs` under `Bash` suppressed our `Write|Edit`
 * registration of the same script — a different hook, since the matcher is
 * what decides when it fires. (The entry hash `addHookEntry` records has
 * always included the matcher; only this check did not.)
 */
export function hasEquivalentHook(settings, event, entry, matcher) {
  const matchers = settings?.hooks?.[event];
  if (!Array.isArray(matchers)) return false;
  return matchers.some(m => Array.isArray(m?.hooks)
    && matcherCovers(m.matcher, matcher)
    && m.hooks.some(h => sameHook(h, entry)));
}

export function addDenyRules(settings, globs) {
  const next = clone(settings);
  next.permissions ??= {};
  next.permissions.deny ??= [];

  // Dedupe globs against themselves (preserving first-seen order) and against existing rules
  const existingSet = new Set(next.permissions.deny);
  const seen = new Set(existingSet);
  const newRules = [];
  for (const g of globs) {
    if (!seen.has(g)) {
      newRules.push(g);
      seen.add(g);
    }
  }

  // Append only the new rules
  newRules.forEach(rule => {
    next.permissions.deny.push(rule);
  });

  // If nothing was added, return no patch
  if (newRules.length === 0) {
    return { settings: next, patch: null, added: [] };
  }

  // Hash the sorted list of added strings canonically
  const sortedAdded = [...newRules].sort();
  const entrySha256 = sha256(JSON.stringify(sortedAdded));

  return {
    settings: next,
    patch: { container: '/permissions/deny', entrySha256, rules: sortedAdded },
    added: newRules,
  };
}

/**
 * Remove the entry whose hash matches. Index-based removal would take out the
 * wrong hook the moment the user adds one of their own above ours, and nothing
 * would notice until something stopped running.
 */
export function revertPatch(settings, patch) {
  const next = clone(settings);

  // Defensive: validate patch structure before accessing properties
  if (!patch || typeof patch !== 'object') {
    return { settings: next, reverted: false };
  }

  if (typeof patch.container !== 'string') {
    return { settings: next, reverted: false };
  }

  if (typeof patch.entrySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(patch.entrySha256)) {
    return { settings: next, reverted: false };
  }

  // Handle /permissions/deny container
  if (patch.container === '/permissions/deny') {
    if (!Array.isArray(patch.rules)) {
      return { settings: next, reverted: false };
    }

    const denyList = next?.permissions?.deny;
    if (!Array.isArray(denyList)) {
      return { settings: next, reverted: false };
    }

    // patch.rules is authoritative for identity; entrySha256 is retained for schema consistency
    // Check if all rules we added are still present
    const rulesToRemove = new Set(patch.rules);
    for (const rule of patch.rules) {
      if (!denyList.includes(rule)) {
        // A rule we added is no longer present - partial hand-edit
        return { settings: next, reverted: false };
      }
    }

    // Remove exactly the rules we added
    const filtered = denyList.filter(rule => !rulesToRemove.has(rule));
    if (filtered.length === 0) {
      // Prune empty deny array and then permissions object if empty
      delete next.permissions.deny;
      if (next.permissions && Object.keys(next.permissions).length === 0) {
        delete next.permissions;
      }
    } else {
      next.permissions.deny = filtered;
    }

    return { settings: next, reverted: true };
  }

  // Handle /hooks/<event> container (existing behavior)
  if (!patch.container.startsWith('/hooks/')) {
    return { settings: next, reverted: false };
  }

  const event = patch.container.replace('/hooks/', '');
  const list = next?.hooks?.[event];
  if (!Array.isArray(list)) return { settings: next, reverted: false };
  const idx = list.findIndex(m => sha256(canon(m)) === patch.entrySha256);
  if (idx === -1) return { settings: next, reverted: false };
  list.splice(idx, 1);
  if (list.length === 0) delete next.hooks[event];
  if (next.hooks && Object.keys(next.hooks).length === 0) delete next.hooks;
  return { settings: next, reverted: true };
}
