# Changelog

Add entries under `## Unreleased`. The next push to `master` that changes shipped code cuts a
release: the release workflow moves them under the new version, tags it and publishes the GitHub
release. A `[minor]` or `[major]` marker in a commit subject picks the bump; otherwise it is a patch.

## Unreleased

- The code is now TypeScript, type-checked by TypeScript 7 in strict mode, and still ships as source
  with no build step: opencode loads `plugin.ts`, and Node or Bun runs `rank.mts`. **Node 22.18 or
  newer is now required** (Bun works as before); `install.sh` refuses an older `node` on `PATH`,
  since the plugin starts the ranker with it.
- Upgrading with `install.sh` replaces `plugin.js`, `lib.mjs` and `rank.mjs` with the new files and
  points the `plugin` entry of an existing `free.jsonc` at `./plugin.ts`. Nothing else in your files
  changes.
- `config.json`, `pins.json`, `state.json`, the ranking and every API response are now checked field
  by field when read. A value of the wrong type in `config.json` keeps its default, and malformed
  entries in `pins.json` are skipped, where before they could break a ranking run.

- Four more free providers on the `freeTier` allowlist, each checked against the provider's own terms
  rather than a price of 0: Z.AI and Zhipu AI (the free GLM Flash models, same key for both
  endpoints), ModelScope (all of its inference is free, with a 2,000 requests a day quota) and
  Mistral (Devstral Small, Codestral and Mistral Small on the free Experiment plan, matched by name
  since the catalog prices them). `providers.env.example` and the README list their keys and caveats.
  Cloudflare Workers AI, Vercel AI Gateway, Hugging Face and the OpenRouter clone gateways were left
  out on purpose, and the README says why.
- A new test keeps `templates/config.example.json` in step with the shipped defaults.
- A `402 Payment Required` now fails over like a removed model (24-hour cooldown) instead of being
  ignored, so a free-plan account that asks for a model it cannot pay for moves on instead of
  retrying a request that can never succeed.
- Tests now run `rank.mjs` as a CLI (stubbed network, fake `opencode`) and `plugin.js` against a
  fake opencode client, bringing line coverage of `src/` to 100%. No behavior change; an
  unreachable API-key check in `rank.mjs` was removed.

## 0.1.0 — 2026-09-25

First public release.

- `free/auto` model for opencode: the plugin swaps it for the best-ranked free model and keeps it
  for the whole session.
- Ranking from LMArena (agent, webdev, text) and Artificial Analysis (coding, agentic,
  intelligence), with stealth-model detection via OpenRouter and `pins.json` overrides.
- Failover on quota, rate limit, removal or refusal: cooldown, next-ranked model, automatic
  continue (a visible thread message under bb).
- Free providers are an explicit allowlist (Zen, OpenRouter and NVIDIA 0-priced models; Groq,
  Cerebras and Google free tiers). Subscription plans that report price 0 are never used.
- The plugin refreshes the ranking itself when it is older than 6 hours.
- `install.sh` / `uninstall.sh`, the `opencode-free` wrapper, and optional bb agent
  registration (`--bb`).
