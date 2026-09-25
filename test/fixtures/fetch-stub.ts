// Preloaded (node --import) into rank.mts runs: answers fetch() from the routes in $FETCH_STUB,
// so the tests never touch the network. The first route whose `match` is part of the URL wins.
import fs from "node:fs"
import { asObject, entries, list, optNumber, optString } from "../../src/lib.mts"

interface Route {
  match: string
  error: string | undefined
  headers: Record<string, string>
  status: number
  statusText: string
  body: unknown
}

const routes = list(JSON.parse(fs.readFileSync(process.env.FETCH_STUB ?? "", "utf8")), (x): Route | undefined => {
  const r = asObject(x)
  const match = optString(r.match)
  if (match === undefined) return undefined
  return { match, error: optString(r.error), headers: entries(r.headers, optString), status: optNumber(r.status) ?? 200, statusText: optString(r.statusText) ?? "OK", body: r.body }
})

globalThis.fetch = async (input, init) => {
  const url = input instanceof Request ? input.url : String(input)
  const route = routes.find((r) => url.includes(r.match))
  if (!route) throw new Error(`no stub for ${url}`)
  if (route.error) throw new Error(route.error)
  const headers = new Headers(init?.headers)
  const denied = Object.entries(route.headers).some(([k, v]) => headers.get(k) !== v)
  return new Response(JSON.stringify(route.body ?? null), { status: denied ? 401 : route.status, statusText: denied ? "Unauthorized" : route.statusText })
}
