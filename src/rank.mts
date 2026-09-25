#!/usr/bin/env node
// Ranks the free models opencode can reach right now and writes ranking.json for plugin.ts.
//   node rank.mts            refresh ranking.json
//   node rank.mts --status   print ranking, cooldowns and per-session picks (no refresh)
//   node rank.mts --quiet    refresh, printing only warnings (scheduled / plugin-triggered runs)
//   --config <free.jsonc>    opencode config to list models with (default: free.jsonc next to this file)
//   --lock <file>            remove this lock file when done (set by the plugin's self-refresh)
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import {
  DIR,
  readJSON,
  writeJSONAtomic,
  loadConfig,
  loadPins,
  isEligible,
  percentiles,
  score,
  coolingUntil,
  decodeModel,
  decodeState,
  asObject,
  list,
  entries,
  optString,
  optNumber,
  stringList,
  errorText,
} from "./lib.mts"
import type { ModelInfo, RankedRow, Row, Scored, SourceHit } from "./lib.mts"

const arg = (name: string) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const CONFIG_FILE = path.resolve(arg("--config") ?? path.join(DIR, "free.jsonc"))
const CACHE = path.join(DIR, "cache")
const HF = "https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&split=latest"
const ARENA: Record<string, [config: string, field: string]> = { arena_agent: ["agent", "score"], arena_webdev: ["webdev", "rating"], arena_text: ["text", "rating"] }
const AA_URL = "https://artificialanalysis.ai/api/v2/language/models/free"

// An Artificial Analysis model: its slug (or name) and its index scores.
interface AAModel {
  name: string
  evaluations: Record<string, number>
}

interface Ranking {
  generatedAt: string
  attribution: string
  candidatesSeen: number
  warnings: string[]
  models: Scored[]
}

function loadEnv(file: string) {
  let text
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return
  }
  for (const line of text.split("\n")) {
    const [, name, value] = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/) ?? []
    if (!name || !value) continue
    process.env[name] = value.replace(/^(['"])(.*)\1$/, "$2")
  }
}

async function getJSON(url: string, headers: Record<string, string> = {}): Promise<unknown> {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url.split("?")[0]}`)
  return res.json()
}

// Fetch a source, falling back to its last good copy. `ttl` skips the network while the cache is fresh.
async function cached<T>(name: string, ttl: number, load: () => Promise<T>, decode: (v: unknown) => T, warnings: string[]) {
  const file = path.join(CACHE, `${name}.json`)
  const prev = asObject(readJSON(file))
  const fetchedAt = optNumber(prev.fetchedAt)
  if (fetchedAt !== undefined && Date.now() - fetchedAt < ttl) return decode(prev.data)
  try {
    const data = await load()
    fs.mkdirSync(CACHE, { recursive: true })
    writeJSONAtomic(file, { fetchedAt: Date.now(), data })
    return data
  } catch (e) {
    warnings.push(`${name}: ${errorText(e)}${fetchedAt !== undefined ? ` (using copy from ${new Date(fetchedAt).toISOString()})` : " (no previous copy)"}`)
    return decode(prev.data)
  }
}

const decodeRows = (v: unknown) =>
  list(v, (x): Row | undefined => {
    const r = asObject(x)
    const name = optString(r.name)
    return name === undefined ? undefined : { name, value: optNumber(r.value) }
  })

// Overall rows come first in every board; stop paging once another category starts.
async function arenaBoard(config: string, field: string) {
  const rows: Row[] = []
  for (let offset = 0; ; offset += 100) {
    const d = asObject(await getJSON(`${HF}&config=${config}&offset=${offset}&length=100`))
    for (const { row } of list(d.rows, asObject)) {
      const r = asObject(row)
      if (r.category !== "overall") return rows
      const name = optString(r.model_name)
      if (name !== undefined) rows.push({ name, value: optNumber(r[field]) })
    }
    if (offset + 100 >= (optNumber(d.num_rows_total) ?? 0)) return rows
  }
}

const decodeAA = (v: unknown) =>
  list(v, (x): AAModel | undefined => {
    const m = asObject(x)
    const name = optString(m.slug) ?? optString(m.name)
    return name === undefined ? undefined : { name, evaluations: entries(m.evaluations, optNumber) }
  })

// Only called when ARTIFICIAL_ANALYSIS_API_KEY is set.
async function aaModels(key: string) {
  const out: AAModel[] = []
  for (let page = 1; page < 20; page++) {
    const d = asObject(await getJSON(`${AA_URL}?page=${page}`, { "x-api-key": key }))
    out.push(...decodeAA(d.data))
    if (asObject(d.pagination).has_more !== true) break
  }
  return out
}

async function openrouterStealth() {
  const d = asObject(await getJSON("https://openrouter.ai/api/v1/models"))
  return list(d.data, (x) => {
    const m = asObject(x)
    const id = optString(m.id)
    return id?.startsWith("stealth/") ? optString(m.name) || id : undefined
  })
}

// `raw`: every model block opencode printed, kept whole for debugging eligibility.
function candidates(): { raw: unknown[]; models: ModelInfo[] } {
  const r = spawnSync("opencode", ["models", "--verbose"], {
    // FREE_ROUTER_RANKING stops the plugin (loaded by this opencode) from starting another ranking.
    env: { ...process.env, OPENCODE_CONFIG: CONFIG_FILE, FREE_ROUTER_DIR: DIR, FREE_ROUTER_RANKING: "1" },
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 64 << 20,
  })
  if (r.status !== 0) throw new Error(`opencode models failed: ${(r.stderr || r.error?.message || "").slice(0, 300)}`)
  const raw: unknown[] = []
  for (const [, , block = ""] of r.stdout.matchAll(/^(\S+\/\S+)\n(\{[\s\S]*?\n\})$/gm)) {
    try {
      raw.push(JSON.parse(block))
    } catch {}
  }
  return { raw, models: list(raw, decodeModel) }
}

async function refresh() {
  loadEnv(path.join(DIR, "providers.env"))
  loadEnv(path.join(DIR, "ranker.env"))
  const cfg = loadConfig()
  const pins = loadPins()
  const warnings: string[] = []

  const { raw, models: all } = candidates()
  const cands = all.filter((m) => isEligible(m, cfg, pins))
  fs.mkdirSync(CACHE, { recursive: true })
  writeJSONAtomic(path.join(CACHE, "candidates.json"), raw) // model metadata only, for debugging eligibility

  const boards: Record<string, RankedRow[]> = {}
  for (const [src, [config, field]] of Object.entries(ARENA)) {
    boards[src] = percentiles(await cached(src, 20 * 3600e3, () => arenaBoard(config, field), decodeRows, warnings))
  }
  const aaKey = process.env.ARTIFICIAL_ANALYSIS_API_KEY
  const aa = aaKey ? await cached("aa", 20 * 3600e3, () => aaModels(aaKey), decodeAA, warnings) : []
  if (!aaKey) warnings.push("aa: ARTIFICIAL_ANALYSIS_API_KEY not set, Artificial Analysis scores skipped")
  const aaRows = (metric: string): Row[] => aa.map((m) => ({ name: m.name, value: m.evaluations[metric] }))
  boards.aa_coding = percentiles(aaRows("artificial_analysis_coding_index"))
  boards.aa_agentic = percentiles(aaRows("artificial_analysis_agentic_index"))
  boards.aa_intelligence = percentiles(aaRows("artificial_analysis_intelligence_index"))
  const stealth = await cached("openrouter_stealth", 3 * 3600e3, openrouterStealth, stringList, warnings)

  const ranking: Ranking = {
    generatedAt: new Date().toISOString(),
    attribution: "Scores use LMArena (lmarena-ai/leaderboard-dataset) and Artificial Analysis (artificialanalysis.ai).",
    candidatesSeen: raw.length,
    warnings,
    models: score(cands, boards, stealth, cfg, pins),
  }
  writeJSONAtomic(path.join(DIR, "ranking.json"), ranking)
  return ranking
}

function decodeHit(v: unknown): SourceHit | undefined {
  const h = asObject(v)
  const as = optString(h.as)
  const pct = optNumber(h.pct)
  return as === undefined || pct === undefined ? undefined : { as, value: optNumber(h.value), pct }
}

function decodeScored(v: unknown): Scored | undefined {
  const m = asObject(v)
  const id = optString(m.id)
  const s = optNumber(m.score)
  const reason = optString(m.reason)
  if (id === undefined || s === undefined || reason === undefined) return undefined
  return { id, score: s, reason, sources: entries(m.sources, decodeHit), release_date: optString(m.release_date) ?? null }
}

function status() {
  const ranking = asObject(readJSON(path.join(DIR, "ranking.json")))
  const models = list(ranking.models, decodeScored)
  const state = decodeState(readJSON(path.join(DIR, "state.json")))
  const now = Date.now()
  console.log(`ranking.json: ${optString(ranking.generatedAt) ?? "missing"}  (${models.length} eligible of ${optNumber(ranking.candidatesSeen) ?? "?"} models)`)
  for (const w of stringList(ranking.warnings)) console.log(`  warning: ${w}`)
  console.log("")
  models.forEach((m, i) => {
    const until = coolingUntil(state, m.id, now)
    const cool = until ? `  [cooling until ${new Date(until).toLocaleTimeString()}: ${state.cooldowns[m.id]?.klass ?? "provider"}]` : ""
    const src = Object.entries(m.sources).map(([k, v]) => `${k}=${v.pct}(${v.as})`).join(" ")
    console.log(`${String(i + 1).padStart(2)}. ${m.score.toFixed(3)}  ${m.id}  — ${m.reason}${cool}${src ? `\n      ${src}` : ""}`)
  })
  const sessions = Object.entries(state.sessions).sort((a, b) => b[1].at - a[1].at).slice(0, 10)
  if (sessions.length) {
    console.log("\nrecent sessions:")
    for (const [id, s] of sessions) console.log(`  ${id}  ${s.model}  (${new Date(s.at).toLocaleString()})`)
  }
}

if (process.argv.includes("--status")) status()
else {
  const lock = arg("--lock")
  try {
    // --quiet: print only warnings, so a clean refresh is silent.
    const r = await refresh()
    if (!process.argv.includes("--quiet")) console.log(`ranked ${r.models.length} free models; top: ${r.models.slice(0, 3).map((m) => m.id).join(", ") || "none"}`)
    for (const w of r.warnings) console.log(`warning: ${w}`)
    if (!r.models.length) console.log("warning: no eligible free models found")
  } catch (e) {
    console.error(`rank failed: ${errorText(e)}`)
    process.exitCode = 1
  } finally {
    if (lock) fs.rmSync(lock, { force: true })
  }
}
