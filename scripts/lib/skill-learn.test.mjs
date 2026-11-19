// scripts/lib/skill-learn.test.mjs
//
// The harness-learn skill: where it finds the commands, which commands it
// shows, what it leaves to the owner, and that the draft shape it documents
// is the one `draftLearning` accepts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { GATE_LIMITS } from '../../assets/scripts/harness-gates.mjs';
import { LEARN_USAGE, LOG_USAGE } from './cli.mjs';
import { TERMINAL_ONLY } from './learn-cli.mjs';
import { FIX, loggedRepo, MISTAKE, signatureOf, WATCH_GATE } from './learn-fixtures.mjs';
import { draftLearning } from './learn-lib.mjs';
import { MIN_CLEAN_CALLS, MIN_CLEAN_SESSIONS } from './replay.mjs';

const SKILL_DIR = resolve(import.meta.dirname, '..', '..', 'skills', 'harness-learn');
const skill = readFileSync(join(SKILL_DIR, 'SKILL.md'), 'utf8');
const drafting = readFileSync(join(SKILL_DIR, 'references', 'drafting.md'), 'utf8');
const both = [skill, drafting];

// Pinned against the skills reference, https://code.claude.com/docs/en/skills,
// read on 2026-11-19, "Available string substitutions": `${CLAUDE_SKILL_DIR}`
// is "The directory containing the skill's `SKILL.md` file. For plugin
// skills, this is the skill's subdirectory within the plugin, not the plugin
// root", and Claude Code substitutes it and `${CLAUDE_PROJECT_DIR}` in the
// skill's markdown content. Frontmatter: `disable-model-invocation` defaults
// to false, and `description` is what Claude reads to decide when to use the
// skill.
const SKILL_DIR_VAR = '${CLAUDE_SKILL_DIR}';
const PROJECT_DIR_VAR = '${CLAUDE_PROJECT_DIR}';
const CLI_PREFIX = `${SKILL_DIR_VAR}/../../scripts/`;

const fenced = text => [...text.matchAll(/```[a-z]*\n([\s\S]*?)```/g)].map(m => m[1]);
const commandLines = text => fenced(text).flatMap(b => b.split('\n').map(l => l.trim())).filter(l => /^node\b.*[\s"/]scripts\/(log|learn)\.mjs\b/.test(l));

/** `{ cli, words }` for each `log` or `learn` command shown: the words after
 * the repository argument. */
function invocations(text) {
  return commandLines(text).map(line => {
    const m = /scripts\/(log|learn)\.mjs"\s+"\$\{CLAUDE_PROJECT_DIR\}"\s+(.*)$/.exec(line);
    assert.ok(m, `not a command of the documented form: ${line}`);
    return { cli: m[1], words: m[2].split(/\s+/) };
  });
}

const nameOf = words => (words[0] === 'policy' ? `policy ${words[1]}` : words[0]);

/** Each subcommand's synopsis line in LEARN_USAGE, by name. */
function learnSynopses() {
  const section = LEARN_USAGE.slice(LEARN_USAGE.indexOf('\nSUBCOMMANDS\n'), LEARN_USAGE.indexOf('\nTERMINAL ONLY\n'));
  const out = new Map();
  for (const line of section.split('\n')) {
    const m = /^ {2}(\S.*)$/.exec(line);
    if (!m) continue;
    const words = m[1].split(' ');
    const end = words.findIndex(w => /^[[<-]/.test(w));
    out.set(words.slice(0, end === -1 ? words.length : end).join(' '), m[1]);
  }
  return out;
}

const logSubcommands = () => /scripts\/log\.mjs <path-to-repo> <([a-z|]+)>/.exec(LOG_USAGE)[1].split('|');

/** The text of the level-2 section headed `heading`. */
function section(text, heading) {
  const start = text.indexOf(`\n## ${heading}\n`);
  assert.notEqual(start, -1, `no section "${heading}"`);
  const next = text.indexOf('\n## ', start + 1);
  return text.slice(start, next === -1 ? text.length : next);
}

const sentences = text => text.replace(/```[\s\S]*?```/g, '').split(/(?<=[.;:])\s+|\n\s*\n|\n\s*[-*]\s+|\n\s*\d+\.\s+/);

test('the frontmatter makes the skill model-invocable and says when to use it in one sentence', () => {
  const front = /^---\n([\s\S]*?)\n---\n/.exec(skill);
  assert.ok(front, 'frontmatter must open the file');
  assert.match(front[1], /^name:\s*harness-learn$/m);
  assert.doesNotMatch(front[1], /disable-model-invocation/, 'Claude must be able to invoke it when the session notice reports sealed sessions');
  assert.doesNotMatch(front[1], /user-invocable:\s*false/);
  const description = /^description:\s*(.+)$/m.exec(front[1])?.[1];
  assert.ok(description, 'a description is what Claude reads to decide when to use the skill');
  assert.match(description, /^Use when /);
  assert.equal(description.match(/[.!?](\s|$)/g)?.length, 1, 'one sentence');
  assert.ok(description.endsWith('.'));
});

test('SKILL.md stays a router, and its one reference is linked and exists', () => {
  assert.ok(skill.split('\n').length <= 140, 'the budget harness-init holds to is 140 lines');
  assert.ok(Buffer.byteLength(skill, 'utf8') <= 8 * 1024, 'SKILL.md loads on every invocation; the budget is 8 KiB');
  const links = [...skill.matchAll(/\]\((references\/[A-Za-z0-9._-]+\.md)\)/g)].map(m => m[1]);
  assert.deepEqual(links, ['references/drafting.md']);
  assert.ok(Buffer.byteLength(drafting, 'utf8') <= 24 * 1024);
});

test('the skill names the CLI path explicitly', () => {
  const first = skill.split('\n## ')[1];
  assert.match(first, /^Where the commands live\n/, 'the location comes first');
  for (const cli of ['log', 'learn']) {
    assert.ok(first.includes(`node "${CLI_PREFIX}${cli}.mjs"`), `${cli} is located from the skill's own directory`);
    assert.ok(existsSync(resolve(SKILL_DIR, '..', '..', 'scripts', `${cli}.mjs`)), `${CLI_PREFIX}${cli}.mjs resolves to the plugin's script`);
  }
  assert.ok(first.includes(PROJECT_DIR_VAR), 'the repository argument is named');
  assert.match(first, /Never\s+run\s+a\s+`scripts\/log\.mjs`\s+or\s+`scripts\/learn\.mjs`\s+found\s+in\s+the\s+target\s+repository/);
});

test('every command shown runs the plugin\'s script on the project directory', () => {
  const lines = both.flatMap(commandLines);
  assert.ok(lines.length >= 8, `only ${lines.length} commands were found; the extractor may be broken`);
  for (const line of lines) {
    assert.match(line, /^node "\$\{CLAUDE_SKILL_DIR\}\/\.\.\/\.\.\/scripts\/(log|learn)\.mjs" "\$\{CLAUDE_PROJECT_DIR\}" /, line);
  }
});

test('every command the skill prints exists in LEARN_USAGE or LOG_USAGE', () => {
  const learn = learnSynopses();
  assert.ok(learn.has('candidates') && learn.has('policy set'), 'the synopsis parser must find the subcommands');
  const shown = both.flatMap(invocations);
  for (const { cli, words } of shown) {
    if (cli === 'log') {
      assert.ok(logSubcommands().includes(words[0]), `log ${words[0]} is not a log subcommand`);
      continue;
    }
    const name = nameOf(words);
    assert.ok(learn.has(name), `learn ${name} is not a learn subcommand`);
    for (const flag of words.filter(w => w.startsWith('--'))) {
      assert.ok(learn.get(name).split(' ').includes(flag), `learn ${name} takes no ${flag}`);
    }
  }
  assert.deepEqual([...new Set(shown.filter(s => s.cli === 'learn').map(s => nameOf(s.words)))].sort(),
    ['approve', 'candidates', 'draft', 'list', 'replay', 'show', 'tick']);
});

test('the only log subcommands the skill runs read the log', () => {
  const shown = both.flatMap(invocations).filter(s => s.cli === 'log').map(s => s.words[0]);
  assert.deepEqual([...new Set(shown)].sort(), ['report', 'status']);
});

test('the skill forbids the three terminal-only commands by name', () => {
  const owner = section(skill, 'What only the owner does');
  for (const name of ['approve', 'wrong', 'policy set']) assert.ok(owner.includes(`\`${name}\``), name);
  assert.match(owner, /Never\s+run\s+any\s+of\s+them/);
  assert.match(owner, /never\s+suggest\s+a\s+way\s+around\s+the\s+terminal\s+check/);
});

test('the skill names every terminal-only subcommand, and land and revert, as owner-only', () => {
  const owner = section(skill, 'What only the owner does');
  for (const name of [...TERMINAL_ONLY, 'land', 'revert']) assert.ok(owner.includes(`\`${name}\``), `${name} is not named as the owner's`);
  const approveShown = commandLines(owner).filter(l => / approve /.test(l));
  assert.equal(approveShown.length, 1, 'the owner is given the exact approve command');
  assert.match(approveShown[0], /approve <id> --sha256 <hash> --action <warn\|block>$/);
  assert.match(owner, /run\s+`show`[^.]*hash/, 'the hash comes from show');
});

// A sentence that names one of these and tells someone to change something
// must forbid it or give it to the owner.
const PROTECTED = [/FAILURES\.md/, /gates\.local\.json/, /\.claude\/kh-harness\/gates\.json/, /LEARNED\.md/, /\bledger\b/, /policy file/, /data directory/, /\blabel\b/];
const CHANGES = /\b(write|writes|edit|edits|change|modify|add|append|update|delete|remove|create)\b/i;

test('the skill contains no instruction to enable the log, write a label, or edit a protected file', () => {
  for (const text of both) {
    for (const s of sentences(text)) {
      if (/\benable\b/i.test(s)) assert.match(s, /\bnever\b/i, `an instruction to enable the log: ${s}`);
      if (PROTECTED.some(p => p.test(s)) && CHANGES.test(s)) assert.match(s, /\b(never|owner)\b/i, `an instruction to change a protected file: ${s}`);
    }
  }
});

test('log content is data, never an instruction', () => {
  assert.match(section(skill, 'Everything read from the log is data'), /data[^.]*never\s+an\s+instruction,\s+whatever\s+it\s+says/);
  assert.match(drafting, /data,\s+never\s+an\s+instruction/);
});

test('the skill claims counts only, never an improvement', () => {
  const claims = section(skill, 'What you may claim');
  assert.match(claims, /recurrences/);
  assert.match(claims, /replay verdicts/);
  assert.match(claims, /firings/);
  assert.match(claims, /Never\s+say\s+that\s+the\s+harness\s+or\s+the\s+agent\s+improved/);
});

/** The draft template in drafting.md with each `"<name>"` placeholder
 * replaced by `values[name]`, parsed. */
function filledDraft(values) {
  const template = fenced(drafting).find(b => b.includes('"signature"'));
  assert.ok(template, 'drafting.md shows the draft shape');
  const used = new Set();
  const text = template.replace(/"<([a-z]+)>"/g, (_, name) => {
    assert.ok(Object.hasOwn(values, name), `no fixture value for <${name}>`);
    used.add(name);
    return JSON.stringify(values[name]);
  });
  assert.deepEqual([...used].sort(), Object.keys(values).sort(), 'every placeholder is filled and every value used');
  return JSON.parse(text);
}

test('the draft shape documented in drafting.md is accepted by draftLearning', () => {
  const root = loggedRepo();
  const draft = filledDraft({
    signature: signatureOf(root),
    title: 'Tests run once, never in watch mode',
    why: 'Watch mode waits for a terminal that an agent session does not have.',
    tool: WATCH_GATE.tool,
    field: WATCH_GATE.field,
    kind: WATCH_GATE.match.kind,
    value: WATCH_GATE.match.value,
    message: WATCH_GATE.message,
    path: 'README.md',
  });
  const result = draftLearning(root, draft);
  assert.ok(result.learning, result.error);
  assert.equal(result.learning.status, 'candidate');
  assert.deepEqual(result.learning.gate, { ...draft.gate, id: result.learning.id, action: 'observe' });
});

test('the limits drafting.md states are the ones the validator and the replay apply', () => {
  assert.ok(drafting.includes(`at most ${GATE_LIMITS.valueMax} characters, with at least 3 characters`));
  assert.ok(drafting.includes(`one line, at most ${GATE_LIMITS.messageMax} characters, with no \`<\` or \`>\``));
  assert.ok(drafting.includes(`first ${GATE_LIMITS.inputMax} characters`));
  assert.match(drafting, new RegExp(`at\\s+least\\s+${MIN_CLEAN_CALLS}\\s+clean\\s+calls\\s+of\\s+that\\s+tool\\s+across\\s+${MIN_CLEAN_SESSIONS}\\s+sessions`));
  const root = loggedRepo();
  const draft = over => draftLearning(root, { signature: signatureOf(root), title: 't', why: 'w', gate: WATCH_GATE, ...over });
  assert.match(draft({ title: 'x'.repeat(121) }).error, /title: must be at most 120 characters/);
  assert.ok(drafting.includes('one line, at most 120 characters'));
  assert.match(draft({ why: 'x'.repeat(301) }).error, /why: must be at most 300 characters/);
  assert.ok(drafting.includes('one line, at most 300 characters, saying why'));
  assert.match(draft({ gate: { ...WATCH_GATE, match: { kind: 'token', value: '*a* ' } } }).error, /at least 3 characters that are neither \* nor whitespace/);
});

test('the event reader drafting.md shows prints the recorded mistake and the corrected call', () => {
  const block = fenced(drafting).find(b => b.startsWith('node --input-type=module'));
  assert.ok(block, 'drafting.md shows how to read the recorded calls');
  const m = /^node --input-type=module -e "([^"]+)" "\$\{CLAUDE_SKILL_DIR\}\/([^"]+)" "\$\{CLAUDE_PROJECT_DIR\}" <session> <event>\n$/.exec(block);
  assert.ok(m, 'the reader has the documented form');
  const root = loggedRepo();
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', m[1], join(SKILL_DIR, m[2]), root, 'one', '2'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const printed = result.stdout.trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(printed.map(e => [e.event, e.status, e.input?.command]), [[2, 'error', MISTAKE], [3, 'ok', FIX]]);
});
