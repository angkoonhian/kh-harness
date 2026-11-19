// scripts/lib/learned-registry.mjs
//
// The learned registry: `docs/harness/LEARNED.md` (`LEARNED_PATH`), the
// kit-owned file the learning loop's rules go in, in the format `parseRules`
// reads. The owner's `docs/harness/RULES.md` is never written by the kit;
// keeping learned rules in their own file is what lets the kit add and
// remove them without touching a byte the owner wrote.
//
// Every function here maps text to text and touches no file. Each returns
// `{ text }` on success or `{ error }`, a one-line sentence naming the field
// at fault and never its value: a title and a why are drafted by a model
// from session logs, so they are untrusted and are cleaned before they are
// rendered, and anything else malformed is refused. The file is committed,
// so they are credential-masked here, at the mask's own floors, and not
// only when the rules brief injects them.
//
// An entry's section is found with the parser's own lines and heading
// pattern (`registryLines`, `ANY_H2`, `RULE_HEADING`), so an id is replaced
// or removed only where `parseRules` reads it. A change is refused, and the
// text left as it was, unless afterwards the parser reads every other entry
// as before and reads the id exactly as the rendered entry alone, once, or,
// after a remove, not at all.
//
// Every entry is written `status: active`, the only status the committed
// file holds: a retired learning is removed from the file, not kept in it
// with another status.
//
// A new file starts from `assets/templates/LEARNED.md.tmpl`, rendered with
// the kit's version as `kitVersion`.
import {
  ANY_H2, ENFORCERS, escapeDelimiters, maskText, parseRules, registryLines, RULE_HEADING, stripUnsafe,
} from '../../assets/scripts/harness-redact.mjs';

const ID = /^L[1-9][0-9]{0,8}$/;
const SHA256 = /^[0-9a-f]{64}$/;
const SIGNATURE = /^[0-9a-f]{16}$/;
// `Date.prototype.toISOString`'s shape, which is how the session log
// records `ts`.
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/;
// One token with nothing a key line or a delimited block could be split by.
const POINTER = /^[^\s<>]{1,200}$/;
const TITLE_MAX = 120;
const WHY_MAX = 300;

/**
 * Untrusted prose as one line of at most `max` characters: invisible and
 * control characters removed, every other whitespace character made a
 * plain space, runs of spaces collapsed and the ends trimmed,
 * credential-shaped values masked, then `<` and `>` escaped. The cap counts
 * the escaped text and never cuts inside an escape or a surrogate pair.
 *
 * The mask runs before the escape and the cap. An escape's `;` ends an
 * unquoted keyed value, so `password=<x>` escaped first would mask only
 * `&lt`; and a cap that cut a token first could leave a fragment too short
 * for any shape to recognise.
 */
function cleanLine(raw, max) {
  const plain = maskText(stripUnsafe(raw).replace(/[^\S ]/g, ' ').replace(/ {2,}/g, ' ').trim());
  let out = '';
  let length = 0;
  for (const ch of plain) {
    const piece = escapeDelimiters(ch);
    if (length + piece.length > max) break;
    out += piece;
    length += piece.length;
  }
  return out.trimEnd();
}

/** True for null, or a timestamp that names a real instant: it round-trips
 * through `Date` with its fractional seconds normalised to milliseconds, so
 * `2026-02-30` or an hour of 24, which `Date` silently rolls over, fail. */
function validTimestamp(ts) {
  if (ts === null) return true;
  if (typeof ts !== 'string' || !TIMESTAMP.test(ts)) return false;
  const date = new Date(ts);
  if (Number.isNaN(date.getTime())) return false;
  const [whole, fraction = ''] = ts.slice(0, -1).split('.');
  return date.toISOString() === `${whole}.${fraction.padEnd(3, '0').slice(0, 3)}Z`;
}
const day = ts => ts === null ? null : ts.slice(0, 10);

/** `{ line }`, the evidence key's value in fixed wording built only from the
 * summary's validated values, or `{ field }` naming its first fault. */
function evidenceLine(summary) {
  if (summary === null || typeof summary !== 'object') return { field: 'evidence' };
  const { signature, sessions, firstTs, lastTs, external } = summary;
  if (typeof signature !== 'string' || !SIGNATURE.test(signature)) return { field: 'evidence signature' };
  if (!Number.isInteger(sessions) || sessions < 1) return { field: 'evidence sessions' };
  if (!validTimestamp(firstTs)) return { field: 'evidence firstTs' };
  if (!validTimestamp(lastTs)) return { field: 'evidence lastTs' };
  if (firstTs !== null && lastTs !== null && Date.parse(firstTs) > Date.parse(lastTs)) return { field: 'evidence date range' };
  if (typeof external !== 'boolean') return { field: 'evidence external' };
  const seen = `signature ${signature}, seen in ${sessions} session${sessions === 1 ? '' : 's'}`;
  const range = firstTs === null && lastTs === null
    ? ', dates unknown'
    : ` from ${day(firstTs) ?? 'an unknown date'} to ${day(lastTs) ?? 'an unknown date'}`;
  return { line: seen + range + (external ? ', includes a session flagged for outside content' : '') };
}

const refuse = field => ({ error: `learned entry: ${field} is missing or malformed — nothing was rendered` });

/**
 * One learned entry as a registry section: the `## <id> — <title>` heading
 * and its key lines, ending in a newline. `id` is `L` and a number;
 * `enforcedBy` one of `ENFORCERS`; `pointer` one token; `evidenceSummary`
 * `{ signature, sessions, firstTs, lastTs, external }`, required, with ISO
 * timestamps or null, in order; `approvedSha256` 64 lowercase hex characters. `title`
 * and `why` are cleaned (see `cleanLine`); either with nothing left is
 * refused.
 */
export function renderLearnedEntry(entry) {
  if (entry === null || typeof entry !== 'object') return refuse('the entry');
  const { id, title, why, enforcedBy, pointer, evidenceSummary, approvedSha256 } = entry;
  if (typeof id !== 'string' || !ID.test(id)) return refuse('id');
  const cleanTitle = typeof title === 'string' ? cleanLine(title, TITLE_MAX) : '';
  if (cleanTitle === '') return refuse('title');
  const cleanWhy = typeof why === 'string' ? cleanLine(why, WHY_MAX) : '';
  if (cleanWhy === '') return refuse('why');
  if (!ENFORCERS.includes(enforcedBy)) return refuse('enforced-by');
  if (typeof pointer !== 'string' || !POINTER.test(pointer) || stripUnsafe(pointer) !== pointer) return refuse('pointer');
  const evidence = evidenceLine(evidenceSummary);
  if (evidence.field) return refuse(evidence.field);
  if (typeof approvedSha256 !== 'string' || !SHA256.test(approvedSha256)) return refuse('approved-sha256');
  return {
    text: [
      `## ${id} — ${cleanTitle}`,
      `- why: ${cleanWhy}`,
      `- enforced-by: ${enforcedBy}`,
      `- pointer: ${pointer}`,
      '- origin: learned',
      '- status: active',
      `- evidence: ${evidence.line}`,
      `- approved-sha256: ${approvedSha256}`,
      '',
    ].join('\n'),
  };
}

/**
 * The `[start, end)` offsets in `text` of the section `parseRules` reads as
 * the rule `id`: from its heading's line to the next level-2 heading's line
 * or the end of the text. The first heading with the id wins, as in the
 * parser. `null` when the parser reads no rule `id`.
 */
function sectionOf(text, id) {
  const lines = registryLines(text);
  // Line `i` of `registryLines` is line `i` of `text`; these are their starts.
  const starts = [0, ...[...text.matchAll(/\r?\n/g)].map(m => m.index + m[0].length)];
  let start = null;
  for (let i = 0; i < lines.length; i++) {
    if (!ANY_H2.test(lines[i])) continue;
    if (start !== null) return [start, starts[i]];
    if (RULE_HEADING.exec(lines[i])?.[1] === id) start = starts[i];
  }
  return start === null ? null : [start, text.length];
}

/** A parsed rule without its line number, as text, for comparing two
 * readings of a rule. */
const reading = ({ line: _line, ...rule }) => JSON.stringify(rule);

/** How many headings in `text` the parser reads as id `id`, the first of
 * them the rule and any other a duplicate. */
const headingsFor = (text, id) => registryLines(text).filter(l => RULE_HEADING.exec(l)?.[1] === id).length;

/**
 * `{ text: after }` when `after` reads, to the parser, exactly as `before`
 * does in every rule but `id`, and as `expected` in rule `id`: the rendered
 * entry read alone, under the one heading with that id, or no rule and no
 * heading with that id when `expected` is null. Otherwise an error, and
 * nothing changes.
 */
function guarded(before, after, id, expected) {
  const others = text => parseRules(text).rules.filter(r => r.id !== id).map(reading).join('\n');
  const own = parseRules(after).rules.find(r => r.id === id);
  const ok = others(after) === others(before)
    && headingsFor(after, id) === (expected === null ? 0 : 1)
    && (expected === null ? own === undefined : own !== undefined && reading(own) === expected);
  const verb = expected === null ? 'removed' : 'rendered';
  return ok
    ? { text: after }
    : { error: `learned entry: the change to ${id} would alter another entry, leave a second ${id}, or not read back as written — nothing was ${verb}` };
}

/**
 * `text` with `entry` (as `renderLearnedEntry` takes it) in place of the
 * section of the same id, or appended after a blank line when there is
 * none. A section's trailing blank lines are kept, and a CRLF file stays
 * CRLF.
 */
export function upsertLearnedEntry(text, entry) {
  if (typeof text !== 'string') return { error: 'learned entry: the registry text is not a string — nothing was rendered' };
  const rendered = renderLearnedEntry(entry);
  if (rendered.error) return rendered;
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const section = rendered.text.replace(/\n/g, eol);
  const expected = reading(parseRules(rendered.text).rules[0]);
  const at = sectionOf(text, entry.id);
  if (at === null) {
    const base = text === '' || text.endsWith('\n') ? text : text + eol;
    return guarded(text, base + (base === '' ? '' : eol) + section, entry.id, expected);
  }
  const [start, end] = at;
  const old = text.slice(start, end);
  const trailing = old.slice(old.replace(/[\r\n \t]+$/, '').length);
  return guarded(text, text.slice(0, start) + section.trimEnd() + (trailing === '' ? eol : trailing) + text.slice(end), entry.id, expected);
}

/**
 * `{ text, removed }`: `text` without the section `parseRules` reads as the
 * rule `id`, every other byte unchanged, and `removed: true`; or `text`
 * itself and `removed: false` when the parser reads no rule `id`.
 */
export function removeLearnedEntry(text, id) {
  if (typeof text !== 'string') return { error: 'learned entry: the registry text is not a string — nothing was removed' };
  if (typeof id !== 'string' || !ID.test(id)) return { error: 'learned entry: id is missing or malformed — nothing was removed' };
  const at = sectionOf(text, id);
  if (at === null) return { text, removed: false };
  const result = guarded(text, text.slice(0, at[0]) + text.slice(at[1]), id, null);
  return result.error ? result : { ...result, removed: true };
}
