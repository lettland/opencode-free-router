import { test } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { tokens, fit, bestMatch, percentiles, score, isFree, isEligible, looksSmall, classifyRetry, classifyError, pick, orderCandidates, mergeState, mergeConfig, readJSON, writeJSONAtomic, loadConfig, loadPins, coolingUntil, split, DEFAULT_CONFIG as cfg } from "../src/lib.mjs"

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
  assert.ok(isFree(model("mistral", "labs-devstral-small-2512"), cfg), "Mistral's 0-priced model")
  assert.ok(isFree(model("mistral", "mistral-small-2603", { cost: { input: 0.15, output: 0.6 } }), cfg), "Experiment plan family")
  assert.ok(!isFree(model("mistral", "mistral-large-2512", { cost: { input: 0.5, output: 1.5 } }), cfg), "paid Mistral family")
  assert.ok(!isFree(model("mistral", "devstral-medium-latest", { cost: { input: 0.4, output: 2 } }), cfg), "paid Mistral family")
  assert.ok(isFree(model("zai", "glm-4.7-flash"), cfg), "Z.AI flash models are priced 0")
  assert.ok(!isFree(model("zai", "glm-4.7-flashx", { cost: { input: 0.07, output: 0.4 } }), cfg), "the paid FlashX twin")
  assert.ok(!isFree(model("zai", "glm-5.3", { cost: { input: 1.4, output: 4.4 } }), cfg), "paid Z.AI flagship")
  assert.ok(isFree(model("zhipuai", "glm-4.5-flash"), cfg), "same free models on the China endpoint")
  assert.ok(isFree(model("modelscope", "Qwen/Qwen3-235B-A22B-Thinking-2507"), cfg), "ModelScope serves everything free")
  assert.ok(!isFree(model("vercel", "meta/llama-3.3-70b"), cfg), "Vercel's catalog 0 is not free")
  assert.ok(!isFree(model("kilo", "z-ai/glm-5.2:free"), cfg), "gateway clone is not on the allowlist")
  assert.ok(!isEligible(model("free", "auto"), cfg, pins), "virtual model")
  assert.ok(!isEligible(model("opencode", "y-free", { capabilities: { toolcall: false } }), cfg, pins))
  assert.ok(!isEligible(model("opencode", "y-free", { limit: { context: 32000 } }), cfg, pins))
  assert.ok(!isEligible(model("openrouter", "nvidia/nemotron-3.5-content-safety:free"), cfg, pins))
  assert.ok(!isEligible(model("opencode", "y-free"), cfg, { ...pins, ban: ["opencode/y-free"] }))
  assert.ok(!isEligible(model("openrouter", "openrouter/auto"), cfg, pins), "OpenRouter routers can bill paid models")
  assert.ok(!isEligible(model("google", "gemini-3.1-flash-live-preview"), cfg, pins), "realtime audio model")
  assert.ok(isEligible(model("openrouter", "stealth/space-bunny-alpha"), cfg, pins))
  assert.ok(isEligible(model("zai", "glm-4.7-flash"), cfg, pins), "free GLM Flash model is usable")
  assert.ok(!isEligible(model("zai", "glm-4.5-flash", { limit: { context: 32000 } }), cfg, pins), "under minContext")
  assert.ok(!isEligible(model("mistral", "labs-devstral-small-2512", { status: "deprecated" }), cfg, pins), "deprecated")
})

test("example config agrees with the shipped defaults", () => {
  const example = JSON.parse(fs.readFileSync(new URL("../templates/config.example.json", import.meta.url), "utf8"))
  assert.deepEqual(example.freeTier, cfg.freeTier, "config.example.json freeTier drifted from DEFAULT_CONFIG")
  assert.equal(example.minContext, cfg.minContext)
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
  assert.equal(classifyRetry({ message: "Provider is overloaded", attempt: 2, next: now + 3600e3 }, cfg, now).cooldownMs, 3600e3, "honours retry-after")
  assert.deepEqual(classifyRetry({ message: "something odd", attempt: 2 }, cfg, now), { action: "wait", klass: "other" })
  assert.deepEqual(classifyRetry({ message: "something odd", attempt: 3 }, cfg, now), { action: "failover", klass: "server", cooldownMs: 5 * 60e3 }, "unknown errors give up eventually")
  assert.equal(classifyRetry({}, cfg, now).klass, "other")
})

test("error classification", () => {
  assert.equal(classifyError({ name: "MessageAbortedError" }, cfg).action, "ignore")
  assert.equal(classifyError({ name: "UnknownError", data: { message: "FreeTierError: OpenCode's free tier can only be used from within OpenCode" } }, cfg).klass, "unavailable")
  assert.equal(classifyError({ name: "APIError", data: { message: "Not Found", statusCode: 404 } }, cfg).klass, "unavailable")
  assert.equal(classifyError({ name: "APIError", data: { message: "Payment required", statusCode: 402 } }, cfg).klass, "unavailable", "free plan asked for a paid model")
  assert.equal(classifyError({ name: "APIError", data: { message: "Unauthorized", statusCode: 401 } }, cfg).scope, "provider")
  assert.equal(classifyError({ name: "APIError", data: { message: "rate limit", statusCode: 429 } }, cfg).klass, "rate")
  assert.equal(classifyError({ name: "UnknownError", data: { message: "tool call failed: file not readable" } }, cfg).action, "ignore")
  assert.equal(classifyError(undefined, cfg).action, "ignore")
  assert.equal(classifyError({ name: "ProviderAuthError" }, cfg).scope, "provider")
  assert.equal(classifyError({ data: { message: "daily limit reached" } }, cfg).klass, "quota")
  assert.equal(classifyError({ name: "APIError", data: { statusCode: 503 } }, cfg).klass, "server")
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

test("cooldowns and ids", () => {
  const state = { cooldowns: { "a/1": { until: 200 }, "b/*": { until: 300 } } }
  assert.equal(coolingUntil(state, "a/1", 100), 200)
  assert.equal(coolingUntil(state, "b/2", 100), 300, "provider-wide cooldown")
  assert.equal(coolingUntil(state, "a/1", 250), 0)
  assert.equal(coolingUntil({}, "c/3", 0), 0)
  assert.deepEqual(split("openrouter/qwen/qwen3:free"), { providerID: "openrouter", modelID: "qwen/qwen3:free" })
})

test("config and pins files", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "free-router-lib-"))
  try {
    assert.deepEqual(loadConfig(dir), cfg, "no config.json means defaults")
    assert.deepEqual(loadPins(dir), { pin: [], ban: [], alias: {} })
    assert.equal(readJSON(path.join(dir, "missing.json"), "fallback"), "fallback")
    fs.writeFileSync(path.join(dir, "config.json"), "{ not json")
    assert.equal(loadConfig(dir).minContext, cfg.minContext, "broken config.json means defaults")
    writeJSONAtomic(path.join(dir, "config.json"), { minContext: 1, cooldownMinutes: { rate: 2 } })
    assert.equal(loadConfig(dir).minContext, 1)
    assert.equal(loadConfig(dir).cooldownMinutes.quota, 360)
    writeJSONAtomic(path.join(dir, "pins.json"), { ban: ["x/y"] })
    assert.deepEqual(loadPins(dir), { pin: [], ban: ["x/y"], alias: {} })
    assert.equal(fs.statSync(path.join(dir, "pins.json")).mode & 0o777, 0o600, "state files are private")
    assert.deepEqual(fs.readdirSync(dir).sort(), ["config.json", "pins.json"], "no temp files left behind")
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
