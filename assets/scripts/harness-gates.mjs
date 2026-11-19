// assets/scripts/harness-gates.mjs
//
// The gate language. A learned gate is data: a tool name, a dotted path to
// one field of the tool's input, a pattern, an action and a fixed message.
// This module says which gates are well formed, reads a gate file, hashes a
// gate and matches one against a tool call.
//
// Installed beside the other hook scripts and evaluated before every tool
// call, so it imports only Node built-ins and sibling files, never spawns a
// child process, and never builds a RegExp from gate data: every pattern
// kind is matched by plain string code whose time is bounded by the input
// length times `valueMax`.
import { createHash } from 'node:crypto';

import { canonicalJson } from './harness-log.mjs';
import { stripUnsafe } from './harness-redact.mjs';

export const GATE_LIMITS = Object.freeze({ valueMax: 200, messageMax: 300, gatesMax: 200 });

const GATE_KEYS = new Set(['id', 'tool', 'field', 'match', 'action', 'message', 'cites']);
const MATCH_KINDS = new Set(['literal', 'token', 'glob']);
const ACTIONS = new Set(['observe', 'warn', 'block']);
const CITES_MAX = 10;
const CITE_LENGTH_MAX = 200;

// Segments that reach an object's prototype machinery rather than its data.
const FORBIDDEN_SEGMENTS = new Set(['__proto__', 'constructor', 'prototype']);

const ID = /^L[0-9]+$/;
const FIELD = /^[A-Za-z_$][A-Za-z0-9_$]*(?:\.[A-Za-z_$][A-Za-z0-9_$]*)*$/;
const LINE_BREAK = /[\n\p{Zl}\p{Zp}]/u;
const ANGLE_BRACKET = /[<>]/;
const WORD_CHARACTER = /^[A-Za-z0-9_]$/;
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

/** Whether `gate` is a full gate of this language. A suspension entry is
 * not a gate; `parseGates` reads those. */
export function validateGate(gate) {
  if (!isPlainObject(gate)) return reject('a gate must be a JSON object');
  const unknown = Object.keys(gate).filter(k => !GATE_KEYS.has(k));
  if (unknown.length > 0) return reject(`unknown key ${JSON.stringify(unknown[0])}`);

  if (typeof gate.id !== 'string' || !ID.test(gate.id)) return reject('id must be L followed by digits');
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

  if (!ACTIONS.has(gate.action)) return reject('action must be observe, warn or block');

  const { message } = gate;
  if (typeof message !== 'string' || message.length === 0 || message.length > GATE_LIMITS.messageMax) {
    return reject(`message must be a non-empty string of at most ${GATE_LIMITS.messageMax} characters`);
  }
  if (LINE_BREAK.test(message)) return reject('message must be a single line');
  if (stripUnsafe(message) !== message) return reject('message must not contain control or invisible characters');
  if (ANGLE_BRACKET.test(message)) return reject('message must not contain < or >');

  if (gate.cites !== undefined) {
    if (!Array.isArray(gate.cites) || gate.cites.length > CITES_MAX) return reject(`cites must be an array of at most ${CITES_MAX} paths`);
    for (const cite of gate.cites) {
      const problem = citeProblem(cite);
      if (problem !== null) return reject(`cites entry ${JSON.stringify(cite)} ${problem}`);
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

const isWordAt = (text, i) => i >= 0 && i < text.length && WORD_CHARACTER.test(text[i]);

function tokenMatches(text, value) {
  for (let at = text.indexOf(value); at !== -1; at = text.indexOf(value, at + 1)) {
    if (!isWordAt(text, at - 1) && !isWordAt(text, at + value.length)) return true;
  }
  return false;
}

/**
 * Whether `pattern` matches the whole of `text`, where `*` is any run of
 * characters (`/` included) and `?` is one UTF-16 code unit; every other
 * character is literal. Two pointers, and on a mismatch only the most recent
 * `*` is retried one character further, so the work is at most the text
 * length times the pattern length.
 */
function globMatches(pattern, text) {
  let p = 0;
  let t = 0;
  let star = -1;
  let resume = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === '*') {
      star = p++;
      resume = t;
    } else if (p < pattern.length && (pattern[p] === '?' || pattern[p] === text[t])) {
      p++;
      t++;
    } else if (star !== -1) {
      p = star + 1;
      t = ++resume;
    } else {
      return false;
    }
  }
  while (p < pattern.length && pattern[p] === '*') p++;
  return p === pattern.length;
}

/** Whether `gate` fires on this tool call. Only a string at the gate's field
 * can match; an unknown kind never does. */
export function matchGate(gate, toolName, toolInput) {
  if (gate.tool !== toolName) return false;
  const text = resolveField(toolInput, gate.field);
  if (text === undefined) return false;
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
  const unknown = Object.keys(file).filter(k => !FILE_KEYS.has(k));
  if (unknown.length > 0) return { reason: `the gate file has unknown key ${JSON.stringify(unknown[0])}` };
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
  if (typeof entry.id !== 'string' || !ID.test(entry.id)) return 'id must be L followed by digits';
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
      result.rejected.push({ index, reason: `duplicate id ${entry.id}` });
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
