// plugin.js runs inside opencode; these tests load it in-process against a fake opencode client
// and an isolated FREE_ROUTER_DIR. setTimeout is mocked so retries and resumes run on demand.
import { test, beforeEach, afterEach, after, mock } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const DIR = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "free-router-plugin-")))
process.env.FREE_ROUTER_DIR = DIR
for (const k of ["FREE_ROUTER_RANKING", "BB_THREAD_ID", "BB_CLI"]) delete process.env[k]
// plugin.js reads FREE_ROUTER_DIR when it loads, so import it only after setting it.
const { server } = await import("../src/plugin.js")

const VIRTUAL = { providerID: "free", modelID: "auto" }
const live = (id, extra = {}) => ({ id, name: id, status: "active", cost: { input: 0, output: 0 }, limit: { context: 200000 }, capabilities: { toolcall: true }, ...extra })
const OPENCODE = { id: "opencode", models: { "a-free": live("a-free"), "b-free": live("b-free"), "c-free": live("c-free") } }
const PROVIDERS = [OPENCODE, { id: "openai", models: { gpt: live("gpt", { cost: { input: 1, output: 1 } }) } }, { id: "empty" }]

const file = (name) => path.join(DIR, name)
const writeJSON = (name, data) => fs.writeFileSync(file(name), JSON.stringify(data))
const readState = () => JSON.parse(fs.readFileSync(file("state.json"), "utf8"))
const logText = () => (fs.existsSync(file("router.log")) ? fs.readFileSync(file("router.log"), "utf8") : "")
const count = (text, needle) => text.split(needle).length - 1

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

// Real time passes for child processes; setTimeout is mocked, so poll on setImmediate.
async function until(cond, what) {
  const deadline = Date.now() + 10_000
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise((r) => setImmediate(r))
  }
}

function fakeClient({ providers = PROVIDERS, statuses = [], abort, prompt } = {}) {
  const calls = { providers: 0, status: 0, abort: [], prompt: [] }
  return {
    calls,
    config: {
      providers: async () => {
        calls.providers++
        if (providers instanceof Error) throw providers
        return { data: { providers } }
      },
    },
    session: {
      abort: async (a) => {
        calls.abort.push(a)
        return abort ? abort() : {}
      },
      status: async () => {
        const s = statuses[Math.min(calls.status++, statuses.length - 1)]
        if (s instanceof Error) throw s
        return { data: s }
      },
      promptAsync: (a) => {
        calls.prompt.push(a)
        return prompt ? prompt(a) : Promise.resolve({})
      },
    },
  }
}

async function start(opts) {
  const client = fakeClient(opts)
  const hooks = await server({ client })
  const send = async (sid, model, { agent = "build", output = { message: { model: { ...model, variant: "high" } } } } = {}) => {
    await hooks["chat.message"]({ sessionID: sid, model, agent }, output)
    return output.message.model
  }
  const emit = (type, properties) => hooks.event({ event: { type, properties } })
  const retry = (sid, message, attempt = 1) => emit("session.status", { sessionID: sid, status: { type: "retry", attempt, message, next: 0 } })
  const fail = (sid, error) => emit("session.error", { sessionID: sid, error })
  const idle = (sid) => emit("session.status", { sessionID: sid, status: { type: "idle" } })
  return { client, hooks, send, emit, retry, fail, idle }
}

const model = (id) => {
  const [providerID, modelID] = id.split("/")
  return { providerID, modelID }
}

beforeEach(() => {
  for (const f of fs.readdirSync(DIR)) fs.rmSync(file(f), { recursive: true, force: true })
  writeJSON("ranking.json", { models: [{ id: "opencode/a-free" }, { id: "opencode/b-free" }, { id: "opencode/c-free" }] })
  mock.timers.enable({ apis: ["setTimeout"] })
})

afterEach(() => mock.timers.reset())
after(() => fs.rmSync(DIR, { recursive: true, force: true }))

test("free/auto gets the best free model, which then sticks to the session", async () => {
  const p = await start()
  assert.deepEqual(await p.send("s1", VIRTUAL), model("opencode/a-free"), "variant of the placeholder is dropped")
  assert.equal(readState().sessions.s1.model, "opencode/a-free")
  assert.match(logText(), /pick s1 -> opencode\/a-free\n/)

  // A newer ranking does not move a session that already has a healthy model.
  writeJSON("ranking.json", { models: [{ id: "opencode/b-free" }, { id: "opencode/a-free" }] })
  fs.utimesSync(file("ranking.json"), new Date(), new Date(Date.now() + 5000))
  assert.deepEqual(await p.send("s1", model("opencode/a-free")), model("opencode/a-free"))
  assert.equal(count(logText(), "pick "), 1)
  assert.deepEqual(await p.send("s2", VIRTUAL), model("opencode/b-free"), "new sessions follow the new ranking")

  // The message model can also come only from the input.
  const bare = { message: {} }
  await p.send("s3", VIRTUAL, { output: bare })
  assert.deepEqual(bare.message.model, model("opencode/b-free"))
  assert.equal(p.client.calls.providers, 1, "live model list is cached")

  // Anything else is left alone, including its errors.
  assert.deepEqual(await p.send("s4", model("openai/gpt")), { ...model("openai/gpt"), variant: "high" })
  await p.fail("s4", { name: "APIError", data: { statusCode: 401 } })
  await p.hooks.event({ event: { type: "session.idle" } })
  await p.hooks.event({})
  const state = readState()
  assert.equal(state.sessions.s4, undefined)
  assert.deepEqual(state.cooldowns, {})
})

test("no free model leaves free/auto in place", async () => {
  const none = await start({ providers: [] })
  assert.deepEqual(await none.send("s1", VIRTUAL), { ...VIRTUAL, variant: "high" })
  await none.send("s1", VIRTUAL)
  assert.equal(none.client.calls.providers, 2, "an empty live list is not cached")
  // Managed but never assigned a model: a failure has nothing to fail over from.
  await none.retry("s1", "Free usage exceeded")
  assert.equal(fs.existsSync(file("state.json")), false)

  const broken = await start({ providers: new Error("server down") })
  await broken.send("s1", VIRTUAL)
  const log = logText()
  assert.match(log, /choose failed s1: server down\n/)
  assert.equal(count(log, "ERROR no free model available for s1; free/auto left in place"), 3)
})

test("a retry that exhausts the model fails over, aborts the turn and continues on the next model", async () => {
  const p = await start({ statuses: [{ s1: { type: "busy" } }, { s1: { type: "idle" } }] })
  await p.send("s1", VIRTUAL)

  await p.retry("s1", "Provider is overloaded")
  assert.match(logText(), /retry s1 attempt 1: Provider is overloaded \(letting opencode retry\)\n/)
  assert.equal(p.client.calls.abort.length, 0)

  await p.retry("s1", "Free usage exceeded, subscribe to Go")
  const state = readState()
  assert.equal(state.cooldowns["opencode/a-free"].klass, "quota")
  assert.equal(state.cooldowns["opencode/a-free"].reason, "Free usage exceeded, subscribe to Go")
  assert.equal(state.sessions.s1.model, "opencode/b-free")
  assert.deepEqual(p.client.calls.abort, [{ path: { id: "s1" } }])
  assert.match(logText(), /failover s1: opencode\/a-free -> opencode\/b-free \(quota: Free usage exceeded, subscribe to Go\)\n/)

  await p.retry("s1", "Free usage exceeded", 2)
  assert.equal(p.client.calls.abort.length, 1, "no second failover while one is pending")

  // opencode is still winding the aborted turn down: wait for idle, once.
  await Promise.all([p.idle("s1"), p.idle("s1")])
  assert.equal(p.client.calls.status, 1)
  assert.equal(p.client.calls.prompt.length, 0)
  mock.timers.tick(700)
  await settle()
  assert.deepEqual(p.client.calls.prompt, [
    {
      path: { id: "s1" },
      body: {
        model: model("opencode/b-free"),
        agent: "build",
        parts: [{ type: "text", text: "[free-router] opencode/a-free hit its usage limit; switched to opencode/b-free. Continue the task from where it stopped." }],
      },
    },
  ])
  assert.match(logText(), /continued s1 on opencode\/b-free\n/)

  // The fallback resume finds nothing left to do.
  mock.timers.tick(1500)
  await settle()
  assert.equal(p.client.calls.prompt.length, 1)
})

test("an idle that fired before the failover is covered by the fallback resume", async () => {
  const p = await start()
  await p.send("s1", VIRTUAL, { agent: "" })
  await p.retry("s1", "Free usage exceeded")
  assert.equal(p.client.calls.prompt.length, 0)
  mock.timers.tick(1500)
  await settle()
  assert.equal(p.client.calls.prompt.length, 1)
  assert.equal(p.client.calls.prompt[0].body.agent, undefined)
})

test("session errors fail over without aborting; auth failures cool the whole provider", async () => {
  const p = await start()
  await p.send("s1", VIRTUAL)
  await p.fail("s1", { name: "MessageAbortedError" })
  assert.equal(fs.existsSync(file("state.json")) && Object.keys(readState().cooldowns).length, 0)

  await p.fail("s1", { name: "APIError", data: { message: "Unauthorized", statusCode: 401 } })
  const state = readState()
  assert.equal(state.cooldowns["opencode/*"].klass, "auth")
  assert.equal(state.cooldowns["opencode/*"].reason, "APIError: Unauthorized")
  assert.equal(state.sessions.s1.model, "opencode/b-free", "every model is cooling, so the one that frees up first")
  assert.match(logText(), /WARN all free models are cooling down; using the one that frees up first: opencode\/b-free\n/)
  assert.equal(p.client.calls.abort.length, 0, "the turn already ended")

  await p.emit("session.idle", { sessionID: "s1" })
  assert.equal(p.client.calls.prompt.length, 1)
  assert.match(p.client.calls.prompt[0].body.parts[0].text, /hit its auth failure;/)
})

test("failovers stop at maxSwitchesPerTurn and when nothing else is left", async () => {
  writeJSON("config.json", { maxSwitchesPerTurn: 1 })
  const p = await start()
  const gone = { data: { message: "model not found", statusCode: 404 } }
  await p.send("s1", VIRTUAL)
  await p.fail("s1", gone)
  await p.idle("s1")
  assert.equal(p.client.calls.prompt.length, 1)
  assert.match(p.client.calls.prompt[0].body.parts[0].text, /hit its availability check \(removed or refused\);/)
  assert.equal(readState().cooldowns["opencode/a-free"].reason, "error: model not found")

  // The continue belongs to the same turn, so it keeps the spent budget.
  await p.send("s1", model("opencode/b-free"))
  await p.fail("s1", gone)
  assert.match(logText(), /give up s1: already switched 1 times this turn; leaving opencode\/b-free \(unavailable\)\n/)
  assert.equal(readState().sessions.s1.model, "opencode/b-free")

  // A new user message gets a new budget.
  assert.deepEqual(await p.send("s1", model("opencode/b-free")), model("opencode/c-free"), "b-free is cooling now")
  await p.fail("s1", gone)
  assert.match(logText(), /failover s1: opencode\/c-free -> opencode\/a-free \(unavailable/)

  const lone = await start({ providers: [{ id: "opencode", models: { "a-free": live("a-free") } }] })
  await lone.send("s2", VIRTUAL)
  await lone.fail("s2", gone)
  assert.match(logText(), /no alternative for s2; staying on opencode\/a-free \(unavailable\)\n/)
})

test("autoContinue off switches the model but leaves the next message to the user", async () => {
  writeJSON("config.json", { autoContinue: false })
  const p = await start()
  await p.send("s1", VIRTUAL)
  await p.retry("s1", "Too Many Requests", 2)
  await p.idle("s1")
  assert.equal(p.client.calls.prompt.length, 0)
  assert.match(logText(), /switched s1 to opencode\/b-free; autoContinue off, next message will use it\n/)
  assert.equal(readState().sessions.s1.model, "opencode/b-free")
})

test("abort, status and continue failures are logged, never thrown", async () => {
  const p = await start({
    statuses: [new Error("status down")],
    abort: () => Promise.reject(new Error("abort down")),
    prompt: () => Promise.resolve({ error: { name: "BadRequest" } }),
  })
  await p.send("s1", VIRTUAL)
  await p.retry("s1", "Free usage exceeded")
  await p.idle("s1")
  const log = logText()
  assert.match(log, /abort failed s1: \{\}\n/)
  assert.match(log, /continue failed s1: \{"name":"BadRequest"\}\n/)

  const q = await start({ prompt: () => Promise.reject(new Error("prompt down")) })
  await q.send("s2", VIRTUAL)
  await q.retry("s2", "Free usage exceeded")
  await q.idle("s2")
  assert.match(logText(), /continue failed s2: \{\}\n/)

  const r = await start({
    prompt: () => {
      throw new Error("sdk bug")
    },
  })
  await r.send("s3", VIRTUAL)
  await r.retry("s3", "Free usage exceeded")
  await r.idle("s3")
  assert.match(logText(), /event session\.status failed s3: Error: sdk bug\n/)
})

test("under bb's ACP agent the continue is queued as a thread message", async (t) => {
  const bin = file("bin")
  fs.mkdirSync(bin)
  fs.writeFileSync(path.join(bin, "bb"), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$FREE_ROUTER_DIR/bb-args"\n', { mode: 0o755 })
  fs.writeFileSync(path.join(bin, "bb-broken"), "#!/bin/sh\necho 'no such thread' >&2\nexit 1\n", { mode: 0o755 })
  process.env.BB_THREAD_ID = "thr_test"
  process.env.BB_CLI = path.join(bin, "bb")
  process.argv.push("acp")
  t.after(() => {
    delete process.env.BB_THREAD_ID
    delete process.env.BB_CLI
    process.argv.pop()
  })

  const p = await start()
  await p.send("s1", VIRTUAL)
  await p.retry("s1", "Free usage exceeded")
  await p.idle("s1")
  await until(() => logText().includes("queued bb continue"), "bb continue")
  assert.match(logText(), /queued bb continue for thr_test on opencode\/b-free\n/)
  assert.deepEqual(fs.readFileSync(file("bb-args"), "utf8").split("\n").slice(0, 5), ["thread", "message", "--mode", "queue", "thr_test"])
  assert.equal(p.client.calls.prompt.length, 0, "never prompts behind bb's back")

  process.env.BB_CLI = path.join(bin, "bb-broken")
  await p.send("s2", VIRTUAL)
  await p.retry("s2", "Free usage exceeded")
  await p.idle("s2")
  await until(() => logText().includes("bb continue failed"), "bb failure")
  assert.match(logText(), /bb continue failed s2: no such thread\n/)
})

test("a stale ranking is refreshed in the background, one run at a time", async (t) => {
  const bin = file("bin")
  fs.mkdirSync(bin)
  const runtime = (name) => fs.writeFileSync(path.join(bin, name), `#!/bin/sh\necho "${name} $*" > "$FREE_ROUTER_DIR/spawned"\n`, { mode: 0o755 })
  const savedPath = process.env.PATH
  process.env.PATH = `${path.join(DIR, "nowhere")}${path.delimiter}${bin}`
  t.after(() => {
    process.env.PATH = savedPath
    delete process.env.FREE_ROUTER_RANKING
  })
  const lock = file("rank.lock")
  const refreshes = () => count(logText(), "refreshing ranking in the background")
  // The shell creates the file before it writes the line, so wait for the whole line.
  const spawned = () => (fs.existsSync(file("spawned")) ? fs.readFileSync(file("spawned"), "utf8") : "")

  // Fresh ranking: nothing to do.
  runtime("node")
  await start()
  assert.equal(fs.existsSync(lock), false)

  // rank.mjs's own opencode must not start another ranking.
  fs.utimesSync(file("ranking.json"), new Date(0), new Date(0))
  process.env.FREE_ROUTER_RANKING = "1"
  await start()
  assert.equal(fs.existsSync(lock), false)
  delete process.env.FREE_ROUTER_RANKING

  await start()
  assert.equal(refreshes(), 1)
  assert.equal(fs.readFileSync(lock, "utf8"), String(process.pid))
  await until(() => spawned().endsWith("\n"), "rank.mjs spawn")
  assert.equal(spawned(), `node ${file("rank.mjs")} --quiet --lock ${lock}\n`)

  await start()
  assert.equal(refreshes(), 1, "a live lock blocks a second run")

  fs.rmSync(file("spawned"))
  fs.rmSync(path.join(bin, "node"))
  runtime("bun")
  const old = new Date(Date.now() - 11 * 60e3)
  fs.utimesSync(lock, old, old)
  fs.rmSync(file("ranking.json"))
  await start()
  assert.equal(refreshes(), 2, "an abandoned lock is taken over")
  await until(() => spawned().endsWith("\n"), "bun spawn")
  assert.match(spawned(), /^bun /)

  fs.rmSync(path.join(bin, "bun"))
  fs.rmSync(lock)
  await start()
  assert.equal(fs.existsSync(lock), false, "lock released when there is nothing to run rank.mjs with")
  assert.match(logText(), /WARN ranking is stale but neither node nor bun is on PATH; run rank\.mjs manually\n/)

  fs.mkdirSync(lock)
  fs.utimesSync(lock, old, old)
  await start()
  assert.match(logText(), /refresh check failed: EISDIR/)
})

test("the log rotates past 1 MiB and a broken log never breaks the plugin", async () => {
  fs.writeFileSync(file("router.log"), "x".repeat((1 << 20) + 1))
  const p = await start({ providers: [] })
  await p.send("s1", VIRTUAL)
  assert.equal(fs.statSync(file("router.log.1")).size, (1 << 20) + 1)
  assert.match(logText(), /^\S+ ERROR no free model available for s1/)

  fs.rmSync(file("router.log"))
  fs.mkdirSync(file("router.log"))
  await p.send("s1", VIRTUAL)
})
