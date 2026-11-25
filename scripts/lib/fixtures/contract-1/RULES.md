# Rules

<!--
## X1 — a heading inside an HTML comment is not a rule
- enforced-by: test
-->

## R1 – Every database query is scoped to the current tenant
- why: a cross-tenant read is a data breach, not a bug
- enforced-by: test
- pointer: tests/tenant.test.mjs
- verify: npm test -- tenant
- priority: high
- status: active
- last-verified: 2026-11-25
- approval: owner

## V8 - Every migration has a down step
- why: a migration that cannot be reversed blocks a rollback
- enforced-by: officer
- pointer: tools/officers/v8.mjs
- approval: agent

## R3 — Keep each rule to one sentence
- enforced-by: none
