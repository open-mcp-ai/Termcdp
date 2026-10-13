/**
 * Minimal HTTP/1.1 client that runs on top of a socket we dialed ourselves.
 *
 * Why not `node:http`: we must control the Host header on that same socket (DevTools validates
 * it), and we need to issue requests over custom transports (SOCKS5, an existing SSH forward).
 * CDP's HTTP surface (`/json/*`) has small, simple responses, so Content-Length + chunked +
 * read-to-EOF are all the framing we need. No connection reuse.
 */
import { BufferedSocket } from '../util/buffered-socket.js'

export const CRLFCRLF = Buffer.from('\r\n\r\n')

/**
 * Parse one HTTP/1.1 header block (up to `\r\n\r\n`).
 * Shared by the plain HTTP client and the WebSocket handshake.
 * @returns {{ statusLine: string, status?: number, statusText?: string, headers: Record<string,string> }}
 *          `status` / `statusText` are present only when the status line matches `HTTP/1.x <code>`
 */
export function parseHeaderBlock(block) {
  const text = block.toString('latin1')
  const lines = text.split('\r\n')
  const statusLine = lines.shift() ?? ''
  const m = /^HTTP\/1\.[01] (\d{3})\s*(.*)$/.exec(statusLine)
  /** @type {Record<string,string>} */
  const headers = {}
  for (const line of lines) {
    if (!line) continue
    const at = line.indexOf(':')
    if (at < 0) continue
    const key = line.slice(0, at).trim().toLowerCase()
    const value = line.slice(at + 1).trim()
    headers[key] = headers[key] ? `${headers[key]}, ${value}` : value
  }
  return m
    ? { statusLine, status: Number(m[1]), statusText: m[2], headers }
    : { statusLine, headers }
}

async function readBody(reader, headers, head) {
  if (head.length) {
    // The body can occasionally arrive in the same chunk as the headers
  }
  const te = headers['transfer-encoding']
  if (te && /\bchunked\b/i.test(te)) {
    const chunks = [head]
    for (;;) {
      const sizeLine = (await reader.readUntil(Buffer.from('\r\n'))).toString('latin1')
      const size = parseInt(sizeLine.trim().split(';')[0], 16)
      if (!Number.isFinite(size)) throw new Error(`invalid chunked length: ${JSON.stringify(sizeLine)}`)
      if (size === 0) {
        await reader.readUntil(CRLFCRLF).catch(() => Buffer.alloc(0)) // trailer (tolerate its absence)
        break
      }
      chunks.push(await reader.read(size))
      await reader.read(2) // CRLF
    }
    return Buffer.concat(chunks)
  }
  const lenHeader = headers['content-length']
  if (lenHeader != null) {
    const len = Number(lenHeader)
    if (!Number.isFinite(len)) throw new Error(`invalid Content-Length: ${lenHeader}`)
    if (head.length >= len) return head.subarray(0, len)
    return Buffer.concat([head, await reader.read(len - head.length)])
  }
  // No length declared: read until the connection closes
  return Buffer.concat([head, await reader.readToEnd()])
}

/**
 * Send an HTTP/1.1 request over an already-connected socket.
 * @param {import('node:net').Socket} socket already connected (possibly via SOCKS)
 * @param {{ host: string, port: number, method?: string, path?: string, headers?: Record<string,string>, body?: Buffer|string, extraSocketText?: string }} opts
 */
async function httpRequestOnSocket(socket, opts) {
  const { host, port, method = 'GET', path = '/', headers = {}, body } = opts
  const bodyBuf = body == null ? null : Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8')

  const lines = [`${method} ${path} HTTP/1.1`, `Host: ${host}:${port}`, 'Connection: close']
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${v}`)
  if (bodyBuf) lines.push(`Content-Length: ${bodyBuf.length}`)
  const head = Buffer.from(lines.join('\r\n') + '\r\n\r\n', 'latin1')

  const reader = new BufferedSocket(socket, opts.extraSocketText ? Buffer.from(opts.extraSocketText, 'latin1') : undefined)
  socket.write(bodyBuf ? Buffer.concat([head, bodyBuf]) : head)

  const headerBlock = await reader.readUntil(CRLFCRLF)
  const parsed = parseHeaderBlock(headerBlock)
  if (parsed.status === undefined) {
    throw new Error(`could not parse the HTTP status line: ${JSON.stringify(parsed.statusLine.slice(0, 120))}`)
  }
  const bodyOut = await readBody(reader, parsed.headers, reader.take())
  reader.detach()
  return { ...parsed, body: bodyOut }
}

export async function httpGetJson(socket, host, port, path) {
  const res = await httpRequestOnSocket(socket, { host, port, method: 'GET', path })
  const text = res.body.toString('utf8')
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`HTTP ${res.status} ${res.statusText} @ ${path}：${text.slice(0, 200)}`)
  }
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`response is not valid JSON @ ${path}: ${text.slice(0, 200)}`)
  }
}
