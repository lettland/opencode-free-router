#!/bin/sh
# Remove opencode-free-router.
#   ./scripts/uninstall.sh [--bb] [--dir PATH] [--purge]
#     --bb     also remove the "free" agent from bb
#     --purge  also delete your keys, config, pins, ranking and state (the whole install directory)
# Without --purge only the code and the wrapper are removed; your files stay.
set -eu

dir="${XDG_CONFIG_HOME:-$HOME/.config}/opencode/free-router"
bb=0
purge=0

while [ $# -gt 0 ]; do
  case "$1" in
    --bb) bb=1 ;;
    --purge) purge=1 ;;
    --dir)
      [ $# -ge 2 ] || { echo "--dir needs a path" >&2; exit 2; }
      dir="$2"
      shift
      ;;
    -h | --help)
      sed -n '2,7p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "unknown option: $1" >&2; exit 2 ;;
  esac
  shift
done

if [ "$bb" = 1 ]; then
  if command -v node >/dev/null 2>&1; then js=node; else js=bun; fi
  "$js" --input-type=module -e '
    import { execFileSync } from "node:child_process"
    const bb = process.env.BB_CLI || "bb"
    const cfg = JSON.parse(execFileSync(bb, ["plugin", "config", "provider-acp", "--json"], { encoding: "utf8" }))
    const agents = JSON.parse(cfg.values?.customAgents || "[]").filter((a) => a.id !== "free")
    execFileSync(bb, ["plugin", "config", "provider-acp", "set", "customAgents", JSON.stringify(agents)], { stdio: ["ignore", "ignore", "inherit"] })
    console.log("bb agents: " + (agents.map((a) => a.id).join(", ") || "(none)"))
  '
fi

link="$HOME/.local/bin/opencode-free"
if [ -L "$link" ] && [ "$(readlink "$link")" = "$dir/opencode-free" ]; then rm -f "$link"; fi

if [ "$purge" = 1 ]; then
  rm -rf "$dir"
  echo "removed $dir"
else
  # The .js/.mjs names are what installs from before the TypeScript port have.
  rm -f "$dir/plugin.ts" "$dir/lib.mts" "$dir/rank.mts" "$dir/plugin.js" "$dir/lib.mjs" "$dir/rank.mjs" "$dir/opencode-free" "$dir/rank.lock"
  echo "removed code from $dir; kept free.jsonc, config.json, pins.json, *.env, ranking and state (use --purge to delete them)"
fi
