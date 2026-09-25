# Security Policy

## Supported versions

Pre-1.0: only the latest commit on `master` receives fixes.

## Reporting a vulnerability

Please **do not** open a public issue for a security problem. Report it privately through
GitHub Security Advisories:
<https://github.com/lettland/opencode-free-router/security/advisories/new>

## What to know

- **Keys.** `providers.env` is exported into opencode, so the agent's tools can read those
  keys, like any opencode provider key. `ranker.env` (Artificial Analysis) is read only by
  `rank.mjs`. Both are created with mode 0600 and are git-ignored.
- **Cost.** A model is used only if its provider is on the `freeTier` allowlist. A price of 0
  alone is not trusted, since subscription plans and gateways report 0 too. Every pick is re-checked
  against live provider data, so a stale ranking cannot route to a model that has since become paid.
  Groq, Cerebras and Google count as free because of their free tiers: a key with billing
  enabled can be charged.
- **Data.** Free models are usually paid for with data. Most of OpenCode Zen's free models are
  exceptions to its zero-retention policy: they may use data to improve the model, NVIDIA's free
  endpoints log usage, and "contributor" models train on prompts. OpenRouter's free providers may keep
  prompts. Don't use `free/auto` for confidential code. Narrow the pool with `pins.json` → `ban`
  or `excludeProviders`.
- **Remote data** (LMArena, Artificial Analysis, OpenRouter) is parsed as JSON and used only
  for scoring; it is never executed.
