// scripts/lib/detect-exposure.mjs
import { openSync, fstatSync, readSync, closeSync } from 'node:fs';
import { join, basename } from 'node:path';

const MAX_BYTES = 512 * 1024;

// `token-in-repo-file` is NOT called `token-in-tracked-file`, and must not be
// renamed back. This scanner walks the filesystem; it never consults the git
// index, so it cannot know whether a file is tracked. Under the old name it
// asserted tracking it had not checked: run against a real repository it
// labelled three files `token-in-tracked-file` that `git ls-files` did not
// know and that had zero commits touching them. The exposure was real; the
// kind was a claim the detector had no evidence for, which is the one thing
// this tool is not allowed to do. If a genuine tracked/untracked split is
// wanted later, it needs the git index as an input, not a new name.
//
// Always-probed paths (e.g., .gitignored local settings)
// The two files `token-in-local-settings` actually names. Whole-branch
// review, F8 (the trailing "related, same module, trivial" note): the test
// used to be `rel.startsWith('.claude/')`, which reported a token in, say,
// `.claude/scripts/lint-touched.mjs` under a kind that names a different
// file. A token anywhere else under `.claude/` is an ordinary
// `token-in-repo-file`.
const LOCAL_SETTINGS_FILES = new Set(['.claude/settings.json', '.claude/settings.local.json']);

const ALWAYS_PROBE = [
  '.claude/settings.local.json',
  '.claude/settings.json',
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.npmrc',
  '.netrc',
];

// Provider-token shapes. Every pattern is global (every match in a file is
// examined, see `tokenFinding`) and anchored at a word boundary: the old
// `/sk-[A-Za-z0-9]{20,}/` matched inside `desk-…`. Audit Tier 1, finding 1
// (docs/2026-11-02-audit-findings.md): the previous list predated today's
// shapes — an OpenAI `sk-proj-…` key failed the old `sk-` rule at its first
// hyphen, and `npm_`, `github_pat_` and `AIza` were not listed at all — so a
// tree holding all three reported `verified`.
const TOKEN_PATTERNS = [
  /\bglpat-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  // The hyphenated body is admitted only after a known vendor prefix: a
  // bare `sk-[A-Za-z0-9_-]{20,}` read `/sk-hynix-memory-chips-report-2024`
  // and `sk-learn-compatible-estimator-api` as high findings (final
  // review, Important 1). The legacy alphanumeric-only form stays.
  /\bsk-(?:[A-Za-z0-9]{20,}|(?:proj|ant|svcacct|admin|or-v1)-[A-Za-z0-9_-]{20,})/g,
  /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g,
  /\bAKIA[0-9A-Z]{16}/g,
  /\bnpm_[A-Za-z0-9]{36}/g,
  /\bAIza[0-9A-Za-z_-]{35}/g,
  /\bBearer\s+[A-Za-z0-9._-]{20,}/gi,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
];

const PEM_PATTERN = /-----BEGIN [A-Z ]*PRIVATE KEY-----/g;

// A credential-shaped KEY followed by a value of eight or more non-space
// characters. Global: every match in a file is examined (a placeholder on
// line 1 used to hide a literal on line 2). The optional closing quote lets
// a JSON key (`"password": "…"`) match. The key list is deliberately
// compound-only beyond the three password spellings: bare `token:` and
// `secret:` were probed against this repository and matched 48 and 8 lines
// of ordinary prose, which would bury the check in noise. `auth[_-]?token`
// also covers `.npmrc`'s `_authToken`.
const DB_CRED = /(?:password|passwd|pwd|api[_-]?key|client[_-]?secret|secret[_-]?key|access[_-]?token|auth[_-]?token)["']?\s*[:=]\s*(\S{8,})/gi;

// Tested on the VALUE only — of a credential line, or of a token match with
// its `Bearer ` scheme removed. It used to be tested on key+value for
// credential lines, so a key that happened to contain `example` hid a real
// value; and it was never applied to tokens, so `Bearer YOUR_TOKEN_HERE` was
// a permanent high finding.
const PLACEHOLDER = /(your[-_]|<|xxx|example|changeme|placeholder|dummy|redacted|^(password|secret|todo)$)/i;

// What makes a TOKEN a placeholder is a filler that dominates its body —
// the documented AWS example key, `ghp_xxxxxxxxxxxxxxxx`, `<your-token>` —
// never a three-letter substring: a real base62 body of 150 characters has
// roughly a 0.5 % chance of containing `xxx`, and skipping it would be a
// false `verified`, the one direction this check must not fail in (final
// review, Important 2). A `Bearer` value keeps the fuller PLACEHOLDER rule:
// its body is free text in the documentation that carries it. A run of one
// repeated letter is NOT treated as filler: real documentation fills with
// `x`, `*` or `#`, and over-reporting a repeated letter is the safe direction.
const TOKEN_PLACEHOLDER = /your[-_]|example|placeholder|changeme|redacted|<|[_-][x*#]{8,}$/i;

// Task 9b, finding 1: a credential-shaped key (`password:`, `pwd=`, ...)
// whose VALUE is a code reference — a property access, a function call, or a
// subscript, e.g. `process.env.TOKEN`, `config.get('x')`, `os.environ["K"]`,
// `self.password`, `settings.SECRET_KEY` — is ordinary source code reading a
// secret from somewhere else, not a secret written in the file. On a real
// TypeScript codebase this shape was 62 of 66 `credentials-in-doc` hits: noise
// loud enough to bury the one real finding and four plausible ones beneath it.
//
// This is syntactic, not a parser: a reference is an identifier, optionally
// extended by one or more `.prop`, `(...)`, or `[...]` segments, and NOTHING
// else — the whole value, start to end. Deliberately conservative, per the
// standing ruling that a guard which misses a real secret is worse than one
// that over-reports: a bare identifier with NO such extension (`SECRET_KEY`
// alone), a quoted string, a `glpat-`-shaped token (a literal that merely
// STARTS with identifier characters before hitting a `-` the pattern below
// does not accept as a continuation), and an empty string all fail to match
// and are therefore classified `literal` — prominent, exactly as before this
// fix. Only a genuine compound reference expression is ever classified
// `reference`. When in doubt, this returns `literal`.
const REFERENCE_VALUE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\([^()]*\)|\[[^[\]]*\])+[;,]?$/;

// The other way a file reads a secret from somewhere else: shell, dotenv,
// `.npmrc` and CI interpolation — `$VAR`, `${VAR}`, `%VAR%`, `${{ secrets.X }}` —
// optionally quoted (including a markdown backtick, so a documented example
// is not a finding) and optionally followed by one statement delimiter. The
// most common `.npmrc` line in existence — `_authToken` set to `${NPM_TOKEN}` —
// is exactly this shape and used to classify `literal`. A value that merely
// STARTS with a dollar sign (`$uper$ecret`) is not an interpolation and
// stays `literal`.
const ENV_REFERENCE = /^["'`]?(?:\$[A-Za-z_][A-Za-z0-9_]*|\$\{\{[^}]*\}\}|\$\{[A-Za-z_][A-Za-z0-9_:.-]*\}|%[A-Za-z_][A-Za-z0-9_]*%)["'`]?[;,]?$/;

/**
 * Classifies a `credentials-in-doc` match's VALUE half (never the key) as
 * `'literal'` (a real string/token — stays a prominent finding) or
 * `'reference'` (code reading a secret from elsewhere — collapsed to a count
 * by report.mjs/gap-model.mjs, never suppressed or dropped here). This
 * function only tags; it never decides what is shown or counted as a
 * failure — see detectExposures below, which runs it over every DB_CRED
 * match and records the result on the finding, and splitExposures /
 * isProminentExposure, which downstream callers use to decide presentation.
 */
export function classifyCredentialValue(value) {
  if (typeof value !== 'string' || value.length === 0) return 'literal';
  return REFERENCE_VALUE.test(value) || ENV_REFERENCE.test(value) ? 'reference' : 'literal';
}

/**
 * Not a credential finding: a file the scan list NAMED that this sweep could
 * not read, so it was never examined at all.
 *
 * Whole-branch review, F1. The defect was not git's path quoting — that was
 * only how the unreadable path got here. The defect was that `scannable`'s
 * `catch { return false }` turned "I could not look at this file" into "there
 * is nothing here", with no record anywhere that a file had been skipped, and
 * `P0.security` then reported `verified / no credential patterns matched` over
 * a plaintext token. A security check that reports success because it never
 * read the file inverts this project's whole doctrine, and the quoting fix
 * alone would leave that inversion in place for every OTHER reason a read can
 * fail (EACCES, a file deleted between the scan and the read, a path outside
 * the tree, a filesystem error). So: an unexpected read failure is a FINDING,
 * carried on the same list every other Phase-0 finding is carried on, and
 * `P0.security` cannot be `verified` while one exists.
 *
 * Deliberately NOT reported: the skips this module makes ON PURPOSE and
 * states in code — `SKIP_DIRS`, `SKIP_EXT` (a PNG is not unexamined, it is
 * not text), a non-regular file such as a submodule gitlink, and a file over
 * `MAX_BYTES`. Reporting those would make `P0.security` `failing` on every
 * real repository, which is its own false report and would teach a reader to
 * skip the one line in this tool they are most likely to act on. The honest
 * treatment of a deliberate skip is a `verified` sentence that claims only
 * what was actually read — see gap-model.mjs's `CLEAN_SWEEP_NOTE` — not an
 * alarm.
 */
export const UNREADABLE_KIND = 'file-unreadable';

/** True for every exposure that must stay individually visible: every kind
 * OTHER than `credentials-in-doc`, and a `credentials-in-doc` finding whose
 * value is a literal rather than a code reference. An `UNREADABLE_KIND`
 * finding is always prominent: it is the one thing that must never be
 * collapsed, since it is the record that the sweep is incomplete. */
export function isProminentExposure(e) {
  return !(e.kind === 'credentials-in-doc' && e.valueKind === 'reference');
}

/** Splits a full exposure list into the ones that must stay prominent and a
 * bare count of the rest (credential-shaped keys holding a code reference,
 * not a literal) — never the entries themselves, so a caller cannot
 * accidentally re-individualise what this exists to collapse. */
export function splitExposures(exposures) {
  const prominent = exposures.filter(isProminentExposure);
  return { prominent, collapsedCount: exposures.length - prominent.length };
}

/**
 * `prominent` (from `splitExposures`) split again, into the credential
 * findings the Exposures section lists and the files the sweep could not
 * examine. Shared — like `splitExposures` itself — so `P0.security`'s own
 * evidence (gap-model.mjs) and the rendered sections (report.mjs) can never
 * disagree about which of the two a finding is, or how many there are of
 * each. Returns both lists; callers decide presentation, never membership.
 */
export function partitionProminent(prominent) {
  return {
    credentials: prominent.filter(e => e.kind !== UNREADABLE_KIND),
    unreadable: prominent.filter(e => e.kind === UNREADABLE_KIND),
  };
}

/** The one shared sentence for the collapsed class, so detect's Phase-0
 * evidence and the Exposures section always say exactly the same thing. */
export function collapsedExposureNote(count) {
  const s = count === 1 ? '' : 's';
  const isAre = count === 1 ? 'is a' : 'are';
  return `${count} credential-shaped key${s} whose value${s} ${isAre} code reference${s} (not literal${s}) — listed in detect.json, not shown here`;
}

/**
 * The one shared sentence for the fixture class — literal credential hits in
 * test or fixture paths, listed at severity `low` — so `P0.security`'s
 * evidence and the reader's expectation of the Exposures section agree.
 */
export function fixtureExposureNote(count) {
  const s = count === 1 ? '' : 's';
  return `${count} credential-shaped literal${s} in test or fixture path${s} — listed under "Exposures" at severity low; a fixture password does not fail this check by itself, but read the list`;
}

/**
 * The one shared sentence for "this sweep is incomplete". Written as one
 * place for the same reason `collapsedExposureNote` is: `P0.security` and the
 * rendered section must not be able to describe the same incompleteness two
 * different ways.
 */
export function unexaminedExposureNote(count) {
  const s = count === 1 ? '' : 's';
  const they = count === 1 ? 'it was' : 'they were';
  return `${count} file${s} named by the file scan could not be read, so ${they} NEVER examined for credentials — this sweep is INCOMPLETE; listed under "Not examined", and in detect.json as kind "${UNREADABLE_KIND}"`;
}

/**
 * Whole-branch review, F12: `P0.security`'s evidence and the Exposures
 * section printed the identical list — 14 lines carrying 7 facts — because
 * the (correct) `splitExposures` fix made the two read the same source. The
 * remedy is for the check to CITE the section rather than reproduce it: the
 * section is where the findings belong, because it is the only one of the two
 * that carries each finding's severity.
 *
 * Which test holds the "62 reference hits do not become 62 lines" guarantee
 * after this change: `report.test.mjs`'s "renderSummary shows a literal
 * credentials-in-doc hit prominently and collapses reference-valued hits to
 * one count line", which counts the rendered lines. `gap-model.test.mjs` can
 * no longer hold it, since this check's evidence is now a fixed two lines
 * whatever the input — and a test that cannot fail for the thing it is named
 * after is worse than no test (F13).
 */
export function prominentExposureNote(count) {
  const s = count === 1 ? '' : 's';
  return `${count} credential finding${s} — listed with severity under "Exposures", and in detect.json as exposures[]`;
}

// Skip binary-ish extensions: images, archives, binaries, fonts, media, source maps
const SKIP_EXT = [
  '.png', '.jpg', '.jpeg', '.gif', '.ico', '.svg', '.webp',
  '.pdf', '.zip', '.gz', '.tar', '.7z',
  '.exe', '.dll', '.so', '.dylib', '.wasm', '.class', '.jar', '.pyc', '.node', '.bin',
  '.woff', '.woff2', '.ttf', '.eot',
  '.mp4', '.mp3', '.wav',
  '.map',
];
const SKIP_DIRS = ['node_modules/', '.git/', 'dist/', 'build/'];

// Audit Tier 1, finding 1 (second half). `P0.security` read `failing` on
// every real repository this kit was pointed at, over passwords in test
// fixtures — and "it always says failing" is how a real finding becomes
// noise. A path ROLE lowers the severity of a literal `credentials-in-doc`
// hit in a test or fixture path to `low`; the finding is still returned,
// still listed under Exposures and still in detect.json. This is not an
// ignore list: nothing is hidden, nothing is configurable, and a provider
// TOKEN keeps its severity wherever it sits, because a live key in a test
// file is still a live key. Matched on whole directory segments and whole
// filenames, never substrings — `contest/`, `latest.ts` and
// `testing-utils.ts` are not test paths. `spec/` (RSpec) counts; `specs/`
// does not — it holds design documents, OpenAPI specs and RFCs far more
// often than tests (final review, Important 3).
const TEST_DIR_SEGMENTS = new Set(['test', 'tests', '__tests__', 'spec', 'fixtures', '__fixtures__', 'testdata', 'mocks', '__mocks__', 'e2e']);
const TEST_FILE_PATTERNS = [/\.(?:test|spec)\.[^.]+$/, /^test_.*\.py$/, /_test\.(?:py|go)$/];

/**
 * `'test'` when `rel` sits in a test, fixture or mock directory or is a
 * test-named file; otherwise `null`. Exported so the report and the check
 * can be tested against the same definition the sweep uses.
 */
export function pathRole(rel) {
  const segments = rel.split('/');
  const base = segments.pop();
  if (segments.some(s => TEST_DIR_SEGMENTS.has(s))) return 'test';
  if (TEST_FILE_PATTERNS.some(re => re.test(base))) return 'test';
  return null;
}

function isBinaryExtension(base) {
  const lower = base.toLowerCase();
  return SKIP_EXT.some(e => lower.endsWith(e));
}

/**
 * Reads the bytes of one path in ONE open — `open` → `fstat` → `read` —
 * deciding on the way whether the path is examined at all, and, when it is
 * not, whether that is a DELIBERATE skip (`reason: null`, silent by design)
 * or an unexpected failure (`reason` set, reported as an `UNREADABLE_KIND`
 * finding). See `UNREADABLE_KIND`'s own comment for why the two are
 * separated rather than all collapsed into one alarm.
 *
 * Audit Tier 3, finding 18: this was a `statSync` in `probe` and then a
 * `readFileSync` in `readTextIfPresent` — two path lookups per file, ~48 %
 * of a detect run on 1,400 files. Every outcome the two had is kept:
 *   - a skipped directory prefix or a binary extension: silent, no open;
 *   - the open fails: `reason` set (the caller decides whether an absent
 *     always-probed path is expected — it is — or a scan-list path that is
 *     missing is an anomaly — it is);
 *   - not a regular file (a submodule gitlink, a directory git listed):
 *     silent — already disclosed as a nested repository by report.mjs;
 *   - over `MAX_BYTES`: silent, by design;
 *   - the read itself fails after a successful open: `reason` set.
 * Returns `{ buf, reason, missing }`; `missing` is true for ENOENT so the
 * always-probe path can stay quiet without re-testing existence.
 */
function openAndRead(root, rel) {
  if (SKIP_DIRS.some(p => rel.startsWith(p) || rel.includes('/' + p))) return { buf: null, reason: null, missing: false };
  if (isBinaryExtension(basename(rel))) return { buf: null, reason: null, missing: false };
  let fd;
  try {
    fd = openSync(join(root, rel), 'r');
  } catch (err) {
    const code = err?.code ?? 'unknown error';
    // A directory opens on POSIX and fails with EISDIR on Windows: both are
    // "not a regular file", which is a deliberate skip, not an alarm.
    if (code === 'EISDIR') return { buf: null, reason: null, missing: false };
    return { buf: null, reason: `could not be opened (${code})`, missing: code === 'ENOENT' };
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_BYTES) return { buf: null, reason: null, missing: false };
    const buf = Buffer.allocUnsafe(st.size);
    let offset = 0;
    while (offset < st.size) {
      const n = readSync(fd, buf, offset, st.size - offset, offset);
      if (n === 0) break;
      offset += n;
    }
    return { buf: offset === st.size ? buf : buf.subarray(0, offset), reason: null, missing: false };
  } catch (err) {
    return { buf: null, reason: `could not be read (${err?.code ?? 'unknown error'})`, missing: false };
  } finally {
    try { closeSync(fd); } catch { /* nothing to do about a close failure */ }
  }
}

function isPlaceholder(value) {
  return PLACEHOLDER.test(value);
}

/** 1-based line of a character offset; the one thing from a user's file,
 * besides its path, that a finding may carry into detect.json. */
function lineOf(text, index) {
  let line = 1;
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}

/**
 * The first token-shaped match in `text` that is not a placeholder, as
 * `{ line }`, or null. Every pattern's every match is considered: a file
 * whose only Bearer value is `YOUR_TOKEN_HERE` is clean, a file whose
 * second `sk-` match is real is a finding.
 */
function tokenFinding(text) {
  let first = null;
  for (const re of [...TOKEN_PATTERNS, PEM_PATTERN]) {
    for (const m of text.matchAll(re)) {
      const isBearer = /^Bearer\s/i.test(m[0]);
      const body = isBearer ? m[0].replace(/^Bearer\s+/i, '') : m[0];
      if (isBearer ? isPlaceholder(body) : TOKEN_PLACEHOLDER.test(body)) continue;
      if (first === null || m.index < first) first = m.index;
      break; // earliest surviving match of THIS pattern found; the next pattern may be earlier still
    }
  }
  return first === null ? null : { line: lineOf(text, first) };
}

/**
 * The credential-line verdict for one file, as `{ valueKind, line }`, or
 * null. Every `DB_CRED` match is examined and placeholders are skipped; the
 * file is `literal` if ANY surviving value is a literal (reported at that
 * line), else `reference` if any survives at all. One finding per file,
 * as before — the line number is what tells the user which one.
 */
function credentialFinding(text) {
  let reference = null;
  for (const m of text.matchAll(DB_CRED)) {
    const value = m[1];
    if (isPlaceholder(value)) continue;
    if (classifyCredentialValue(value) === 'literal') return { valueKind: 'literal', line: lineOf(text, m.index) };
    reference ??= { valueKind: 'reference', line: lineOf(text, m.index) };
  }
  return reference;
}

/**
 * Decodes a file's bytes as text, deciding the encoding from the bytes rather
 * than assuming UTF-8. Order matters (see task-5-report.md, fix round 4):
 *   1. UTF-16LE BOM (FF FE)  -> decode as utf16le
 *   2. UTF-16BE BOM (FE FF)  -> byte-swap then decode as utf16le
 *   3. NUL byte in first 8 KB, no BOM -> treat as binary, skip (return null)
 *   4. Otherwise decode as UTF-8, stripping a UTF-8 BOM if present.
 *
 * Known limitation: BOM-less UTF-16 (or other multi-byte-per-char encodings
 * without a BOM) is out of scope. There is no reliable, non-heuristic way to
 * distinguish it from binary content, and heuristics here have a history of
 * causing regressions (see task-5-report.md). Such files are skipped.
 *
 * Never throws: any failure decoding is treated as "not readable text" —
 * the NUL sniff, BOM-less UTF-16, a decoder throwing are this module's own
 * documented policy, not a failure, and crying alarm over them would make
 * the check useless. (An `fs` failure is `openAndRead`'s to report.)
 */
function decodeText(buf) {
  try {
    // UTF-16LE BOM
    if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) {
      return buf.subarray(2).toString('utf16le');
    }

    // UTF-16BE BOM: Node has no native utf16be decoder, so byte-swap into
    // little-endian order first.
    if (buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff) {
      let body = Buffer.from(buf.subarray(2)); // copy: swap16 mutates in place
      if (body.length % 2 !== 0) body = body.subarray(0, body.length - 1);
      body.swap16();
      return body.toString('utf16le');
    }

    // Binary-content sniff over the raw bytes (not a decoded string).
    const sniffLen = Math.min(buf.length, 8192);
    if (buf.subarray(0, sniffLen).includes(0)) return null;

    // UTF-8, stripping a UTF-8 BOM if present so BOM-prefixed first lines
    // still match patterns anchored at the start of the text.
    const start = (buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) ? 3 : 0;
    return buf.subarray(start).toString('utf8');
  } catch {
    return null;
  }
}

/**
 * Scans the text of one file `openAndRead` handed over. Returns its findings;
 * an undecodable buffer (binary by sniff, BOM-less UTF-16) yields none, by
 * policy — see decodeText.
 */
function scanFile(buf, rel, isLocalSettings) {
  const findings = [];
  const text = decodeText(buf);
  if (!text) return findings;

  const token = tokenFinding(text);
  if (token) {
    const kind = isLocalSettings ? 'token-in-local-settings' : 'token-in-repo-file';
    findings.push({ kind, location: rel, severity: 'high', line: token.line });
  }

  const credential = credentialFinding(text);
  if (credential) {
    const finding = {
      kind: 'credentials-in-doc', location: rel, severity: 'medium',
      valueKind: credential.valueKind, line: credential.line,
    };
    // Recorded only where it changed the severity, so a consumer can tell
    // "low because of where it is" from any other low.
    if (credential.valueKind === 'literal' && pathRole(rel) === 'test') {
      finding.severity = 'low';
      finding.pathRole = 'test';
    }
    findings.push(finding);
  }

  return findings;
}

/**
 * Scans one path and appends whatever it found to `out` — including, when the
 * path could not be read, the `UNREADABLE_KIND` record that keeps the skip
 * from being silent. `announceMissing` is the one thing that differs between
 * `detectExposures`' two paths: a path the FILE SCAN named and that is not
 * there is a real anomaly worth reporting (that is F1 exactly — the quoted
 * literal `"src/caf\303\251.ts"` stat-ed as ENOENT), while an `ALWAYS_PROBE`
 * path is a guess at a name that usually is not there, so its absence is
 * expected and silent — decided from the open's own ENOENT, not a separate
 * `existsSync` (finding 18).
 */
function scanPath(root, rel, out, announceMissing) {
  const { buf, reason, missing } = openAndRead(root, rel);
  if (reason) {
    if (announceMissing || !missing) out.push({ kind: UNREADABLE_KIND, location: rel, severity: 'high', reason });
    return;
  }
  if (!buf) return;
  // `.claude/` holds the gitignored, machine-local settings file the kit
  // treats as a credential carrier. Whole-branch review, F8 (related note):
  // this used to label ANY finding under `.claude/` as
  // `token-in-local-settings`, so a token in `.claude/scripts/*.mjs` was
  // reported under a kind naming a file it was not in. It is now the two
  // settings files themselves, which is what the kind actually names.
  out.push(...scanFile(buf, rel, LOCAL_SETTINGS_FILES.has(rel)));
}

export function detectExposures(root, files, harness) {
  const out = [];
  const seen = new Set(files);

  for (const r of harness?.remotes ?? []) {
    if (r.hasCredential) out.push({ kind: 'token-in-remote-url', location: `git remote "${r.name}"`, severity: 'high' });
  }

  for (const rel of files) scanPath(root, rel, out, true);

  // Scan always-probed paths, deduplicating against files already checked
  for (const rel of ALWAYS_PROBE) {
    if (seen.has(rel)) continue;
    scanPath(root, rel, out, false);
  }

  return out;
}
