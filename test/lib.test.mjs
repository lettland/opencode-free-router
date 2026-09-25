import { test } from "node:test"
import assert from "node:assert/strict"
import { tokens, fit, bestMatch, percentiles, score, isFree, isEligible, looksSmall, classifyRetry, classifyError, pick, orderCandidates, mergeState, mergeConfig, DEFAULT_CONFIG as cfg } from "../src/lib.mjs"

test("config merge keeps nested defaults", () => {
  const c = mergeConfig({ freeTier: { groq: [] }, weights: { arena_agent: 1 }, minContext: 1000 })
  assert.deepEqual(c.freeTier.groq, [])
  assert.deepEqual(c.freeTier.cerebras, ["*"], "untouched provider keeps its default")
  assert.equal(c.weights.arena_agent, 1)
  assert.equal(c.weights.arena_webdev, 0.35)
  assert.equal(c.minContext, 1000)
  assert.equal(c.cooldownMinutes.quota, 360)
})

const pins = { pin: [], ban: [], alias: {} }
const model = (providerID, id, extra = {}) => ({
  providerID,
  id,
  name: id,
  status: "active",
  cost: { input: 0, output: 0 },
  limit: { context: 200000 },
  capabilities: { toolcall: true },
  ...extra,
})

test("name matching", () => {
  const rows = [
    { name: "nvidia-nemotron-3-ultra-550b-a55b-nvfp4", value: 1400 },
    { name: "mimo-v2.6-pro", value: 1500 },
    { name: "muse-spark-1.3-max", value: 1600 },
    { name: "Kimi K3 (Max)", value: 1 },
    { name: "qwen3.8-27b", value: 1300 },
  ]
  assert.equal(bestMatch(["nemotron-3-ultra-free"], rows)?.name, "nvidia-nemotron-3-ultra-550b-a55b-nvfp4")
  assert.equal(bestMatch(["nvidia/nemotron-3-ultra-550b-a55b:free"], rows)?.name, "nvidia-nemotron-3-ultra-550b-a55b-nvfp4")
  assert.equal(bestMatch(["mimo-v2.6-flash-free"], rows), undefined, "flash must not match pro")
  assert.equal(bestMatch(["muse-spark-1.3-contributor-free"], rows), undefined, "unknown variant qualifier")
  assert.equal(bestMatch(["qwen/qwen3.8-27b:free"], rows)?.name, "qwen3.8-27b")
  assert.equal(bestMatch(["Qwen 3.8 27B"], rows)?.name, "qwen3.8-27b")
  assert.ok(fit(tokens("space-bunny-free"), tokens("Space Bunny Alpha")) >= 0)
  assert.deepEqual(tokens("ling-3.0-flash-fin-free"), ["ling", "3", "flash", "fin"])
  assert.deepEqual(tokens("ling-3-0-flash-fin"), ["ling", "3", "flash", "fin"], "AA dash versions")
  assert.deepEqual(tokens("muse-spark-1-3-xhigh"), ["muse", "spark", "1.3"])
  assert.deepEqual(tokens("gemma-4-26b-a4b-it"), ["gemma", "4", "26b", "a4b"])
})

test("percentiles", () => {
  const p = percentiles([{ value: 10 }, { value: 30 }, { value: 20 }])
  assert.deepEqual(p.map((r) => r.pct), [0, 1, 0.5])
})

test("small-model detection", () => {
  assert.ok(looksSmall("liquid/lfm-2.5-2.6b:free"))
  assert.ok(looksSmall("nemotron-3.5-lightning-free"))
  assert.ok(!looksSmall("nvidia/nemotron-3-ultra-550b-a55b:free"))
  assert.ok(!looksSmall("space-bunny-free"))
})

test("scoring: stealth near top, tiny unscored below scored, pins win", () => {
  const boards = { arena_webdev: percentiles([{ name: "nvidia-nemotron-3-ultra-550b", value: 1500 }, { name: "big-model", value: 1700 }, { name: "weak", value: 1000 }]) }
  const cands = [model("opencode", "nemotron-3-ultra-free"), model("opencode", "space-bunny-free", { name: "Space Bunny Free" }), model("openrouter", "liquid/lfm-2.5-2.6b:free", { release_date: new Date().toISOString().slice(0, 10) })]
  const r = score(cands, boards, ["Space Bunny Alpha"], cfg, pins)
  assert.equal(r[0].id, "opencode/space-bunny-free")
  assert.equal(r[1].id, "opencode/nemotron-3-ultra-free")
  assert.equal(r.at(-1).id, "openrouter/liquid/lfm-2.5-2.6b:free")
  const pinned = score(cands, boards, ["Space Bunny Alpha"], cfg, { ...pins, pin: ["opencode/nemotron-3-ultra-free"] })
  assert.equal(pinned[0].id, "opencode/nemotron-3-ultra-free")
})

test("free filter", () => {
  assert.ok(isFree(model("opencode", "x-free"), cfg))
  assert.ok(!isFree(model("openai", "gpt-x", { cost: { input: 1, output: 2 } }), cfg))
  assert.ok(isFree(model("groq", "llama-x", { cost: { input: 0.5, output: 1 } }), cfg), "freeTier provider")
  assert.ok(!isFree(model("google", "gemini-3.1-pro", { cost: { input: 1, output: 2 } }), cfg), "google pro not free tier")
  assert.ok(isFree(model("google", "gemini-3.8-flash", { cost: { input: 1, output: 2 } }), cfg))
  assert.ok(!isFree(model("openrouter", "a:free"), { ...cfg, excludeProviders: ["openrouter"] }))
  assert.ok(!isFree(model("zai-coding-plan", "glm-5.2"), cfg), "subscription plans report price 0 but are not free")
  assert.ok(!isFree(model("lmstudio", "local-model"), cfg), "unlisted provider with price 0")
  assert.ok(!isFree(model("opencode", "claude-x", { cost: { input: 3, output: 15 } }), cfg), "paid Zen model")
  assert.ok(isFree(model("nvidia", "nemotron-x"), cfg))
  assert.ok(!isEligible(model("free", "auto"), cfg, pins), "virtual model")
  assert.ok(!isEligible(model("opencode", "y-free", { capabilities: { toolcall: false } }), cfg, pins))
  assert.ok(!isEligible(model("opencode", "y-free", { limit: { context: 32000 } }), cfg, pins))
  assert.ok(!isEligible(model("openrouter", "nvidia/nemotron-3.5-content-safety:free"), cfg, pins))
  assert.ok(!isEligible(model("opencode", "y-free"), cfg, { ...pins, ban: ["opencode/y-free"] }))
  assert.ok(!isEligible(model("openrouter", "openrouter/auto"), cfg, pins), "OpenRouter routers can bill paid models")
  assert.ok(!isEligible(model("google", "gemini-3.1-flash-live-preview"), cfg, pins), "realtime audio model")
  assert.ok(isEligible(model("openrouter", "stealth/space-bunny-alpha"), cfg, pins))
})

test("retry classification", () => {
  const now = 1_000_000
  assert.equal(classifyRetry({ message: "Free usage exceeded, subscribe to Go", attempt: 1, next: now + 5000 }, cfg, now).klass, "quota")
  assert.equal(classifyRetry({ message: "Free usage exceeded, subscribe to Go", attempt: 1 }, cfg, now).action, "failover")
  assert.equal(classifyRetry({ message: "Too Many Requests", attempt: 1, next: now + 5000 }, cfg, now).action, "wait")
  const r = classifyRetry({ message: "Too Many Requests", attempt: 1, next: now + 3 * 3600e3 }, cfg, now)
  assert.equal(r.action, "failover")
  assert.equal(r.cooldownMs, 3 * 3600e3, "honours retry-after")
  assert.equal(classifyRetry({ message: "Provider is overloaded", attempt: 1 }, cfg, now).action, "wait")
  assert.equal(classifyRetry({ message: "Provider is overloaded", attempt: 2 }, cfg, now).action, "failover")
})

test("error classification", () => {
  assert.equal(classifyError({ name: "MessageAbortedError" }, cfg).action, "ignore")
  assert.equal(classifyError({ name: "UnknownError", data: { message: "FreeTierError: OpenCode's free tier can only be used from within OpenCode" } }, cfg).klass, "unavailable")
  assert.equal(classifyError({ name: "APIError", data: { message: "Not Found", statusCode: 404 } }, cfg).klass, "unavailable")
  assert.equal(classifyError({ name: "APIError", data: { message: "Unauthorized", statusCode: 401 } }, cfg).scope, "provider")
  assert.equal(classifyError({ name: "APIError", data: { message: "rate limit", statusCode: 429 } }, cfg).klass, "rate")
  assert.equal(classifyError({ name: "UnknownError", data: { message: "tool call failed: file not readable" } }, cfg).action, "ignore")
})

test("pick and order", () => {
  const now = 5_000
  const state = { cooldowns: { "a/1": { until: now + 100 }, "b/*": { until: now + 50 } } }
  assert.deepEqual(pick(["a/1", "b/2", "c/3"], state, [], now), { id: "c/3", allCooling: false })
  assert.deepEqual(pick(["a/1", "b/2"], state, [], now), { id: "b/2", allCooling: true }, "soonest cooldown")
  assert.deepEqual(pick(["a/1", "c/3"], state, ["c/3"], now), { id: "a/1", allCooling: true })
  const live = [model("opencode", "new-free", { release_date: "2026-09-24" }), model("opencode", "old-free", { release_date: "2026-01-01" }), model("openai", "paid", { cost: { input: 1, output: 1 } })]
  const ranking = { models: [{ id: "opencode/old-free" }, { id: "openai/paid" }, { id: "opencode/gone-free" }] }
  assert.deepEqual(orderCandidates(ranking, live, cfg, pins), ["opencode/old-free", "opencode/new-free"], "stale ranking cannot route to paid or vanished models")
})

test("state merge keeps later cooldowns and prunes", () => {
  const now = Date.now()
  const merged = mergeState(
    { cooldowns: { x: { until: now + 10 }, old: { until: now - 1 } }, sessions: { s: { model: "a", at: now - 40 * 864e5 } } },
    { cooldowns: { x: { until: now + 20 } }, sessions: { t: { model: "b", at: now } } },
  )
  assert.equal(merged.cooldowns.x.until, now + 20)
  assert.ok(!merged.cooldowns.old)
  assert.ok(!merged.sessions.s)
  assert.equal(merged.sessions.t.model, "b")
})
