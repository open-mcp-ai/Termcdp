/**
 * Endpoint = "one CDP port" + "how to reach it". The unit of termcdp's multi-instance model.
 *
 * Accepted spellings (the `instances` tool takes these):
 *   lab1=127.0.0.1:9222                          direct
 *   lab1=http://127.0.0.1:9222                   direct (equivalent)
 *   win10=socks5://127.0.0.1:1080?cdp=127.0.0.1:9222          via SOCKS5
 *   win10=socks5://user:pass@127.0.0.1:1080?cdp=127.0.0.1:9333
 *
 * The `cdp=` host must be an IP literal or `localhost`: DevTools validates the Host header,
 * and a container name / domain name gets you an HTTP 500.
 */
import { socks5Connect, isIpv4 } from './socks5.js'
import { connectTcp } from './tcp.js'
import { httpGetJson } from './http.js'
import { WsConnection } from './ws.js'

const DEFAULT_CDP = { host: '127.0.0.1', port: 9222 }

/** A CDP address must be an IP literal or `localhost` (an IPv6 literal contains a colon) */
function isIpLiteral(host) {
  return isIpv4(host) || host.includes(':')
}

/**
 * Parse an endpoint spec.
 * @param {string} spec either `name=...` or a bare address
 * @param {string} [fallbackName]
 */
export function parseEndpoint(spec, fallbackName) {
  let name = fallbackName
  let rest = String(spec ?? '').trim()
  const eq = rest.indexOf('=')
  if (eq > 0 && !rest.slice(0, eq).includes('/')) {
    name = rest.slice(0, eq).trim()
    rest = rest.slice(eq + 1).trim()
  }
  if (!rest) throw new Error(`endpoint spec is empty: ${JSON.stringify(spec)}`)

  if (/^socks5h?:\/\//i.test(rest)) {
    const u = new URL(rest)
    const cdpSpec = u.searchParams.get('cdp')
    let cdp = { ...DEFAULT_CDP }
    if (cdpSpec) {
      const at = cdpSpec.lastIndexOf(':')
      if (at < 0) throw new Error(`endpoint cdp= is missing a port: ${cdpSpec}`)
      cdp = { host: cdpSpec.slice(0, at), port: Number(cdpSpec.slice(at + 1)) }
    }
    if (!isIpLiteral(cdp.host) && cdp.host !== 'localhost') {
      throw new Error(
        `endpoint cdp= host must be an IP or localhost (got ${cdp.host}):` +
          'DevTools validates the Host header; a domain or container name returns HTTP 500',
      )
    }
    return {
      name: name ?? 'default',
      kind: 'socks5',
      proxy: {
        host: u.hostname,
        port: Number(u.port || 1080),
        user: u.username ? decodeURIComponent(u.username) : undefined,
        pass: u.password ? decodeURIComponent(u.password) : undefined,
      },
      cdp,
      raw: spec,
    }
  }

  const withoutScheme = rest.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
  const at = withoutScheme.lastIndexOf(':')
  if (at < 0) throw new Error(`endpoint is missing a port: ${rest}`)
  const cdp = { host: withoutScheme.slice(0, at), port: Number(withoutScheme.slice(at + 1)) }
  if (!Number.isFinite(cdp.port) || cdp.port <= 0) throw new Error(`endpoint has an invalid port: ${rest}`)
  if (!isIpLiteral(cdp.host) && cdp.host !== 'localhost') {
    throw new Error(
      `endpoint host must be an IP or localhost (got ${cdp.host}):` +
        'DevTools validates the Host header; a domain or container name returns HTTP 500',
    )
  }
  return { name: name ?? 'default', kind: 'direct', cdp, raw: spec }
}

export function describeEndpoint(ep) {
  const cdp = `${ep.cdp.host}:${ep.cdp.port}`
  if (ep.kind === 'direct') return `${ep.name} → ${cdp} (direct)`
  const auth = ep.proxy.user ? `${ep.proxy.user}@` : ''
  return `${ep.name} → ${cdp} (via socks5 ${auth}${ep.proxy.host}:${ep.proxy.port})`
}

/** Dial a TCP connection to the endpoint's CDP port */
export async function dialCdp(ep, timeoutMs = 10_000) {
  if (ep.kind === 'direct') {
    return connectTcp(ep.cdp.host, ep.cdp.port, timeoutMs)
  }
  return socks5Connect({ proxy: ep.proxy, target: ep.cdp, timeoutMs })
}

/**
 * HTTP discovery: /json/version, falling back to /json/list.
 *
 * Chrome's /json/version carries a browser-level `webSocketDebuggerUrl`. Some CDP servers omit it
 * there and expose the WebSocket only per target: Node's V8 inspector answers /json/version with
 * just {Browser, Protocol-Version}. When that happens we take the first target's
 * `webSocketDebuggerUrl` from /json/list — for Node that endpoint *is* the main isolate's session,
 * so commands work on the root connection with no sessionId (see call()).
 * @returns {Promise<{ version: any, path: string, wsUrl: string }>}
 */
export async function discover(ep, timeoutMs = 10_000) {
  const socket = await dialCdp(ep, timeoutMs)
  let raw
  try {
    const version = await httpGetJson(socket, ep.cdp.host, ep.cdp.port, '/json/version')
    raw = version.webSocketDebuggerUrl
    if (raw) {
      const path = new URL(raw.replace(/^ws:/i, 'http:')).pathname
      return {
        version,
        path,
        // Normalize: always dial our own cdp host/port, keep only the path
        wsUrl: `ws://${ep.cdp.host}:${ep.cdp.port}${path}`,
      }
    }
  } finally {
    socket.destroy()
  }

  // /json/version had no WebSocket URL: fall back to the target list (e.g. Node's inspector).
  const list = await listTargets(ep, timeoutMs)
  const first = list.find((t) => t.webSocketDebuggerUrl)
  if (!first) throw new Error(`discovery failed: /json/version and /json/list both lack a webSocketDebuggerUrl on ${ep.cdp.host}:${ep.cdp.port}`)
  const path = new URL(first.webSocketDebuggerUrl.replace(/^ws:/i, 'http:')).pathname
  return {
    version: { Browser: first.type, fallbackTarget: first },
    path,
    wsUrl: `ws://${ep.cdp.host}:${ep.cdp.port}${path}`,
  }
}

/** List the endpoint's targets (`/json/list`) — a quick scan without opening a session */
export async function listTargets(ep, timeoutMs = 10_000) {
  const socket = await dialCdp(ep, timeoutMs)
  try {
    return await httpGetJson(socket, ep.cdp.host, ep.cdp.port, '/json/list')
  } finally {
    socket.destroy()
  }
}

/**
 * Connect the endpoint's browser-level WebSocket — one connection that owns every session
 * of that browser.
 * @returns {Promise<{ ws: WsConnection, version: any, wsUrl: string }>}
 */
export async function connectBrowser(ep, { timeoutMs = 15_000, maxPayload } = {}) {
  const { version, path, wsUrl } = await discover(ep, timeoutMs)
  const socket = await dialCdp(ep, timeoutMs)
  const ws = await WsConnection.connect({
    host: ep.cdp.host,
    port: ep.cdp.port,
    path,
    socket,
    timeoutMs,
    maxPayload,
    label: ep.name,
  })
  return { ws, version, wsUrl }
}
