// scripts/lib/apply-lib.mjs
//
// The only module in the kit that writes to a user's repository. Rules that
// make "never overwrite" structural rather than aspirational:
//   1. The write allowlist is enforced here, in code — never in settings.
//   2. Every proposal's target — allowlist AND filesystem containment — is
//      validated before any of them is written, so a bad proposal cannot
//      leave a half-applied repository.
//   3. A write-time failure (an I/O error pass 1 could not have predicted)
//      stops the batch but is recorded, never thrown away and never left
//      unrecorded — a partially applied repository that is accurately
//      described in its manifest is recoverable; one that is not, is not.
//   4. There is no --force. Not a flag, not an option, not a code path.
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, sep } from 'node:path';
import { classify, emptyManifest, sha256 } from './manifest.mjs';
import { addDenyRules, addHookEntry, buildMatcherEntry, hasEquivalentHook } from './settings-merge.mjs';

const SETTINGS_PATH = '.claude/settings.json';
const CLAUDE_REDIRECT_PATH = 'docs/harness/CLAUDE.proposed.md';

// A hand-rolled O(n·m) LCS diff is fine for the kit's own small template and
// script files. It is not fine for an arbitrary file a future proposal might
// target: 20k lines is already gigabytes of DP table, 40k OOMs Node. Above
// this many lines on either side, print a summary instead of a diff.
const DIFF_LINE_BAILOUT = 3000;

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

/**
 * Task 9b (coordinator round 2, finding 2 — "the one I care most about"):
 * uninstall-lib.mjs's directory cleanup used to carry its OWN, hand-
 * maintained allowlist of directories it may remove — a second list
 * answering the same question `assertAllowed` already answers for writes.
 * Two lists of what this tool may touch diverge eventually, and when they
 * do here the consequence is a file-removal mistake (removing something
 * apply could never write, or refusing to remove something it did), which
 * is worse than a duplicated predicate anywhere else in this codebase.
 *
 * `isAllowedDirectory` is not a second list: it is the SAME `ALLOWED_EXACT`
 * / `ALLOWED_PREFIXES` constants `assertAllowed` reads, reinterpreted for a
 * directory rather than a file. A directory is allowed exactly when it:
 *   - equals one of `ALLOWED_PREFIXES` with its trailing slash stripped
 *     (`.claude`, `scripts`, `docs/harness`) — the directories this tool's
 *     OWN generators write directly under; or
 *   - sits UNDER one of those prefixes (`.claude/scripts`, `.claude/rules`,
 *     `.claude/scripts/`); or
 *   - is the PARENT directory of one of `ALLOWED_EXACT`'s own file paths
 *     (`docs`, the parent of `docs/ARCHITECTURE.md`) — a directory no
 *     prefix names, but one a real write can still bring into existence.
 *
 * Deliberately does not duplicate `assertAllowed`'s absolute-path/`..`/`.git`
 * checks — a directory path reaching this function has already cleared
 * those as plain path-syntax safety (uninstall-lib.mjs's own guard, and
 * `assertContained` afterward); this function answers only the allowlist
 * question, the one that must never drift from what writes are allowed.
 */
export function isAllowedDirectory(relDir) {
  const normalized = relDir.split('\\').join('/');
  if (ALLOWED_PREFIXES.some(p => p === `${normalized}/`)) return true;
  if (ALLOWED_PREFIXES.some(p => normalized.startsWith(p))) return true;
  for (const f of ALLOWED_EXACT) {
    const parent = dirname(f);
    if (parent !== '.' && parent === normalized) return true;
  }
  return false;
}

/**
 * The allowlist is a string check on the *proposed* relative path. This is
 * the filesystem check: where does that path actually resolve on disk, right
 * now? A pre-existing symlink or junction anywhere along the chain — down to
 * and including the target itself, not just its parent — can route a write
 * outside the repository even though the proposed path string looks fine.
 *
 * The walk starts at the exact target, not dirname(target): a dangling
 * symlink sitting AT the target (e.g. HANDOFF.md itself is a broken symlink)
 * redirects a create-on-write there, and checking only the parent directory
 * would miss it entirely, since the parent (the repo root) is always fine.
 *
 * Exported because uninstall-lib.mjs needs exactly this check before every
 * rmSync. A delete routed outside the repository by a junction is at least
 * as bad as a write routed there, and the allowlist alone cannot see it.
 */
export function assertContained(root, relPath) {
  const abs = join(root, relPath);

  let realRoot;
  try {
    realRoot = realpathSync(root);
  } catch {
    throw new Error(`not allowed: could not resolve the repository root while checking "${relPath}"`);
  }

  let cur = abs;
  for (;;) {
    let entry;
    try {
      entry = lstatSync(cur); // does not follow a symlink/junction at cur itself
    } catch {
      entry = null;
    }
    if (entry) break;
    const parent = dirname(cur);
    if (parent === cur) break; // reached filesystem root without finding anything
    cur = parent;
  }

  let real;
  try {
    real = realpathSync(cur); // fully resolves any symlink/junction chain
  } catch {
    // Most commonly a dangling symlink: it exists (lstat succeeded above) but
    // cannot be resolved to a real, existing location. Refuse rather than
    // assume it is safe.
    throw new Error(`not allowed: "${relPath}" cannot be verified to stay inside the repository (broken symlink?)`);
  }

  const rel = relative(realRoot, real);
  const escapes = isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`);
  if (escapes) {
    throw new Error(`not allowed: "${relPath}" escapes the repository root via a symlink or junction`);
  }
}

function splitLines(content) {
  if (content === '') return [];
  return content.endsWith('\n') ? content.slice(0, -1).split('\n') : content.split('\n');
}

/**
 * Line-based diff via a longest-common-subsequence table. Not the fastest
 * algorithm available, but this project has zero npm dependencies and these
 * are hand-authored template files, not generated multi-megabyte sources.
 * See DIFF_LINE_BAILOUT for the point past which this stops being true.
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
  const a = splitLines(before);
  const b = splitLines(after);

  if (a.length > DIFF_LINE_BAILOUT || b.length > DIFF_LINE_BAILOUT) {
    return `--- a/${label}\n+++ b/${label}\n` +
      `(diff suppressed: ${a.length} vs ${b.length} lines exceeds the ${DIFF_LINE_BAILOUT}-line preview limit)`;
  }

  const ops = diffLines(a, b);
  const lines = [`--- a/${label}`, `+++ b/${label}`];
  for (const op of ops) {
    if (op.type === 'ctx') lines.push(` ${op.line}`);
    else if (op.type === 'add') lines.push(`+${op.line}`);
    else lines.push(`-${op.line}`);
  }
  return lines.join('\n');
}

/**
 * Reads `.claude/settings.json`. Distinguishes "absent" (fine — treated as
 * `{}`) from "present but unreadable as a settings object" (parse error, or
 * valid JSON that is not a plain object — an array, a string, null, ...).
 * The latter must never be silently replaced with `{}`: that would destroy
 * the user's file rather than merge into it.
 */
function readSettingsResult(root) {
  const p = join(root, SETTINGS_PATH);
  if (!existsSync(p)) return { ok: true, settings: {}, raw: null };

  let raw;
  try {
    raw = readFileSync(p, 'utf8');
  } catch {
    return { ok: false };
  }

  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false };
  }

  // `permissions` and `permissions.deny`, when present, must be shapes
  // addDenyRules can safely mutate — a plain object, and an array,
  // respectively. Validated HERE, once, rather than inside addDenyRules:
  // every consumer of this result then sees one validated shape, so
  // `{"permissions":"nope"}` or `{"permissions":{"deny":3}}` is refused
  // exactly like unparseable JSON, never passed through to crash a
  // `.push(...)` or a `new Set(...)` deep inside the merge.
  const permissions = parsed.permissions;
  if (permissions !== undefined && (permissions === null || typeof permissions !== 'object' || Array.isArray(permissions))) {
    return { ok: false };
  }
  const deny = permissions?.deny;
  if (deny !== undefined && !Array.isArray(deny)) {
    return { ok: false };
  }

  return { ok: true, settings: parsed, raw };
}

/**
 * Task 9b, finding 5: this tool's own write always appended a trailing
 * newline, even to a file that had none — the single most common
 * one-line diff after an otherwise content-identical round trip (a plain
 * `JSON.stringify(x, null, 2)` never ends in one). `raw` is the file's
 * exact original text (`null` when it did not exist, i.e. being created
 * fresh — a brand-new file keeps the conventional trailing newline).
 * Deliberately narrow: this matches ONE byte, not the original's line
 * endings or indentation — see apply.mjs's own `alreadyCanonical` comment
 * (and this project's standing ruling against a format-preserving JSON
 * editor) for why the rest of the reformat stays disclosed, not fixed.
 */
function matchingNewline(raw) {
  return raw != null && !raw.endsWith('\n') ? '' : '\n';
}

/**
 * Task 9b (coordinator round 2, finding 3): apply.mjs and uninstall.mjs
 * each rewrite `.claude/settings.json` via `JSON.stringify(x, null, 2)` —
 * applying a patch, and reverting one — and each used to carry its OWN,
 * near-identical sentence disclosing that the rest of the file may have
 * been reformatted along with it. Two independently-worded copies of the
 * same disclosure drift: this project's verification already caught the
 * two differ in a small way ("beyond what was listed" vs. "beyond what
 * was reverted"). One sentence, one place; `verb` is the only thing that
 * legitimately differs between the two callers ("applying the patch
 * above" / "reverting the patch(es) above").
 */
export function settingsReformattedNote(verb) {
  return `note       .claude/settings.json was reformatted while ${verb} — its content is ` +
    `unchanged beyond what was listed, but whitespace/indentation may now differ throughout the file ` +
    `(this tool always rewrites it as JSON.stringify(settings, null, 2); it does not preserve the ` +
    `original formatting).`;
}

/**
 * Preview of a settings-hook proposal: the added entry, and nothing else.
 *
 * `.claude/settings.json` is the single most credential-dense file this tool
 * ever touches — this codebase's own detect-exposure treats it and hook
 * command bodies as credential carriers — and a dry run is the *default*,
 * so whatever this function emits is printed to a terminal without anyone
 * asking for it. Serialising the whole settings object and diffing it with
 * full context printed the user's `env` block and every unrelated hook
 * command verbatim, secrets included.
 *
 * `addHookEntry` only ever appends one matcher entry to `hooks[event]`, so
 * the entire change is that one entry. Showing the user's own lines to
 * present a one-entry addition was gratuitous even before it leaked
 * anything: nothing outside the added entry is read into this preview.
 */
function renderSettingsHookDiff(root, proposal) {
  const result = readSettingsResult(root);
  if (!result.ok) {
    return `--- a/${SETTINGS_PATH}\n+++ b/${SETTINGS_PATH}\n` +
      `(${SETTINGS_PATH} could not be parsed as a JSON object — no changes will be made; fix its JSON and re-run)`;
  }

  const container = `hooks.${proposal.event}`;
  const siblings = Array.isArray(result.settings?.hooks?.[proposal.event])
    ? result.settings.hooks[proposal.event].length
    : 0;

  // The EXACT element addHookEntry will push — built by the SAME function
  // (buildMatcherEntry), not a second independently-maintained copy of its
  // ternary, so a preview/write mismatch is structurally impossible rather
  // than merely commented against.
  const matcherEntry = buildMatcherEntry(proposal.entry, proposal.matcher);
  const added = JSON.stringify(matcherEntry, null, 2);

  const lines = [`--- a/${SETTINGS_PATH}`, `+++ b/${SETTINGS_PATH}`, `@@ ${container} @@`];
  for (const line of splitLines(added)) lines.push(`+${line}`);
  if (siblings > 0) {
    lines.push(`(appended after ${siblings} existing ${container} entr${siblings === 1 ? 'y' : 'ies'}, which are left unchanged and not shown)`);
  }
  lines.push(`(nothing else in ${SETTINGS_PATH} is changed, or shown — it is yours, and it may hold credentials)`);
  return lines.join('\n');
}

/**
 * Preview of a settings-deny proposal: the rules that would actually be
 * added, and nothing else — mirrors renderSettingsHookDiff immediately
 * above, and for the same reason. `permissions.deny` can hold the user's own
 * rules, which can themselves embed a credential (a `Bash(curl ... TOKEN ...)`
 * pattern is a deny rule shape as valid as any other), so diffing the whole
 * array would leak exactly like diffing the whole file would.
 *
 * `addDenyRules` already computes exactly which proposed rules are new —
 * `added` — so this never needs to look at anything else in the file.
 */
function renderSettingsDenyDiff(root, proposal) {
  const result = readSettingsResult(root);
  if (!result.ok) {
    return `--- a/${SETTINGS_PATH}\n+++ b/${SETTINGS_PATH}\n` +
      `(${SETTINGS_PATH} could not be parsed as a JSON object — no changes will be made; fix its JSON and re-run)`;
  }

  const existing = Array.isArray(result.settings?.permissions?.deny) ? result.settings.permissions.deny.length : 0;
  const { added } = addDenyRules(result.settings, proposal.globs);

  const lines = [`--- a/${SETTINGS_PATH}`, `+++ b/${SETTINGS_PATH}`, `@@ permissions.deny @@`];
  if (added.length === 0) {
    lines.push(`(every proposed rule is already present — nothing would be added)`);
  } else {
    for (const rule of added) lines.push(`+${JSON.stringify(rule)}`);
    if (existing > 0) {
      lines.push(`(appended after ${existing} existing permissions.deny entr${existing === 1 ? 'y' : 'ies'}, which are left unchanged and not shown)`);
    }
  }
  lines.push(`(nothing else in ${SETTINGS_PATH} is changed, or shown — it is yours, and it may hold credentials)`);
  return lines.join('\n');
}

/**
 * Where a file proposal will actually land. CLAUDE.md is the file most
 * likely to be hand-tuned and to hold decisions that cannot be re-derived
 * from source: if it already exists — no matter who wrote it, or when — the
 * proposal is redirected to a sibling the user can diff and merge by hand,
 * rather than written in place.
 */
function resolveFileTarget(root, proposal) {
  if (proposal.path === 'CLAUDE.md' && existsSync(join(root, 'CLAUDE.md'))) {
    return { targetPath: CLAUDE_REDIRECT_PATH, redirectFrom: 'CLAUDE.md' };
  }
  return { targetPath: proposal.path, redirectFrom: null };
}

/**
 * Unified-style diff of a proposal against what is on disk today (or
 * nothing). For a redirected CLAUDE.md, this previews the diff against the
 * redirect target — never against CLAUDE.md itself, which is never touched,
 * so the preview must never present the user's own lines as being deleted.
 */
export function renderDiff(root, proposal) {
  if (proposal.kind === 'settings-hook') {
    return renderSettingsHookDiff(root, proposal);
  }
  if (proposal.kind === 'settings-deny') {
    return renderSettingsDenyDiff(root, proposal);
  }

  const { targetPath, redirectFrom } = resolveFileTarget(root, proposal);
  const target = join(root, targetPath);
  const before = existsSync(target) ? readFileSync(target, 'utf8') : '';
  const body = unifiedDiff(before, proposal.contents, targetPath);

  return redirectFrom
    ? `(${redirectFrom} already exists and is left untouched — previewing the redirect to ${targetPath} instead)\n${body}`
    : body;
}

/**
 * `mode`, when given, is applied with an explicit `chmod` call AFTER the
 * write — not merely passed as `writeFileSync`'s own `mode` option, which
 * Node only honours when the file is actually CREATED (the open flag's
 * mode is ignored on an existing file). A proposal like P1.bootstrap's
 * `scripts/bootstrap.sh` (mode `0o755` — it has a shebang and is meant to
 * be executed directly) must end up executable whether this is the first
 * write or a later one re-writing changed contents.
 *
 * `chmod` is injected (defaulting to the real `chmodSync`) for the same
 * reason `verify.mjs`'s `run` is injectable: real POSIX mode bits are not
 * observable on every platform this project is developed on (Windows'
 * `chmodSync` has no execute-bit concept `stat().mode` can report — a
 * review confirmed the bits are genuinely unobservable there, not merely
 * untested), but the CALL this function makes is the same production line
 * regardless of OS. Injecting `chmod` lets a test pin that line directly,
 * on every platform, rather than asserting an effect one platform cannot
 * produce.
 */
function writeFileDeep(absPath, contents, relPath, mode, chmod) {
  try {
    mkdirSync(dirname(absPath), { recursive: true });
    writeFileSync(absPath, contents, 'utf8');
    if (mode != null) chmod(absPath, mode);
  } catch (err) {
    const wrapped = new Error(`failed to write ${relPath}: ${err.message}`);
    wrapped.path = relPath;
    throw wrapped;
  }
}

function upsertFileEntry(files, entry) {
  const idx = files.findIndex(f => f.path === entry.path);
  if (idx === -1) files.push(entry);
  else files[idx] = entry;
}

/**
 * Task 9b, finding 4: uninstall used to leave behind every directory apply
 * had to create to write its own files — on a repository with no `.claude/`
 * at all beforehand, a complete uninstall still left an empty `.claude/`,
 * `.claude/scripts/` and `scripts/` behind. The fix needs to know, at
 * uninstall time, which directories THIS tool actually brought into
 * existence — never one that already existed, and never one a later
 * `rmdir` could be wrong to touch merely because it happens to be empty
 * NOW. That provenance has to be recorded at the moment of creation, since
 * "is this directory empty" on its own cannot answer "did we create it" —
 * a user's own, separately-empty directory of the same name is
 * indistinguishable from ours after the fact.
 *
 * Called BEFORE `writeFileDeep`'s own `mkdirSync(..., { recursive: true })`
 * so every ancestor directory's existence is checked against the real
 * filesystem as it stood before this write, not after. `nextManifest` is
 * mutated in place and de-duplicated via a Set — safe to call once per
 * write even when an earlier write in the same batch already created a
 * shared ancestor (e.g. two files landing in `.claude/scripts/`).
 */
function recordCreatedDirs(root, nextManifest, relPath) {
  const dir = dirname(relPath.split('\\').join('/'));
  if (dir === '.' || dir === '/') return;
  const created = new Set(nextManifest.dirsCreated ?? []);
  let cum = '';
  for (const seg of dir.split('/')) {
    cum = cum ? `${cum}/${seg}` : seg;
    if (!existsSync(join(root, cum))) created.add(cum);
  }
  nextManifest.dirsCreated = [...created];
}

function applyFileProposal({ root, proposal, nextManifest, written, skipped, redirected, chmod }) {
  const { targetPath, redirectFrom } = resolveFileTarget(root, proposal);
  if (redirectFrom) redirected.push({ from: redirectFrom, to: targetPath });

  const cls = classify(root, nextManifest, targetPath);
  const abs = join(root, targetPath);

  if (cls === 'ours-unmodified') {
    const existingEntry = nextManifest.files.find(f => f.path === targetPath);
    const newHash = sha256(proposal.contents);
    if (existingEntry && existingEntry.sha256 === newHash) {
      // Identical content already in place: nothing to write, but a library
      // caller must be able to tell "nothing needed doing" from "nothing
      // happened" — report it rather than staying silent.
      skipped.push({ path: targetPath, why: 'unchanged', checkId: proposal.checkId });
      return;
    }

    recordCreatedDirs(root, nextManifest, targetPath);
    writeFileDeep(abs, proposal.contents, targetPath, proposal.mode, chmod);
    upsertFileEntry(nextManifest.files, { path: targetPath, sha256: newHash, step: proposal.step, writtenAt: new Date().toISOString() });
    written.push({ path: targetPath, step: proposal.step, checkId: proposal.checkId });
    return;
  }

  if (cls === 'theirs' && !existsSync(abs)) {
    recordCreatedDirs(root, nextManifest, targetPath);
    writeFileDeep(abs, proposal.contents, targetPath, proposal.mode, chmod);
    upsertFileEntry(nextManifest.files, { path: targetPath, sha256: sha256(proposal.contents), step: proposal.step, writtenAt: new Date().toISOString() });
    written.push({ path: targetPath, step: proposal.step, checkId: proposal.checkId });
    return;
  }

  // Either `theirs` and already present, or `ours-modified` — a run that
  // declines to overwrite must say so, not quietly report success.
  skipped.push({ path: targetPath, why: cls, checkId: proposal.checkId });
}

/**
 * Review finding 5: a settings patch that ACTIVATES a script must not be
 * applied unless that script, and everything it depends on, is actually
 * present on disk — checked against the real filesystem, after the write
 * phase, never merely trusted because the batch's PLAN said it would
 * write them. Without this, a hook that shares a dependency with another
 * (e.g. lint-touched.mjs and verify-touched.mjs both importing
 * harness-redact.mjs) could get registered in one run while the shared
 * file was never (re)written in that same run — propose.mjs's own
 * "never re-propose a file already in the manifest" rule means exactly
 * this happens once a user deletes the shared file and only ONE of the
 * two hooks' checks is absent on a later run. The result without this
 * check: a `Stop`/`PostToolUse` hook registered, exiting 0 or 2 as far as
 * settings.json is concerned, that actually dies with
 * `ERR_MODULE_NOT_FOUND` on every turn or every edit.
 *
 * `existsSync`, not the manifest: the manifest only records what a PRIOR
 * run believed it wrote, which is exactly the stale information this
 * check exists to not trust.
 */
function missingDependencies(root, proposal) {
  return (proposal.requiresFiles ?? []).filter(f => !existsSync(join(root, f)));
}

function applySettingsHookProposal({ root, proposal, nextManifest, patched, skipped }) {
  const settingsPath = join(root, SETTINGS_PATH);

  const missing = missingDependencies(root, proposal);
  if (missing.length > 0) {
    skipped.push({ path: SETTINGS_PATH, why: `missing-dependency: ${missing.join(', ')}`, checkId: proposal.checkId });
    return;
  }

  const result = readSettingsResult(root);

  if (!result.ok) {
    // The single most security-relevant file in the repository. An
    // unparseable settings.json (trailing commas, comments, a JSON array
    // instead of an object, ...) must never be silently replaced with `{}` —
    // that destroys whatever the user had. Write nothing; report it.
    skipped.push({ path: SETTINGS_PATH, why: 'unparseable', checkId: proposal.checkId });
    return;
  }

  const settings = result.settings;
  if (hasEquivalentHook(settings, proposal.event, proposal.entry?.command)) {
    skipped.push({ path: SETTINGS_PATH, why: 'unchanged', checkId: proposal.checkId });
    return;
  }

  const { settings: next, patch } = addHookEntry(settings, proposal.event, proposal.entry, proposal.matcher);
  // Task 9b, finding 4: recorded only once, the first time this run (or any
  // prior one — `nextManifest` starts from a clone of the existing
  // manifest) finds the file absent right before writing it. Never reset
  // back to false: once the file was ours to create, it stays ours to
  // clean up even across later runs that only patch it further.
  if (result.raw === null) nextManifest.settingsCreated = true;
  recordCreatedDirs(root, nextManifest, SETTINGS_PATH);
  writeFileDeep(settingsPath, JSON.stringify(next, null, 2) + matchingNewline(result.raw), SETTINGS_PATH);

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

function applySettingsDenyProposal({ root, proposal, nextManifest, patched, skipped }) {
  const settingsPath = join(root, SETTINGS_PATH);
  const result = readSettingsResult(root);

  if (!result.ok) {
    // Same reasoning as applySettingsHookProposal: never silently replace an
    // unparseable settings.json with {}.
    skipped.push({ path: SETTINGS_PATH, why: 'unparseable', checkId: proposal.checkId });
    return;
  }

  const { settings: next, patch } = addDenyRules(result.settings, proposal.globs);

  // addDenyRules returns patch: null when every proposed rule is already
  // present — a patch describing an empty change is a lie the manifest would
  // later act on (e.g. uninstall trying to revert rules that were never
  // ours to begin with), so only a non-null patch may ever be recorded.
  if (!patch) {
    skipped.push({ path: SETTINGS_PATH, why: 'unchanged', checkId: proposal.checkId });
    return;
  }

  if (result.raw === null) nextManifest.settingsCreated = true;
  recordCreatedDirs(root, nextManifest, SETTINGS_PATH);
  writeFileDeep(settingsPath, JSON.stringify(next, null, 2) + matchingNewline(result.raw), SETTINGS_PATH);

  nextManifest.settingsPatches.push({
    event: 'permissions.deny',
    container: patch.container,
    entrySha256: patch.entrySha256,
    rules: patch.rules,
    step: proposal.step,
    checkId: proposal.checkId,
    appliedAt: new Date().toISOString(),
  });
  patched.push({ event: 'permissions.deny', step: proposal.step, checkId: proposal.checkId });
}

/**
 * Applies proposals additively: writes only what classify() says is safe to
 * write, never mutates the manifest it was given, and validates every
 * proposal's target — allowlist and filesystem containment — before writing
 * any of them, so a bad proposal cannot leave a half-applied repository.
 *
 * Never throws on an I/O failure encountered while applying. Such a failure
 * stops the batch (nothing after it is attempted) but is recorded in
 * `failed` and returned normally, with the manifest reflecting exactly what
 * was written before the failure — so the caller can always write that
 * manifest and know it describes reality.
 *
 * `chmod` defaults to the real `chmodSync` and is never overridden by any
 * production caller (apply.mjs) — it exists so a test can inject a stub and
 * assert the call itself, platform-independently, rather than its OS-level
 * effect (see `writeFileDeep`'s own comment on why that effect is not
 * observable on every platform this project is developed on).
 */
export function applyProposals({ root, proposals, manifest, kitVersion, chmod = chmodSync }) {
  // Pass 1: validate. No write happens until every proposal in the batch has
  // cleared both the allowlist and the containment check.
  //
  // KNOWN GAP, deliberately not closed here. `assertContained` is a
  // filesystem check, and pass 2 writes without re-running it: between the
  // two passes an adversary with write access to the repository could
  // replace a validated directory with a junction, and the write would
  // follow it out. Closing that needs an open-then-verify-by-handle write
  // rather than a path write, which Node's synchronous fs makes awkward and
  // which would buy nothing against an attacker who already has write access
  // to the tree. It is recorded because it is the same shape as I1 — a
  // decision made once and then trusted — and because the next person to
  // touch this loop should know the re-check is missing on purpose.
  // uninstall-lib.mjs does re-check at delete time; the cost there is one
  // realpathSync per entry, and deleting is not recoverable.
  for (const proposal of proposals) {
    if (proposal.kind === 'file') {
      assertAllowed(proposal.path);
      const { targetPath } = resolveFileTarget(root, proposal);
      assertAllowed(targetPath);
      assertContained(root, targetPath);
    } else if (proposal.kind === 'settings-hook' || proposal.kind === 'settings-deny') {
      assertAllowed(SETTINGS_PATH);
      assertContained(root, SETTINGS_PATH);
    } else {
      throw new Error(`apply: unknown proposal kind: ${proposal.kind}`);
    }
  }

  const written = [];
  const patched = [];
  const skipped = [];
  const redirected = [];
  const failed = [];

  const nextManifest = structuredClone(manifest ?? emptyManifest(kitVersion));
  nextManifest.files ??= [];
  nextManifest.settingsPatches ??= [];

  // Pass 2: apply. Every path in this batch already cleared validation; what
  // remains is what validation cannot predict — actual I/O.
  for (const proposal of proposals) {
    try {
      if (proposal.kind === 'file') {
        applyFileProposal({ root, proposal, nextManifest, written, skipped, redirected, chmod });
      } else if (proposal.kind === 'settings-hook') {
        applySettingsHookProposal({ root, proposal, nextManifest, patched, skipped });
      } else {
        applySettingsDenyProposal({ root, proposal, nextManifest, patched, skipped });
      }
    } catch (err) {
      failed.push({ path: err?.path ?? proposal.path ?? SETTINGS_PATH, error: err?.message ?? String(err) });
      break;
    }
  }

  return { written, patched, skipped, redirected, failed, manifest: nextManifest };
}

// `ALLOWED_PREFIXES`/`ALLOWED_EXACT` are exported for exactly one purpose:
// a test proving `assertAllowed` and `isAllowedDirectory` read the SAME
// list, not two that happen to agree today — see apply-lib.test.mjs. No
// production caller should import these to re-derive its own allowlist
// logic; `assertAllowed`/`isAllowedDirectory` are the two sanctioned
// readers of them.
export { SETTINGS_PATH, CLAUDE_REDIRECT_PATH, matchingNewline, ALLOWED_PREFIXES, ALLOWED_EXACT };
