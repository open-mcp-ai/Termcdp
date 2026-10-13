/**
 * BufferedSocket — read exactly N bytes, or read up to a delimiter, on top of a raw socket.
 *
 * Why: TCP fragmentation is not under our control, and the hand-written SOCKS5 / HTTP /
 * WebSocket handshakes all need deterministic reads on top of it. Node has nothing built-in
 * for this, so here it is.
 *
 * Single-consumer model: only one `read*` may be in flight at a time.
 */
export class BufferedSocket {
  /**
   * @param {import('node:net').Socket} socket
   * @param {Buffer} [rest] bytes already read but not yet consumed (e.g. left over after a SOCKS reply, or the head after a WS upgrade)
   */
  constructor(socket, rest) {
    this.socket = socket
    /** @type {Buffer} */
    this.buf = rest && rest.length ? Buffer.from(rest) : Buffer.alloc(0)
    this.closed = false
    /** @type {Error|null} */
    this.failure = null
    /** @type {(() => void)|null} */
    this._wake = null

    this._onData = (chunk) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
      this._signal()
    }
    this._onEnd = () => {
      this.closed = true
      this._signal()
    }
    this._onError = (err) => {
      this.failure = err
      this.closed = true
      this._signal()
    }
    socket.on('data', this._onData)
    socket.on('end', this._onEnd)
    socket.on('close', this._onEnd)
    socket.on('error', this._onError)
  }

  _signal() {
    const wake = this._wake
    this._wake = null
    if (wake) wake()
  }

  /** Wait until at least n bytes are buffered (or the connection ends / fails) */
  async need(n) {
    while (this.buf.length < n) {
      if (this.failure) throw this.failure
      if (this.closed) {
        throw new Error(
          `connection closed: needed ${n} bytes, got only ${this.buf.length}` +
            (this.buf.length ? ` (tail: ${JSON.stringify(this.buf.subarray(-48).toString('latin1'))})` : ''),
        )
      }
      await new Promise((resolve) => {
        this._wake = resolve
      })
    }
  }

  /** Read exactly n bytes */
  async read(n) {
    if (n === 0) return Buffer.alloc(0)
    await this.need(n)
    const out = this.buf.subarray(0, n)
    this.buf = this.buf.subarray(n)
    return out
  }

  /**
   * Read up to a delimiter (the delimiter itself is consumed and not returned).
   * @returns {Promise<Buffer>} everything before the delimiter
   */
  async readUntil(delim) {
    for (;;) {
      const at = this.buf.indexOf(delim)
      if (at >= 0) {
        const head = this.buf.subarray(0, at)
        this.buf = this.buf.subarray(at + delim.length)
        return head
      }
      if (this.failure) throw this.failure
      if (this.closed) {
        throw new Error(
          `connection closed before the delimiter arrived (buffered ${this.buf.length} bytes: ${JSON.stringify(this.buf.subarray(-64).toString('latin1'))})`,
        )
      }
      await new Promise((resolve) => {
        this._wake = resolve
      })
    }
  }

  /** Take the whole current buffer (leaves the connection alone) */
  take() {
    const out = this.buf
    this.buf = Buffer.alloc(0)
    return out
  }

  /** Read until the connection closes, returning everything that was left (for HTTP responses without Content-Length) */
  async readToEnd() {
    while (!this.closed) {
      await new Promise((resolve) => {
        this._wake = resolve
      })
    }
    if (this.failure) throw this.failure
    return this.take()
  }

  /** Remove the listeners and hand the socket back to the next layer (e.g. WebSocket frame decoding) */
  detach() {
    this.socket.off('data', this._onData)
    this.socket.off('end', this._onEnd)
    this.socket.off('close', this._onEnd)
    this.socket.off('error', this._onError)
    const rest = this.take()
    return { socket: this.socket, rest }
  }
}
