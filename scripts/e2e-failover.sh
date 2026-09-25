#!/bin/sh
# End-to-end failover check against a real opencode (not run in CI; needs opencode, node 22.18+, curl
# and network access to OpenCode Zen's free models).
#   ./scripts/e2e-failover.sh
# Ranks a fake provider that always answers 429 "per-day limit" first, then checks that
#   1. the turn fails over to a real free model and is continued automatically,
#   2. the failed model is on cooldown,
#   3. the next turn stays on the switched model (sticky) even after the cooldown is cleared.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
fake_port="${FAKE_PORT:-18999}"
oc_port="${OC_PORT:-18998}"
work=$(mktemp -d "${TMPDIR:-/tmp}/free-router-e2e.XXXXXX")
pids=""
cleanup() {
  for p in $pids; do kill "$p" 2>/dev/null || true; done
  rm -rf "$work"
}
trap cleanup EXIT INT TERM

cp "$repo/src/plugin.ts" "$repo/src/lib.mts" "$repo/src/rank.mts" "$work/"
# The fake provider must count as free; everything else keeps the defaults.
printf '{"freeTier":{"fakefree":["*"]}}\n' >"$work/config.json"
cp "$repo/templates/pins.example.json" "$work/pins.json"

cat >"$work/free.jsonc" <<EOF
{
  "\$schema": "https://opencode.ai/config.json",
  "plugin": ["./plugin.ts"],
  "model": "free/auto",
  "provider": {
    "free": { "npm": "@ai-sdk/openai-compatible", "name": "Free", "options": { "baseURL": "http://127.0.0.1:9/v1", "apiKey": "x" },
      "models": { "auto": { "name": "auto", "tool_call": true, "limit": { "context": 200000, "output": 32000 } } } },
    "fakefree": { "npm": "@ai-sdk/openai-compatible", "name": "Fake", "options": { "baseURL": "http://127.0.0.1:$fake_port/v1", "apiKey": "x" },
      "models": { "broken": { "name": "Broken Free", "tool_call": true, "limit": { "context": 200000, "output": 32000 } } } }
  }
}
EOF

# Ranking: the fake model first, then every live Zen free model.
OPENCODE_CONFIG="$work/free.jsonc" FREE_ROUTER_RANKING=1 opencode models opencode | node -e '
  const ids = require("fs").readFileSync(0, "utf8").split("\n").filter((l) => /^opencode\/\S+/.test(l))
  const models = [{ id: "fakefree/broken", score: 9, reason: "e2e", sources: {} }, ...ids.map((id, i) => ({ id, score: 1 - i / 100, reason: "e2e", sources: {} }))]
  require("fs").writeFileSync(process.argv[1], JSON.stringify({ generatedAt: new Date().toISOString(), models }))
' "$work/ranking.json"

node -e '
  require("http").createServer((req, res) => {
    req.resume()
    res.writeHead(429, { "content-type": "application/json", "retry-after": "3600" })
    res.end(JSON.stringify({ error: { message: "Rate limit exceeded: free-models-per-day", code: 429 } }))
  }).listen(Number(process.argv[1]), "127.0.0.1")
' "$fake_port" &
pids="$pids $!"

OPENCODE_CONFIG="$work/free.jsonc" FREE_ROUTER_DIR="$work" FREE_ROUTER_RANKING=1 \
  env -u BB_THREAD_ID -u BB_CLI opencode serve --port "$oc_port" --hostname 127.0.0.1 >"$work/serve.log" 2>&1 &
pids="$pids $!"

api="http://127.0.0.1:$oc_port"
q="directory=$work"
i=0
until curl -sf "$api/session?$q" >/dev/null 2>&1; do
  i=$((i + 1))
  [ "$i" -lt 60 ] || { echo "FAIL: opencode serve did not start"; cat "$work/serve.log"; exit 1; }
  sleep 0.5
done

sid=$(curl -sf -X POST "$api/session?$q" -H 'content-type: application/json' -d '{}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).id')

prompt() {
  curl -sf -o /dev/null -X POST "$api/session/$sid/prompt_async?$q" -H 'content-type: application/json' \
    -d "{\"model\":{\"providerID\":\"free\",\"modelID\":\"auto\"},\"parts\":[{\"type\":\"text\",\"text\":\"$1\"}]}"
}

# Wait until an assistant message containing $1 exists; print "provider/model" of that message.
wait_reply() {
  i=0
  while [ "$i" -lt 90 ]; do
    # shellcheck disable=SC2016 # ${...} is a JS template literal
    hit=$(curl -sf "$api/session/$sid/message?$q" | node -e '
      const msgs = JSON.parse(require("fs").readFileSync(0, "utf8"))
      const m = msgs.find((m) => m.info.role === "assistant" && m.parts.some((p) => p.type === "text" && (p.text || "").includes(process.argv[1])))
      if (m) console.log(`${m.info.providerID}/${m.info.modelID}`)
    ' "$1")
    [ -n "$hit" ] && { echo "$hit"; return 0; }
    i=$((i + 1))
    sleep 1
  done
  return 1
}

prompt "Reply with exactly: e2e-one"
first=$(wait_reply "e2e-one") || { echo "FAIL: no reply after failover"; cat "$work/router.log" 2>/dev/null; exit 1; }
case "$first" in fakefree/*) echo "FAIL: answered by the fake model?"; exit 1 ;; esac
grep -q '"fakefree/broken"' "$work/state.json" || { echo "FAIL: fake model not on cooldown"; exit 1; }
echo "ok  failover: fakefree/broken -> $first (auto-continued)"

# Clear cooldowns: the fake model is #1 again, but the session must stay on its model.
node -e '
  const f = process.argv[1], s = JSON.parse(require("fs").readFileSync(f, "utf8"))
  s.cooldowns = {}
  require("fs").writeFileSync(f, JSON.stringify(s))
' "$work/state.json"
prompt "Reply with exactly: e2e-two"
second=$(wait_reply "e2e-two") || { echo "FAIL: no reply to second turn"; exit 1; }
[ "$second" = "$first" ] || { echo "FAIL: second turn moved from $first to $second"; exit 1; }
echo "ok  sticky: second turn stayed on $second"
echo "PASS"
