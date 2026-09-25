// Preloaded (node --import) into rank.mjs runs: answers fetch() from the routes in $FETCH_STUB,
// so the tests never touch the network. The first route whose `match` is part of the URL wins.
import fs from "node:fs"

const routes = JSON.parse(fs.readFileSync(process.env.FETCH_STUB, "utf8"))

globalThis.fetch = async (url, { headers = {} } = {}) => {
  const route = routes.find((r) => String(url).includes(r.match))
  if (!route) throw new Error(`no stub for ${url}`)
  if (route.error) throw new Error(route.error)
  const denied = Object.entries(route.headers ?? {}).some(([k, v]) => headers[k] !== v)
  const status = denied ? 401 : (route.status ?? 200)
  return {
    ok: status < 400,
    status,
    statusText: denied ? "Unauthorized" : (route.statusText ?? "OK"),
    json: async () => route.body,
  }
}
