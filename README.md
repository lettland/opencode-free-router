# opencode-free-router

[![ci](https://github.com/lettland/opencode-free-router/actions/workflows/ci.yml/badge.svg)](https://github.com/lettland/opencode-free-router/actions/workflows/ci.yml)
[![Coverage Status](https://coveralls.io/repos/github/lettland/opencode-free-router/badge.svg?branch=master)](https://coveralls.io/github/lettland/opencode-free-router?branch=master)

An [opencode](https://opencode.ai) plugin that always runs on the **best free model available right
now**, so you never have to track which free models exist this week.

You pick one model, `free/auto`, and the plugin does the rest:

- **Ranked, not random.** Every free model opencode can reach is scored with
  [LMArena](https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset) (agent, webdev and text
  boards) and [Artificial Analysis](https://artificialanalysis.ai) (coding, agentic and intelligence
  indices). New stealth models that have no benchmarks yet, like the ones OpenRouter and OpenCode Zen
  run for a week, are detected and placed near the top.
- **Sticky.** A session keeps its model. It doesn't switch on every request. When a better model shows up, new sessions get it.
- **Fails over.** When the model hits its quota or rate limit, gets removed, or is refused, it goes on
  cooldown and the session moves to the next-ranked model. The interrupted task then continues automatically.
- **Only free.** Free providers are an explicit allowlist, and each pick is re-checked against
  live provider data. Subscription plans that report a price of 0 are never used.

```
$ opencode-free run "explain this repo"
> build · space-bunny-free
```

## Install

Requires opencode and Node 22.18+ (or Bun), on macOS or Linux. The code is TypeScript and ships as
source: opencode loads the plugin directly, and Node 22.18+ or Bun runs the ranker without a build
step.

```sh
git clone https://github.com/lettland/opencode-free-router
cd opencode-free-router
./scripts/install.sh          # add --bb to also register a bb agent
```

To pin a release instead of tracking `master`, `git checkout vX.Y.Z` (see
[releases](https://github.com/lettland/opencode-free-router/releases)) before running it.

This installs into `~/.config/opencode/free-router` (or `$XDG_CONFIG_HOME/…`, or `--dir PATH`), runs
the first ranking, and links `opencode-free` into `~/.local/bin` if that is on your `PATH`. Re-run it
to upgrade. Your config, pins, keys and state are never overwritten.

Then:

```sh
opencode-free                 # TUI on free/auto
opencode-free run "..."       # one-shot
opencode-free acp             # ACP agent (Zed, JetBrains, bb, ...)
```

`opencode-free` is plain `opencode` with the free-router config layered on top via `OPENCODE_CONFIG`.
Your normal `opencode` is unaffected.

## Which free models

Without any keys you get OpenCode Zen's free models. Each key you add grows the pool:

| Provider | Key | What counts as free |
|---|---|---|
| OpenCode Zen | none | models priced 0 (`*-free`, big-pickle, …) |
| OpenRouter | `OPENROUTER_API_KEY` | `:free` models (its routers like `openrouter/auto` are excluded) |
| NVIDIA | `NVIDIA_API_KEY` | models priced 0 on build.nvidia.com |
| Z.AI | `ZHIPU_API_KEY` | models priced 0 (GLM-4.7-Flash, GLM-4.5-Flash, GLM-4.6V-Flash) |
| Zhipu AI | `ZHIPU_API_KEY` | the same free GLM Flash models, for a China (BigModel) account |
| ModelScope | `MODELSCOPE_API_KEY` | models priced 0, which is all of them (2,000 requests a day) |
| Mistral | `MISTRAL_API_KEY` | Devstral Small, Codestral and Mistral Small, via the free Experiment plan |
| Groq | `GROQ_API_KEY` | all models, via the free tier |
| Cerebras | `CEREBRAS_API_KEY` | all models, via the free tier |
| Google AI Studio | `GOOGLE_GENERATIVE_AI_API_KEY` | Flash and Gemma models, via the free tier |

Keys you already have through `opencode auth login` or your shell environment just work. Otherwise
put them in `~/.config/opencode/free-router/providers.env`. That also covers launches that don't read
your shell profile, like bb or GUI apps. **Use free-plan accounts**: Groq, Cerebras, Google and
Mistral models count as free because of their free tiers, so a key with billing enabled may be
charged.

The four additions have their own caveats:

- **Z.AI / Zhipu.** The free GLM Flash models are free for every account, not trial credits. The
  catch is throughput: one request at a time, about one a second. They are two separate platforms
  sharing one variable, `ZHIPU_API_KEY`: a z.ai key only works on `zai`, a BigModel (China) key only
  on `zhipuai`. opencode reads the key for both, the wrong endpoint answers 401, and that provider
  goes on a 24-hour cooldown, so exactly one of the two ever reaches the pool.
- **ModelScope.** Everything it serves is free, with a quota of 2,000 requests a day (500 per model)
  and no card, but signup wants a phone number and the endpoint is fastest inside Asia.
- **Mistral.** The Experiment plan (no card, 1B tokens a month, 1 request a second) covers Devstral
  Small 2, Codestral and Mistral Small, but the catalog prices them, so the router matches them by
  name. Right now that means Codestral and Mistral Small: every Devstral entry Mistral lists is
  marked deprecated, including its only 0-priced one, and the router skips those. The Devstral glob
  is there for the first current Devstral Small that appears. Tune the families in `config.json` if
  Mistral changes the plan:
  `{"mistral": ["$zero", "devstral-small*", "codestral*", "mistral-small*"]}`.

Left out on purpose, because a price of 0 there does not mean free: Cloudflare Workers AI (10,000
neurons a day, and the models its free plan dropped now answer 403, which would bench the whole
provider), Vercel AI Gateway (the free credits need a payment method, and the catalog marks Llama
models as 0 that Vercel actually prices), Hugging Face ($0.10 of monthly credits), and the many
gateway clones that list every model at 0.

An optional `ARTIFICIAL_ANALYSIS_API_KEY` in `ranker.env` adds Artificial Analysis scores (free key,
100 requests a day; the ranker uses a few per refresh). Without it, ranking uses LMArena only.

## How ranking works

`rank.mts` writes `ranking.json`. The plugin re-runs it in the background whenever the file is older
than `refreshHours` (6).

1. It lists the models opencode can reach (`opencode models --verbose`) and keeps the ones that are free,
   can call tools, and have at least 64k context.
2. It matches each model against the leaderboards by name. `mimo-v2.6-flash` never matches
   `mimo-v2.6-pro`, and AA's `ling-3-0-flash-fin` matches `ling-3.0-flash-fin-free`.
3. Each source becomes a percentile. The score is the weighted mean over the sources that matched.
4. Models with no benchmarks: stealth models (OpenRouter's `stealth/` listing) score 0.95. Others
   score about 0.25–0.35, less for small models, so an unknown 2B preview never beats a
   benchmarked model.

```sh
node ~/.config/opencode/free-router/rank.mts --status    # ranking, cooldowns, model per session
```

### Overrides: `pins.json`

```json
{
  "pin":   ["opencode/space-bunny-free"],
  "ban":   ["openrouter/liquid/lfm-2.5-2.6b:free"],
  "alias": { "opencode/some-model-free": "name-on-the-leaderboard" }
}
```

`pin` forces models to the top in that order, `ban` never uses them, and `alias` fixes a missed benchmark
match. Run `rank.mts` after editing.

### Settings: `config.json`

Everything is optional. Nested maps merge with the defaults key by key.

| Key | Default | Meaning |
|---|---|---|
| `freeTier` | see table above | allowlist: provider → model globs; `"$zero"` = models priced 0 |
| `excludeProviders` | `[]` | never use these, e.g. `["openrouter"]` for sensitive code |
| `minContext` | `64000` | minimum context window |
| `weights` | agent 0.35, webdev 0.35, text 0.15, AA coding 0.25, agentic 0.25, intelligence 0.15 | score weights |
| `stealthScore` | `0.95` | score for unbenchmarked stealth models |
| `cooldownMinutes` | quota 360, rate 10, server 5, unavailable 1440 | how long a failed model sits out, unless `retry-after` says longer |
| `maxSwitchesPerTurn` | `3` | failover budget per message |
| `autoContinue` | `true` | continue the task automatically after a switch |
| `refreshHours` | `6` | re-rank when `ranking.json` is older than this |

## Failover in detail

opencode keeps one model for a whole turn, including its own retries, which can wait hours on a
`retry-after`. So when the plugin sees a quota or rate-limit retry, or an error saying the model is gone:

1. The model goes on cooldown, until `retry-after` if the provider sends one, otherwise the default above.
2. The session moves to the next-ranked model that isn't cooling down. If every model is cooling down, it
   uses the one that frees up first.
3. The turn is aborted and continued on the new model:
   - **opencode (TUI / run / serve):** a follow-up prompt, `[free-router] X hit its usage limit;
     switched to Y. Continue the task from where it stopped.`
   - **bb:** the same text, sent as a queued thread message so it's visible in the thread.

The partial output of the interrupted turn is lost. At most `maxSwitchesPerTurn` switches happen per message.

## bb

`./scripts/install.sh --bb` registers a custom ACP agent **Free (auto)** (provider `acp-free`) that
runs `opencode-free acp`. Pick `free/auto` as its model. No other bb agent is touched.

## Privacy

**Free models are usually paid for with your data.** Assume prompts and completions may be logged or
used for training:

- On OpenCode Zen, most free models are explicit exceptions to Zen's zero-retention policy. During the
  free period, data "may be used to improve the model" (Big Pickle, MiMo Flash, Ling Flash Fin). NVIDIA's free
  endpoints log usage ("do not submit personal or confidential data"). "Contributor" models such as
  Muse Spark Contributor Free train on your prompts. Some stealth models state zero retention. Check
  [Zen's privacy notes](https://opencode.ai/docs/zen/) for the current list.
- On OpenRouter, free providers may keep prompts.
- Groq, Cerebras, Google and Mistral free tiers follow each provider's own terms. So do Z.AI's free
  GLM Flash models and ModelScope's free inference.

Don't point `free/auto` at confidential or client code. To narrow the pool, `ban` specific models in
`pins.json` or list whole providers in `excludeProviders`. See [SECURITY.md](SECURITY.md).

## Troubleshooting

- `rank.mts --status` shows the ranking, warnings, active cooldowns, and which model each session uses.
- `router.log` in the install directory records picks, failovers, continues and background refreshes.
- `cache/candidates.json` holds what opencode reported for each model, which explains why a model was or
  wasn't eligible.

## Development

```sh
npm ci --ignore-scripts       # compiler and type definitions, for npm run check only
npm run check                 # type-check (TypeScript 7, strict)
npm test                      # unit tests (no network, no opencode)
npm run test:coverage         # same, plus coverage/lcov.info (Node 26+)
npm run lint:sh               # shellcheck
./scripts/e2e-failover.sh     # real opencode + a fake 429 provider: failover, continue, stickiness
```

Every push to `master` that changes shipped code (`src`, `bin`, `templates`, the install scripts,
`package.json`) is tagged and released automatically. Write entries under `## Unreleased` in
[CHANGELOG.md](CHANGELOG.md); a `[minor]` or `[major]` marker in a commit subject picks the bump,
otherwise it is a patch.

## Uninstall

```sh
./scripts/uninstall.sh [--bb] [--purge]
```

This removes the code and the wrapper (and the bb agent with `--bb`). Your config, keys and state stay
unless you pass `--purge`.

## Attribution

Model scores come from [LMArena](https://lmarena.ai) (`lmarena-ai/leaderboard-dataset`) and
[Artificial Analysis](https://artificialanalysis.ai). Not affiliated with either, or with opencode.

## License

[BSD-2-Clause](LICENSE)
