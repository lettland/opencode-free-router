// Pure helpers shared by rank.mts (node) and plugin.ts (opencode/bun). No dependencies.
import fs from "node:fs"
import path from "node:path"
import { fileURLToPath } from "node:url"

// The install directory is wherever these files live (install.sh copies them there);
// FREE_ROUTER_DIR overrides it, e.g. for an isolated test copy.
export const DIR = process.env.FREE_ROUTER_DIR || path.dirname(fileURLToPath(import.meta.url))

export interface ModelRef {
  providerID: string
  modelID: string
}

export const VIRTUAL: ModelRef = { providerID: "free", modelID: "auto" }
export const isVirtual = (m: ModelRef) => m.providerID === VIRTUAL.providerID && m.modelID === VIRTUAL.modelID

// A model as `opencode models --verbose` and opencode's provider list report it; only what the
// router reads. Older opencode versions put the tool-call flag in `tool_call`.
export interface ModelInfo {
  id: string
  providerID: string
  name?: string | undefined
  status?: string | undefined
  release_date?: string | undefined
  cost?: { input: number; output: number } | undefined
  limit?: { context: number } | undefined
  capabilities?: { toolcall: boolean } | undefined
  tool_call?: boolean | undefined
}

// ---------- JSON ----------

// Files and API responses are parsed as unknown and narrowed field by field, so a hand-edited or
// truncated file degrades to defaults instead of reaching the code in the wrong shape.
export type JsonObject = Record<string, unknown>
export const isObject = (v: unknown): v is JsonObject => typeof v === "object" && v !== null && !Array.isArray(v)
export const isArray = (v: unknown): v is unknown[] => Array.isArray(v)
export const asObject = (v: unknown): JsonObject => (isObject(v) ? v : {})
export const asArray = (v: unknown): unknown[] => (isArray(v) ? v : [])
export const optString = (v: unknown) => (typeof v === "string" ? v : undefined)
export const optNumber = (v: unknown) => (typeof v === "number" ? v : undefined)
export const optBoolean = (v: unknown) => (typeof v === "boolean" ? v : undefined)
export const stringList = (v: unknown) => asArray(v).filter((x) => typeof x === "string")

// The items of a JSON array that decode; the others are dropped.
export function list<T>(v: unknown, decode: (x: unknown) => T | undefined): T[] {
  const out: T[] = []
  for (const x of asArray(v)) {
    const d = decode(x)
    if (d !== undefined) out.push(d)
  }
  return out
}

// The entries of a JSON object whose values decode; the others are dropped.
export function entries<T>(v: unknown, decode: (x: unknown) => T | undefined): Record<string, T> {
  const out: Record<string, T> = {}
  for (const [k, x] of Object.entries(asObject(v))) {
    const d = decode(x)
    if (d !== undefined) out[k] = d
  }
  return out
}

export function decodeModel(v: unknown): ModelInfo | undefined {
  const m = asObject(v)
  const id = optString(m.id)
  const providerID = optString(m.providerID)
  if (id === undefined || providerID === undefined) return undefined
  const cost = asObject(m.cost)
  const input = optNumber(cost.input)
  const output = optNumber(cost.output)
  const context = optNumber(asObject(m.limit).context)
  const toolcall = optBoolean(asObject(m.capabilities).toolcall)
  return {
    id,
    providerID,
    name: optString(m.name),
    status: optString(m.status),
    release_date: optString(m.release_date),
    cost: input === undefined || output === undefined ? undefined : { input, output },
    limit: context === undefined ? undefined : { context },
    capabilities: toolcall === undefined ? undefined : { toolcall },
    tool_call: optBoolean(m.tool_call),
  }
}

export const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e))

// ---------- files ----------

// undefined when the file is missing or not JSON.
export function readJSON(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"))
  } catch {
    return undefined
  }
}

export function writeJSONAtomic(file: string, data: unknown) {
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 })
  fs.renameSync(tmp, file)
}

export type CooldownClass = "quota" | "rate" | "server" | "unavailable"

export interface Config {
  minContext: number
  freeTier: Record<string, string[]>
  excludeProviders: string[]
  weights: Record<string, number>
  stealthScore: number
  unscoredBase: number
  unscoredRecencyMax: number
  smallPenalty: number
  cooldownMinutes: Record<CooldownClass, number>
  maxSwitchesPerTurn: number
  autoContinue: boolean
  refreshHours: number
}

// User config overrides defaults key by key; the nested maps merge one level deep. A value of the
// wrong type keeps the default.
export function mergeConfig(user: unknown): Config {
  const u = asObject(user)
  const d = DEFAULT_CONFIG
  return {
    minContext: optNumber(u.minContext) ?? d.minContext,
    freeTier: { ...d.freeTier, ...entries(u.freeTier, (x) => (isArray(x) ? stringList(x) : undefined)) },
    excludeProviders: isArray(u.excludeProviders) ? stringList(u.excludeProviders) : d.excludeProviders,
    weights: { ...d.weights, ...entries(u.weights, optNumber) },
    stealthScore: optNumber(u.stealthScore) ?? d.stealthScore,
    unscoredBase: optNumber(u.unscoredBase) ?? d.unscoredBase,
    unscoredRecencyMax: optNumber(u.unscoredRecencyMax) ?? d.unscoredRecencyMax,
    smallPenalty: optNumber(u.smallPenalty) ?? d.smallPenalty,
    cooldownMinutes: { ...d.cooldownMinutes, ...entries(u.cooldownMinutes, optNumber) },
    maxSwitchesPerTurn: optNumber(u.maxSwitchesPerTurn) ?? d.maxSwitchesPerTurn,
    autoContinue: optBoolean(u.autoContinue) ?? d.autoContinue,
    refreshHours: optNumber(u.refreshHours) ?? d.refreshHours,
  }
}

export function loadConfig(dir = DIR) {
  return mergeConfig(readJSON(path.join(dir, "config.json")))
}

export interface Pins {
  pin: string[]
  ban: string[]
  alias: Record<string, string>
}

export function loadPins(dir = DIR): Pins {
  const p = asObject(readJSON(path.join(dir, "pins.json")))
  return { pin: stringList(p.pin), ban: stringList(p.ban), alias: entries(p.alias, optString) }
}

export const DEFAULT_CONFIG: Config = {
  minContext: 64000,
  // The only providers treated as free, with model-id globs. "$zero" = models priced 0 there.
  // A price of 0 alone is not trusted: coding/token plans, gateways and local servers report 0 too.
  freeTier: {
    // Priced 0 by the provider itself: Zen and OpenRouter ":free" slugs, NVIDIA's free
    // endpoints, Z.AI's free GLM Flash models and ModelScope's free inference.
    opencode: ["$zero"],
    openrouter: ["$zero"],
    nvidia: ["$zero"],
    zai: ["$zero"],
    zhipuai: ["$zero"],
    modelscope: ["$zero"],
    // Priced, but free on a free-plan account (models.dev lists paid prices). Only the models
    // the free tier actually covers: Mistral's Experiment plan (Devstral Small, Codestral,
    // Mistral Small), Groq and Cerebras everything, Google Flash and Gemma.
    mistral: ["$zero", "devstral-small*", "codestral*", "mistral-small*"],
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

export interface Cooldown {
  until: number
  klass?: string | undefined
  reason?: string | undefined
}

export interface SessionPick {
  model: string
  at: number
}

export interface State {
  cooldowns: Record<string, Cooldown>
  sessions: Record<string, SessionPick>
}

export function decodeState(v: unknown): State {
  const s = asObject(v)
  return {
    cooldowns: entries(s.cooldowns, (x) => {
      const c = asObject(x)
      const until = optNumber(c.until)
      return until === undefined ? undefined : { until, klass: optString(c.klass), reason: optString(c.reason) }
    }),
    sessions: entries(s.sessions, (x) => {
      const p = asObject(x)
      const model = optString(p.model)
      return model === undefined ? undefined : { model, at: optNumber(p.at) ?? 0 }
    }),
  }
}

export function mergeState(disk: State, mine: State): State {
  const out: State = { cooldowns: { ...disk.cooldowns }, sessions: { ...disk.sessions } }
  for (const [k, v] of Object.entries(mine.cooldowns)) {
    const cur = out.cooldowns[k]
    if (!cur || cur.until < v.until) out.cooldowns[k] = v
  }
  for (const [k, v] of Object.entries(mine.sessions)) {
    const cur = out.sessions[k]
    if (!cur || cur.at <= v.at) out.sessions[k] = v
  }
  const now = Date.now()
  for (const [k, v] of Object.entries(out.cooldowns)) if (v.until < now) delete out.cooldowns[k]
  for (const [k, v] of Object.entries(out.sessions)) if (v.at < now - 30 * 864e5) delete out.sessions[k]
  return out
}

// ---------- eligibility ----------

function glob(pattern: string, s: string) {
  const re = new RegExp("^" + pattern.split("*").map((p) => p.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "i")
  return re.test(s)
}

export const key = (m: ModelInfo) => `${m.providerID}/${m.id}`

export function isFree(model: ModelInfo, cfg: Config) {
  const provider = model.providerID
  if (cfg.excludeProviders.includes(provider)) return false
  const c = model.cost
  const zero = !!c && c.input === 0 && c.output === 0
  return (cfg.freeTier[provider] ?? []).some((p) => (p === "$zero" ? zero : glob(p, model.id)))
}

const NON_CHAT = /content-safety|guard|lyria|tts|whisper|embed|rerank|image|audio|music|transcri|-live\b/i

export function isEligible(model: ModelInfo, cfg: Config, pins: Pick<Pins, "ban"> = { ban: [] }) {
  const id = key(model)
  if (isVirtual({ providerID: model.providerID, modelID: model.id })) return false
  // OpenRouter's own routers (auto, free, fusion, ...) report cost 0 but pick per request, possibly paid models.
  if (model.providerID === "openrouter" && model.id.startsWith("openrouter/")) return false
  if (pins.ban.includes(id)) return false
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

export function tokens(name: string) {
  let s = name.toLowerCase()
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
export function fit(cand: string[], board: string[]) {
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

// A leaderboard entry. bestMatch caches tokens(name) in `tokens`.
export interface Row {
  name: string
  value: number | undefined
  tokens?: string[] | undefined
}

export interface RankedRow extends Row {
  pct: number | undefined
}

// names: candidate name variants. Picks fewest extra tokens, then highest value.
export function bestMatch<R extends Row>(names: string[], rows: R[]) {
  let best: { row: R; extra: number } | undefined
  for (const n of names) {
    const ct = tokens(n)
    for (const r of rows) {
      const extra = fit(ct, r.tokens ?? (r.tokens = tokens(r.name)))
      if (extra < 0) continue
      const higher = r.value !== undefined && best?.row.value !== undefined && r.value > best.row.value
      if (!best || extra < best.extra || (extra === best.extra && higher)) best = { row: r, extra }
    }
  }
  return best?.row
}

// Percentile of each row's value within its board (1 = best).
export function percentiles<R extends { value?: number | undefined }>(rows: R[]): (R & { pct: number | undefined })[] {
  const sorted = rows.map((r) => r.value).filter((v) => typeof v === "number")
  const n = sorted.length
  return rows.map((r) => {
    const value = r.value
    if (value === undefined || n < 2) return { ...r, pct: undefined }
    return { ...r, pct: sorted.filter((v) => v < value).length / (n - 1) }
  })
}

const SMALL = /\b(nano|mini|lite|small|xs|lightning|tiny)\b/i

export function looksSmall(name: string) {
  if (SMALL.test(name.replace(/[-_]/g, " "))) return true
  const m = name.toLowerCase().match(/(?:^|[^a-z0-9.])(\d+(?:\.\d+)?)b(?![a-z0-9])/g)
  if (!m) return false
  const sizes = m.map((x) => parseFloat(x.replace(/[^0-9.]/g, "")))
  return Math.max(...sizes) < 40
}

// ---------- scoring ----------

export interface SourceHit {
  as: string
  value: number | undefined
  pct: number
}

export interface Scored {
  id: string
  score: number
  reason: string
  sources: Record<string, SourceHit>
  release_date: string | null
}

// boards: {arena_agent: rows, ...} with pct; stealth: names of stealth models; now: ms
export function score(cands: ModelInfo[], boards: Record<string, RankedRow[]>, stealth: string[], cfg: Config, pins: Pins, now = Date.now()) {
  const out: Scored[] = []
  for (const m of cands) {
    const id = key(m)
    const alias = pins.alias[id]
    const names = alias ? [alias] : [m.id, m.name ?? ""].filter((n) => n !== "")
    const sources: Record<string, SourceHit> = {}
    let num = 0
    let den = 0
    for (const [src, rows] of Object.entries(boards)) {
      const w = cfg.weights[src]
      if (!w || !rows.length) continue
      const hit = bestMatch(names, rows)
      if (!hit || hit.pct === undefined) continue
      sources[src] = { as: hit.name, value: hit.value, pct: +hit.pct.toFixed(3) }
      num += w * hit.pct
      den += w
    }
    let s: number
    let reason: string
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
    if (pins.pin.includes(id)) {
      s = 2 - pins.pin.indexOf(id) * 0.01
      reason = "pinned"
    }
    out.push({ id, score: +s.toFixed(4), reason, sources, release_date: m.release_date ?? null })
  }
  return out.sort((a, b) => b.score - a.score)
}

// The model ids of a ranking.json, best first.
export const rankedIds = (ranking: unknown) => list(asObject(ranking).models, (m) => optString(asObject(m).id))

// ---------- failure classification ----------

const RE_QUOTA = /free usage exceeded|usage limit|quota|exhausted|insufficient|credits|limit reached|daily limit|per[- ]day|freeusagelimit/i
const RE_RATE = /\b429\b|rate.?limit|too many requests|rate increased too quickly/i
const RE_SERVER = /\b5\d\d\b|overloaded|unavailable|internal|server.?error|provider returned error|terminated|fetch failed|econn|etimedout|socket/i
const RE_GONE = /freetiererror|free tier can only|model.?not.?found|no such model|does not exist|unknown model|not supported|no endpoints found|decommissioned|deprecated|\b404\b/i

export type FailureClass = CooldownClass | "auth"

export interface Failover {
  action: "failover"
  klass: FailureClass
  cooldownMs: number
  // "provider": cool every model of the provider, not just this one.
  scope?: "provider"
}

export type RetryDecision = Failover | { action: "wait"; klass: "rate" | "server" | "other" }
export type ErrorDecision = Failover | { action: "ignore" }

// The retry status opencode reports while it retries a request.
export interface RetryInfo {
  message?: string | undefined
  attempt?: number | undefined
  next?: number | undefined
}

// A session.error payload: one of opencode's error types, or anything shaped like one.
export interface ErrorInfo {
  name?: string | undefined
  data?: JsonObject | undefined
}

// Retry status from session.status: decide whether to abandon this model now.
export function classifyRetry({ message = "", attempt = 1, next = 0 }: RetryInfo, cfg: Config, now = Date.now()): RetryDecision {
  const wait = Math.max(0, next - now)
  const min = (k: CooldownClass) => cfg.cooldownMinutes[k] * 60e3
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
export function classifyError(error: ErrorInfo | undefined, cfg: Config): ErrorDecision {
  if (!error) return { action: "ignore" }
  const name = error.name ?? ""
  if (/MessageAbortedError|ContextOverflow|MessageOutputLength/i.test(name)) return { action: "ignore" }
  const d = error.data ?? {}
  const text = `${name} ${optString(d.message) ?? ""} ${optString(d.responseBody) ?? ""}`
  const status = optNumber(d.statusCode)
  const min = (k: CooldownClass) => cfg.cooldownMinutes[k] * 60e3
  if (/ProviderAuthError/i.test(name) || status === 401 || status === 403)
    return { action: "failover", klass: "auth", scope: "provider", cooldownMs: min("unavailable") }
  if (status === 404 || RE_GONE.test(text)) return { action: "failover", klass: "unavailable", cooldownMs: min("unavailable") }
  // 402: a free-plan account asking for a model it cannot pay for. Model-scoped, like a removal.
  if (status === 402 || /payment required/i.test(text)) return { action: "failover", klass: "unavailable", cooldownMs: min("unavailable") }
  if (RE_QUOTA.test(text)) return { action: "failover", klass: "quota", cooldownMs: min("quota") }
  if (status === 429 || RE_RATE.test(text)) return { action: "failover", klass: "rate", cooldownMs: min("rate") }
  if ((status !== undefined && status >= 500 && status < 600) || RE_SERVER.test(text))
    return { action: "failover", klass: "server", cooldownMs: min("server") }
  return { action: "ignore" }
}

export function coolingUntil(state: Pick<State, "cooldowns">, id: string, now = Date.now()) {
  const provider = id.split("/")[0]
  const a = state.cooldowns[id]?.until ?? 0
  const b = state.cooldowns[`${provider}/*`]?.until ?? 0
  const u = Math.max(a, b)
  return u > now ? u : 0
}

// Ordered candidate ids: ranking order first, then live free models the ranking has not seen (newest first).
export function orderCandidates(ranked: readonly string[], live: ModelInfo[], cfg: Config, pins: Pins) {
  const liveEligible = new Map<string, ModelInfo>()
  for (const m of live) if (isEligible(m, cfg, pins)) liveEligible.set(key(m), m)
  const ordered = ranked.filter((id) => liveEligible.has(id))
  const rest = [...liveEligible.values()]
    .filter((m) => !ordered.includes(key(m)))
    .sort((a, b) => (b.release_date ?? "").localeCompare(a.release_date ?? ""))
    .map(key)
  return [...ordered, ...rest]
}

// Pick: first candidate not cooling; if all cooling, the one whose cooldown ends first.
export function pick(ordered: string[], state: Pick<State, "cooldowns">, exclude: string[] = [], now = Date.now()) {
  const pool = ordered.filter((id) => !exclude.includes(id))
  const free = pool.find((id) => !coolingUntil(state, id, now))
  if (free) return { id: free, allCooling: false }
  if (!pool.length) return undefined
  const soonest = pool.reduce((a, b) => (coolingUntil(state, b, now) < coolingUntil(state, a, now) ? b : a))
  return { id: soonest, allCooling: true }
}

export const split = (id: string): ModelRef => {
  const i = id.indexOf("/")
  return { providerID: id.slice(0, i), modelID: id.slice(i + 1) }
}
