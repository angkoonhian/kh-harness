import { readFileSync } from 'node:fs';
import { render, versionStamp } from './render.mjs';
import { selectProfile } from './profiles/index.mjs';
import { globToRegExp } from './glob.mjs';

const ASSETS = new URL('../../assets/', import.meta.url);
const read = rel => readFileSync(new URL(rel, ASSETS), 'utf8');

const BRIEF_PATH = '.claude/scripts/session-brief.mjs';
const LINT_TOUCHED_PATH = '.claude/scripts/lint-touched.mjs';
const VERIFY_TOUCHED_PATH = '.claude/scripts/verify-touched.mjs';
// Shared by lint-touched.mjs (PostToolUse) and verify-touched.mjs (Stop) —
// see harness-redact.mjs's own comment for why a shared chokepoint exists
// at all. Both scripts import it via a relative `./harness-redact.mjs`, so
// it must always land in the SAME directory as each of them.
const REDACT_PATH = '.claude/scripts/harness-redact.mjs';

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
 * Root-anchored and `**\/`-anchored forms are both listed deliberately, for
 * the same reason as typescript.mjs's dist/build globs (see its comment):
 * this is about OUR OWN matcher (glob.mjs's `globToRegExp`), not Claude
 * Code's. `globToRegExp` compiles `**` to `.*` with a required literal `/`
 * before the final segment, so `hasEvidence('**\/migrations/**', [...])` is
 * false for a root-level `migrations/` and the rule is never PROPOSED at
 * all — even though Claude Code's own `Edit(...)` matcher is wider (per its
 * docs, `**\/` also matches zero directory segments) and would have
 * honoured `Edit(**\/migrations/**)` against a root-level path just fine
 * once proposed. The duplication exists to satisfy OUR evidence filter, not
 * Claude Code's matcher.
 *
 * As with every candidate here, a rule is only ever PROPOSED when the path
 * is visible to `listFiles` (scan.mjs) — tracked by git, or not excluded on
 * the dependency-free fallback walk. Migration directories are typically
 * committed, so this rarely bites the way it does for build output (see
 * typescript.mjs/python.mjs), but the mechanism is the same: no evidence,
 * no proposal, by design.
 */
const PROTECTED_PATH_CANDIDATES = [
  'prisma/migrations/**',
  'src/migrations/**',
  'migrations/**',
  '**/migrations/**',
  'drizzle/**',
  'alembic/versions/**',
  // Root-anchored AND **-anchored, deliberately — same reason as this
  // file's migrations comment above and typescript.mjs's dist/build
  // comment: it is OUR `globToRegExp` that requires the literal `/`, not
  // Claude Code's matcher. `hasEvidence('**/__generated__/**', [...])` is
  // false for a root-level `__generated__/`, and likewise for
  // `**/*.generated.*` against a root-level `foo.generated.ts` (both
  // verified) — so without the root-anchored form, our evidence filter
  // never proposes a rule for either, regardless of what Claude Code
  // itself would have matched. Do not collapse this back to one form.
  '__generated__/**',
  '**/__generated__/**',
  '*.generated.*',
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

/**
 * The shared redaction module both process-output hooks (lint-touched.mjs's
 * PostToolUse sensor and verify-touched.mjs's Stop gate) import — see
 * harness-redact.mjs's own comment for why a shared chokepoint exists at
 * all. Returned by EITHER sensorProposal or stopgateProposal's own
 * generator, independently — not only by whichever happens to run first —
 * so that satisfying just one of the two checks (the other already
 * `declared`, or installed by an earlier run) still brings this file along.
 * `buildProposals`' own dedupe (see its comment on `alreadyWritten`) is what
 * keeps it from being proposed twice when BOTH generators fire in the same
 * batch, and from being re-proposed once a prior run already recorded it in
 * the manifest.
 */
function redactAssetProposal(kitVersion, step) {
  return {
    kind: 'file', path: REDACT_PATH, step,
    contents: versionStamp(kitVersion, step, '//') + '\n' + read('scripts/harness-redact.mjs'),
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
function sensorProposal({ kitVersion, stack }) {
  if (!stack.packages.some(p => p.scripts?.includes('lint'))) return [];
  return [{
    kind: 'file', path: LINT_TOUCHED_PATH, step: 9,
    contents: read('scripts/lint-touched.mjs').replace(
      '#!/usr/bin/env node\n',
      `#!/usr/bin/env node\n${versionStamp(kitVersion, 9, '//')}\n`,
    ),
    reason: 'no PostToolUse hook registered',
  }, redactAssetProposal(kitVersion, 9), {
    kind: 'settings-hook', event: 'PostToolUse', step: 9,
    matcher: 'Write|Edit',
    entry: { type: 'command', command: `node ${LINT_TOUCHED_PATH}` },
    reason: 'no PostToolUse hook registered in .claude/settings.json',
  }];
}

/**
 * The Stop gate: runs the repository's own verification command (its
 * `typecheck` script, falling back to `test`) when a turn ends, and blocks
 * once per distinct failure — see verify-touched.mjs's own header comment
 * for the full rationale. Decidable only when at least one package
 * declares a `typecheck` or `test` script — the same evidence-gated shape
 * as `sensorProposal`: a gate with nothing to run is noise.
 *
 * No `matcher`: a Stop event has no "which tool ran" to scope against, and
 * the whole point is to run on every Stop, not a subset of them.
 *
 * The cost this accepts is stated plainly in `reason`, not hidden in the
 * installed script: falling back to `test` means a full test-suite run, up
 * to the hook's own 120s bound, at the end of every turn. That is a real
 * tradeoff the user is accepting, not a side effect to discover later —
 * and it never names the command ITSELF (`scripts.test`'s value can carry a
 * credential, same as `scripts.lint`'s has, twice, in this project's own
 * history), only what kind of cost it is.
 */
function stopgateProposal({ kitVersion, stack }) {
  const hasTypecheck = stack.packages.some(p => p.scripts?.includes('typecheck'));
  const hasTest = stack.packages.some(p => p.scripts?.includes('test'));
  if (!hasTypecheck && !hasTest) return [];
  const reason = hasTypecheck
    ? 'no Stop hook registered — runs the repository\'s typecheck script, bounded at 120s, at the end of every turn'
    : 'no Stop hook registered — no typecheck script was found, so this falls back to the full test script, bounded at 120s, at the end of every turn';
  return [{
    kind: 'file', path: VERIFY_TOUCHED_PATH, step: 10,
    contents: read('scripts/verify-touched.mjs').replace(
      '#!/usr/bin/env node\n',
      `#!/usr/bin/env node\n${versionStamp(kitVersion, 10, '//')}\n`,
    ),
    reason: 'no Stop hook registered',
  }, redactAssetProposal(kitVersion, 10), {
    kind: 'settings-hook', event: 'Stop', step: 10,
    entry: { type: 'command', command: `node ${VERIFY_TOUCHED_PATH}` },
    reason,
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
  'P2.sensor': sensorProposal,
  'P2.stopgate': stopgateProposal,
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
    for (const p of gen({ kitVersion, harness, root, stack, checks, files })) {
      if (p.kind === 'file' && alreadyWritten.has(p.path)) continue;
      out.push({ ...p, checkId: c.id });
      if (p.kind === 'file') alreadyWritten.add(p.path);
    }
  }
  return out;
}

export { BRIEF_PATH, LINT_TOUCHED_PATH, VERIFY_TOUCHED_PATH, REDACT_PATH };
