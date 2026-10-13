/**
 * SOCKS5 client dial (RFC1928, with optional RFC1929 username/password auth).
 *
 * Why hand-written: Node has no SOCKS support built in, and `socks-proxy-agent` + `ws` would
 * add dependencies while taking control of the Host / Origin headers away from us — DevTools
 * validates both, so the handshake must be ours.
 *
 * Target addresses always use "remote resolution" semantics:
 *   - IPv4 literal → ATYP=0x01
 *   - IPv6 literal → ATYP=0x04
 *   - anything else (including `127.0.0.1`, when we want the proxy to resolve it on its end)
 *     → ATYP=0x03 domain name
 * That is what makes `socks5://…?cdp=127.0.0.1:9222` reach the *remote* machine's loopback.
 */
import { BufferedSocket } from '../util/buffered-socket.js'
import { connectTcp } from './tcp.js'

const SOCKS_VERSION = 0x05
const METHOD_NO_AUTH = 0x00
const METHOD_USERPASS = 0x02
const METHOD_NONE_ACCEPTABLE = 0xff

const REPLIES = {
  0x01: 'general SOCKS server failure',
  0x02: 'connection not allowed by ruleset',
  0x03: 'network unreachable',
  0x04: 'host unreachable',
  0x05: 'connection refused',
  0x06: 'TTL expired',
  0x07: 'command not supported',
  0x08: 'address type not supported',
}

const IPV4_RE = /^\d{1,3}(?:\.\d{1,3}){3}$/

/** Is `host` a dotted-quad IPv4 literal? (endpoint Host validation and ATYP encoding share one notion) */
export function isIpv4(host) {
  if (!IPV4_RE.test(host)) return false
  return host.split('.').map(Number).every((n) => n >= 0 && n <= 255)
}

/** Encode a target address as SOCKS5 ATYP + ADDR */
function encodeAddress(host) {
  if (isIpv4(host)) {
    const parts = host.split('.').map(Number)
    return Buffer.from([0x01, ...parts])
  }
  if (host.includes(':')) {
    // Simplified: standard 8-group or `::` IPv6 text only (no IPv4-in-IPv6 embedding)
    const groups = expandIpv6(host)
    if (groups) {
      const buf = Buffer.alloc(17)
      buf[0] = 0x04
      for (let i = 0; i < 8; i++) buf.writeUInt16BE(groups[i], 1 + i * 2)
      return buf
    }
  }
  const name = Buffer.from(host, 'utf8')
  if (name.length > 255) throw new Error(`hostname too long: ${host}`)
  return Buffer.concat([Buffer.from([0x03, name.length]), name])
}

function expandIpv6(host) {
  const [headPart, tailPart] = host.split('::')
  const head = headPart ? headPart.split(':').filter(Boolean) : []
  const tail = tailPart !== undefined ? (tailPart ? tailPart.split(':').filter(Boolean) : []) : null
  const parse = (xs) => xs.map((x) => (/^[0-9a-f]{1,4}$/i.test(x) ? parseInt(x, 16) : NaN))
  const h = parse(head)
  if (h.some(Number.isNaN)) return null
  if (tail === null) return h.length === 8 ? h : null
  const t = parse(tail)
  if (t.some(Number.isNaN)) return null
  const fill = 8 - h.length - t.length
  if (fill < 0) return null
  return [...h, ...Array(fill).fill(0), ...t]
}

/** Read and discard the reply's BND.ADDR (we don't need it, but it must be consumed) */
async function readBndAddress(reader, atyp) {
  if (atyp === 0x01) await reader.read(4)
  else if (atyp === 0x04) await reader.read(16)
  else if (atyp === 0x03) {
    const [len] = await reader.read(1)
    await reader.read(len)
  } else {
    throw new Error(`unknown ATYP in the SOCKS5 reply: 0x${atyp.toString(16)}`)
  }
  await reader.read(2) // BND.PORT
}

/**
 * Connect to a target through a SOCKS5 proxy.
 * @param {{ proxy: {host: string, port: number, user?: string, pass?: string}, target: {host: string, port: number}, timeoutMs?: number }} opts
 * @returns {Promise<import('node:net').Socket>}
 */
export async function socks5Connect({ proxy, target, timeoutMs = 10_000 }) {
  const socket = await connectTcp(proxy.host, proxy.port, timeoutMs)
  const reader = new BufferedSocket(socket)
  try {
    const wantAuth = proxy.user != null && proxy.user !== ''
    const methods = wantAuth ? [METHOD_NO_AUTH, METHOD_USERPASS] : [METHOD_NO_AUTH]
    socket.write(Buffer.from([SOCKS_VERSION, methods.length, ...methods]))

    const greeting = await reader.read(2)
    if (greeting[0] !== SOCKS_VERSION) {
      throw new Error(`SOCKS5 version mismatch: got 0x${greeting[0].toString(16)}`)
    }
    const method = greeting[1]
    if (method === METHOD_NONE_ACCEPTABLE) {
      throw new Error('SOCKS5 proxy rejected every authentication method (0xFF)')
    }
    if (method === METHOD_USERPASS) {
      if (!wantAuth) throw new Error('SOCKS5 proxy requires username/password, but none was provided')
      const u = Buffer.from(proxy.user, 'utf8')
      const p = Buffer.from(proxy.pass ?? '', 'utf8')
      socket.write(Buffer.concat([Buffer.from([0x01, u.length]), u, Buffer.from([p.length]), p]))
      const authReply = await reader.read(2)
      if (authReply[1] !== 0x00) {
        throw new Error(`SOCKS5 authentication failed (status 0x${authReply[1].toString(16)})`)
      }
    } else if (method !== METHOD_NO_AUTH) {
      throw new Error(`SOCKS5 proxy picked an unsupported authentication method: 0x${method.toString(16)}`)
    }

    const portBuf = Buffer.alloc(2)
    portBuf.writeUInt16BE(target.port, 0)
    socket.write(Buffer.concat([Buffer.from([SOCKS_VERSION, 0x01, 0x00]), encodeAddress(target.host), portBuf]))

    const replyHead = await reader.read(4)
    if (replyHead[0] !== SOCKS_VERSION) {
      throw new Error(`SOCKS5 reply version mismatch: 0x${replyHead[0].toString(16)}`)
    }
    const rep = replyHead[1]
    if (rep !== 0x00) {
      throw new Error(`SOCKS5 CONNECT failed: ${REPLIES[rep] ?? `unknown status 0x${rep.toString(16)}`} (${target.host}:${target.port})`)
    }
    await readBndAddress(reader, replyHead[3])

    const { rest } = reader.detach()
    if (rest.length) socket.unshift(rest)
    return socket
  } catch (err) {
    socket.destroy()
    throw err
  }
}
