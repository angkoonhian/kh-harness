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

export function addHookEntry(settings, event, entry) {
  const next = clone(settings);
  next.hooks ??= {};
  next.hooks[event] ??= [];
  const matcherEntry = { hooks: [entry] };
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
  if (typeof patch.container !== 'string' || !patch.container.startsWith('/hooks/')) {
    return { settings: next, reverted: false };
  }
  if (typeof patch.entrySha256 !== 'string' || !/^[0-9a-f]{64}$/.test(patch.entrySha256)) {
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
