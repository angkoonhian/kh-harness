import { readFileSync } from 'node:fs';
import { render, versionStamp } from './render.mjs';

const ASSETS = new URL('../../assets/', import.meta.url);
const read = rel => readFileSync(new URL(rel, ASSETS), 'utf8');

const BRIEF_PATH = '.claude/scripts/session-brief.mjs';

/** Generators receive the full detection context and return proposals.
 * { kitVersion, harness, root, stack, checks } are available to all generators.
 * A generator yields nothing by returning an empty array or not being registered. */
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
    reason: 'no SessionStart hook registered in .claude/settings.json',
  }],
  // Test-only generator to verify context passing
  'TEST.contextcheck': ({ kitVersion, harness, root, stack, checks }) => {
    if (typeof root !== 'string' && typeof root !== 'undefined') return [];
    if (!Array.isArray(stack?.packages ?? [])) return [];
    if (!Array.isArray(checks)) return [];
    return [{ kind: 'file', path: '.context-verified', step: 99, contents: 'ok', reason: 'test' }];
  },
};

export function buildProposals({ checks, manifest, kitVersion, harness, root, stack }) {
  const alreadyWritten = new Set((manifest?.files ?? []).map(f => f.path));
  const out = [];
  for (const c of checks) {
    // Both gates, read from the check — never re-derived here.
    if (c.state !== 'absent' || c.decidable === false) continue;
    const gen = GENERATORS[c.id];
    if (!gen) continue;
    for (const p of gen({ kitVersion, harness, root, stack, checks })) {
      if (p.kind === 'file' && alreadyWritten.has(p.path)) continue;
      out.push({ ...p, checkId: c.id });
    }
  }
  return out;
}

export { BRIEF_PATH };
