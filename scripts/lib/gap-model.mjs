export const STATES = ['absent', 'declared', 'verified', 'failing', 'n/a'];

const MAX_INSTRUCTION_LINES = 150;

/**
 * Credit an event from `.claude/settings.json`'s hook registry rather than from
 * a filename under `.claude/scripts/`. A hook's script may live anywhere in the
 * repository, so a filename check cannot be made adequate here — and does not
 * need to be, because settings.json is an exact record of what is wired up.
 *
 * This can only widen a check to `declared`; it can never create a proposal, so
 * the central invariant is untouched. The registered command goes into the
 * evidence so the user can see what was credited.
 */
function registeredHook(harness, event, proposal) {
  const commands = harness.claudeDir.hookEvents?.[event] ?? [];
  return commands.length
    ? { state: 'declared', evidence: commands.map(c => `${event} hook: ${c}`) }
    : { state: 'absent', proposal };
}

/**
 * Each entry describes one runbook step. `check` returns
 * { state, evidence, proposal? } — and the wrapper enforces the invariant that
 * only `absent` may carry a proposal, so no individual check can break it.
 */
// Runbook step 1 ("branch for the work") is deliberately NOT a check. Being on
// a branch is a precondition of the apply run, not a capability the repository
// lacks — modelling it as a gap makes every otherwise-complete repo on `main`
// report a proposal, which would defeat the load-bearing test. Plan 2 enforces
// it as an apply-time refusal instead.
const CHECKS = [
  {
    id: 'P0.inventory', step: 2, phase: 0,
    lookedFor: ['docs/harness/detect.json'],
    // Produced by this very run, so it is evidence by construction.
    check: () => ({ state: 'verified', evidence: ['produced by this run'] }),
  },
  {
    id: 'P0.security', step: 3, phase: 0,
    lookedFor: ['tokens in remotes, tracked files and .claude settings'],
    check: ({ exposures }) => exposures.length
      ? { state: 'failing', evidence: exposures.map(e => `${e.kind} at ${e.location}`) }
      : { state: 'verified', evidence: ['no credential patterns matched'] },
  },
  {
    id: 'P0.recon', step: 4, phase: 0,
    lookedFor: ['docs/harness/recon.md'],
    check: ({ harness }) => harness.reconPresent
      ? { state: 'declared', evidence: ['docs/harness/recon.md'] }
      : { state: 'absent', proposal: 'run the recon prompt to write docs/harness/recon.md' },
  },
  {
    id: 'P1.bootstrap', step: 5, phase: 1,
    lookedFor: ['scripts/bootstrap.sh', 'scripts/setup.sh', 'Makefile', 'justfile'],
    check: ({ harness }) => harness.bootstrap
      ? { state: 'declared', evidence: [harness.bootstrap] }
      : { state: 'absent', proposal: 'create scripts/bootstrap.sh from template' },
  },
  {
    id: 'P1.instructions', step: 6, phase: 1,
    lookedFor: ['CLAUDE.md', 'AGENTS.md'],
    check: ({ harness }) => {
      const { path, lines } = harness.instructions;
      if (!path) return { state: 'absent', proposal: 'run the instruction-file prompt to derive CLAUDE.md from recon' };
      const evidence = [`${path} (${lines} lines)`];
      if (lines > MAX_INSTRUCTION_LINES) evidence.push(`${lines} lines exceeds the ${MAX_INSTRUCTION_LINES}-line budget; prune rather than replace`);
      return { state: 'declared', evidence };
    },
  },
  {
    id: 'P1.architecture', step: 7, phase: 1,
    lookedFor: ['docs/ARCHITECTURE.md'],
    check: ({ harness }) => harness.architecture
      ? { state: 'declared', evidence: [harness.architecture] }
      : { state: 'absent', proposal: 'run the architecture prompt to write docs/ARCHITECTURE.md' },
  },
  {
    id: 'P1.pathrules', step: 7, phase: 1,
    lookedFor: ['.claude/rules/'],
    check: ({ harness }) => harness.claudeDir.rules.length
      ? { state: 'declared', evidence: harness.claudeDir.rules }
      : { state: 'absent', proposal: 'scaffold .claude/rules/ with globs derived from the workspace layout' },
  },
  {
    id: 'P2.scripts', step: 8, phase: 2,
    lookedFor: ['a lint and typecheck script in every package'],
    check: ({ stack }) => {
      // `p.scripts` is a sorted list of script NAMES — see detect-stack.mjs.
      const lacks = (p, name) => !p.scripts?.includes(name);
      const missing = stack.packages.filter(p => lacks(p, 'lint') || lacks(p, 'typecheck'))
        .map(p => `${p.name}: missing ${[lacks(p, 'lint') && 'lint', lacks(p, 'typecheck') && 'typecheck'].filter(Boolean).join(' + ')}`);
      return missing.length
        ? { state: 'absent', evidence: missing, proposal: `add lint/typecheck scripts to ${missing.length} package(s)` }
        : { state: 'declared', evidence: ['every package has lint and typecheck'] };
    },
  },
  {
    id: 'P2.sensor', step: 9, phase: 2,
    lookedFor: ['a PostToolUse hook in .claude/settings.json'],
    check: ({ harness }) => registeredHook(harness, 'PostToolUse',
      'install scripts/lint-touched.mjs and register a PostToolUse hook'),
  },
  {
    id: 'P2.stopgate', step: 10, phase: 2,
    lookedFor: ['a Stop hook in .claude/settings.json'],
    check: ({ harness }) => registeredHook(harness, 'Stop',
      'install scripts/verify-touched.mjs and register a Stop hook'),
  },
  {
    id: 'P2.protected', step: 11, phase: 2,
    lookedFor: ['deny rules in .claude/settings.json'],
    // Existence of settings.json is not enough — an empty or rule-less file
    // must not be reported as protecting anything.
    check: ({ harness }) => harness.claudeDir.denyRules > 0
      ? { state: 'declared', evidence: [`${harness.claudeDir.denyRules} deny rule(s) in .claude/settings.json`] }
      : { state: 'absent', proposal: 'create .claude/settings.json with deny rules for protected paths' },
  },
  {
    id: 'P2.langserver', step: 12, phase: 2,
    lookedFor: ['a language server for the detected stack'],
    // Whether a language server is installed is machine state, not repo state,
    // so this genuinely does not apply to what this tool inspects — 'declared'
    // would claim an observation that was never made.
    check: () => ({ state: 'n/a', evidence: ['not determinable from the repository; verify by hand'] }),
  },
  {
    id: 'P4.remote', step: 15, phase: 4,
    lookedFor: ['at least one git remote'],
    check: ({ harness }) => harness.remotes.length
      ? { state: 'declared', evidence: harness.remotes.map(r => r.name) }
      : { state: 'absent', proposal: 'add a git remote so the harness is backed up off this machine' },
  },
  // Two capabilities, two checks. Conflating them is how a repository with a
  // working SessionStart hook was told to "install HANDOFF.md and session-brief
  // hook" — a proposal to install something it already had.
  {
    id: 'P4.handoff', step: 16, phase: 4,
    lookedFor: ['HANDOFF.md', 'docs/HANDOFF.md'],
    check: ({ harness }) => harness.handoff
      ? { state: 'declared', evidence: [harness.handoff] }
      : { state: 'absent', proposal: 'create HANDOFF.md from template' },
  },
  {
    id: 'P4.sessionbrief', step: 16, phase: 4,
    lookedFor: ['a SessionStart hook in .claude/settings.json'],
    check: ({ harness }) => registeredHook(harness, 'SessionStart',
      'install scripts/session-brief.mjs and register a SessionStart hook'),
  },
];

export function buildGaps({ stack, harness, exposures, profile, git, checkDefs = CHECKS }) {
  const applicable = new Set(profile.appliesToSteps());
  return checkDefs.map(def => {
    if (!applicable.has(def.step)) {
      return { id: def.id, step: def.step, phase: def.phase, state: 'n/a',
        lookedFor: def.lookedFor, evidence: [`not applicable to profile ${profile.id}`], proposal: null };
    }
    const r = def.check({ stack, harness, exposures, profile, git });
    return {
      id: def.id, step: def.step, phase: def.phase,
      state: r.state, lookedFor: def.lookedFor, evidence: r.evidence ?? [],
      // The invariant, enforced centrally: only `absent` may propose.
      proposal: r.state === 'absent' ? (r.proposal ?? null) : null,
    };
  });
}
