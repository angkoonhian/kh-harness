import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { render, versionStamp } from './render.mjs';
import { hasEquivalentHook } from './settings-merge.mjs';

const ASSETS = new URL('../../assets/', import.meta.url);
const read = rel => readFileSync(new URL(rel, ASSETS), 'utf8');

const BRIEF_PATH = '.claude/scripts/session-brief.mjs';
const BRIEF_COMMAND = `node ${BRIEF_PATH}`;

/** One generator per check id. A check with no generator yields nothing. */
const GENERATORS = {
  'P4.handoff': ({ kitVersion }) => ([{
    kind: 'file', path: 'HANDOFF.md', step: 16,
    contents: render(read('templates/HANDOFF.md.tmpl'), { stamp: versionStamp(kitVersion, 16, '<!--') + ' -->' }),
    reason: 'no handoff file found',
  }]),
  'P4.sessionbrief': ({ kitVersion, harness }) => {
    const out = [{
      kind: 'file', path: BRIEF_PATH, step: 16,
      contents: read('scripts/session-brief.mjs').replace(
        '#!/usr/bin/env node\n',
        `#!/usr/bin/env node\n${versionStamp(kitVersion, 16, '//')}\n`,
      ),
      reason: 'no SessionStart brief hook registered',
    }];
    const registered = harness?.claudeDir?.hookEvents ?? {};
    const already = (registered.SessionStart ?? []).some(c => c === BRIEF_COMMAND);
    if (!already) {
      out.push({
        kind: 'settings-hook', event: 'SessionStart', step: 16,
        entry: { type: 'command', command: BRIEF_COMMAND },
        reason: 'no SessionStart hook registered in .claude/settings.json',
      });
    }
    return out;
  },
};

export function buildProposals({ checks, manifest, kitVersion, harness }) {
  const alreadyWritten = new Set((manifest?.files ?? []).map(f => f.path));
  const out = [];
  for (const c of checks) {
    // Both gates, read from the check — never re-derived here.
    if (c.state !== 'absent' || c.decidable === false) continue;
    const gen = GENERATORS[c.id];
    if (!gen) continue;
    for (const p of gen({ kitVersion, harness })) {
      if (p.kind === 'file' && alreadyWritten.has(p.path)) continue;
      out.push({ ...p, checkId: c.id });
    }
  }
  return out;
}

export { BRIEF_PATH, BRIEF_COMMAND };
