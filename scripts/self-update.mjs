#!/usr/bin/env node
// Started in the background by the session-start hook, with the plugin's
// root as its one argument: fast-forwards that checkout to its upstream
// when it safely can, and records the outcome for the next session to
// report. See scripts/lib/self-update.mjs. Prints nothing; its output goes
// nowhere.
import { selfUpdate } from './lib/self-update.mjs';

const root = process.argv[2];
if (root) {
  try {
    selfUpdate(root);
  } catch {
    // Nobody is listening, and the next attempt is within the hour.
  }
}
