#!/usr/bin/env node
// Ranks the free models opencode can reach right now and writes ranking.json for plugin.js.
//   node rank.mjs            refresh ranking.json
//   node rank.mjs --status   print ranking, cooldowns and per-session picks (no refresh)
//   node rank.mjs --quiet    refresh, printing only warnings (scheduled / plugin-triggered runs)
//   --config <free.jsonc>    opencode config to list models with (default: free.jsonc next to this file)
//   --lock <file>            remove this lock file when done (set by the plugin's self-refresh)
import fs from "node:fs"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { DIR, readJSON, writeJSONAtomic, loadConfig, loadPins, isEligible, percentiles, score, coolingUntil } from "./lib.mjs"

const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i > 0 ? process.argv[i + 1] : undefined
}
const CONFIG_FILE = path.resolve(arg("--config") ?? path.join(DIR, "free.jsonc"))
const CACHE = path.join(DIR, "cache")
const HF = "https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&split=latest"
const ARENA = { arena_agent: ["agent", "score"], arena_webdev: ["webdev", "rating"], arena_text: ["text", "rating"] }
const AA_URL = "https://artificialanalysis.ai/api/v2/language/models/free"

function loadEnv(file) {
  let text
  try {
    text = fs.readFileSync(file, "utf8")
  } catch {
    return
  }
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
    if (!m || !m[2]) continue
    process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2")
  }
}

async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) })
  if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url.split("?")[0]}`)
  return res.json()
}

// Fetch a source, falling back to its last good copy. `ttl` skips the network while the cache is fresh.
async function cached(name, ttl, load, warnings) {
  const file = path.join(CACHE, `${name}.json`)
  const prev = readJSON(file)
  if (prev && Date.now() - prev.fetchedAt < ttl) return prev.data
  try {
    const data = await load()
    fs.mkdirSync(CACHE, { recursive: true })
    writeJSONAtomic(file, { fetchedAt: Date.now(), data })
    return data
  } catch (e) {
    warnings.push(`${name}: ${e.message}${prev ? ` (using copy from ${new Date(prev.fetchedAt).toISOString()})` : " (no previous copy)"}`)
    return prev?.data ?? []
  }
}

// Overall rows come first in every board; stop paging once another category starts.
async function arenaBoard(config, field) {
  const rows = []
  for (let offset = 0; ; offset += 100) {
    const d = await getJSON(`${HF}&config=${config}&offset=${offset}&length=100`)
    for (const { row } of d.rows) {
      if (row.category !== "overall") return rows
      rows.push({ name: row.model_name, value: row[field] })
    }
    if (offset + 100 >= d.num_rows_total) return rows
  }
}

async function aaModels() {
  const key = process.env.ARTIFICIAL_ANALYSIS_API_KEY
  if (!key) return null
  const out = []
  for (let page = 1; page < 20; page++) {
    const d = await getJSON(`${AA_URL}?page=${page}`, { "x-api-key": key })
    out.push(...d.data)
    if (!d.pagination?.has_more) break
  }
  return out
}

async function openrouterStealth() {
  const d = await getJSON("https://openrouter.ai/api/v1/models")
  return d.data.filter((m) => m.id.startsWith("stealth/")).map((m) => m.name || m.id)
}

function candidates() {
  const r = spawnSync("opencode", ["models", "--verbose"], {
    // FREE_ROUTER_RANKING stops the plugin (loaded by this opencode) from starting another ranking.
    env: { ...process.env, OPENCODE_CONFIG: CONFIG_FILE, FREE_ROUTER_DIR: DIR, FREE_ROUTER_RANKING: "1" },
    encoding: "utf8",
    timeout: 180_000,
    maxBuffer: 64 << 20,
  })
  if (r.status !== 0) throw new Error(`opencode models failed: ${(r.stderr || r.error?.message || "").slice(0, 300)}`)
  const out = []
  for (const m of r.stdout.matchAll(/^(\S+\/\S+)\n(\{[\s\S]*?\n\})$/gm)) {
    try {
      out.push(JSON.parse(m[2]))
    } catch {}
  }
  return out
}

async function refresh() {
  loadEnv(path.join(DIR, "providers.env"))
  loadEnv(path.join(DIR, "ranker.env"))
  const cfg = loadConfig()
  const pins = loadPins()
  const warnings = []

  const all = candidates()
  const cands = all.filter((m) => isEligible(m, cfg, pins))
  fs.mkdirSync(CACHE, { recursive: true })
  writeJSONAtomic(path.join(CACHE, "candidates.json"), all) // model metadata only, for debugging eligibility

  const boards = {}
  for (const [src, [config, field]] of Object.entries(ARENA)) {
    boards[src] = percentiles(await cached(src, 20 * 3600e3, () => arenaBoard(config, field), warnings))
  }
  const aa = process.env.ARTIFICIAL_ANALYSIS_API_KEY ? await cached("aa", 20 * 3600e3, aaModels, warnings) : []
  if (!process.env.ARTIFICIAL_ANALYSIS_API_KEY) warnings.push("aa: ARTIFICIAL_ANALYSIS_API_KEY not set, Artificial Analysis scores skipped")
  const aaRows = (metric) => (aa ?? []).map((m) => ({ name: m.slug ?? m.name, value: m.evaluations?.[metric] ?? undefined }))
  boards.aa_coding = percentiles(aaRows("artificial_analysis_coding_index"))
  boards.aa_agentic = percentiles(aaRows("artificial_analysis_agentic_index"))
  boards.aa_intelligence = percentiles(aaRows("artificial_analysis_intelligence_index"))
  const stealth = await cached("openrouter_stealth", 3 * 3600e3, openrouterStealth, warnings)

  const models = score(cands, boards, stealth, cfg, pins)
  const ranking = {
    generatedAt: new Date().toISOString(),
    attribution: "Scores use LMArena (lmarena-ai/leaderboard-dataset) and Artificial Analysis (artificialanalysis.ai).",
    candidatesSeen: all.length,
    warnings,
    models,
  }
  writeJSONAtomic(path.join(DIR, "ranking.json"), ranking)
  return ranking
}

function status() {
  const ranking = readJSON(path.join(DIR, "ranking.json"), { models: [], warnings: [] })
  const state = readJSON(path.join(DIR, "state.json"), { cooldowns: {}, sessions: {} })
  const now = Date.now()
  console.log(`ranking.json: ${ranking.generatedAt ?? "missing"}  (${ranking.models.length} eligible of ${ranking.candidatesSeen ?? "?"} models)`)
  for (const w of ranking.warnings ?? []) console.log(`  warning: ${w}`)
  console.log("")
  ranking.models.forEach((m, i) => {
    const until = coolingUntil(state, m.id, now)
    const cool = until ? `  [cooling until ${new Date(until).toLocaleTimeString()}: ${state.cooldowns[m.id]?.klass ?? "provider"}]` : ""
    const src = Object.entries(m.sources).map(([k, v]) => `${k}=${v.pct}(${v.as})`).join(" ")
    console.log(`${String(i + 1).padStart(2)}. ${m.score.toFixed(3)}  ${m.id}  — ${m.reason}${cool}${src ? `\n      ${src}` : ""}`)
  })
  const sessions = Object.entries(state.sessions ?? {}).sort((a, b) => b[1].at - a[1].at).slice(0, 10)
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
    console.error(`rank failed: ${e.message}`)
    process.exitCode = 1
  } finally {
    if (lock) fs.rmSync(lock, { force: true })
  }
}
