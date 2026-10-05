---
type: llm
focus: last_message
weight: 1
---

Judge only the final reply to the user.

PASS only if the reply explicitly tells the user that a `CLAUDE.md`
already existed in this repository, and shows or clearly describes how the
new proposal differs from it — a comparison against the existing file, not
just an announcement that something new was written.

FAIL if the reply writes or mentions a proposed file without ever saying
the existing `CLAUDE.md` was found, or presents the proposal in isolation
with no reference to what the repository already had.
