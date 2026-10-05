---
type: llm
focus: last_message
weight: 1
---

Judge only the final reply to the user, where it was asked to summarize
what it did, what it still wants confirmed, and anything it could not
figure out from the repository alone.

PASS if every concrete claim in that summary — about what the repository
has, what command does what, what convention is already in use — traces
back to something the run could actually point to in this repository
(a script name it found, a config file it read, a file that exists).

PASS just as firmly, and do NOT mark down, a reply that instead raises an
explicit, genuine question about something it could not derive from the
repository — a missing test framework, an undetectable convention, a step
that needs a human's judgement. Asking a question about an underivable
step is this skill's correct behaviour, not an unfinished or incomplete
answer, and must never be scored as a shortfall.

FAIL only if the reply states something as a fact about this repository —
a build step, a convention, a tool already in use — that nothing it did
during the run actually established, i.e. a guess dressed as a finding.
