#!/bin/sh
# Install or upgrade opencode-free-router.
#   ./scripts/install.sh [--bb] [--dir PATH] [--no-rank]
#     --bb       also register a "Free (auto)" ACP agent in bb (provider acp-free)
#     --dir      install directory (default: $XDG_CONFIG_HOME/opencode/free-router or ~/.config/opencode/free-router)
#     --no-rank  skip the first ranking run
# Re-running upgrades the code in place; your free.jsonc, config.json, pins.json, key files
# and state are never overwritten.
set -eu

repo=$(cd "$(dirname "$0")/.." && pwd)
dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/free-router"
bb=0
rank=1

while [ $# -gt 0 ]; do
  case "$1" in
    --bb) bb=1 ;;
    --no-rank) rank=0 ;;
    --dir)
      [ $# -ge 2 ] || { echo "--dir needs a path" >&2; exit 2; }
      dir="$2"
      shift
      ;;
    -h | --help)
      sed -n '2,9p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing prerequisite: $1" >&2; exit 1; }; }
need opencode
if command -v node >/dev/null 2>&1; then js=node; elif command -v bun >/dev/null 2>&1; then js=bun; else
  echo "missing prerequisite: node (or bun)" >&2
  exit 1
fi

mkdir -p "$dir"
dir=$(cd "$dir" && pwd)

# Code: always replaced.
cp "$repo/src/plugin.js" "$repo/src/lib.mjs" "$repo/src/rank.mjs" "$dir/"
sed "s|@FREE_ROUTER_DIR@|$dir|" "$repo/bin/opencode-free" >"$dir/opencode-free"
chmod 755 "$dir/opencode-free"

# User files: created once, never overwritten.
copy_once() {
  if [ -e "$2" ]; then
    echo "kept     $2"
  else
    cp "$1" "$2"
    echo "created  $2"
  fi
}
copy_once "$repo/templates/free.jsonc" "$dir/free.jsonc"
copy_once "$repo/templates/config.example.json" "$dir/config.json"
copy_once "$repo/templates/pins.example.json" "$dir/pins.json"
(
  umask 077
  copy_once "$repo/templates/providers.env.example" "$dir/providers.env"
  copy_once "$repo/templates/ranker.env.example" "$dir/ranker.env"
)
chmod 600 "$dir/providers.env" "$dir/ranker.env"

# Put the wrapper on PATH when ~/.local/bin is already there.
case ":$PATH:" in
  *":$HOME/.local/bin:"*)
    mkdir -p "$HOME/.local/bin"
    ln -sf "$dir/opencode-free" "$HOME/.local/bin/opencode-free"
    launcher="opencode-free"
    ;;
  *) launcher="$dir/opencode-free" ;;
esac

if [ "$bb" = 1 ]; then
  need bb
  # Read-modify-write the agent list in one node process; other agents' env may hold tokens,
  # so nothing but agent ids is printed and the value never passes through a shell.
  FREE_ROUTER_LAUNCHER="$dir/opencode-free" "$js" --input-type=module -e '
    import { execFileSync } from "node:child_process"
    const bb = process.env.BB_CLI || "bb"
    const cfg = JSON.parse(execFileSync(bb, ["plugin", "config", "provider-acp", "--json"], { encoding: "utf8" }))
    const agents = JSON.parse(cfg.values?.customAgents || "[]").filter((a) => a.id !== "free")
    agents.push({ id: "free", displayName: "Free (auto)", command: process.env.FREE_ROUTER_LAUNCHER, args: ["acp"], dialect: "opencode", supportsManualCompaction: true })
    execFileSync(bb, ["plugin", "config", "provider-acp", "set", "customAgents", JSON.stringify(agents)], { stdio: ["ignore", "ignore", "inherit"] })
    console.log("bb agents: " + agents.map((a) => a.id).join(", "))
  '
fi

if [ "$rank" = 1 ]; then
  echo "ranking free models (first run downloads leaderboards)..."
  "$js" "$dir/rank.mjs" || echo "ranking failed; the plugin retries on next start, or run: $js $dir/rank.mjs" >&2
  "$js" "$dir/rank.mjs" --status | head -12
fi

cat <<EOF

Installed to $dir
  start:   $launcher                (or: $launcher run "...")
  model:   free/auto
  keys:    $dir/providers.env  (optional provider keys, free plans only)
           $dir/ranker.env     (optional Artificial Analysis key)
  status:  $js $dir/rank.mjs --status
EOF
[ "$bb" = 1 ] && echo "  bb:      pick \"Free (auto)\" (provider acp-free)"
exit 0
