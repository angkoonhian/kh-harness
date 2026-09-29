import { execFileSync } from 'node:child_process';
import { readIfPresent, existsAny } from './scan.mjs';

const BOOTSTRAP_CANDIDATES = [
  'scripts/bootstrap.sh', 'scripts/bootstrap.ps1', 'scripts/setup.sh', 'scripts/setup.ps1',
  'bootstrap.sh', 'setup.sh', 'Makefile', 'Taskfile.yml', 'justfile',
];

const OTHER_EDITOR_PREFIXES = ['.cursor/rules', '.cursorrules', '.github/copilot-instructions.md', '.windsurfrules', '.clinerules', '.aider.conf.yml'];

function under(files, prefix, suffix) {
  return files.filter(f => f.startsWith(prefix) && (!suffix || f.endsWith(suffix))).sort();
}

function lineCount(text) {
  if (!text) return 0;
  const t = text.endsWith('\n') ? text.slice(0, -1) : text;
  return t.length === 0 ? 0 : t.split('\n').length;
}

/**
 * Count entries in `.claude/settings.json`'s `permissions.deny` array. Never
 * throws: a missing file, unparseable JSON, or a missing/malformed `deny`
 * array all yield 0 rather than an error.
 */
function denyRuleCount(root) {
  const text = readIfPresent(root, '.claude/settings.json');
  if (text == null) return 0;
  try {
    const deny = JSON.parse(text)?.permissions?.deny;
    return Array.isArray(deny) ? deny.length : 0;
  } catch { return 0; }
}

/** Remote URLs may embed credentials. We record only whether one is present. */
function remotes(root) {
  try {
    const out = execFileSync('git', ['-C', root, 'remote', '-v'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    });
    const seen = new Map();
    for (const line of out.split('\n')) {
      const m = line.match(/^(\S+)\s+(\S+)/);
      if (!m) continue;
      const [, name, url] = m;
      if (!seen.has(name)) seen.set(name, { name, hasCredential: /\/\/[^/@\s]+:[^/@\s]+@/.test(url) });
    }
    return [...seen.values()];
  } catch { return []; }
}

export function detectHarness(root, files) {
  const claudeMd = readIfPresent(root, 'CLAUDE.md');
  const agentsMd = readIfPresent(root, 'AGENTS.md');
  const instructionsPath = claudeMd != null ? 'CLAUDE.md' : (agentsMd != null ? 'AGENTS.md' : null);

  return {
    instructions: { path: instructionsPath, lines: lineCount(claudeMd ?? agentsMd) },
    agentsMd: agentsMd != null ? 'AGENTS.md' : null,
    claudeDir: {
      settings: files.includes('.claude/settings.json'),
      localSettings: files.includes('.claude/settings.local.json'),
      denyRules: denyRuleCount(root),
      hooks: under(files, '.claude/scripts/'),
      agents: under(files, '.claude/agents/', '.md'),
      skills: under(files, '.claude/skills/', '.md'),
      commands: under(files, '.claude/commands/', '.md'),
      rules: under(files, '.claude/rules/'),
    },
    otherEditors: files.filter(f => OTHER_EDITOR_PREFIXES.some(p => f === p || f.startsWith(p + '/'))).sort(),
    architecture: existsAny(root, ['docs/ARCHITECTURE.md', 'ARCHITECTURE.md', 'docs/architecture.md']),
    handoff: existsAny(root, ['HANDOFF.md', 'docs/HANDOFF.md']),
    bootstrap: existsAny(root, BOOTSTRAP_CANDIDATES),
    gitattributes: files.includes('.gitattributes'),
    remotes: remotes(root),
  };
}
