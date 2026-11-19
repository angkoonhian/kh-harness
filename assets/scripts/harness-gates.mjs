// assets/scripts/harness-gates.mjs
//
// The gate language. A learned gate is data: a tool name, a dotted path to
// one field of the tool's input, a pattern, an action and a fixed message.
// This module says which gates are well formed, reads a gate file, hashes a
// gate and matches one against a tool call.
//
// Installed beside the other hook scripts and evaluated before every tool
// call, so it imports only Node built-ins and sibling files, never spawns a
// child process, and never builds a RegExp from gate data. A gate inspects
// only the first `inputMax` characters of its field; text beyond them is not
// inspected. Every kind then runs in time linear in what it inspects.
//
// A rejection reason is fixed text naming the rule broken, never a key or
// value taken from the file, since reasons are shown to the owner and the
// model.
import { createHash } from 'node:crypto';

import { canonicalJson, maskText, stripUnsafe } from './harness-redact.mjs';

/** `inputMax` is how many leading characters of a field a gate inspects;
 * a gate never sees text beyond them. */
export const GATE_LIMITS = Object.freeze({ valueMax: 200, messageMax: 300, gatesMax: 100, inputMax: 65536 });

const GATE_KEYS = new Set(['id', 'tool', 'field', 'match', 'action', 'message', 'cites']);
const MATCH_KINDS = new Set(['literal', 'token', 'glob']);
export const GATE_ACTIONS = Object.freeze(['observe', 'warn', 'block']);
const ACTIONS = new Set(GATE_ACTIONS);
const CITES_MAX = 10;
const CITE_LENGTH_MAX = 200;

// A value with fewer characters than this that are neither `*` nor
// whitespace matches everything or nearly everything.
const SIGNIFICANT_MIN = 3;

// Segments that reach an object's prototype machinery rather than its data.
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

/** A gate's id, which is also its learning's id in the ledger. */
export const GATE_ID = /^L[1-9][0-9]{0,8}$/;
const FIELD = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
const LINE_BREAK = /[\n\p{Zl}\p{Zp}]/u;
const ANGLE_BRACKET = /[<>]/;
const DRIVE_PREFIX = /^[A-Za-z]:/;

const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);
const reject = reason => ({ ok: false, reason });

function citeProblem(cite) {
  if (typeof cite !== 'string' || cite.length === 0) return 'is not a non-empty string';
  if (cite.length > CITE_LENGTH_MAX) return `is longer than ${CITE_LENGTH_MAX} characters`;
  if (cite.startsWith('/') || cite.startsWith('\\') || DRIVE_PREFIX.test(cite)) return 'is not repository-relative';
  if (cite.split(/[\\/]/).includes('..')) return 'leaves the repository with ..';
  return null;
}

const significantLength = value => Array.from(value.replace(/[*\s]/gu, '')).length;

/** Whether `gate` is a full gate of this language. A suspension entry is
 * not a gate; `parseGates` reads those. */
export function validateGate(gate) {
  if (!isPlainObject(gate)) return reject('a gate must be a JSON object');
  if (Object.keys(gate).some(k => !GATE_KEYS.has(k))) {
    return reject('a gate may have only the keys id, tool, field, match, action, message and cites');
  }

  if (typeof gate.id !== 'string' || !GATE_ID.test(gate.id)) return reject('id must be L followed by 1 to 9 digits, without a leading zero');
  if (typeof gate.tool !== 'string' || gate.tool.length === 0 || gate.tool.length > GATE_LIMITS.valueMax) {
    return reject(`tool must be a non-empty string of at most ${GATE_LIMITS.valueMax} characters`);
  }
  if (typeof gate.field !== 'string' || gate.field.length > GATE_LIMITS.valueMax || !FIELD.test(gate.field)) {
    return reject('field must be a dotted path of identifier segments');
  }
  if (gate.field.split('.').some(s => FORBIDDEN_SEGMENTS.has(s))) {
    return reject('field must not name __proto__, constructor or prototype');
  }

  const { match } = gate;
  if (!isPlainObject(match) || Object.keys(match).some(k => k !== 'kind' && k !== 'value')) {
    return reject('match must be an object of kind and value only');
  }
  if (!MATCH_KINDS.has(match.kind)) return reject('match.kind must be literal, token or glob');
  if (typeof match.value !== 'string' || match.value.length === 0 || match.value.length > GATE_LIMITS.valueMax) {
    return reject(`match.value must be a non-empty string of at most ${GATE_LIMITS.valueMax} characters`);
  }
  if (significantLength(match.value) < SIGNIFICANT_MIN) {
    return reject(`match.value must have at least ${SIGNIFICANT_MIN} characters that are neither * nor whitespace`);
  }

  if (!ACTIONS.has(gate.action)) return reject('action must be observe, warn or block');

  const { message } = gate;
  if (typeof message !== 'string' || message.length === 0 || message.length > GATE_LIMITS.messageMax) {
    return reject(`message must be a non-empty string of at most ${GATE_LIMITS.messageMax} characters`);
  }
  if (LINE_BREAK.test(message)) return reject('message must be a single line');
  if (stripUnsafe(message) !== message) return reject('message must not contain control or invisible characters');
  if (ANGLE_BRACKET.test(message)) return reject('message must not contain < or >');
  // The hook prints a message as written. The sweep's floors, because a
  // message is prose the model is told to follow: `Basic authentication` is
  // an instruction, while a real token exceeds every floor.
  if (maskText(message, { floors: 'sweep' }) !== message) return reject('message must not contain a credential');

  if (gate.cites !== undefined) {
    if (!Array.isArray(gate.cites) || gate.cites.length > CITES_MAX) return reject(`cites must be an array of at most ${CITES_MAX} paths`);
    for (const cite of gate.cites) {
      const problem = citeProblem(cite);
      if (problem !== null) return reject(`cites: an entry ${problem}`);
    }
  }
  return { ok: true };
}

/** SHA-256 hex of the gate's canonical JSON without `action`, so promoting
 * or demoting a gate keeps its identity; `harnessIdentity` hashes the same. */
export function gateSha256(gate) {
  const { action: _action, ...content } = gate;
  return createHash('sha256').update(canonicalJson(content)).digest('hex');
}

/** The string at the dotted `field` of `input`, through own properties of
 * objects only, or undefined. */
function resolveField(input, field) {
  let value = input;
  for (const segment of field.split('.')) {
    if (FORBIDDEN_SEGMENTS.has(segment)) return undefined;
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, segment)) return undefined;
    value = value[segment];
  }
  return typeof value === 'string' ? value : undefined;
}

/** `A-Z`, `a-z`, `0-9` or `_` at index `i`; false outside the text. */
function isWordAt(text, i) {
  const c = text.charCodeAt(i);
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x5a) || (c >= 0x61 && c <= 0x7a) || c === 0x5f;
}

/** For each prefix of `codes`, the length of its longest proper prefix that
 * is also its suffix. */
function borderTable(codes) {
  const border = new Uint16Array(codes.length);
  for (let i = 1, k = 0; i < codes.length; i++) {
    while (k > 0 && codes[i] !== codes[k]) k = border[k - 1];
    if (codes[i] === codes[k]) k++;
    border[i] = k;
  }
  return border;
}

/**
 * Whether `value` occurs in `text` with a non-word character or a string end
 * on each side. A repeated `indexOf` from each failed occurrence would cost
 * the text length times the value length when occurrences overlap at every
 * position, so every occurrence is found in one Knuth-Morris-Pratt pass from
 * the first.
 */
function tokenMatches(text, value) {
  const first = text.indexOf(value);
  if (first === -1) return false;
  const codes = new Uint16Array(value.length);
  for (let i = 0; i < value.length; i++) codes[i] = value.charCodeAt(i);
  const border = borderTable(codes);
  const last = codes.length - 1;
  for (let i = first, k = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    while (k > 0 && c !== codes[k]) k = border[k - 1];
    if (c !== codes[k]) continue;
    if (k < last) {
      k++;
    } else {
      if (!isWordAt(text, i - last - 1) && !isWordAt(text, i + 1)) return true;
      k = border[last];
    }
  }
  return false;
}

/**
 * Whether `value` matches the whole of `text`, where `*` is any run of
 * characters (`/` included) and every other character, `?` among them, is
 * literal. The segments between stars are found left to right with
 * `indexOf`, each from where the previous one ended, so the search only
 * moves forward; the leftmost place for each is always the best one.
 */
function globMatches(value, text) {
  const segments = value.split('*');
  if (segments.length === 1) return text === value;
  const head = segments[0];
  const tail = segments[segments.length - 1];
  const tailStart = text.length - tail.length;
  if (tailStart < head.length || !text.startsWith(head) || !text.endsWith(tail)) return false;
  let at = head.length;
  for (const segment of segments.slice(1, -1)) {
    const found = text.indexOf(segment, at);
    if (found === -1 || found + segment.length > tailStart) return false;
    at = found + segment.length;
  }
  return true;
}

/** Whether `gate` fires on this tool call. Only a string at the gate's field
 * can match, and only its first `inputMax` characters are inspected, as if
 * they were the whole field; an unknown kind never matches. */
export function matchGate(gate, toolName, toolInput) {
  if (gate.tool !== toolName) return false;
  const field = resolveField(toolInput, gate.field);
  if (field === undefined) return false;
  const text = field.length > GATE_LIMITS.inputMax ? field.slice(0, GATE_LIMITS.inputMax) : field;
  const { kind, value } = gate.match;
  if (kind === 'literal') return text.includes(value);
  if (kind === 'token') return tokenMatches(text, value);
  if (kind === 'glob') return globMatches(value, text);
  return false;
}

const FILE_KEYS = new Set(['schema', 'gates', 'generatedBy']);

// The index of a rejection that concerns the whole file, not one entry.
const WHOLE_FILE = -1;

/** `{ file }` when `text` is a gate file of the expected shape, else
 * `{ reason }`. */
function readGateFile(text) {
  if (typeof text !== 'string') return { reason: 'the gate file is not text' };
  let file;
  try {
    file = JSON.parse(text);
  } catch {
    return { reason: 'the gate file is not valid JSON' };
  }
  if (!isPlainObject(file)) return { reason: 'the gate file must be a JSON object' };
  if (Object.keys(file).some(k => !FILE_KEYS.has(k))) return { reason: 'the gate file may have only the keys schema, gates and generatedBy' };
  if (file.schema !== 1) return { reason: 'the gate file must have schema 1' };
  if (!Array.isArray(file.gates)) return { reason: 'the gate file must have a gates array' };
  if (file.generatedBy !== undefined && typeof file.generatedBy !== 'string') return { reason: 'generatedBy must be a string' };
  return { file };
}

const isSuspension = entry => isPlainObject(entry) && Object.hasOwn(entry, 'suspended');

function suspensionProblem(entry) {
  const keys = Object.keys(entry);
  if (keys.length !== 2 || !Object.hasOwn(entry, 'id') || entry.suspended !== true) {
    return 'a suspension must be exactly { id, suspended: true }';
  }
  if (typeof entry.id !== 'string' || !GATE_ID.test(entry.id)) return 'id must be L followed by 1 to 9 digits, without a leading zero';
  return null;
}

/**
 * The gates and suspended ids in a gate file's text. A file that is not
 * `{ schema: 1, gates: [...] }`, optionally with a string `generatedBy`,
 * yields nothing and one rejection at index -1. Otherwise each entry is a
 * gate or a suspension; one that is neither, repeats an earlier id, or is
 * a gate beyond the first `gatesMax` is rejected by its index, and the rest
 * still load.
 */
export function parseGates(text) {
  const result = { gates: [], suspended: [], rejected: [] };
  const { file, reason } = readGateFile(text);
  if (file === undefined) {
    result.rejected.push({ index: WHOLE_FILE, reason });
    return result;
  }
  const seen = new Set();
  file.gates.forEach((entry, index) => {
    const suspension = isSuspension(entry);
    const problem = suspension ? suspensionProblem(entry) : validateGate(entry).reason ?? null;
    if (problem !== null) {
      result.rejected.push({ index, reason: problem });
    } else if (seen.has(entry.id)) {
      result.rejected.push({ index, reason: 'duplicate id: an earlier entry has the same id' });
    } else if (!suspension && result.gates.length >= GATE_LIMITS.gatesMax) {
      result.rejected.push({ index, reason: `more than ${GATE_LIMITS.gatesMax} gates` });
    } else {
      seen.add(entry.id);
      if (suspension) result.suspended.push(entry.id);
      else result.gates.push(entry);
    }
  });
  return result;
}
