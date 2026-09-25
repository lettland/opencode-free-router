// free-router: replaces the free/auto placeholder with the best-ranked free model, keeps that
// model for the whole session, and fails over to the next-ranked one when it runs out.
// opencode keeps one model for a whole turn (including its own retries), so a failover aborts
// the turn and continues it on the next model. See README.md.
import fs from "node:fs"
import path from "node:path"
import { execFile, spawn } from "node:child_process"
import {
  DIR,
  isVirtual,
  readJSON,
  writeJSONAtomic,
  loadConfig,
  loadPins,
  mergeState,
  orderCandidates,
  pick,
  classifyRetry,
  classifyError,
  coolingUntil,
  split,
} from "./lib.mjs"

const STATE = path.join(DIR, "state.json")
const RANKING = path.join(DIR, "ranking.json")
const LOG = path.join(DIR, "router.log")
const LIVE_TTL = 5 * 60e3

function log(msg) {
  try {
    const st = fs.statSync(LOG, { throwIfNoEntry: false })
    if (st && st.size > 1 << 20) fs.renameSync(LOG, `${LOG}.1`)
    fs.appendFileSync(LOG, `${new Date().toISOString()} ${msg}\n`, { mode: 0o600 })
  } catch {}
}

const readState = () => readJSON(STATE, { cooldowns: {}, sessions: {} })

// Merge-on-write: other opencode processes share state.json.
function update(fn) {
  const mine = { cooldowns: {}, sessions: {} }
  fn(mine)
  writeJSONAtomic(STATE, mergeState(readState(), mine))
}

const REASON = { quota: "usage limit", rate: "rate limit", unavailable: "availability check (removed or refused)", auth: "auth failure", server: "provider errors" }

function which(bin) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const p = path.join(dir, bin)
    try {
      fs.accessSync(p, fs.constants.X_OK)
      return p
    } catch {}
  }
}

// Re-rank in the background when ranking.json is missing or stale. process.execPath is the
// opencode binary here, so run rank.mjs with node (or bun) from PATH. One run at a time via a
// lock file; a lock older than 10 minutes is treated as abandoned.
function maybeRefresh(cfg) {
  if (process.env.FREE_ROUTER_RANKING) return
  const st = fs.statSync(RANKING, { throwIfNoEntry: false })
  if (st && Date.now() - st.mtimeMs < cfg.refreshHours * 3600e3) return
  const lock = path.join(DIR, "rank.lock")
  try {
    fs.writeFileSync(lock, String(process.pid), { flag: "wx" })
  } catch {
    const l = fs.statSync(lock, { throwIfNoEntry: false })
    if (l && Date.now() - l.mtimeMs < 10 * 60e3) return
    fs.writeFileSync(lock, String(process.pid))
  }
  const runtime = which("node") ?? which("bun")
  if (!runtime) {
    fs.rmSync(lock, { force: true })
    log("WARN ranking is stale but neither node nor bun is on PATH; run rank.mjs manually")
    return
  }
  const out = fs.openSync(LOG, "a")
  const child = spawn(runtime, [path.join(DIR, "rank.mjs"), "--quiet", "--lock", lock], {
    detached: true,
    stdio: ["ignore", out, out],
    env: { ...process.env, FREE_ROUTER_DIR: DIR },
  })
  child.unref()
  fs.closeSync(out)
  log(`refreshing ranking in the background (pid ${child.pid})`)
}

export const server = async ({ client }) => {
  const cfg = loadConfig()
  try {
    maybeRefresh(cfg)
  } catch (e) {
    log(`refresh check failed: ${e?.message ?? e}`)
  }
  let ranking = { mtime: 0, data: undefined }
  let live = { at: 0, models: [] }
  // Per-session turn bookkeeping for this process.
  const turns = new Map()
  const turnOf = (sid) => turns.get(sid) ?? turns.set(sid, { switches: 0, pending: undefined, expectContinue: false, managed: false }).get(sid)

  function getRanking() {
    const st = fs.statSync(RANKING, { throwIfNoEntry: false })
    if (st && st.mtimeMs !== ranking.mtime) ranking = { mtime: st.mtimeMs, data: readJSON(RANKING) }
    return ranking.data
  }

  async function getLive() {
    if (Date.now() - live.at < LIVE_TTL && live.models.length) return live.models
    const r = await client.config.providers()
    const providers = r.data?.providers ?? []
    live = { at: Date.now(), models: providers.flatMap((p) => Object.values(p.models ?? {}).map((m) => ({ ...m, providerID: m.providerID ?? p.id }))) }
    return live.models
  }

  // Ordered ids that are live, free right now and eligible; the runtime free check guards a stale ranking.
  const candidates = async () => orderCandidates(getRanking(), await getLive(), cfg, loadPins())

  async function choose(sid, exclude = []) {
    const state = readState()
    const ordered = await candidates()
    const sticky = state.sessions[sid]?.model
    if (!exclude.length && sticky && ordered.includes(sticky) && !coolingUntil(state, sticky)) return sticky
    const p = pick(ordered, state, exclude)
    if (p?.allCooling) log(`WARN all free models are cooling down; using the one that frees up first: ${p.id}`)
    return p?.id
  }

  const setSticky = (sid, id) => update((s) => (s.sessions[sid] = { model: id, at: Date.now() }))

  async function failover(sid, c, message, abort) {
    const t = turnOf(sid)
    const from = readState().sessions[sid]?.model
    if (!from || t.pending) return
    const coolKey = c.scope === "provider" ? `${from.split("/")[0]}/*` : from
    update((s) => (s.cooldowns[coolKey] = { until: Date.now() + c.cooldownMs, klass: c.klass, reason: String(message).slice(0, 200) }))
    if (t.switches >= cfg.maxSwitchesPerTurn) {
      log(`give up ${sid}: already switched ${t.switches} times this turn; leaving ${from} (${c.klass})`)
      return
    }
    const to = await choose(sid, [from])
    if (!to) {
      log(`no alternative for ${sid}; staying on ${from} (${c.klass})`)
      return
    }
    setSticky(sid, to)
    t.switches++
    t.pending = { from, to, klass: c.klass }
    log(`failover ${sid}: ${from} -> ${to} (${c.klass}: ${String(message).slice(0, 160)})`)
    if (abort) {
      const r = await client.session.abort({ path: { id: sid } }).catch((e) => ({ error: e }))
      if (r?.error) log(`abort failed ${sid}: ${JSON.stringify(r.error).slice(0, 200)}`)
    }
    // The idle event normally triggers the continue; this covers an idle that fired before we got here.
    setTimeout(() => resume(sid), 1500)
  }

  async function resume(sid, tries = 0) {
    const t = turnOf(sid)
    if (!t.pending || t.firing) return
    t.firing = true
    const st = await client.session.status().catch(() => undefined)
    const type = st?.data?.[sid]?.type
    if (!t.pending || (type && type !== "idle")) {
      t.firing = false
      if (t.pending && tries < 20) setTimeout(() => resume(sid, tries + 1), 700)
      return
    }
    const { from, to, klass } = t.pending
    t.pending = undefined
    t.expectContinue = true
    const text = `[free-router] ${from} hit its ${REASON[klass] ?? klass}; switched to ${to}. Continue the task from where it stopped.`
    if (cfg.autoContinue === false) {
      t.expectContinue = false
      t.firing = false
      log(`switched ${sid} to ${to}; autoContinue off, next message will use it`)
      return
    }
    // Under bb (ACP) the aborted turn has already ended and bb drops output from a prompt it did not
    // start, so queue the continue as a visible thread message instead of prompting behind its back.
    // Only when opencode itself is bb's ACP agent: a TUI/serve started from a bb terminal
    // inherits BB_THREAD_ID too, and must not post into that thread.
    if (process.env.BB_THREAD_ID && process.argv.includes("acp")) {
      execFile(process.env.BB_CLI || "bb", ["thread", "message", "--mode", "queue", process.env.BB_THREAD_ID, text], { timeout: 60e3 }, (err, _out, stderr) => {
        if (err) {
          t.expectContinue = false
          log(`bb continue failed ${sid}: ${String(stderr || err.message).slice(0, 200)}`)
        } else log(`queued bb continue for ${process.env.BB_THREAD_ID} on ${to}`)
      })
      t.firing = false
      return
    }
    const r = await client.session
      .promptAsync({ path: { id: sid }, body: { model: split(to), ...(t.agent ? { agent: t.agent } : {}), parts: [{ type: "text", text }] } })
      .catch((e) => ({ error: e }))
    if (r?.error) {
      t.expectContinue = false
      log(`continue failed ${sid}: ${JSON.stringify(r.error).slice(0, 200)}`)
    } else log(`continued ${sid} on ${to}`)
    t.firing = false
  }

  return {
    "chat.message": async (input, output) => {
      const sid = input.sessionID
      const model = output.message?.model ?? input.model
      const t = turnOf(sid)
      const ours = t.expectContinue
      t.expectContinue = false
      const sticky = readState().sessions[sid]?.model
      const managed = isVirtual(model) || (!!sticky && !!model && `${model.providerID}/${model.modelID}` === sticky)
      if (!managed) {
        t.managed = false
        return
      }
      t.managed = true
      if (input.agent) t.agent = input.agent
      if (!ours) {
        // A real user message starts a new turn: reset the switch budget, drop any queued continue.
        t.switches = 0
        t.pending = undefined
      }
      const id = await choose(sid).catch((e) => log(`choose failed ${sid}: ${e?.message ?? e}`))
      if (!id) {
        log(`ERROR no free model available for ${sid}; free/auto left in place, the request will fail`)
        return
      }
      const { providerID, modelID } = split(id)
      const { variant: _variant, ...rest } = output.message.model ?? {}
      output.message.model = { ...rest, providerID, modelID }
      if (sticky !== id) log(`pick ${sid} -> ${id}${sticky ? ` (was ${sticky})` : ""}`)
      setSticky(sid, id)
    },

    event: async ({ event }) => {
      const p = event?.properties ?? {}
      const sid = p.sessionID
      if (!sid || !turns.get(sid)?.managed) return
      try {
        if (event.type === "session.status" && p.status?.type === "retry") {
          if (turns.get(sid).pending) return
          const c = classifyRetry(p.status, cfg)
          if (c.action === "failover") await failover(sid, c, p.status.message, true)
          else log(`retry ${sid} attempt ${p.status.attempt}: ${String(p.status.message).slice(0, 120)} (letting opencode retry)`)
        } else if ((event.type === "session.status" && p.status?.type === "idle") || event.type === "session.idle") {
          await resume(sid)
        } else if (event.type === "session.error") {
          const c = classifyError(p.error, cfg)
          if (c.action === "failover") await failover(sid, c, `${p.error?.name ?? "error"}: ${p.error?.data?.message ?? ""}`, false)
        }
      } catch (e) {
        log(`event ${event.type} failed ${sid}: ${e?.stack ?? e}`)
      }
    },
  }
}
