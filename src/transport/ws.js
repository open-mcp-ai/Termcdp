/**
 * Hand-written WebSocket client (RFC6455 — client side only, no extensions, no compression).
 *
 * Why hand-written:
 *  1) The handshake must run on a socket we dialed ourselves (possibly via SOCKS5). `ws` would
 *     need an agent, which means a dependency.
 *  2) CDP rejects non-whitelisted `Origin` headers (unless Chrome was given
 *     --remote-allow-origins). Writing the handshake ourselves means we simply never send one,
 *     and that whole class of failure disappears.
 *  3) Full control over the `Host` header (DevTools validates it) and over the max frame size.
 *
 * Supports: text/binary frames, fragment reassembly, ping→pong, close handshake, 64-bit lengths,
 * client-side masking, and write-side backpressure.
 */
import crypto from 'node:crypto'
import { EventEmitter } from 'node:events'
import { BufferedSocket } from '../util/buffered-socket.js'
import { connectTcp } from './tcp.js'
import { parseHeaderBlock, CRLFCRLF } from './http.js'
import { withTimeout } from '../util/async.js'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

const OP_CONT = 0x0
const OP_TEXT = 0x1
const OP_BINARY = 0x2
const OP_CLOSE = 0x8
const OP_PING = 0x9
const OP_PONG = 0xa

export class WsConnection extends EventEmitter {
  #socket
  #reader
  #sendChain = Promise.resolve()
  #closed = false
  #maxPayload
  #meta

  constructor(socket, rest, meta) {
    super()
    this.#socket = socket
    this.#reader = new BufferedSocket(socket, rest)
    this.#maxPayload = meta.maxPayload ?? 256 * 1024 * 1024
    this.#meta = meta
    this.setMaxListeners(0)
    this.#pump()
  }

  get closed() {
    return this.#closed
  }

  get meta() {
    return this.#meta
  }

  /**
   * Establish the WebSocket connection.
   * @param {{ host: string, port: number, path: string, socket?: import('node:net').Socket,
   *           rest?: Buffer, headers?: Record<string,string>, timeoutMs?: number, maxPayload?: number,
   *           label?: string }} opts
   */
  static async connect(opts) {
    const { host, port, path = '/', headers = {}, timeoutMs = 15_000 } = opts
    const socket = opts.socket ?? (await connectTcp(host, port, timeoutMs))
    const key = crypto.randomBytes(16).toString('base64')
    // Deliberately no Origin header: Chrome rejects DevTools connections with a non-whitelisted Origin
    const requestLines = [
      `GET ${path} HTTP/1.1`,
      `Host: ${host}:${port}`,
      'Upgrade: websocket',
      'Connection: Upgrade',
      `Sec-WebSocket-Key: ${key}`,
      'Sec-WebSocket-Version: 13',
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      '',
      '',
    ]
    const reader = new BufferedSocket(socket, opts.rest)
    socket.write(Buffer.from(requestLines.join('\r\n'), 'latin1'))

    let block
    try {
      block = await withTimeout(
        reader.readUntil(CRLFCRLF),
        timeoutMs,
        `WebSocket upgrade timed out (${host}:${port}${path})`,
      )
    } catch (err) {
      socket.destroy()
      throw err
    }
    const { statusLine, status, headers: resHeaders } = parseHeaderBlock(block)
    if (status !== 101) {
      const hint =
        status === 400
          ? ' (most likely the Host header was rejected by DevTools: make sure you connect to 127.0.0.1, not a domain name)'
          : status === 403
            ? ' (most likely the Origin check: send no Origin header, or launch Chrome with --remote-allow-origins)'
            : ''
      socket.destroy()
      throw new Error(`WebSocket upgrade rejected (HTTP ${status ?? '?'}): ${statusLine}${hint}`)
    }
    const accept = crypto.createHash('sha1').update(key + GUID).digest('base64')
    if (resHeaders['sec-websocket-accept'] !== accept) {
      socket.destroy()
      throw new Error('Sec-WebSocket-Accept mismatch (not a real WebSocket server?)')
    }
    const { socket: sock2, rest } = reader.detach()
    return new WsConnection(sock2, rest, { ...opts, maxPayload: opts.maxPayload })
  }

  /** Send text (what CDP uses) or binary */
  send(payload, { binary = false } = {}) {
    const opcode = binary ? OP_BINARY : OP_TEXT
    const data = Buffer.isBuffer(payload) ? payload : Buffer.from(String(payload), 'utf8')
    this.#sendChain = this.#sendChain.then(() => this.#writeFrame(opcode, data))
    return this.#sendChain
  }

  ping(payload = Buffer.alloc(0)) {
    this.#sendChain = this.#sendChain.then(() => this.#writeFrame(OP_PING, payload))
    return this.#sendChain
  }

  /** Send a close frame and close the socket */
  close(code = 1000, reason = '') {
    if (this.#closed) {
      this.#socket.destroy()
      return Promise.resolve()
    }
    const reasonBuf = Buffer.from(reason, 'utf8')
    const payload = Buffer.alloc(2 + reasonBuf.length)
    payload.writeUInt16BE(code, 0)
    reasonBuf.copy(payload, 2)
    this.#sendChain = this.#sendChain
      .then(() => this.#writeFrame(OP_CLOSE, payload))
      .catch(() => {})
      .then(() => {
        this.#closed = true
        this.#socket.end()
      })
    return this.#sendChain
  }

  destroy() {
    this.#closed = true
    this.#socket.destroy()
  }

  async #writeFrame(opcode, data) {
    if (this.#closed) throw new Error('WebSocket is closed')
    const len = data.length
    const mask = crypto.randomBytes(4)
    let ext
    if (len < 126) {
      ext = Buffer.from([0x80 | len])
    } else if (len < 65536) {
      ext = Buffer.alloc(3)
      ext[0] = 0x80 | 126
      ext.writeUInt16BE(len, 1)
    } else {
      ext = Buffer.alloc(9)
      ext[0] = 0x80 | 127
      ext.writeBigUInt64BE(BigInt(len), 1)
    }
    const masked = Buffer.allocUnsafe(len)
    for (let i = 0; i < len; i++) masked[i] = data[i] ^ mask[i & 3]
    const frame = Buffer.concat([Buffer.from([0x80 | opcode]), ext, mask, masked])
    const ok = this.#socket.write(frame)
    if (!ok) {
      await new Promise((resolve) => this.#socket.once('drain', resolve))
    }
  }

  async #readFrame() {
    const head = await this.#reader.read(2)
    const fin = (head[0] & 0x80) !== 0
    if (head[0] & 0x70) throw new Error('received a frame with RSV bits set (no extensions are supported)')
    const opcode = head[0] & 0x0f
    const masked = (head[1] & 0x80) !== 0
    let len = head[1] & 0x7f
    if (len === 126) {
      len = (await this.#reader.read(2)).readUInt16BE(0)
    } else if (len === 127) {
      const big = (await this.#reader.read(8)).readBigUInt64BE(0)
      if (big > BigInt(this.#maxPayload)) {
        throw new Error(`frame length ${big} exceeds the limit ${this.#maxPayload}`)
      }
      len = Number(big)
    }
    if (len > this.#maxPayload) throw new Error(`frame length ${len} exceeds the limit ${this.#maxPayload}`)
    let mask = null
    if (masked) mask = await this.#reader.read(4)
    const payload = len ? Buffer.from(await this.#reader.read(len)) : Buffer.alloc(0)
    if (mask) {
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
    }
    return { fin, opcode, payload }
  }

  async #pump() {
    /** @type {Buffer|null} */
    let frag = null
    let fragOpcode = 0
    try {
      for (;;) {
        const { fin, opcode, payload } = await this.#readFrame()
        if (opcode === OP_PING) {
          this.#sendChain = this.#sendChain.then(() => this.#writeFrame(OP_PONG, payload)).catch(() => {})
          continue
        }
        if (opcode === OP_PONG) continue
        if (opcode === OP_CLOSE) {
          const code = payload.length >= 2 ? payload.readUInt16BE(0) : undefined
          this.emit('closing', { code, reason: payload.subarray(2).toString('utf8') })
          break
        }
        if (opcode === OP_CONT) {
          if (!frag) throw new Error('received an orphan continuation frame (no start frame)')
          frag = Buffer.concat([frag, payload])
        } else {
          if (frag) throw new Error('a new data frame arrived before the previous fragmented message finished')
          frag = payload
          fragOpcode = opcode
        }
        if (fin) {
          const data = frag
          frag = null
          this.emit('message', data, fragOpcode === OP_BINARY)
        }
      }
    } catch (err) {
      this.emit('error', err)
    } finally {
      this.#closed = true
      this.emit('close')
    }
  }
}
