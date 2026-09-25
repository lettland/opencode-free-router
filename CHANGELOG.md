# Changelog

Add entries under `## Unreleased`. The next push to `master` that changes shipped code cuts a
release: the release workflow moves them under the new version, tags it and publishes the GitHub
release. A `[minor]` or `[major]` marker in a commit subject picks the bump; otherwise it is a patch.

## Unreleased

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
