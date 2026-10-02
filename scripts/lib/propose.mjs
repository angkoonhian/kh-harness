import { readFileSync } from 'node:fs';
import { render, versionStamp } from './render.mjs';
import { selectProfile } from './profiles/index.mjs';
import { globToRegExp } from './glob.mjs';

const ASSETS = new URL('../../assets/', import.meta.url);
const read = rel => readFileSync(new URL(rel, ASSETS), 'utf8');

const BRIEF_PATH = '.claude/scripts/session-brief.mjs';

/**
 * Evidence-based protected-path candidates for conventions that are NOT
 * universal to a language — migrations are an ORM/framework convention
 * (Prisma, Drizzle, Django, Alembic, ...), not a fact about every project
 * written in a given language. Plan 1 hardcoded `**\/migrations/**` into the
 * stack profiles and the review struck it for exactly that reason: a profile
 * asserting this is an opinion about layout it has no basis for (see
 * docs/plan-1-execution-log.md).
 *
 * Listing the known conventions HERE, instead, is not an opinion, because
 * every candidate below is filtered against the repository's actual file
 * list in `protectedPathProposal` — a candidate that matches nothing is
 * simply never proposed. Applied uniformly (not split per detected stack):
 * uniformity is safe precisely because the existence filter prunes whatever
 * is absent, and it avoids maintaining a second set of per-language guesses.
 *
 * Root-anchored and `**\/`-anchored forms are both listed for the same
 * reason generic.mjs's lockfile globs needed root-anchored siblings: `**`
 * requires a literal `/` before the final segment, so it only ever matches a
 * NESTED occurrence, never one sitting at the repository root.
 */
const PROTECTED_PATH_CANDIDATES = [
  'prisma/migrations/**',
  'src/migrations/**',
  'migrations/**',
  '**/migrations/**',
  'drizzle/**',
  'alembic/versions/**',
  '**/__generated__/**',
  '**/*.generated.*',
];

/** True if `glob` matches at least one path in `files`. */
function hasEvidence(glob, files) {
  const re = globToRegExp(glob);
  return files.some(f => re.test(f));
}

/**
 * Intersects `profile.protectedGlobs()` (the universal-per-stack candidates:
 * lockfiles, build output) with `PROTECTED_PATH_CANDIDATES` (the ORM/
 * framework conventions above), keeps only the globs with evidence in
 * `files`, and wraps each survivor as a Claude Code `Edit(...)` permission
 * pattern — the shape `.claude/settings.json`'s `permissions.deny` actually
 * takes (see settings-merge.mjs's tests). The candidate table holds RAW
 * globs and the filter matches RAW globs; wrapping happens only at the very
 * end, on survivors only, so nothing here ever has to parse a wrapped string
 * back apart.
 *
 * `Edit`, specifically — not `Read` — because the risk being guarded is
 * modification, not the agent reading context it legitimately needs.
 */
function protectedPathProposal({ stack, files }) {
  const profile = selectProfile(stack);
  const candidates = [...profile.protectedGlobs(), ...PROTECTED_PATH_CANDIDATES];
  const seen = new Set();
  const surviving = [];
  for (const glob of candidates) {
    if (seen.has(glob)) continue;
    seen.add(glob);
    if (hasEvidence(glob, files)) surviving.push(glob);
  }
  if (surviving.length === 0) return [];
  return [{
    kind: 'settings-deny', step: 11,
    globs: surviving.map(g => `Edit(${g})`),
    reason: 'deny edits to protected paths found in this repository',
  }];
}

/** Generators receive the full detection context and return proposals.
 * { kitVersion, harness, root, stack, checks, files } are available to all
 * generators. A generator yields nothing by returning an empty array or not
 * being registered. */
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
  'P2.protected': protectedPathProposal,
};

/**
 * `generators` lets a caller extend or override the production table for a
 * single call — this exists so tests can inject a probe generator (e.g. to
 * verify the full context is passed through) without that probe living in
 * the production table. A generator registered there is a live proposal
 * path: `TEST.contextcheck` used to live here and proposed `.context-verified`,
 * a path `assertAllowed` refuses — a crash waiting for a real check to reuse
 * that id, not just a dead test fixture.
 */
export function buildProposals({ checks, manifest, kitVersion, harness, root, stack, files = [], generators = {} }) {
  const registry = { ...GENERATORS, ...generators };
  const alreadyWritten = new Set((manifest?.files ?? []).map(f => f.path));
  const out = [];
  for (const c of checks) {
    // Both gates, read from the check — never re-derived here.
    if (c.state !== 'absent' || c.decidable === false) continue;
    const gen = registry[c.id];
    if (!gen) continue;
    for (const p of gen({ kitVersion, harness, root, stack, checks, files })) {
      if (p.kind === 'file' && alreadyWritten.has(p.path)) continue;
      out.push({ ...p, checkId: c.id });
    }
  }
  return out;
}

export { BRIEF_PATH };
