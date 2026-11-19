// scripts/lib/detect-exposure.mjs
import { openSync, fstatSync, readSync, closeSync, lstatSync } from 'node:fs';
import { join, basename } from 'node:path';
import { CREDENTIAL_SHAPES } from '../../assets/scripts/harness-redact.mjs';

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
// The two files `token-in-local-settings` names. A token anywhere else
// under `.claude/`, in `.claude/scripts/lint-touched.mjs` say, is an
// ordinary `token-in-repo-file`: the kind must name the file it is in.
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

// The sweep's shapes are the hook mask's: `CREDENTIAL_SHAPES` is the one
// table, kept in the installed asset because a hook may import nothing
// else. A token shape's match is reported as a token; a keyed shape's
// `value` group is judged below before it is reported as a credential line.
const TOKEN_SHAPES = CREDENTIAL_SHAPES.filter(s => s.kind === 'token');
const KEYED_SHAPES = CREDENTIAL_SHAPES.filter(s => s.kind === 'keyed');

// The mask stars any value; the sweep reports one only from eight characters
// (quotes included), so `password: null` and `DB_PASS=x` in documentation
// are not findings.
const MIN_KEYED_VALUE = 8;

/**
 * True when the quote that seems to open the value at `valueStart` is the
 * closing quote of a string literal that ends in the key, as in
 * `"password: " + input`: source code, which the mask still stars and the
 * sweep does not report.
 *
 * Decided by counting: the quote closes a literal exactly when an odd number
 * of quotes of its kind stands before it on its line. So `"password": "x"`,
 * with two before the value's quote, is a value, whatever its first
 * character, and `"a" + "password: " + b`, with three, is not. A quote
 * after a backslash is not counted, and an apostrophe between two letters is
 * a word's, as in `don't`, not a string's.
 */
function closesLiteral(text, valueStart) {
  const quote = text[valueStart];
  if (quote !== '"' && quote !== "'") return false;
  const lineStart = text.lastIndexOf('\n', valueStart - 1) + 1;
  let before = 0;
  for (let i = lineStart; i < valueStart; i++) {
    if (text[i] !== quote || text[i - 1] === '\\') continue;
    if (quote === "'" && i > lineStart && /\p{L}/u.test(text[i - 1]) && /\p{L}/u.test(text[i + 1] ?? '')) continue;
    before += 1;
  }
  return before % 2 === 1;
}

// Tested on the VALUE only: a keyed shape's `value`, or a Bearer token's
// body. Tested on key and value together, a key containing `example` would
// hide a real value.
const PLACEHOLDER = /(your[-_]|<|xxx|example|changeme|placeholder|dummy|redacted|^(password|secret|todo)$)/i;

// What makes a TOKEN a placeholder is a filler that dominates its body —
// the documented AWS example key, `ghp_xxxxxxxxxxxxxxxx`, `<your-token>` —
// never a three-letter substring: a real base62 body of 150 characters has
// roughly a 0.5 % chance of containing `xxx`, and skipping it would be a
// false `verified`, the one direction this check must not fail in. A
// `Bearer` value keeps the fuller PLACEHOLDER rule:
// its body is free text in the documentation that carries it. A run of one
// repeated letter is NOT treated as filler: real documentation fills with
// `x`, `*` or `#`, and over-reporting a repeated letter is the safe direction.
// The filler may follow `/`, as in Slack's documented webhook URL.
const TOKEN_PLACEHOLDER = /your[-_]|example|placeholder|changeme|redacted|<|[_/-][x*#]{8,}$/i;

// A credential-shaped key (`password:`, `pwd=`, ...) whose VALUE is a code
// reference — a property access, a function call, or a
// subscript, e.g. `process.env.TOKEN`, `config.get('x')`, `os.environ["K"]`,
// `self.password`, `settings.SECRET_KEY` — is ordinary source code reading a
// secret from somewhere else, not a secret written in the file. On a real
// TypeScript codebase this shape is most `credentials-in-doc` hits: noise
// loud enough to bury the real findings beneath it.
//
// This is syntactic, not a parser: a reference is an identifier, optionally
// extended by one or more `.prop`, `(...)`, or `[...]` segments, and NOTHING
// else — the whole value, start to end. Deliberately conservative, since a
// guard which misses a real secret is worse than one that over-reports: a
// bare identifier with NO such extension (`SECRET_KEY`
// alone), a quoted string, a `glpat-`-shaped token (a literal that merely
// STARTS with identifier characters before hitting a `-` the pattern below
// does not accept as a continuation), and an empty string all fail to match
// and are therefore classified `literal`, which is prominent. Only a
// genuine compound reference expression is ever classified `reference`.
// When in doubt, this returns `literal`.
const REFERENCE_VALUE = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*|\([^()]*\)|\[[^[\]]*\])+[;,]?$/;

// The other way a file reads a secret from somewhere else: shell, dotenv,
// `.npmrc` and CI interpolation — `$VAR`, `${VAR}`, `%VAR%`, `${{ secrets.X }}` —
// optionally quoted (including a markdown backtick, so a documented example
// is not a finding) and optionally followed by one statement delimiter. The
// most common `.npmrc` line in existence — `_authToken` set to `${NPM_TOKEN}` —
// is exactly this shape, and is a reference. A value that merely
// STARTS with a dollar sign (`$uper$ecret`) is not an interpolation and
// stays `literal`.
const ENV_REFERENCE = /^["'`]?(?:\$[A-Za-z_][A-Za-z0-9_]*|\$\{\{[^}]*\}\}|\$\{[A-Za-z_][A-Za-z0-9_:.-]*\}|%[A-Za-z_][A-Za-z0-9_]*%)["'`]?[;,]?$/;

/**
 * Classifies a `credentials-in-doc` match's VALUE half (never the key) as
 * `'literal'` (a real string/token — stays a prominent finding) or
 * `'reference'` (code reading a secret from elsewhere — collapsed to a count
 * by report.mjs/gap-model.mjs, never suppressed or dropped here). This
 * function only tags; it never decides what is shown or counted as a
 * failure — see detectExposures below, which runs it over every keyed
 * value and records the result on the finding, and splitExposures /
 * isProminentExposure, which downstream callers use to decide presentation.
 */
export function classifyCredentialValue(value) {
  if (typeof value !== 'string' || value.length === 0) return 'literal';
  return REFERENCE_VALUE.test(value) || ENV_REFERENCE.test(value) ? 'reference' : 'literal';
}

/**
 * Not a credential finding: a file the scan list NAMED that this sweep could
 * not read, or a directory the fallback walk could not list, so it was never
 * examined at all.
 *
 * "I could not look at this file" must never become "there is nothing
 * here": a security check that reports success because it never read a
 * file inverts this project's whole doctrine. That holds for every reason a
 * read can fail (EACCES, a file deleted between the scan and the read, a
 * path outside the tree, a filesystem error). So an unexpected read failure
 * is a FINDING, carried on the same list every other Phase-0 finding is
 * carried on, and `P0.security` cannot be `verified` while one exists.
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
  return `${count} path${s} could not be read (a file the scan named, or a directory it could not list), so ${they} NEVER examined for credentials — this sweep is INCOMPLETE; listed under "Not examined", and in detect.json as kind "${UNREADABLE_KIND}"`;
}

/**
 * `P0.security`'s evidence CITES the Exposures section rather than
 * reproducing it: both read the same source (`splitExposures`), and the
 * section is where the findings belong, because it is the only one of the
 * two that carries each finding's severity.
 *
 * The guarantee that many reference-valued hits do not become as many lines
 * is held by `report.test.mjs`'s "renderSummary shows a literal
 * credentials-in-doc hit prominently and collapses reference-valued hits to
 * one count line", which counts the rendered lines. `gap-model.test.mjs`
 * cannot hold it: this check's evidence is a fixed two lines whatever the
 * input.
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

// A check that reads `failing` on every real repository, over passwords in
// test fixtures, is how a real finding becomes noise. So a path ROLE lowers the severity of a literal `credentials-in-doc`
// hit in a test or fixture path to `low`; the finding is still returned,
// still listed under Exposures and still in detect.json. This is not an
// ignore list: nothing is hidden, nothing is configurable, and a provider
// TOKEN keeps its severity wherever it sits, because a live key in a test
// file is still a live key. Matched on whole directory segments and whole
// filenames, never substrings — `contest/`, `latest.ts` and
// `testing-utils.ts` are not test paths. `spec/` (RSpec) counts; `specs/`
// does not — it holds design documents, OpenAPI specs and RFCs far more
// often than tests.
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
 * One open per file, with the size and type read from the open handle: a
 * separate stat is a second path lookup per file, a large share of a detect
 * run on a big repository. The outcomes:
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
function isDanglingLink(abs) {
  try {
    return lstatSync(abs).isSymbolicLink();
  } catch {
    return false;
  }
}

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
    // A dangling symlink: the link is listed, its target is not there, and
    // there are no bytes to examine — a deliberate skip, not a permanent
    // high finding.
    if (code === 'ENOENT' && isDanglingLink(join(root, rel))) return { buf: null, reason: null, missing: false };
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
 * Every token-shaped match in `text` that is not a placeholder, as
 * `{ start, end, severity }`. Every match of every shape is considered: a
 * file whose only Bearer value is `YOUR_TOKEN_HERE` is clean, a file whose
 * second `sk-` match is real is a finding.
 */
function realTokens(text) {
  const found = [];
  for (const shape of TOKEN_SHAPES) {
    // A Bearer body is free text in the documentation that carries it, so it
    // gets the fuller rule; every other token has a vendor shape to fill.
    const placeholder = shape.id === 'bearer' ? PLACEHOLDER : TOKEN_PLACEHOLDER;
    for (const m of text.matchAll(shape.pattern)) {
      if (placeholder.test(m[0])) continue;
      found.push({ start: m.index, end: m.index + m[0].length, severity: shape.severity });
    }
  }
  return found;
}

/** The earliest of `tokens` as `{ line, severity }`, or null. */
function tokenFinding(text, tokens) {
  if (tokens.length === 0) return null;
  const first = tokens.reduce((a, b) => (b.start < a.start ? b : a));
  return { line: lineOf(text, first.start), severity: first.severity };
}

/**
 * The credential-line verdict for one file, as `{ valueKind, line }`, or
 * null. Every keyed match is examined; a value that is short, a placeholder,
 * the closing quote of a literal (`closesLiteral`), or overlaps one of `tokens`
 * is skipped — a token after `api_key:` or
 * `Bearer` is one secret, already reported as the token. The file is
 * `literal` if ANY surviving value is a literal (reported at the earliest
 * such line), else `reference` if any survives at all. One finding per file;
 * the line number is what tells the user which one.
 */
function credentialFinding(text, tokens) {
  let literal = null;
  let reference = null;
  for (const shape of KEYED_SHAPES) {
    for (const m of text.matchAll(shape.pattern)) {
      const { value } = m.groups;
      const start = m.index + m[0].length - value.length;
      if (value.length < MIN_KEYED_VALUE || isPlaceholder(value) || closesLiteral(text, start)) continue;
      if (tokens.some(t => t.start < start + value.length && start < t.end)) continue;
      if (classifyCredentialValue(value) === 'literal') {
        if (literal === null || m.index < literal) literal = m.index;
      } else if (reference === null || m.index < reference) {
        reference = m.index;
      }
    }
  }
  if (literal !== null) return { valueKind: 'literal', line: lineOf(text, literal) };
  if (reference !== null) return { valueKind: 'reference', line: lineOf(text, reference) };
  return null;
}

/**
 * Decodes a file's bytes as text, deciding the encoding from the bytes rather
 * than assuming UTF-8. Order matters:
 *   1. UTF-16LE BOM (FF FE)  -> decode as utf16le
 *   2. UTF-16BE BOM (FE FF)  -> byte-swap then decode as utf16le
 *   3. NUL byte in first 8 KB, no BOM -> treat as binary, skip (return null)
 *   4. Otherwise decode as UTF-8, stripping a UTF-8 BOM if present.
 *
 * Known limitation: BOM-less UTF-16 (or other multi-byte-per-char encodings
 * without a BOM) is out of scope. There is no reliable, non-heuristic way to
 * distinguish it from binary content, and a heuristic that guesses wrong
 * reports mojibake as findings. Such files are skipped.
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

  const tokens = realTokens(text);
  const token = tokenFinding(text, tokens);
  if (token) {
    const kind = isLocalSettings ? 'token-in-local-settings' : 'token-in-repo-file';
    findings.push({ kind, location: rel, severity: token.severity, line: token.line });
  }

  const credential = credentialFinding(text, tokens);
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
 * there is a real anomaly worth reporting (a path git printed quoted, such
 * as `"src/caf\303\251.ts"`, opens as ENOENT), while an `ALWAYS_PROBE`
 * path is a guess at a name that usually is not there, so its absence is
 * expected and silent — decided from the open's own ENOENT, not a separate
 * `existsSync`.
 */
function scanPath(root, rel, out, announceMissing) {
  const { buf, reason, missing } = openAndRead(root, rel);
  if (reason) {
    if (announceMissing || !missing) out.push({ kind: UNREADABLE_KIND, location: rel, severity: 'high', reason });
    return;
  }
  if (!buf) return;
  // `.claude/` holds the gitignored, machine-local settings file the kit
  // treats as a credential carrier. Only a finding in one of the two
  // settings files themselves is `token-in-local-settings`, which is what
  // the kind names; one elsewhere under `.claude/` is not.
  out.push(...scanFile(buf, rel, LOCAL_SETTINGS_FILES.has(rel)));
}

/**
 * `unreadableDirs` is `listFiles`' record of the directories its fallback
 * walk could not list (scan.mjs). Nothing beneath one is in `files`, so each
 * becomes an `UNREADABLE_KIND` finding: the sweep cannot claim a tree it
 * never saw (audit 2026-11-18, C1).
 */
export function detectExposures(root, files, harness, unreadableDirs = []) {
  const out = [];
  const seen = new Set(files);

  for (const r of harness?.remotes ?? []) {
    if (r.hasCredential) out.push({ kind: 'token-in-remote-url', location: `git remote "${r.name}"`, severity: 'high' });
  }

  for (const dir of unreadableDirs) {
    out.push({ kind: UNREADABLE_KIND, location: dir, severity: 'high', reason: 'a directory the file scan could not list, so nothing beneath it was examined' });
  }

  for (const rel of files) scanPath(root, rel, out, true);

  // Scan always-probed paths, deduplicating against files already checked
  for (const rel of ALWAYS_PROBE) {
    if (seen.has(rel)) continue;
    scanPath(root, rel, out, false);
  }

  return out;
}
