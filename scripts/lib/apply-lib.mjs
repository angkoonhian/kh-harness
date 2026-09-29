// scripts/lib/apply-lib.mjs
//
// The only module in the kit that writes to a user's repository. Three rules
// make "never overwrite" structural rather than aspirational:
//   1. The write allowlist is enforced here, in code — never in settings.
//   2. Every proposal's path is validated before any of them is written, so a
//      bad proposal cannot leave a half-applied repository.
//   3. There is no --force. Not a flag, not an option, not a code path.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { classify, emptyManifest, sha256 } from './manifest.mjs';
import { addHookEntry, hasEquivalentHook } from './settings-merge.mjs';

const SETTINGS_PATH = '.claude/settings.json';
const CLAUDE_REDIRECT_PATH = 'docs/harness/CLAUDE.proposed.md';

// Exact paths and path prefixes the kit is ever allowed to write. Anything
// else — however it got proposed — is refused before a single byte is
// written. This list, not a permission rule in settings.json, is what keeps
// harness-kit from ever touching a user's own files: settings-based
// containment would appear to work (writes match through `Edit`, not
// `Write(path)`) and silently would not.
const ALLOWED_EXACT = new Set(['CLAUDE.md', 'HANDOFF.md', 'docs/ARCHITECTURE.md']);
const ALLOWED_PREFIXES = ['docs/harness/', '.claude/', 'scripts/'];

/** Throws on any path outside the allowlist. Never consulted anywhere but here. */
export function assertAllowed(relPath) {
  if (typeof relPath !== 'string' || relPath.length === 0) {
    throw new Error(`not allowed: empty or non-string path`);
  }

  const normalized = relPath.split('\\').join('/');

  // Absolute paths (POSIX or Windows-drive-letter) are never relative to the
  // target repository, so they are never allowed regardless of what they say.
  if (normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized)) {
    throw new Error(`not allowed: absolute path: ${relPath}`);
  }

  // Path traversal: any ".." segment could escape the repository root.
  if (normalized.split('/').includes('..')) {
    throw new Error(`not allowed: path traversal: ${relPath}`);
  }

  // .git is explicitly off-limits even though nothing in ALLOWED_PREFIXES
  // would ever match it — a repository's own history is never a write target.
  if (normalized === '.git' || normalized.startsWith('.git/')) {
    throw new Error(`not allowed: .git is off-limits: ${relPath}`);
  }

  if (ALLOWED_EXACT.has(normalized) || ALLOWED_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
    return;
  }

  throw new Error(`not allowed: "${relPath}" is outside the write allowlist`);
}

function splitLines(content) {
  if (content === '') return [];
  return content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
}

/**
 * Line-based diff via a longest-common-subsequence table. Not the fastest
 * algorithm available, but this project has zero npm dependencies and these
 * are hand-authored template files, not generated multi-megabyte sources.
 */
function diffLines(a, b) {
  const n = a.length;
  const m = b.length;
  const dp = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    }
  }

  const ops = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ type: 'ctx', line: a[i] });
      i++; j++;
    } else if (dp[i + 1][j] >= dp[i][j + 1]) {
      ops.push({ type: 'del', line: a[i] });
      i++;
    } else {
      ops.push({ type: 'add', line: b[j] });
      j++;
    }
  }
  while (i < n) { ops.push({ type: 'del', line: a[i] }); i++; }
  while (j < m) { ops.push({ type: 'add', line: b[j] }); j++; }
  return ops;
}

function unifiedDiff(before, after, label) {
  const ops = diffLines(splitLines(before), splitLines(after));
  const lines = [`--- a/${label}`, `+++ b/${label}`];
  for (const op of ops) {
    if (op.type === 'ctx') lines.push(` ${op.line}`);
    else if (op.type === 'add') lines.push(`+${op.line}`);
    else lines.push(`-${op.line}`);
  }
  return lines.join('\n');
}

function readSettings(root) {
  const p = join(root, SETTINGS_PATH);
  if (!existsSync(p)) return {};
  try {
    return JSON.parse(readFileSync(p, 'utf8'));
  } catch {
    return {};
  }
}

/** Preview of a settings-hook proposal: the whole file, before and after the merge. */
function renderSettingsHookDiff(root, proposal) {
  const before = readSettings(root);
  const beforeText = JSON.stringify(before, null, 2) + '\n';
  const { settings: after } = addHookEntry(before, proposal.event, proposal.entry);
  const afterText = JSON.stringify(after, null, 2) + '\n';
  return unifiedDiff(beforeText, afterText, SETTINGS_PATH);
}

/** Unified-style diff of a proposal against what is on disk today (or nothing). */
export function renderDiff(root, proposal) {
  if (proposal.kind === 'settings-hook') {
    return renderSettingsHookDiff(root, proposal);
  }
  const target = join(root, proposal.path);
  const before = existsSync(target) ? readFileSync(target, 'utf8') : '';
  return unifiedDiff(before, proposal.contents, proposal.path);
}

function writeFileDeep(absPath, contents) {
  mkdirSync(dirname(absPath), { recursive: true });
  writeFileSync(absPath, contents, 'utf8');
}

function upsertFileEntry(files, entry) {
  const idx = files.findIndex(f => f.path === entry.path);
  if (idx === -1) files.push(entry);
  else files[idx] = entry;
}

function applyFileProposal({ root, proposal, nextManifest, written, skipped, redirected }) {
  let targetPath = proposal.path;

  // CLAUDE.md is the file most likely to be hand-tuned and to hold decisions
  // that cannot be re-derived from source. If it already exists — no matter
  // who wrote it, or when — it is never written in place: the proposal is
  // redirected to a sibling the user can diff and merge by hand.
  if (proposal.path === 'CLAUDE.md' && existsSync(join(root, 'CLAUDE.md'))) {
    targetPath = CLAUDE_REDIRECT_PATH;
    redirected.push({ from: 'CLAUDE.md', to: targetPath });
  }

  const cls = classify(root, nextManifest, targetPath);
  const abs = join(root, targetPath);

  if (cls === 'ours-unmodified') {
    const existingEntry = nextManifest.files.find(f => f.path === targetPath);
    const newHash = sha256(proposal.contents);
    // Identical content already in place — nothing to do, nothing to report.
    if (existingEntry && existingEntry.sha256 === newHash) return;

    writeFileDeep(abs, proposal.contents);
    upsertFileEntry(nextManifest.files, { path: targetPath, sha256: newHash, step: proposal.step, writtenAt: new Date().toISOString() });
    written.push({ path: targetPath, step: proposal.step, checkId: proposal.checkId });
    return;
  }

  if (cls === 'theirs' && !existsSync(abs)) {
    writeFileDeep(abs, proposal.contents);
    upsertFileEntry(nextManifest.files, { path: targetPath, sha256: sha256(proposal.contents), step: proposal.step, writtenAt: new Date().toISOString() });
    written.push({ path: targetPath, step: proposal.step, checkId: proposal.checkId });
    return;
  }

  // Either `theirs` and already present, or `ours-modified` — a run that
  // declines to overwrite must say so, not quietly report success.
  skipped.push({ path: targetPath, why: cls, checkId: proposal.checkId });
}

function applySettingsHookProposal({ root, proposal, nextManifest, patched }) {
  const settingsPath = join(root, SETTINGS_PATH);
  const settings = readSettings(root);

  // Already wired up — reapplying would just duplicate the hook entry.
  if (hasEquivalentHook(settings, proposal.event, proposal.entry?.command)) return;

  const { settings: next, patch } = addHookEntry(settings, proposal.event, proposal.entry);
  writeFileDeep(settingsPath, JSON.stringify(next, null, 2) + '\n');

  nextManifest.settingsPatches.push({
    event: proposal.event,
    container: patch.container,
    entrySha256: patch.entrySha256,
    step: proposal.step,
    checkId: proposal.checkId,
    appliedAt: new Date().toISOString(),
  });
  patched.push({ event: proposal.event, step: proposal.step, checkId: proposal.checkId });
}

/**
 * Applies proposals additively: writes only what classify() says is safe to
 * write, never mutates the manifest it was given, and validates every
 * proposal's path before writing any of them so a bad proposal cannot leave
 * a half-applied repository.
 */
export function applyProposals({ root, proposals, manifest, kitVersion }) {
  // Pass 1: validate. No write happens until every proposal in the batch has
  // been checked against the allowlist.
  for (const proposal of proposals) {
    if (proposal.kind === 'file') {
      assertAllowed(proposal.path);
    } else if (proposal.kind === 'settings-hook') {
      assertAllowed(SETTINGS_PATH);
    } else {
      throw new Error(`apply: unknown proposal kind: ${proposal.kind}`);
    }
  }

  const written = [];
  const patched = [];
  const skipped = [];
  const redirected = [];

  const nextManifest = structuredClone(manifest ?? emptyManifest(kitVersion));
  nextManifest.files ??= [];
  nextManifest.settingsPatches ??= [];

  // Pass 2: apply. Every path in this batch already cleared the allowlist.
  for (const proposal of proposals) {
    if (proposal.kind === 'file') {
      applyFileProposal({ root, proposal, nextManifest, written, skipped, redirected });
    } else {
      applySettingsHookProposal({ root, proposal, nextManifest, patched });
    }
  }

  return { written, patched, skipped, redirected, manifest: nextManifest };
}

export { SETTINGS_PATH, CLAUDE_REDIRECT_PATH };
