// rank.mts is a CLI, so these tests run it for real: fetch() is stubbed by a preload
// (fixtures/fetch-stub.ts) and `opencode` on PATH is a shell script printing canned models.
import { test } from "node:test"
import type { TestContext } from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { asArray, asObject, list, optString, readJSON } from "../src/lib.mts"

const RANK = fileURLToPath(new URL("../src/rank.mts", import.meta.url))
const STUB = new URL("./fixtures/fetch-stub.ts", import.meta.url).href

const FAKE_OPENCODE = `#!/bin/sh
printf '%s|%s|%s\\n' "$OPENCODE_CONFIG" "$FREE_ROUTER_RANKING" "$FOO_KEY" > "$FREE_ROUTER_DIR/opencode-env"
if [ -n "$FAKE_OPENCODE_FAIL" ]; then echo "boom" >&2; exit 1; fi
cat "$FREE_ROUTER_DIR/models.txt"
`

const model = (providerID: string, id: string, extra: Record<string, unknown> = {}) => ({
  providerID,
  id,
  name: id,
  status: "active",
  cost: { input: 0, output: 0 },
  limit: { context: 200000 },
  capabilities: { toolcall: true },
  ...extra,
})

// `opencode models --verbose` output, plus one block that is not valid JSON.
const modelsOut = (...ms: ReturnType<typeof model>[]) => ms.map((m) => `${m.providerID}/${m.id}\n${JSON.stringify(m, null, 2)}\n`).join("") + "opencode/broken\n{\n  nope\n}\n"

const MODELS = modelsOut(model("opencode", "big-free", { name: "Big Model" }), model("opencode", "space-bunny-free"), model("openai", "paid", { cost: { input: 1, output: 1 } }))

const overall = (model_name: string, field: string, value: number) => ({ row: { category: "overall", model_name, [field]: value } })
const ROUTES = [
  { match: "config=agent&offset=0", body: { num_rows_total: 150, rows: [overall("big-model", "score", 1500), overall("small-model", "score", 1000)] } },
  { match: "config=agent&offset=100", body: { num_rows_total: 150, rows: [overall("mid-model", "score", 1200), { row: { category: "coding", model_name: "big-model", score: 1 } }] } },
  { match: "config=webdev", body: { num_rows_total: 2, rows: [overall("big-model", "rating", 1400), overall("small-model", "rating", 1100)] } },
  { match: "config=text", status: 500, statusText: "Server Error" },
  {
    match: "models/free?page=1",
    headers: { "x-api-key": "k" },
    body: { data: [{ slug: "big-model", evaluations: { artificial_analysis_coding_index: 60 } }, { name: "Other Model" }], pagination: { has_more: true } },
  },
  { match: "models/free?page=2", headers: { "x-api-key": "k" }, body: { data: [{ slug: "small-model", evaluations: { artificial_analysis_coding_index: 20 } }] } },
  { match: "openrouter.ai/api/v1/models", body: { data: [{ id: "stealth/space-bunny-alpha", name: "Space Bunny Alpha" }, { id: "stealth/quiet-fox", name: "" }, { id: "meta/llama" }] } },
]

function setup(t: TestContext) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "free-router-rank-")))
  fs.mkdirSync(path.join(dir, "bin"))
  fs.writeFileSync(path.join(dir, "bin", "opencode"), FAKE_OPENCODE, { mode: 0o755 })
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

function run(dir: string, args: string[] = [], { routes = ROUTES, models = MODELS, env = {} }: { routes?: unknown[]; models?: string; env?: Record<string, string> } = {}) {
  fs.writeFileSync(path.join(dir, "routes.json"), JSON.stringify(routes))
  fs.writeFileSync(path.join(dir, "models.txt"), models)
  const base = { ...process.env }
  delete base.ARTIFICIAL_ANALYSIS_API_KEY
  return spawnSync(process.execPath, ["--import", STUB, RANK, ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...base, FREE_ROUTER_DIR: dir, FETCH_STUB: path.join(dir, "routes.json"), PATH: `${path.join(dir, "bin")}:/usr/bin:/bin`, ...env },
  })
}

const readRanking = (dir: string) => asObject(readJSON(path.join(dir, "ranking.json")))
const rankedModels = (dir: string) => list(readRanking(dir).models, asObject)

test("refresh ranks eligible models from every source, then serves from cache", (t) => {
  const dir = setup(t)
  fs.writeFileSync(path.join(dir, "providers.env"), "# provider keys\nexport FOO_KEY='abc'\nEMPTY=\n\nnot a line\n")
  fs.writeFileSync(path.join(dir, "ranker.env"), 'ARTIFICIAL_ANALYSIS_API_KEY="k"\n')

  const r = run(dir, ["--config", "free.jsonc"])
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^ranked 2 free models; top: opencode\/big-free, opencode\/space-bunny-free$/m)
  assert.match(r.stdout, /^warning: arena_text: 500 Server Error for https:\/\/datasets-server\.huggingface\.co\/rows \(no previous copy\)$/m)
  assert.equal(fs.readFileSync(path.join(dir, "opencode-env"), "utf8"), `${path.join(dir, "free.jsonc")}|1|abc\n`, "config, recursion guard and providers.env reach opencode")

  assert.equal(readRanking(dir).candidatesSeen, 3, "unparsable model blocks are skipped")
  const models = rankedModels(dir)
  assert.deepEqual(
    models.map((m) => [m.id, m.reason]),
    [
      ["opencode/big-free", "benchmarks (arena_agent, arena_webdev, aa_coding)"],
      ["opencode/space-bunny-free", "stealth model (no benchmarks yet)"],
    ],
  )
  assert.equal(models[0]?.score, 1)
  assert.equal(asArray(readJSON(path.join(dir, "cache", "candidates.json"))).length, 3)
  assert.deepEqual(
    list(asObject(readJSON(path.join(dir, "cache", "arena_agent.json"))).data, (r) => optString(asObject(r).name)),
    ["big-model", "small-model", "mid-model"],
    "pages until the overall rows end",
  )

  // Fresh caches need no network; the source that never succeeded warns again.
  const quiet = run(dir, ["--quiet"], { routes: [] })
  assert.equal(quiet.status, 0, quiet.stderr)
  assert.equal(quiet.stdout, "warning: arena_text: no stub for https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&split=latest&config=text&offset=0&length=100 (no previous copy)\n")
  assert.deepEqual(rankedModels(dir).map((m) => m.id), ["opencode/big-free", "opencode/space-bunny-free"])

  // A stale cache is refetched; when that fails, the last good copy is still used.
  const file = path.join(dir, "cache", "arena_agent.json")
  fs.writeFileSync(file, JSON.stringify({ ...asObject(readJSON(file)), fetchedAt: Date.now() - 21 * 3600e3 }))
  const stale = run(dir, ["--quiet"], { routes: [] })
  assert.match(stale.stdout, /^warning: arena_agent: no stub for .* \(using copy from \d{4}-\d\d-\d\dT.*Z\)$/m)
  assert.ok(asObject(rankedModels(dir)[0]?.sources).arena_agent)
})

test("refresh without an AA key or eligible models still writes a ranking and frees the lock", (t) => {
  const dir = setup(t)
  const lock = path.join(dir, "rank.lock")
  fs.writeFileSync(lock, "1")

  const r = run(dir, ["--lock", lock], { models: modelsOut(model("openai", "paid", { cost: { input: 1, output: 1 } })) })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^ranked 0 free models; top: none$/m)
  assert.match(r.stdout, /^warning: aa: ARTIFICIAL_ANALYSIS_API_KEY not set, Artificial Analysis scores skipped$/m)
  assert.match(r.stdout, /^warning: no eligible free models found$/m)
  assert.deepEqual(readRanking(dir).models, [])
  assert.ok(!fs.existsSync(lock))
})

test("refresh fails cleanly when opencode fails or is missing", (t) => {
  const dir = setup(t)
  const lock = path.join(dir, "rank.lock")

  fs.writeFileSync(lock, "1")
  const failed = run(dir, ["--lock", lock], { env: { FAKE_OPENCODE_FAIL: "1" } })
  assert.equal(failed.status, 1)
  assert.equal(failed.stderr, "rank failed: opencode models failed: boom\n\n", "opencode's stderr, verbatim")
  assert.ok(!fs.existsSync(lock), "lock is released on failure too")

  const missing = run(dir, [], { env: { PATH: path.join(dir, "nowhere") } })
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /^rank failed: opencode models failed: spawnSync opencode ENOENT$/m)
  assert.ok(!fs.existsSync(path.join(dir, "ranking.json")))
})

test("--status prints the ranking, cooldowns and recent sessions", (t) => {
  const dir = setup(t)

  const empty = run(dir, ["--status"])
  assert.equal(empty.status, 0, empty.stderr)
  assert.equal(empty.stdout, "ranking.json: missing  (0 eligible of ? models)\n\n")

  const now = Date.now()
  fs.writeFileSync(
    path.join(dir, "ranking.json"),
    JSON.stringify({
      generatedAt: "2026-09-25T10:00:00.000Z",
      candidatesSeen: 9,
      warnings: ["aa: down"],
      models: [
        { id: "opencode/big-free", score: 0.91234, reason: "benchmarks (arena_agent)", sources: { arena_agent: { as: "big-model", value: 1500, pct: 1 } } },
        { id: "groq/fast", score: 0.25, reason: "unscored", sources: {} },
        { id: "nvidia/calm", score: 0.2, reason: "unscored", sources: {} },
      ],
    }),
  )
  fs.writeFileSync(
    path.join(dir, "state.json"),
    JSON.stringify({
      cooldowns: { "opencode/big-free": { until: now + 3600e3, klass: "quota" }, "groq/*": { until: now + 3600e3 } },
      sessions: { ses_old: { model: "groq/fast", at: now - 1000 }, ses_new: { model: "opencode/big-free", at: now } },
    }),
  )
  const r = run(dir, ["--status"])
  assert.equal(r.status, 0, r.stderr)
  const lines = r.stdout.split("\n")
  const line = (i: number) => lines[i] ?? `(no line ${i})`
  assert.equal(line(0), "ranking.json: 2026-09-25T10:00:00.000Z  (3 eligible of 9 models)")
  assert.equal(line(1), "  warning: aa: down")
  assert.match(line(3), /^ 1\. 0\.912 {2}opencode\/big-free {2}— benchmarks \(arena_agent\) {2}\[cooling until .+: quota\]$/)
  assert.equal(line(4), "      arena_agent=1(big-model)")
  assert.match(line(5), /^ 2\. 0\.250 {2}groq\/fast {2}— unscored {2}\[cooling until .+: provider\]$/)
  assert.equal(line(6), " 3. 0.200  nvidia/calm  — unscored")
  assert.equal(line(8), "recent sessions:")
  assert.match(line(9), /^ {2}ses_new {2}opencode\/big-free {2}\(.+\)$/, "newest first")
  assert.match(line(10), /^ {2}ses_old {2}groq\/fast/)
})
