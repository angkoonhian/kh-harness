// assets/scripts/harness-redact.mjs
//
// Shared stderr redaction chokepoint for every process-output hook this kit
// installs — today that is lint-touched.mjs's PostToolUse sensor and
// verify-touched.mjs's Stop gate, and any future one must import this file
// rather than carry its own copy. Two hooks each holding an independent
// copy of this logic is exactly the shape that lets a redaction fix land in
// one and not the other; this project has already shipped four
// secret-exposure defects, and "the fix only ever reached one of the two
// copies" is a failure mode this extraction removes structurally, not by
// convention.
//
// Two independent layers:
//
//   Layer 1 (dropCommandFragments): a denylist against what is KNOWN to
//   have come from a command the calling hook itself built. A shell or
//   interpreter can echo a FRAGMENT of a failing command line, not
//   necessarily the whole string (confirmed: node's own SyntaxError
//   reporter prints only the text after an unbalanced quote) — so every
//   whitespace-delimited token of length >= 8 drawn from the command(s) is
//   treated as sensitive, and any surviving line containing one is dropped
//   outright. `exemptions` carries whatever the caller appended to its own
//   command (a file path, say) that legitimately belongs in a real
//   diagnostic and must never be treated as a redactable fragment.
//
//   Layer 2 (maskCredentials): a credential-SHAPE allowlist, independent of
//   layer 1 — catches a credential-shaped value arriving from ANYWHERE in
//   the output, including content the hook never built itself (e.g. a
//   linted file's own source, or a verification command's own diagnostic
//   text). Masks the VALUE and never drops the line: a genuine diagnostic
//   that happens to mention a credential should still reach Claude, with
//   the secret starred out, not disappear entirely.
//
// Attribution — deciding what the output is even ABOUT — is each caller's
// own concern and stays in the caller; it has nothing to do with redaction
// and does not belong in a shared chokepoint.

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

/**
 * Layer 1. `commands` is every raw command string the calling hook itself
 * built (e.g. `[lintScript, fullCommand]`, or a single verify command) —
 * each is checked both as a whole-string match (the "shell echoes the
 * entire line" case) and tokenized for the fragment case.
 */
export function dropCommandFragments(lines, commands, exemptions = new Set()) {
  const tokens = [...new Set(commands.flatMap(c => commandTokens(c, exemptions)))];
  return lines.filter(l => {
    if (commands.some(c => l.includes(c))) return false;
    return !tokens.some(t => l.includes(t));
  });
}

/** Layer 2. Credential-shaped values, independent of where they came from. */
export const CREDENTIAL_RULES = [
  [/\bsk-[A-Za-z0-9_-]{6,}/g, '***'],
  [/\bglpat-[A-Za-z0-9_-]{6,}/g, '***'],
  [/\bghp_[A-Za-z0-9]{6,}/g, '***'],
  [/\bgithub_pat_[A-Za-z0-9_]{6,}/g, '***'],
  [/\bAKIA[A-Za-z0-9]{12,}/g, '***'],
  [/\bxox[abprs]-[A-Za-z0-9-]{6,}/g, '***'],
  [/\bBearer\s+\S+/gi, 'Bearer ***'],
  [/(--(?:token|auth-token|api-key)=)\S+/gi, '$1***'],
  [/\b(password|api_key)=\S+/gi, '$1=***'],
];

export function maskCredentials(line) {
  let masked = line;
  for (const [re, replacement] of CREDENTIAL_RULES) masked = masked.replace(re, replacement);
  return masked;
}

/** Convenience: both layers, in the required order (fragments dropped, then
 * remaining lines mask-filtered for credential shapes). */
export function redactLines(lines, commands, exemptions = new Set()) {
  return dropCommandFragments(lines, commands, exemptions).map(maskCredentials);
}
