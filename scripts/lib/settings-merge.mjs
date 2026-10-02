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
 */
export function addHookEntry(settings, event, entry, matcher) {
  const next = clone(settings);
  next.hooks ??= {};
  next.hooks[event] ??= [];
  const matcherEntry = matcher === undefined ? { hooks: [entry] } : { matcher, hooks: [entry] };
  next.hooks[event].push(matcherEntry);
  return {
    settings: next,
    patch: { container: `/hooks/${event}`, entrySha256: sha256(canon(matcherEntry)) },
  };
}

export function hasEquivalentHook(settings, event, command) {
  const matchers = settings?.hooks?.[event];
  if (!Array.isArray(matchers)) return false;
  return matchers.some(m => Array.isArray(m?.hooks) && m.hooks.some(h => h?.command === command));
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
