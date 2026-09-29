import { execFileSync } from 'node:child_process';
import { readIfPresent, existsAny } from './scan.mjs';
import { redactSecrets } from './detect-exposure.mjs';

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

// Project-scoped settings only. `~/.claude/settings.json` is deliberately not
// read: it is machine state, not repository state — the same reasoning that
// makes P2.langserver honestly `n/a`.
const SETTINGS_FILES = ['.claude/settings.json', '.claude/settings.local.json'];

/** Parse a settings file. Never throws: missing or malformed yields null. */
function parseSettings(root, rel) {
  const text = readIfPresent(root, rel);
  if (text == null) return null;
  try { return JSON.parse(text); } catch { return null; }
}

/**
 * Count entries in `.claude/settings.json`'s `permissions.deny` array. Never
 * throws: a missing file, unparseable JSON, or a missing/malformed `deny`
 * array all yield 0 rather than an error.
 */
function denyRuleCount(root) {
  const deny = parseSettings(root, '.claude/settings.json')?.permissions?.deny;
  return Array.isArray(deny) ? deny.length : 0;
}

/**
 * The hooks a repository has actually registered, grouped by event.
 *
 * This is the repository's own registry of what is wired up. A hook's script
 * may live anywhere — `node docs/agent-context/inject.js` is a real example —
 * so the file list under `.claude/scripts/` cannot answer whether an event is
 * covered, and a filename check can never be made adequate. Settings can.
 *
 * Shape parsed (Claude Code's):
 *   { "hooks": { "<Event>": [ { "matcher": "…", "hooks": [ { "command": "…" } ] } ] } }
 *
 * Commands are redacted against the credential patterns before being recorded,
 * because everything here is embedded whole into `docs/harness/detect.json`.
 * Never throws: a missing file, bad JSON or any malformed shape yields `{}`.
 */
function hookEvents(root) {
  const out = {};
  for (const rel of SETTINGS_FILES) {
    const hooks = parseSettings(root, rel)?.hooks;
    if (!hooks || typeof hooks !== 'object' || Array.isArray(hooks)) continue;
    for (const [event, matchers] of Object.entries(hooks)) {
      for (const matcher of Array.isArray(matchers) ? matchers : []) {
        for (const entry of Array.isArray(matcher?.hooks) ? matcher.hooks : []) {
          const command = typeof entry?.command === 'string' ? entry.command.trim() : '';
          if (!command) continue;
          (out[event] ??= []).push(redactSecrets(command));
        }
      }
    }
  }
  for (const event of Object.keys(out)) out[event] = [...new Set(out[event])].sort();
  return out;
}

const DOC_EXTENSIONS = ['.md', '.markdown'];

// Paths this kit itself writes or scaffolds. A pointer at one of these is the
// harness pointing at itself, not the repository pointing at its own docs.
const KIT_OUTPUT_PREFIXES = ['docs/harness/', '.claude/'];
const KIT_OUTPUT_FILES = new Set(['CLAUDE.md', 'AGENTS.md', 'HANDOFF.md', 'docs/HANDOFF.md']);

const isDoc = f => DOC_EXTENSIONS.some(e => f.toLowerCase().endsWith(e));
const isKitOutput = f => KIT_OUTPUT_FILES.has(f) || KIT_OUTPUT_PREFIXES.some(p => f.startsWith(p));

/**
 * Every path-shaped string the instruction file mentions, before resolution.
 * Three syntaxes, all of them things a repository writes deliberately:
 *   - `@path/to/file` — Claude Code's native import syntax
 *   - `[text](path)`  — a markdown link
 *   - `` `path` ``    — an inline-code path
 *
 * No attempt is made to tell a path from prose here. Resolution against the
 * real file list does that: `npm test` and `@someone` are not files, so they
 * disappear. URLs, anchors, absolute paths and parent escapes are dropped
 * outright because they can never name something inside this repository.
 */
function mentionedPaths(text) {
  if (!text) return [];
  const out = new Set();
  const add = raw => {
    let p = String(raw).trim().replace(/^<|>$/g, '').split('#')[0].split('?')[0];
    p = p.replace(/^\.\//, '').replace(/\/+$/, '');
    if (!p) return;
    if (/^[a-z][a-z0-9+.-]*:/i.test(p)) return;          // https:, mailto:, …
    if (p.startsWith('/') || p.startsWith('..')) return; // outside the repository
    out.add(p);
  };
  for (const m of text.matchAll(/(?:^|[\s(<])@([^\s`'"()<>\[\],;]+)/gm)) add(m[1]);
  for (const m of text.matchAll(/\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g)) add(m[1]);
  for (const m of text.matchAll(/`([^`\n]+)`/g)) add(m[1]);
  return [...out];
}

/**
 * Documentation the repository points at, resolved against the file list.
 *
 * This is (a) of finding D1: read the repository's own pointer instead of
 * guessing filenames. A directory pointer (`docs/wiki/`) credits the markdown
 * it contains. Nothing is content-sniffed and no candidate name list is
 * consulted — the set of names people give an architecture document is
 * unbounded, the set of ways a repository points at its own docs is not.
 */
function docPointers(text, files) {
  const present = new Set(files);
  const out = new Set();
  for (const p of mentionedPaths(text)) {
    if (present.has(p)) {
      if (isDoc(p) && !isKitOutput(p)) out.add(p);
      continue;
    }
    const prefix = p + '/';
    for (const f of files) if (f.startsWith(prefix) && isDoc(f) && !isKitOutput(f)) out.add(f);
  }
  return [...out].sort();
}

/** Markdown under docs/ that this kit did not write. */
function projectDocs(files) {
  return files.filter(f => f.startsWith('docs/') && isDoc(f) && !isKitOutput(f)).sort();
}

/**
 * Any userinfo on an http(s) remote is a credential. Both shapes count:
 * `https://user:token@host` and the single-token `https://TOKEN@host`, which
 * is the canonical one-liner in countless tutorials and was previously missed
 * because the pattern required a colon.
 *
 * Anchoring on http(s) excludes `ssh://git@github.com` and scp-style
 * `git@github.com:o/r.git`, where `git@` is a username, not a secret. The `@`
 * must sit in the authority — `[^/@\s]+` cannot cross a path separator — so a
 * repository path containing `@` is not mistaken for one.
 */
const REMOTE_CREDENTIAL = /^https?:\/\/[^/@\s]+@/i;

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
      if (!seen.has(name)) seen.set(name, { name, hasCredential: REMOTE_CREDENTIAL.test(url) });
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
      // File inventory. NOT what decides whether an event is covered — see hookEvents.
      hooks: under(files, '.claude/scripts/'),
      hookEvents: hookEvents(root),
      agents: under(files, '.claude/agents/', '.md'),
      skills: under(files, '.claude/skills/', '.md'),
      commands: under(files, '.claude/commands/', '.md'),
      rules: under(files, '.claude/rules/'),
    },
    otherEditors: files.filter(f => OTHER_EDITOR_PREFIXES.some(p => f === p || f.startsWith(p + '/'))).sort(),
    architecture: existsAny(root, ['docs/ARCHITECTURE.md', 'ARCHITECTURE.md', 'docs/architecture.md']),
    // What the repository itself points at, and what documentation exists at
    // all — so P1.architecture can tell "there is none" from "I only know
    // three filenames". See gap-model.mjs.
    docPointers: docPointers(claudeMd ?? agentsMd, files),
    projectDocs: projectDocs(files),
    handoff: existsAny(root, ['HANDOFF.md', 'docs/HANDOFF.md']),
    bootstrap: existsAny(root, BOOTSTRAP_CANDIDATES),
    gitattributes: files.includes('.gitattributes'),
    remotes: remotes(root),
  };
}
