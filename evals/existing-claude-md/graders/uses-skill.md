---
type: tool_used
tool: Skill
min: 1
arm: with-only
---

With-only indicator, not part of the score: confirms the plugin's skill
actually fired, rather than Claude handling the request from general
knowledge alone. Excluded from without-arm scoring by the runtime.

This case shipped without such an indicator, and that gap hid a real
result. The suite's first measured run reported a delta of zero on both
cases, which reads as "the plugin makes no difference" — but the skill had
never fired at all. `greenfield-ts` showed it (`uses-skill: passed=false`);
this case had no way to show anything, so half the evidence was missing.

Every case needs one. A scored delta is only interpretable once you know
whether the thing being measured was switched on.
