// assets/scripts/harness-redact.mjs
//
// The one module every hook this kit installs may import, besides Node's
// built-ins and the other installed scripts: a hook is copied into a
// repository's `.claude/scripts/`, where nothing in `scripts/lib/` can
// reach it. Whatever two hooks must agree on therefore lives here, once,
// and a hook must import it from here and never carry a copy: a fix made
// to one copy and not the other is how a credential reaches the model.
// `detect` imports the same functions, so what a hook does and what
// `detect` reports cannot disagree.
//
// The file's name covers the first of the things it holds:
//
//   1. REDACTION — `dropCommandFragments` (layer 1, a denylist of command
//      fragments) and `maskCredentials`/`maskText` (layer 2, masking by
//      `CREDENTIAL_SHAPES`, the credential table the sweep in
//      `scripts/lib/detect-exposure.mjs` reads too), with `stripUnsafe` and
//      `escapeDelimiters` for repository text a brief injects into the
//      model's context.
//   2. CANONICAL JSON — `canonicalJson`, which every hash of a JSON value
//      is taken over.
//   3. OUTPUT BOUNDS — `MAX_REPORT_LINES`, `MAX_REPORT_BYTES` and
//      `boundReport`, which keep a hook's output inside Claude Code's
//      10,000-character cap, past which it does not arrive.
//   4. SESSION-MARKER STATE — `safeSessionId`, `markerPath`,
//      `readJSONMarker`/`writeJSONMarker`, `openMarker`, `signatureOf`,
//      `MAX_REPORTS_SINCE_CLEAN`: the per-session bookkeeping the hooks
//      bound themselves with.
//   5. THE PROJECT ROOT — `projectRoot`, the one answer every hook uses.
//   6. THE HANDOFF LOCATION — `HANDOFF_CANDIDATES` and `findHandoff`.
//   7. THE RULES REGISTRY — its two locations and `parseRules`.
//   8. A BOUNDED RUNNER — `runBounded` and `killTree`, for the two hooks
//      that run a repository's own command.
//
// The file cannot be renamed to say so: `.claude/scripts/harness-redact.mjs`
// is recorded in every manifest the kit has written, and `uninstall` reads
// the manifest to decide what it may remove, so a rename would orphan every
// existing install's record of this file. A rename needs a manifest
// migration first.
//
// Two independent layers of redaction:
//
//   Layer 1 (dropCommandFragments): a denylist against what is KNOWN to
//   have come from a command the calling hook itself built. A shell or
//   interpreter can echo a FRAGMENT of a failing command line, not
//   necessarily the whole string (node's SyntaxError reporter prints only
//   the text after an unbalanced quote), so every whitespace-delimited token
//   of length >= 8 drawn from the command(s) is treated as sensitive, and
//   any surviving line containing one is dropped outright. `exemptions`
//   carries whatever legitimately belongs in a real diagnostic and must
//   never be treated as a redactable fragment: what the caller appended to
//   its own command (the edited file), and, via `pathTokenExemptions`, the
//   command's own path and config-file tokens (`eslint src/components`,
//   `tsc -p tsconfig.build.json`), which every diagnostic names and which
//   are not secrets.
//
//   Layer 2 (maskCredentials, maskText): the credential-SHAPE table,
//   independent of layer 1. It catches a credential-shaped value arriving
//   from ANYWHERE in the output, including content the hook never built
//   itself (a linted file's own source, a verification command's own
//   diagnostic text). It masks the VALUE and never drops the line: a
//   genuine diagnostic that happens to mention a credential should still
//   reach Claude, with the secret starred out.
//
// Attribution, deciding what the output is even ABOUT, is each caller's own
// concern and stays in the caller.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, lstatSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir, userInfo } from 'node:os';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

/**
 * Whitespace-delimited tokens of length >= 8 drawn from `command`, in
 * first-seen order, minus anything in `exemptions`.
 */
export function commandTokens(command, exemptions = new Set()) {
  const seen = new Set();
  const tokens = [];
  for (const raw of command.split(/\s+/)) {
    const t = raw.replace(/^['"]+|['"]+$/g, '');
    if (t.length < 8 || exemptions.has(t) || seen.has(t)) continue;
    seen.add(t);
    tokens.push(t);
  }
  return tokens;
}

// A command token that names a config file: a config-shaped extension, or a
// dotted `*rc` name (`.eslintrc`, `.eslintrc.cjs`), standing alone or attached
// to a flag (`--config=eslint.config.js`). Anchored at the end of the token so
// a value that merely ENDS in one of these characters sequences after a
// credential flag is still excluded by the flag check in
// `pathTokenExemptions`.
const CONFIG_SHAPED = /(?:\.(?:json|ya?ml|toml|[cm]?[jt]s|cfg|ini|conf)|(?:^|[/=])\.[\w-]+rc(?:\.\w+)?)$/i;
// A flag whose NAME is credential-shaped is never exempt, whatever its value
// looks like: `--token` set to `secrets.json` is still a token.
const CREDENTIAL_FLAG = /^--?(?:[\w-]*(?:token|key|secret|password|passwd|pwd|auth)[\w-]*)=/i;
// Nor is anything that can carry userinfo: a URL or an `scp`-style
// `user@host:path`, whatever it ends in. `…@host/x.json` has a config
// file's suffix and may hold a credential before the `@`.
const CARRIES_USERINFO = /:\/\/|@/;

/**
 * The tokens of `command` that name a PATH or a CONFIG FILE rather than
 * anything secret, for use as layer-1 exemptions. With
 * `eslint src/components`, `ruff check backend/app` or
 * `eslint -c .eslintrc.cjs .`, every diagnostic names the path or config
 * the command named; without these exemptions `dropCommandFragments` takes
 * every diagnostic for an echo of the command and the hook reports nothing.
 *
 * Exempt: (a) a token that is a DIRECTORY prefix of one of `paths` (whole
 * segments — `src/comp` is not a prefix of `src/components/x`), with a
 * leading `./` or trailing `/` tolerated, or the path itself; (b) a token
 * shaped like a config file (`CONFIG_SHAPED`); (c) when `root` is given, a
 * token that resolves against `root` to a path that exists inside it
 * (`tsc -p packages/app`). Never exempt: a token whose flag name is
 * credential-shaped (`CREDENTIAL_FLAG`). Only tokens `commandTokens` would
 * produce are returned, so the result composes with it directly.
 */
export function pathTokenExemptions(command, paths = [], root = null) {
  const normalized = paths.map(p => p.replace(/^\.\//, '').replace(/\/+$/, ''));
  const isDirPrefixOrSelf = token => {
    const t = token.replace(/^\.\//, '').replace(/\/+$/, '');
    return t.length > 0 && normalized.some(p => p === t || p.startsWith(t + '/'));
  };
  const existsUnderRoot = token => {
    if (root === null) return false;
    const abs = resolve(root, token);
    const rel = relative(root, abs);
    return rel !== '' && rel.split(sep)[0] !== '..' && !isAbsolute(rel) && existsSync(abs);
  };
  const exempt = new Set();
  for (const token of commandTokens(command)) {
    if (CREDENTIAL_FLAG.test(token) || CARRIES_USERINFO.test(token)) continue;
    if (isDirPrefixOrSelf(token) || CONFIG_SHAPED.test(token) || existsUnderRoot(token)) exempt.add(token);
  }
  return exempt;
}

/**
 * Layer 1. `commands` is every raw command string the calling hook itself
 * built (e.g. `[lintScript, fullCommand]`, or a single verify command) —
 * each is checked both as a whole line (the "shell echoes the entire
 * command" case) and tokenized for the fragment case. The whole-command
 * rule compares the full line, never a substring: a one-word script such
 * as `eslint` or `jest` is below the token floor, and as a substring it
 * matched every diagnostic that names the tool.
 */
export function dropCommandFragments(lines, commands, exemptions = new Set()) {
  const echoes = new Set(commands.map(c => c.trim()));
  const tokens = [...new Set(commands.flatMap(c => commandTokens(c, exemptions)))];
  return lines.filter(l => {
    if (echoes.has(l.trim())) return false;
    return !tokens.some(t => l.includes(t));
  });
}

/**
 * Layer 2, and the credential sweep's pattern list: the one table of
 * credential shapes. The installed hooks mask with it, and
 * `scripts/lib/detect-exposure.mjs` builds its token and keyed lists from it
 * and keeps none of its own, so a shape one recognises the other recognises
 * too. It lives here because an installed hook may import only this module.
 *
 * `kind: 'token'` — the whole match is the secret, identified by its own
 * shape (a vendor prefix, a JWT's `eyJ`, a PEM header). The mask replaces the
 * match; the sweep reports it as a token.
 *
 * `kind: 'keyed'` — the secret is identified by what precedes it: a key, an
 * `Authorization` scheme, a URL's `user:` part. The named group `value` is
 * always the END of the match, so everything before it is the key, which the
 * mask keeps. The mask replaces any value; the sweep judges the value
 * (placeholder, code reference, length) before it reports one.
 *
 * Boundaries are `(?<![A-Za-z0-9])`, not `\b`: `\b` counts `_` as part of a
 * word, so it would miss a token written straight after an underscore. A
 * colour code's final `m` is a letter, so ANSI sequences are stripped before
 * any line is matched (see `maskCredentials`).
 *
 * The mask is a superset of the sweep. A shape's optional `maskPattern`
 * replaces `pattern` for the mask only, with a lower floor or a looser body:
 * a mask that hides too much costs a diagnostic, one that hides too little
 * leaks a secret into the model's context. The sweep uses `pattern` alone,
 * because a finding it reports must be worth reading. A caller masking prose
 * the model is told to follow can ask for the sweep's floors instead (see
 * `maskText`), so a word after `Bearer` is not starred while a real token,
 * which exceeds every sweep floor, still is.
 *
 * `severity` is the severity of the sweep's finding for a token shape. A
 * keyed shape's finding is a credential line, whose severity the sweep sets
 * from the value and the path.
 *
 * Every pattern is global and is shared, so use it only through `matchAll`
 * and `replace`, which do not depend on `lastIndex`. Length floors sit far
 * below each vendor's real token length and above the ordinary identifiers
 * that share a prefix (`npm_config_cache`, `hf_transfer`, `ghp_client`).
 */
const PEM_HEADER = /-----BEGIN [A-Z ]*PRIVATE KEY-----/;
const PEM_FOOTER = /-----END [A-Z ]*PRIVATE KEY-----/;

// A keyed value: a quoted string through its closing quote, spaces and
// backslash escapes included, or to the end of the line when the quote never
// closes; a Python triple quote counts as one quote, and inside single quotes
// a doubled `''` is an escape (SQL, YAML). Otherwise an unquoted
// run that stops at whitespace, `,` or `;`. Quotes inside an unquoted run are
// kept so `config.get('x')` stays one value for the sweep's reference check.
// Each alternative's repeated part has disjoint branches, so a match is
// linear in the line's length.
const KEYED_VALUE = String.raw`(?<value>"""(?:(?!""")[^\\\r\n]|\\.)*(?:""")?|'''(?:(?!''')[^\\\r\n]|\\.)*(?:''')?|"(?:[^"\\\r\n]|\\.)*"?|'(?:[^'\\\r\n]|\\.|'')*'?|[^\s"',;][^\s,;]*)`;
// `=` or `:`, never the first character of `==`, `===` or `=>`.
const ASSIGN = String.raw`\s*[:=](?![=>])\s*`;
// A key followed by an assignment. `=>` assigns only between a quoted key and
// a quoted value, the PHP and Ruby hash form `'password' => 'x'`; a bare
// identifier before `=>` is a JavaScript arrow function's parameter.
const keyedAssign = keys => String.raw`(?:["'][\w.-]*?(?:${keys})["']\s*=>\s*(?=["'])|(?:${keys})["']?${ASSIGN})`;

// `maskPattern`, when present, is what the mask uses in place of `pattern`:
// a broader match, never a narrower one.
const shape = (id, kind, pattern, maskPattern) => Object.freeze(
  maskPattern ? { id, kind, pattern, maskPattern, severity: 'high' } : { id, kind, pattern, severity: 'high' });

export const CREDENTIAL_SHAPES = Object.freeze([
  // The sweep admits a hyphenated body only after a known prefix:
  // `sk-learn-compatible-…` and `/sk-hynix-…` are prose. The mask stars any
  // `sk-` run from ten characters.
  shape('sk-key', 'token', /(?<![A-Za-z0-9])sk-(?:[A-Za-z0-9]{20,}|(?:proj|ant|svcacct|admin|or-v1)-[A-Za-z0-9_-]{20,})/g,
    /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{10,}/g),
  shape('stripe', 'token', /(?<![A-Za-z0-9])(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{10,}/g),
  shape('gitlab-pat', 'token', /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{16,}/g, /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{10,}/g),
  shape('gitlab-runner', 'token', /(?<![A-Za-z0-9])glrt-[A-Za-z0-9_-]{16,}/g),
  shape('github', 'token', /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{16,}/g, /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{10,}/g),
  shape('github-fine-grained', 'token', /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{22,}/g),
  shape('npm', 'token', /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{36}/g),
  // AKIA: a long-term access key id; ASIA: a temporary (STS) one.
  shape('aws-access-key', 'token', /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}/g),
  shape('google', 'token', /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g),
  shape('slack', 'token', /(?<![A-Za-z0-9])xox[abprs]-[A-Za-z0-9-]{10,}/g),
  shape('slack-app', 'token', /(?<![A-Za-z0-9])xapp-[A-Za-z0-9-]{10,}/g),
  shape('slack-webhook', 'token', /(?<![A-Za-z0-9])hooks\.slack\.com\/services\/T[A-Z0-9]{6,}\/B[A-Z0-9]{6,}\/[A-Za-z0-9]{20,}/g),
  shape('sendgrid', 'token', /(?<![A-Za-z0-9])SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g),
  shape('hugging-face', 'token', /(?<![A-Za-z0-9])hf_[A-Za-z0-9]{20,}/g),
  shape('docker', 'token', /(?<![A-Za-z0-9])dckr_pat_[A-Za-z0-9_-]{10,}/g),
  // A real PyPI token is a macaroon of well over a hundred characters; a
  // shorter floor matches package names such as `pypi-publish-action`.
  shape('pypi', 'token', /(?<![A-Za-z0-9])pypi-[A-Za-z0-9_-]{50,}/g),
  // Three base64url segments, the first always `eyJ` (`{"`).
  shape('jwt', 'token', /(?<![A-Za-z0-9])eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g),
  // The token after the scheme word; the word itself is kept. The sweep reads
  // a Bearer token from 20 characters; the mask stars a Bearer or a
  // standalone Basic value from 8. The lookahead runs first so the lookbehind
  // is tried only where a token starts, not at every position of a long
  // whitespace run.
  shape('bearer', 'token', /(?=[A-Za-z0-9._~+/-]{20})(?<=(?<![A-Za-z0-9])Bearer\s+)[A-Za-z0-9._~+/-]{20,}=*/gi,
    /(?=[A-Za-z0-9._~+/-]{8})(?<=(?<![A-Za-z0-9])(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/-]{8,}=*/gi),
  // The sweep reads the header alone, so nothing else on its line can make it
  // a placeholder. The mask stars from the header to the end of the line,
  // whichever floors it uses (see `PEM_TO_END_OF_LINE`); a key's body lines
  // carry no marker of their own, and `maskText` masks them by tracking the
  // block.
  shape('pem-private-key', 'token', new RegExp(PEM_HEADER.source, 'g')),
  // `scheme://user:secret@host`. The user name, which may be empty as in
  // `redis://:secret@host`, is kept; a URL with no password is not matched.
  shape('url-userinfo', 'keyed', /:\/\/[^/\s:@]*:(?<value>[^@\s/]+)(?=@)/g),
  // `password=x`, `"password": "x"`, `DB_PASS: x`, `AWS_SECRET_ACCESS_KEY=x`,
  // `'password' => 'x'`. Bare `token:` and `secret:` are not keys: in prose
  // they are words.
  shape('credential-assignment', 'keyed', new RegExp(
    keyedAssign(String.raw`password|passwd|pwd|api[_-]?key|client[_-]?secret|secret[_-]?(?:access[_-]?)?key|access[_-]?token|auth[_-]?token|private[_-]?key|_pass|_secret`) + KEYED_VALUE, 'gi')),
  // `TOKEN=x`, `GITHUB_TOKEN=x`, `--token=x`: a key ending in `token`, set
  // with `=` and no whitespace, as env files and flags write it. `token:`
  // begins a sentence as often as a setting, and `const token = f(a, b)` is
  // code. `[=]` rather than `=` so this line is not itself an assignment
  // the sweep reports.
  shape('token-assignment', 'keyed', new RegExp(
    String.raw`(?<![A-Za-z0-9])token[=](?![=>])` + KEYED_VALUE, 'gi')),
  // `Authorization: token x`, `Authorization: Basic x`, `Authorization: x`.
  shape('authorization-header', 'keyed', new RegExp(
    keyedAssign(String.raw`(?<![A-Za-z0-9])authorization`) + String.raw`["']?(?:(?:bearer|basic|token|digest)\s+)?` + KEYED_VALUE, 'gi')),
]);

// CSI (`ESC [` or the one-byte C1 form), OSC terminated by BEL or ST, and
// every other escape: `ESC`, any intermediate bytes, one final byte.
const ANSI_SEQUENCE = /\u001b\[[0-?]*[ -/]*[@-~]|\u009b[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)|\u001b[ -/]*[0-~]/g;

export function stripAnsi(text) {
  return text.replace(ANSI_SEQUENCE, '');
}

// C0 and C1 controls except tab and newline, every format character (`Cf`:
// zero-width, bidi embeddings, overrides and isolates, the byte-order mark,
// the soft hyphen), the whole tag block U+E0000–U+E007F, assigned or not, the
// variation selectors U+FE00–U+FE0F and U+E0100–U+E01EF, the Hangul
// fillers U+115F, U+1160, U+3164 and U+FFA0, which render as blank space,
// and the line and paragraph separators U+2028 and U+2029, which a
// multiline regular expression's `^` and `$` treat as line breaks while a
// split on newlines does not. Next-line U+0085, a line break to other
// tools, is a C1 control and covered above.
const UNSAFE_CHARACTER = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029\p{Cf}\u115f\u1160\u3164\uffa0\ufe00-\ufe0f\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu;

/**
 * Removes what a reader cannot see from text bound for the model's context:
 * whole ANSI sequences first, so no escape body is left behind, then every
 * `UNSAFE_CHARACTER`. Text without either passes unchanged. Run it before
 * `maskText`: an invisible character inside a token hides the token from the
 * mask, and stripping it afterwards would reassemble the token.
 */
export function stripUnsafe(text) {
  return stripAnsi(text).replace(UNSAFE_CHARACTER, '');
}

/** Escapes `<` and `>`, so repository text placed inside a delimited block
 * can neither close that block nor open another. */
export function escapeDelimiters(text) {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** What the mask writes in place of every value it hides. */
export const SCRUB_MARK = '***';

// A private-key header and everything after it on its line. Not a floor, so
// it applies whichever floors the mask uses.
const PEM_TO_END_OF_LINE = new RegExp(PEM_HEADER.source + '.*', 'g');

/** Options every mask entry point takes. `floors: 'mask'` (the default) uses
 * each shape's `maskPattern`, `'sweep'` its stricter `pattern`. */
const sweepFloors = options => options?.floors === 'sweep';

/** Masks one line that `stripAnsi` has already cleaned. */
function maskLine(line, sweep) {
  let masked = line.replace(PEM_TO_END_OF_LINE, SCRUB_MARK);
  for (const { kind, pattern, maskPattern = pattern } of CREDENTIAL_SHAPES) {
    const re = sweep ? pattern : maskPattern;
    masked = kind === 'token'
      ? masked.replace(re, SCRUB_MARK)
      : masked.replace(re, (...args) => {
        const match = args[0];
        const { value } = args.at(-1);
        return match.slice(0, match.length - value.length) + SCRUB_MARK;
      });
  }
  return masked;
}

/**
 * Masks one line of output: the line and every key survive, only values are
 * replaced. ANSI sequences are removed first, so a coloured secret is masked
 * and the result carries no colour. A PEM key's body lines are masked only
 * by `maskText`, which sees the lines around them. `options` as for
 * `maskText`.
 */
export function maskCredentials(line, options) {
  return maskLine(stripAnsi(line), sweepFloors(options));
}

/**
 * Masks multi-line text: every line as `maskCredentials` would, and every
 * line from a PEM private-key header through its footer replaced by `SCRUB_MARK`
 * after its own leading spaces and tabs. Line endings, `\n` or `\r\n`, are
 * kept, and so is the line count; the indentation is kept because a
 * caller may group lines by it (eslint's stylish blocks). A header with no
 * footer masks to the end of the text.
 *
 * `options.floors` is `'mask'` (the default) or `'sweep'`. Use `'sweep'` only
 * for prose the model is told to follow, where a short word starred after
 * `Bearer` garbles an instruction: it leaves a value below the sweep's
 * floors in place. Any other value means `'mask'`.
 */
export function maskText(text, options) {
  const sweep = sweepFloors(options);
  const parts = stripAnsi(text).split(/(\r?\n)/);
  let inKey = false;
  for (let i = 0; i < parts.length; i += 2) {
    const line = parts[i];
    if (inKey) {
      inKey = !PEM_FOOTER.test(line);
      parts[i] = line.match(/^[ \t]*/)[0] + SCRUB_MARK;
      continue;
    }
    parts[i] = maskLine(line, sweep);
    const header = PEM_HEADER.exec(line);
    inKey = header !== null && !PEM_FOOTER.test(line.slice(header.index));
  }
  return parts.join('');
}

// --- Canonical JSON ----------------------------------------------------------

function serialiseSorted(value) {
  if (Array.isArray(value)) return `[${value.map(serialiseSorted).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const members = Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${serialiseSorted(value[k])}`);
    return `{${members.join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * JSON with object keys sorted recursively and no whitespace, so equal
 * values hash equally whatever order their keys were written in. Keys are
 * sorted as strings, so `"10"` precedes `"9"`; arrays keep their order.
 * `value` is first passed through `JSON.stringify`'s own rules (`toJSON`,
 * dropped `undefined`), and must therefore be JSON-serialisable.
 */
export function canonicalJson(value) {
  return serialiseSorted(JSON.parse(JSON.stringify(value)));
}

// --- Bounding what reaches stderr -----------------------------------------
//
// Shared so neither hook's bound can silently drift out of sync with the
// other's — see MAX_REPORT_LINES/MAX_REPORT_BYTES below.

/** The line bound every hook's output shares. */
export const MAX_REPORT_LINES = 60;
/**
 * A line-count bound alone cannot stop a single very long line (minified
 * output, a one-line stack trace, a JSON formatter run with no pretty-print)
 * from pushing megabytes into Claude's context at the default 10 MB spawn
 * buffer — measured: a single 50 000-character line reached stderr in full
 * before this existed. 10 000 bytes is generous for a genuine diagnostic
 * and far below anything that would flood a turn.
 *
 * It is also EXACTLY Claude Code's own documented cap, which is the reason
 * the number matters rather than merely being generous. From the hooks
 * reference: a hook's `additionalContext`, `systemMessage` and
 * `initialUserMessage` strings, and its plain stdout, are capped at 10,000
 * characters; over the limit, Claude Code saves the output to a file in the
 * session directory and replaces it with the file path plus a preview of the
 * first 2,000 characters — and "Claude Code doesn't ask Claude to read the
 * file". So exceeding this is not a flooded context, it is the output
 * SILENTLY NOT ARRIVING: past the cap a handoff brief is replaced by a path
 * Claude is never told to open, and nothing reports it.
 */
export const MAX_REPORT_BYTES = 10_000;

/**
 * Cuts `str` to at most `maxBytes` UTF-8 bytes, never mid-character: `end`
 * is the first byte NOT kept, so while it is a UTF-8 continuation byte
 * (`10xxxxxx`) the character before it is being split and the cut walks
 * back. Without this, a multi-byte character straddling the boundary decodes
 * to U+FFFD — a corrupted last character in the one place a user is reading
 * for information.
 */
function sliceUtf8(str, maxBytes) {
  const buf = Buffer.from(str, 'utf8');
  if (buf.length <= maxBytes) return str;
  let end = maxBytes;
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.subarray(0, end).toString('utf8');
}

/**
 * Bounds `lines` first by count, then by total byte size, and returns the
 * final string to write (without a trailing newline). `header` is
 * prepended before either bound is computed, since it counts toward the
 * byte budget too. No hook may write to its output stream through any path
 * but this one plus its own single `write` call site — see each hook's own
 * comment on its chokepoint.
 *
 * The truncation notice is INSIDE the byte budget, not appended after it,
 * and one further byte is reserved for the single trailing newline every
 * caller adds (each writes `boundReport(...) + '\n'`), so the bound holds on
 * what is actually WRITTEN rather than on an intermediate string: a bound
 * that is over by the length of its own notice is no bound against a cap
 * past which the output does not arrive.
 *
 * A non-empty `footer` follows everything else on its own line, truncation
 * notices included, and its bytes are reserved from the budget, so a
 * closing delimiter is never cut.
 *
 * Contract, therefore: this returns at most `MAX_REPORT_BYTES - 1` bytes,
 * and `boundReport(...) + '\n'` is at most `MAX_REPORT_BYTES`.
 */
export function boundReport(lines, header = '', footer = '') {
  const shown = lines.slice(0, MAX_REPORT_LINES);
  let report = header + shown.join('\n');
  if (lines.length > MAX_REPORT_LINES) {
    report += `\n--- truncated: ${lines.length - MAX_REPORT_LINES} more line(s) ---`;
  }
  const tail = footer === '' ? '' : '\n' + footer;
  const budget = MAX_REPORT_BYTES - 1 - Buffer.byteLength(tail, 'utf8'); // 1: the caller's trailing newline
  if (Buffer.byteLength(report, 'utf8') > budget) {
    const notice = '\n--- truncated: output exceeded the byte limit ---';
    report = sliceUtf8(report, budget - Buffer.byteLength(notice, 'utf8')) + notice;
  }
  return report + tail;
}

// --- The two facts every hook needs before it can do anything -------------

/**
 * The repository root, as Claude Code reports it, falling back to the
 * process's own working directory.
 *
 * Every hook asks here. A bare `process.cwd()` is wrong whenever a hook is
 * invoked with another working directory: the session-start brief would
 * then tell the model, as a premise, that the repository has no handoff.
 */
export function projectRoot() {
  return process.env.CLAUDE_PROJECT_DIR || process.cwd();
}

/**
 * The two conventional locations for a repository's handoff file, in
 * precedence order, and the one function that resolves them.
 *
 * `detect-harness.mjs` credits `P4.handoff` through this function and the
 * session-start hook reads through it, so a repository whose handoff lives
 * at `docs/HANDOFF.md` is never credited by `detect` and then told by the
 * hook, in the model's context, that it has none.
 *
 * The hook looks where detection credits, not the reverse:
 * `docs/HANDOFF.md` is a real convention, and narrowing detection to the
 * root would make `P4.handoff` propose creating a root `HANDOFF.md` in a
 * repository that already has one under `docs/`, leaving two handoffs that
 * disagree. A wrong write is worse than a wrong read, and widening the hook
 * costs one extra `existsSync`.
 *
 * The list lives in this module because the hook is copied into a user's
 * repository, where a constant in `scripts/lib/` could never reach it.
 */
export const HANDOFF_CANDIDATES = ['HANDOFF.md', 'docs/HANDOFF.md'];

export function findHandoff(root) {
  for (const rel of HANDOFF_CANDIDATES) {
    if (existsSync(join(root, rel))) return rel;
  }
  return null;
}

// --- The rules registry: location and parser -----------------------------
//
// `docs/harness/RULES.md` is where a repository records its own rules, each
// with the mechanism that ENFORCES it, so a rule Claude is merely told
// (`enforced-by: none`) can be told apart from one it cannot break (a deny
// rule, a hook, a lint, a test, a critic).
//
// The parser lives HERE for the reason `findHandoff` does: two things must
// agree on what a rule is — `detect` (scripts/lib/rules-evidence.mjs, which
// credits `P3.rules`) and the installed `rules-brief.mjs` hook (which
// re-injects the rules into every prompt) — and a parser in `scripts/lib/`
// could never reach the installed hook.
//
// Why Markdown with `key: value` bullets and not JSON or YAML: this file is
// written and edited by a HUMAN — the kit scaffolds the shape and never
// writes a rule into it — so it must stay pleasant to edit by hand, and the
// kit has no YAML parser (zero dependencies). A 40-line parser is the
// cheaper choice. Anthropic's observation that models alter JSON less than
// Markdown applies to machine-maintained state; this is not that.
//
// The rules the learning loop adds live in a second file of the same
// format, `docs/harness/LEARNED.md`, which the kit writes and the owner does
// not (scripts/lib/learned-registry.mjs). Every reader of the registry reads
// both, and a rule is the owner's or a learned one by the file it is in,
// never by its `origin` key.
//
// HTML comments are stripped FIRST. That is what makes the shipped
// template's worked example inert: everything the kit itself puts in the
// scaffold sits inside one comment, so a user who never edits the file has
// a registry of zero rules, never a registry of our example pretending to
// be theirs. (`markdownRemainder` in uninstall-lib.mjs relies on the same
// property from the other side, to recognise an unfilled scaffold.)

export const RULES_PATH = 'docs/harness/RULES.md';
export const LEARNED_PATH = 'docs/harness/LEARNED.md';

/** Every value `enforced-by` may take. `none` is a claim, not an enforcer —
 * it is recorded so the registry can say plainly which rules are told and
 * which are held, and `review` means a human reviewer is the mechanism. */
export const ENFORCERS = Object.freeze(['deny', 'hook', 'lint', 'test', 'critic', 'ci', 'review', 'none']);

/** Every value a learned entry's `approved-action` line may take: the
 * actions of a gate, as harness-gates.mjs's `GATE_ACTIONS` lists them. */
export const APPROVED_ACTIONS = Object.freeze(['observe', 'warn', 'block']);

/**
 * Whether a learned rule cannot be broken, by what its registry entry
 * records: a hook enforces it and its gate was approved at `block`. A gate
 * that warns or only observes lets the call run, and an entry that records
 * no action is not known to block, so the model can still break those rules
 * and the prompt hook re-tells them. `detect`'s count of injected rules
 * uses this same test.
 */
export const heldByBlockingGate = rule => rule.enforcedBy === 'hook' && rule.approvedAction === 'block';

export function findRules(root) {
  return existsSync(join(root, RULES_PATH)) ? RULES_PATH : null;
}

export function findLearned(root) {
  return existsSync(join(root, LEARNED_PATH)) ? LEARNED_PATH : null;
}

// `## <id> — <rule>`: the id is one token (letters, digits, `_`, `.`, `-`,
// starting with a letter); the separator is an em-dash, en-dash or hyphen
// run, or just whitespace; the rule is whatever follows, trimmed.
// Exported, with `registryLines`, so scripts/lib/learned-registry.mjs finds
// an entry's section by exactly the lines and headings this parser reads.
export const RULE_HEADING = /^##\s+([A-Za-z][\w.-]*)(?:\s+[—–-]+\s+|\s+)(\S.*)$/;
export const ANY_H2 = /^##(\s|$)/;
const KEY_LINE = /^\s*[-*]\s*([A-Za-z][\w-]*)\s*:\s*(.*)$/;

/** Canonical field for a key as a user might spell it: `enforced-by`,
 * `enforcedBy`, `enforced_by`, `Enforced-By` all mean `enforcedBy`. */
function fieldFor(key) {
  const k = key.toLowerCase().replace(/[-_]/g, '');
  if (k === 'enforcedby') return 'enforcedBy';
  if (k === 'lastverified') return 'lastVerified';
  if (k === 'approvedsha256') return 'approvedSha256';
  if (k === 'approvedaction') return 'approvedAction';
  if (k === 'why' || k === 'pointer' || k === 'verify' || k === 'priority' || k === 'status' || k === 'origin' || k === 'evidence') return k;
  return null; // unknown keys are ignored, as Claude Code ignores unknown frontmatter
}

/**
 * The lines `parseRules` reads from registry `text`: every HTML comment
 * blanked to its newlines alone, then split on `\n` or `\r\n`. Line `i` is
 * line `i` of `text` split the same way, without its comment characters.
 */
export function registryLines(text) {
  return text.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, '')).split(/\r?\n/);
}

/**
 * Parses the registry text. Never throws; `null`/non-string input is an
 * empty registry. Returns `{ rules, problems }` where every problem is a
 * one-line human sentence naming the rule id or the line number — never a
 * rule's own text, since a rule line may carry anything and this output
 * reaches `docs/harness/detect.json`, which is committed. The one value
 * echoed is a rejected `enforced-by` token, because naming what was
 * rejected is the only way the sentence can be acted on.
 *
 * Each rule: `{ id, rule, why, enforcedBy, pointer, verify, priority, status,
 * lastVerified, origin, evidence, approvedSha256, approvedAction, line }`.
 * `origin`, `evidence`, `approvedSha256` and `approvedAction` are the keys
 * the kit writes into a learned entry; each of the first three is its
 * trimmed text, or null when absent or empty, and `approvedAction` is the
 * action the entry's gate was approved at, one of `APPROVED_ACTIONS`, or
 * null when absent or anything else (reported). `status` is `active` (default) or `superseded` — a
 * superseded rule stays in the file as a record but is excluded from
 * re-injection and from the enforcement counts; `lastVerified` is a
 * YYYY-MM-DD string or null (anything else is reported, never guessed at).
 * `enforcedBy` is always one of ENFORCERS (an absent or unknown value is
 * recorded as `none` AND reported, so a typo cannot silently promote a
 * claim to an enforcer); `priority` is `high` or `normal`; `line` is the
 * 1-based line of the heading in the ORIGINAL text (comments are blanked,
 * not removed, so line numbers survive the strip).
 */
export function parseRules(text) {
  if (typeof text !== 'string' || text.length === 0) return { rules: [], problems: [] };
  const lines = registryLines(text);
  const rules = [];
  const problems = [];
  const seen = new Set();
  let current = null;
  const close = () => {
    if (!current) return;
    if (current.enforcedBy === undefined) {
      problems.push(`${current.id}: no enforced-by line — recorded as none`);
      current.enforcedBy = 'none';
    }
    rules.push(current);
    current = null;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (ANY_H2.test(line)) {
      close();
      const m = line.match(RULE_HEADING);
      if (!m) {
        problems.push(`line ${i + 1}: heading is not "<id> — <rule>"`);
        continue;
      }
      const id = m[1];
      if (seen.has(id)) {
        problems.push(`duplicate id ${id} at line ${i + 1} — the first definition is kept`);
        continue;
      }
      seen.add(id);
      current = { id, rule: m[2].trim(), why: null, enforcedBy: undefined, pointer: null, verify: null, priority: 'normal', status: 'active', lastVerified: null, origin: null, evidence: null, approvedSha256: null, approvedAction: null, line: i + 1 };
      continue;
    }
    if (!current) continue;
    const k = line.match(KEY_LINE);
    if (!k) continue;
    const field = fieldFor(k[1]);
    if (!field) continue;
    const value = k[2].trim();
    if (field === 'enforcedBy') {
      const v = value.toLowerCase();
      if (ENFORCERS.includes(v)) current.enforcedBy = v;
      else { problems.push(`${current.id}: enforced-by "${v}" is not one of ${ENFORCERS.join('/')} — recorded as none`); current.enforcedBy = 'none'; }
    } else if (field === 'priority') {
      current.priority = value.toLowerCase() === 'high' ? 'high' : 'normal';
    } else if (field === 'status') {
      const v = value.toLowerCase();
      if (v === 'active' || v === 'superseded') current.status = v;
      else problems.push(`${current.id}: status "${v}" is not active or superseded — recorded as active`);
    } else if (field === 'lastVerified') {
      if (/^\d{4}-\d{2}-\d{2}$/.test(value)) current.lastVerified = value;
      else problems.push(`${current.id}: last-verified is not a YYYY-MM-DD date — recorded as unknown`);
    } else if (field === 'approvedAction') {
      const v = value.toLowerCase();
      if (APPROVED_ACTIONS.includes(v)) current.approvedAction = v;
      else problems.push(`${current.id}: approved-action is not ${APPROVED_ACTIONS.slice(0, -1).join(', ')} or ${APPROVED_ACTIONS.at(-1)} — recorded as unknown`);
    } else {
      current[field] = value.length ? value : null;
    }
  }
  close();
  return { rules, problems };
}

// --- Session-scoped marker state, shared by both hooks' own bounding -----
//
// Both lint-touched.mjs (dedupe a standing lint error per file) and
// verify-touched.mjs (dedupe a standing verification failure, bound how
// many times either blocks/reports since its last clean run) need the identical
// building blocks: a sanitized session_id, a safe-to-write location under
// the OS temp directory, and a read/write pair that never throws. One copy
// here instead of two, for the same reason the redaction layers are one
// copy instead of two.

/**
 * `session_id` is attacker-shaped: it comes straight off a hook payload and
 * would otherwise go straight into a filesystem path. A `../`-laden or
 * absolute value could escape the marker directory entirely; a NUL byte
 * would make any `fs` call on the resulting path throw outright. Reducing
 * to a strict allowlisted charset and refusing anything else outright means
 * there is no path left for a malicious value to take — a value that does
 * not survive this check is never used to build a path at all. The caller
 * must treat `null` as "skip tracking for this invocation", never invent a
 * fallback filename.
 */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]+$/;

export function safeSessionId(sessionId) {
  return typeof sessionId === 'string' && sessionId.length > 0 && sessionId.length <= 200 && SAFE_SESSION_ID.test(sessionId)
    ? sessionId
    : null;
}

/**
 * A stable, filesystem-safe tag for the current OS user. Hashed (not used
 * raw) so an unusual username can never itself become a path-safety
 * concern the way `session_id` already is one. Falls back to a constant
 * rather than throwing — `os.userInfo()` can throw in a minimal/sandboxed
 * environment with no resolvable home directory — which only widens the
 * shared-temp-directory exposure `markerDir` describes, never a crash.
 */
function userTag() {
  try {
    const id = typeof process.getuid === 'function' ? String(process.getuid()) : userInfo().username;
    return createHash('sha256').update(id, 'utf8').digest('hex').slice(0, 16);
  } catch {
    return 'unknown';
  }
}

/** A stable, filesystem-safe tag for a repository root, so two different
 * repositories (or a repository moved/renamed) never share a marker even
 * if a `session_id` were ever reused across them. */
export function rootTag(root) {
  return createHash('sha256').update(resolve(root), 'utf8').digest('hex').slice(0, 16);
}

/**
 * The directory every marker lives under: per-user (see userTag), under
 * the OS temp directory, created with owner-only permissions on POSIX
 * (`0o700` — a no-op on win32, where ACLs already default to per-user
 * access under `%TEMP%`). This narrows, but does not eliminate, the
 * pre-seeded-marker exposure a shared temp directory allows across
 * DIFFERENT users; within the same user and the same machine the residual
 * risk is accepted.
 * Creation failure is swallowed — the caller's own marker read/write is
 * already failure-tolerant, and a directory that cannot be created simply
 * means every marker operation beneath it will consistently fail-safe too.
 *
 * `HK_MARKER_DIR` overrides the location, following the same `HK_*`
 * convention as `HK_LINT_TIMEOUT_MS` and friends. It exists for one reason:
 * this is ONE FIXED DIRECTORY shared by every invocation of every hook, for
 * the life of the machine, and nothing removes what is written there.
 * Markers are keyed by `(rootTag, namespace, sessionId)`, so they never
 * COLLIDE — but they do accumulate, one file per repository per namespace
 * per session, for ever.
 *
 * The accumulation is bounded and then accepted:
 *
 *   BOUNDED — `markerPath` shards by `rootTag` as a DIRECTORY level, so the
 *   entry count in any one directory grows with sessions PER REPOSITORY
 *   rather than with sessions across the machine.
 *
 *   ACCEPTED — what remains is NOT fixed with a cleanup sweep. A marker is a
 *   few dozen bytes of JSON and the OS cleans its temp directory; deleting
 *   files is a destructive action on the hot path of a hook that fires on
 *   every edit and every turn end, and the one thing worse than litter is a
 *   hook that removes the wrong file while a turn is in flight.
 *
 * A marker under a name no current hook uses is never read and is harmless:
 * a marker's absence is the permissive default everywhere (see
 * `readJSONMarker`'s `fallback`), so an unreachable marker can only ever
 * cost a hook one un-deduplicated report.
 *
 * In TESTS the accumulation is removed outright, which is what the override
 * is for: `scripts/lib/test-marker-sandbox.mjs` points this at a per-run
 * temp directory and deletes it in a teardown that runs on pass, fail or
 * throw, since thousands of entries in one shared directory are a credible
 * cause of a rare, unattributable failure in a suite that sets sub-second
 * timeouts.
 */
/**
 * True when `dir` is a real directory of ours: not a link (a symlink or
 * junction planted at a predictable path redirects every marker read and
 * write), and on POSIX not another user's. A
 * refusal means "no marker directory": `markerPath` returns null and every
 * caller's existing fail-open path takes over.
 */
function ownDirectory(dir) {
  let st;
  try {
    st = lstatSync(dir);
  } catch {
    return false;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return false;
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
  return true;
}

/** Creates `dir` if absent and returns it, or null when it is not ours. */
function ensureOwnDirectory(dir) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  } catch {
    // best-effort — see comment above; ownDirectory decides from what is there
  }
  return ownDirectory(dir) ? dir : null;
}

export function markerDir() {
  const override = process.env.HK_MARKER_DIR;
  const dir = override && override.length > 0
    ? override
    : join(tmpdir(), `kh-harness-stop-${userTag()}`);
  return ensureOwnDirectory(dir);
}

/**
 * Builds a marker's full path: the per-user directory, then a DIRECTORY
 * named for the repo-root tag, then `<namespace>-<sanitized session_id>` as
 * the filename — so neither a cross-repo nor a cross-session collision is
 * possible, AND two DIFFERENT hooks sharing a (root, session_id) pair never
 * read or write each other's marker. lint-touched.mjs and verify-touched.mjs
 * track differently-shaped state (per-file signatures vs. a single
 * count/lastSignature/timedOut) under the SAME root and session; without
 * `namespace` they would silently corrupt one another's bookkeeping the
 * moment both fired in the same session.
 *
 * `rootTag` is a DIRECTORY LEVEL rather than a filename prefix. The marker's
 * identity is (root, namespace, session) either way; the directory level
 * bounds how many entries land in one directory. Nothing removes a marker
 * (see `markerDir`, which rules against a cleanup sweep and says why), so in
 * one flat directory the entry count would grow with sessions across every
 * repository on the machine, for the life of the machine. A directory per
 * repository bounds it by that repository's own session count.
 *
 * The cost is one `mkdirSync` on a path that already did one, on a hot path
 * (every edit, every turn end). It is not a cleanup mechanism and it deletes
 * nothing: deleting files on the hot path of a hook that fires mid-turn is a
 * worse trade than litter.
 *
 * Creation failure is swallowed for the same reason `markerDir`'s is: every
 * marker read and write beneath it is already failure-tolerant, so a
 * directory that cannot be created means the caller consistently fails safe
 * (see `writeJSONMarker`, which reports failure rather than pretending).
 */
export function markerPath(root, sessionId, namespace) {
  const base = markerDir();
  if (base === null) return null;
  const dir = ensureOwnDirectory(join(base, rootTag(root)));
  if (dir === null) return null;
  return join(dir, `${namespace}-${sessionId}`);
}

/**
 * Reads and JSON-parses a marker file. Never throws: an absent, unreadable,
 * or malformed marker all resolve to `fallback` — the safe, permissive
 * default — never a reason to crash or to skip the caller's own logic.
 */
export function readJSONMarker(path, fallback) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Writes a marker file and reports whether it actually landed on disk.
 * Never throws — but, critically, never PRETENDS success either. The
 * marker is the sole thing bounding how many times a caller may block or
 * report since its last clean run; a caller that swallows a write failure and proceeds
 * as if the state was recorded loses the bound it exists to provide, which
 * is strictly worse than under-blocking once. Every caller MUST check the
 * return value and fail open (skip the block/report) when it is `false`.
 */
export function writeJSONMarker(path, state) {
  try {
    const fd = openMarker(path, constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC);
    if (fd === null) return false;
    try {
      writeFileSync(fd, JSON.stringify(state), 'utf8');
    } finally {
      closeSync(fd);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Opens a marker file with `flags`, numeric `fs.constants` open flags, and
 * returns its descriptor, never through a link planted at the marker's own
 * path: O_NOFOLLOW where the platform defines it (POSIX); elsewhere an lstat
 * first, and null when a link is there. Throws what the open throws.
 */
export function openMarker(path, flags) {
  if (constants.O_NOFOLLOW !== undefined) return openSync(path, flags | constants.O_NOFOLLOW);
  let st = null;
  try { st = lstatSync(path); } catch { /* absent: the open may create it */ }
  return st?.isSymbolicLink() ? null : openSync(path, flags);
}

// --- Running a repository's own command, bounded ---------------------------
//
// Shared by the two process hooks. `spawnSync` with a `timeout` signals only
// the SHELL and leaves what the shell started running, so both go through
// the runner below, which kills the tree.

/**
 * Kills the ENTIRE process tree `child` roots, not merely `child` itself.
 * `spawnSync`'s own `timeout` option only ever signals the direct child —
 * with `shell: true` that is the SHELL, not whatever the shell went on to
 * run, so a `tsc`/test-runner process the shell started survives a timeout
 * kill and keeps running, one orphan per turn, forever, measured.
 *
 * POSIX: `detached: true` at spawn time (see runBounded) makes the shell the
 * leader of a NEW process group; `process.kill(-pid, signal)` (a NEGATIVE
 * pid) signals every process in that group, which ordinarily includes
 * anything the shell spawns, since a child inherits its parent's process
 * group unless it explicitly calls `setsid`/`setpgid` itself.
 *
 * win32 has no POSIX process groups; `taskkill /T /F` walks the OS's own
 * process tree (via the same mechanism Task Manager's "End process tree"
 * uses) regardless of how the tree was spawned, which is the standard win32
 * equivalent.
 */
export function killTree(child) {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGKILL');
    }
  } catch {
    // A kill that cannot even be issued (process already gone, permission
    // denied) must never throw — a hook never throws.
  }
}

/**
 * Runs `command` under a shell, bounded by `timeoutMs` and `maxBuffer`,
 * resolving to a result shaped like `spawnSync`'s own (`status`, `signal`,
 * `error`, `stdout`, `stderr`) plus `timedOut`/`overflowed`. A timeout
 * kills the whole tree (see killTree) and waits up to `killGraceMs` for it
 * to go. An overflow does NOT kill, or a passing but verbose command would
 * be blamed for the cutoff: the first
 * `maxBuffer` characters of each stream are kept, the rest is dropped, the
 * command runs to its own end and `status` is its own. Never throws; a
 * spawn failure resolves with `error` set, exactly like `spawnSync`.
 */
export function runBounded(command, { cwd, env, timeoutMs, maxBuffer, killGraceMs = 5_000 }) {
  return new Promise(resolvePromise => {
    let settled = false;
    let timedOut = false;
    let overflowed = false;
    let killIssued = false;
    let stdout = '';
    let stderr = '';
    let timer;
    let graceTimer = null;

    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      resolvePromise(result);
    };

    let child;
    try {
      child = spawn(command, {
        cwd,
        env,
        shell: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        // POSIX only — see killTree's comment. A no-op flag on win32,
        // where taskkill does the real work regardless.
        detached: process.platform !== 'win32',
      });
    } catch (error) {
      finish({ status: null, signal: null, error, stdout: '', stderr: '', timedOut: false, overflowed: false });
      return;
    }

    const issueKill = () => {
      if (killIssued) return;
      killIssued = true;
      killTree(child);
      graceTimer = setTimeout(() => {
        finish({ status: null, signal: 'SIGKILL', error: null, stdout, stderr, timedOut, overflowed });
      }, killGraceMs);
    };

    const append = (current, chunk) => {
      if (current.length >= maxBuffer) { overflowed = true; return current; }
      const room = maxBuffer - current.length;
      if (chunk.length > room) overflowed = true;
      return current + chunk.slice(0, room);
    };

    child.stdout?.on('data', chunk => { stdout = append(stdout, chunk.toString('utf8')); });
    child.stderr?.on('data', chunk => { stderr = append(stderr, chunk.toString('utf8')); });

    timer = setTimeout(() => {
      timedOut = true;
      issueKill();
    }, timeoutMs);

    child.on('error', error => {
      finish({ status: null, signal: null, error, stdout, stderr, timedOut, overflowed });
    });
    child.on('exit', (code, signal) => {
      finish({ status: code, signal, error: null, stdout, stderr, timedOut, overflowed });
    });
  });
}

/**
 * Normalizes away what is expected to differ between otherwise-identical
 * runs of the SAME failure, so a signature computed over the result is
 * stable across repeated runs of an unfixed problem: absolute paths (which
 * embed a machine- or run-specific directory) and elapsed-time figures
 * (which never repeat exactly). Anything this misses falls back on each
 * caller's own cap, never on this function alone being perfect.
 */
function normalizeForSignature(text) {
  return text
    .replace(/[A-Za-z]:[\\/][^\s"']+/g, '<path>') // C:\Users\...\x, C:/a/b
    .replace(/(?<=[\s"'(]|^)\/(?:[^\s"']+\/)+[^\s"']*/g, '<path>') // POSIX-absolute /a/b/c
    .replace(/\b\d+(?:\.\d+)?\s*(?:ms|s|sec|secs|seconds?|m|min|mins|minutes?)\b/gi, '<time>')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?\b/g, '<time>'); // 0:01:23, 12:34.5
}

export function signatureOf(lines) {
  return createHash('sha256').update(normalizeForSignature(lines.join('\n')), 'utf8').digest('hex');
}

/** How many distinct failures a hook reports in full since its last clean
 * run: the Stop gate's blocks, or the lint sensor's diagnostics for one
 * file. A clean run resets the count, so the bound limits churn on one
 * unfixed problem and never silences a session. A self-imposed
 * defence-in-depth bound, independent of (and stricter than) the platform's
 * own documented 8-consecutive-block Stop-hook cap
 * (`CLAUDE_CODE_STOP_HOOK_BLOCK_CAP`, see verify-touched.mjs's header
 * comment) — shared so both hooks' own bounds move together if this value
 * is ever revisited. */
export const MAX_REPORTS_SINCE_CLEAN = 3;
