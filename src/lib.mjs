// Pure helpers shared by rank.mjs (node) and plugin.js (opencode/bun). No dependencies.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// The install directory is wherever these files live (install.sh copies them there);
// FREE_ROUTER_DIR overrides it, e.g. for an isolated test copy.
export const DIR = process.env.FREE_ROUTER_DIR || path.dirname(fileURLToPath(import.meta.url))
export const VIRTUAL = { providerID: "free", modelID: "auto" }
export const isVirtual = (m) => m?.providerID === VIRTUAL.providerID && m?.modelID === VIRTUAL.modelID

// ---------- files ----------

export function readJSON(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return fallback
  }
}

export function writeJSONAtomic(file, data) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 })
  fs.renameSync(tmp, file)
}

const NESTED = ["freeTier", "weights", "cooldownMinutes"]

// User config overrides defaults key by key; the nested maps merge one level deep.
export function mergeConfig(user = {}) {
  const out = { ...DEFAULT_CONFIG, ...user }
  for (const k of NESTED) out[k] = { ...DEFAULT_CONFIG[k], ...(user[k] ?? {}) }
  return out
}

export function loadConfig(dir = DIR) {
  return mergeConfig(readJSON(path.join(dir, "config.json"), {}))
}

export function loadPins(dir = DIR) {
  return { pin: [], ban: [], alias: {}, ...readJSON(path.join(dir, "pins.json"), {}) }
}

export const DEFAULT_CONFIG = {
  minContext: 64000,
  // The only providers treated as free, with model-id globs. "$zero" = models priced 0 there.
  // A price of 0 alone is not trusted: coding/token plans, gateways and local servers report 0 too.
  // Groq, Cerebras and Google are free through their free tiers (models.dev lists paid prices).
  freeTier: {
    opencode: ["$zero"],
    openrouter: ["$zero"],
    nvidia: ["$zero"],
    groq: ["*"],
    cerebras: ["*"],
    google: ["*flash*", "*gemma*"],
  },
  excludeProviders: [],
  weights: { arena_agent: 0.35, arena_webdev: 0.35, arena_text: 0.15, aa_coding: 0.25, aa_agentic: 0.25, aa_intelligence: 0.15 },
  stealthScore: 0.95,
  unscoredBase: 0.25,
  unscoredRecencyMax: 0.1,
  smallPenalty: 0.15,
  cooldownMinutes: { quota: 360, rate: 10, server: 5, unavailable: 1440 },
  maxSwitchesPerTurn: 3,
  autoContinue: true,
  refreshHours: 6,
}

// ---------- merge-on-write state ----------

export function mergeState(disk, mine) {
  const out = { cooldowns: { ...(disk?.cooldowns ?? {}) }, sessions: { ...(disk?.sessions ?? {}) } }
  for (const [k, v] of Object.entries(mine?.cooldowns ?? {})) {
    if (!out.cooldowns[k] || out.cooldowns[k].until < v.until) out.cooldowns[k] = v
  }
  for (const [k, v] of Object.entries(mine?.sessions ?? {})) {
    if (!out.sessions[k] || (out.sessions[k].at ?? 0) <= (v.at ?? 0)) out.sessions[k] = v
  }
  const now = Date.now()
  for (const [k, v] of Object.entries(out.cooldowns)) if (v.until < now) delete out.cooldowns[k]
  for (const [k, v] of Object.entries(out.sessions)) if ((v.at ?? 0) < now - 30 * 864e5) delete out.sessions[k]
  return out
}

// ---------- eligibility ----------

function glob(pattern, s) {
  const re = new RegExp("^" + pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i")
  return re.test(s)
}

export const key = (m) => `${m.providerID}/${m.id ?? m.modelID}`

export function isFree(model, cfg) {
  const provider = model.providerID
  if ((cfg.excludeProviders ?? []).includes(provider)) return false
  const c = model.cost
  const zero = !!c && c.input === 0 && c.output === 0
  return (cfg.freeTier?.[provider] ?? []).some((p) => (p === "$zero" ? zero : glob(p, model.id)))
}

const NON_CHAT = /content-safety|guard|lyria|tts|whisper|embed|rerank|image|audio|music|transcri|-live\b/i

export function isEligible(model, cfg, pins = { ban: [] }) {
  const id = key(model)
  if (isVirtual({ providerID: model.providerID, modelID: model.id })) return false
  // OpenRouter's own routers (auto, free, fusion, ...) report cost 0 but pick per request, possibly paid models.
  if (model.providerID === "openrouter" && model.id.startsWith("openrouter/")) return false
  if (pins.ban?.includes(id)) return false
  if (NON_CHAT.test(model.id)) return false
  if (model.status === "deprecated") return false
  if (!(model.capabilities?.toolcall ?? model.tool_call)) return false
  if ((model.limit?.context ?? 0) < cfg.minContext) return false
  return isFree(model, cfg)
}

// ---------- name matching ----------

const EFFORT = new Set(["max", "high", "medium", "low", "xhigh", "minimal", "thinking", "instant", "reasoning", "preview", "free", "exp", "latest", "nvfp4", "fp8", "fp4", "bf16", "it", "instruct", "chat", "harness", "codex"])
// Tokens that denote a different model variant: present on one side only means no match.
const QUALIFIERS = new Set(["small", "mini", "nano", "lite", "flash", "pro", "ultra", "super", "plus", "turbo", "air", "omni", "next", "code", "coder", "vl", "fin", "sante", "contributor", "lightning", "note", "xs", "s"])
const SIZE = /^\d+(\.\d+)?[bm]$/

export function tokens(name) {
  let s = String(name).toLowerCase()
  s = s.replace(/:free$/, "")
  if (s.includes("/")) s = s.slice(s.lastIndexOf("/") + 1)
  s = s.replace(/\(([^)]*)\)/g, " $1 ")
  s = s.replace(/(\d)-(\d{1,2})(?![\d.a-z])/g, "$1.$2") // AA slugs: muse-spark-1-3 -> 1.3 (not gemma-4-26b)
  s = s.replace(/([a-z]{2,})(\d)/g, "$1 $2") // qwen3.8 -> qwen 3.8, but keep a55b / k2 style
  s = s.replace(/\bv(\d)/g, "$1")
  return s
    .split(/[\s_\-/]+/)
    .filter(Boolean)
    .map((t) => t.replace(/^(\d+)\.0$/, "$1"))
    .filter((t) => !EFFORT.has(t) && !/^\d{4}$|^\d{8}$/.test(t))
}

// Returns extra-token count when `cand` tokens fit inside `board` tokens, else -1.
export function fit(cand, board) {
  if (cand.length === 0) return -1
  const b = new Set(board)
  const c = new Set(cand)
  for (const t of c) if (!b.has(t)) return -1
  for (const t of b) if (!c.has(t) && QUALIFIERS.has(t)) return -1
  const cs = cand.filter((t) => SIZE.test(t))
  const bs = board.filter((t) => SIZE.test(t))
  if (cs.length && bs.length && !cs.some((t) => bs.includes(t))) return -1
  return [...b].filter((t) => !c.has(t)).length
}

// rows: [{name, value}] ; names: candidate name variants. Picks fewest extra tokens, then highest value.
export function bestMatch(names, rows) {
  let best
  for (const n of names) {
    const ct = tokens(n)
    for (const r of rows) {
      const extra = fit(ct, r.tokens ?? (r.tokens = tokens(r.name)))
      if (extra < 0) continue
      if (!best || extra < best.extra || (extra === best.extra && r.value > best.row.value)) best = { row: r, extra }
    }
  }
  return best?.row
}

// Percentile of each row's value within its board (1 = best).
export function percentiles(rows) {
  const vals = rows.map((r) => r.value).filter((v) => typeof v === "number")
  const sorted = [...vals].sort((a, b) => a - b)
  const n = sorted.length
  return rows.map((r) => {
    if (typeof r.value !== "number" || n < 2) return { ...r, pct: undefined }
    let lo = 0
    while (lo < n && sorted[lo] < r.value) lo++
    return { ...r, pct: lo / (n - 1) }
  })
}

const SMALL = /\b(nano|mini|lite|small|xs|lightning|tiny)\b/i

export function looksSmall(name) {
  if (SMALL.test(String(name).replace(/[-_]/g, " "))) return true
  const m = String(name).toLowerCase().match(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z0-9])/g)
  if (!m) return false
  const sizes = m.map((x) => parseFloat(x.replace(/[^0-9.]/g, "")))
  return Math.max(...sizes) < 40
}

// ---------- scoring ----------

// cands: opencode models; boards: {arena_agent: rows, ...} with pct; stealth: [names]; now: ms
export function score(cands, boards, stealth, cfg, pins, now = Date.now()) {
  const out = []
  for (const m of cands) {
    const id = key(m)
    const alias = pins.alias?.[id]
    const names = alias ? [alias] : [m.id, m.name].filter(Boolean)
    const sources = {}
    let num = 0
    let den = 0
    for (const [src, rows] of Object.entries(boards)) {
      const w = cfg.weights[src]
      if (!w || !rows?.length) continue
      const hit = bestMatch(names, rows)
      if (!hit || hit.pct === undefined) continue
      sources[src] = { as: hit.name, value: hit.value, pct: +hit.pct.toFixed(3) }
      num += w * hit.pct
      den += w
    }
    let s
    let reason
    const own = [tokens(m.id), tokens(m.name ?? "")].filter((t) => t.length)
    const isStealth = !den && stealth.some((n) => own.some((t) => fit(t, tokens(n)) >= 0))
    if (den) {
      s = num / den
      reason = `benchmarks (${Object.keys(sources).join(", ")})`
    } else if (isStealth) {
      s = cfg.stealthScore
      reason = "stealth model (no benchmarks yet)"
    } else {
      const released = Date.parse(m.release_date ?? "") || 0
      const ageDays = released ? (now - released) / 864e5 : 365
      s = cfg.unscoredBase + cfg.unscoredRecencyMax * Math.max(0, 1 - ageDays / 90)
      reason = "unscored"
      if (looksSmall(`${m.id} ${m.name ?? ""}`)) {
        s -= cfg.smallPenalty
        reason += ", small-model penalty"
      }
    }
    if (pins.pin?.includes(id)) {
      s = 2 - pins.pin.indexOf(id) * 0.01
      reason = "pinned"
    }
    out.push({ id, score: +s.toFixed(4), reason, sources, release_date: m.release_date ?? null })
  }
  return out.sort((a, b) => b.score - a.score)
}

// ---------- failure classification ----------

const RE_QUOTA = /free usage exceeded|usage limit|quota|exhausted|insufficient|credits|limit reached|daily limit|per[- ]day|freeusagelimit/i
const RE_RATE = /\b429\b|rate.?limit|too many requests|rate increased too quickly/i
const RE_SERVER = /\b5\d\d\b|overloaded|unavailable|internal|server.?error|provider returned error|terminated|fetch failed|econn|etimedout|socket/i
const RE_GONE = /freetiererror|free tier can only|model.?not.?found|no such model|does not exist|unknown model|not supported|no endpoints found|decommissioned|deprecated|\b404\b/i

// Retry status from session.status: decide whether to abandon this model now.
export function classifyRetry({ message = "", attempt = 1, next = 0 }, cfg, now = Date.now()) {
  const wait = Math.max(0, next - now)
  const min = (k) => cfg.cooldownMinutes[k] * 60e3
  if (RE_QUOTA.test(message)) return { action: "failover", klass: "quota", cooldownMs: Math.max(wait, min("quota")) }
  if (RE_RATE.test(message)) {
    if (wait > 60e3 || attempt >= 2) return { action: "failover", klass: "rate", cooldownMs: Math.max(wait, min("rate")) }
    return { action: "wait", klass: "rate" }
  }
  if (RE_SERVER.test(message)) {
    if (attempt >= 2) return { action: "failover", klass: "server", cooldownMs: Math.max(wait, min("server")) }
    return { action: "wait", klass: "server" }
  }
  if (attempt >= 3) return { action: "failover", klass: "server", cooldownMs: min("server") }
  return { action: "wait", klass: "other" }
}

// Terminal session.error: decide whether it is the model's fault (switch) or not (leave alone).
export function classifyError(error, cfg) {
  if (!error) return { action: "ignore" }
  const name = error.name ?? ""
  if (/MessageAbortedError|ContextOverflow|MessageOutputLength/i.test(name)) return { action: "ignore" }
  const d = error.data ?? {}
  const text = `${name} ${d.message ?? ""} ${d.responseBody ?? ""}`
  const status = d.statusCode
  const min = (k) => cfg.cooldownMinutes[k] * 60e3
  if (/ProviderAuthError/i.test(name) || status === 401 || status === 403)
    return { action: "failover", klass: "auth", scope: "provider", cooldownMs: min("unavailable") }
  if (status === 404 || RE_GONE.test(text)) return { action: "failover", klass: "unavailable", cooldownMs: min("unavailable") }
  if (RE_QUOTA.test(text)) return { action: "failover", klass: "quota", cooldownMs: min("quota") }
  if (status === 429 || RE_RATE.test(text)) return { action: "failover", klass: "rate", cooldownMs: min("rate") }
  if ((status >= 500 && status < 600) || RE_SERVER.test(text)) return { action: "failover", klass: "server", cooldownMs: min("server") }
  return { action: "ignore" }
}

export function coolingUntil(state, id, now = Date.now()) {
  const provider = id.split("/")[0]
  const a = state.cooldowns?.[id]?.until ?? 0
  const b = state.cooldowns?.[`${provider}/*`]?.until ?? 0
  const u = Math.max(a, b)
  return u > now ? u : 0
}

// Ordered candidate ids: ranking order first, then live free models the ranking has not seen (newest first).
export function orderCandidates(ranking, live, cfg, pins) {
  const liveEligible = new Map()
  for (const m of live) if (isEligible(m, cfg, pins)) liveEligible.set(key(m), m)
  const ordered = []
  for (const r of ranking?.models ?? []) if (liveEligible.has(r.id)) ordered.push(r.id)
  const rest = [...liveEligible.values()]
    .filter((m) => !ordered.includes(key(m)))
    .sort((a, b) => String(b.release_date ?? "").localeCompare(String(a.release_date ?? "")))
    .map(key)
  return [...ordered, ...rest]
}

// Pick: first candidate not cooling; if all cooling, the one whose cooldown ends first.
export function pick(ordered, state, exclude = [], now = Date.now()) {
  const pool = ordered.filter((id) => !exclude.includes(id))
  const free = pool.find((id) => !coolingUntil(state, id, now))
  if (free) return { id: free, allCooling: false }
  if (!pool.length) return undefined
  const soonest = [...pool].sort((a, b) => coolingUntil(state, a, now) - coolingUntil(state, b, now))[0]
  return { id: soonest, allCooling: true }
}

export const split = (id) => {
  const i = id.indexOf("/")
  return { providerID: id.slice(0, i), modelID: id.slice(i + 1) }
}
