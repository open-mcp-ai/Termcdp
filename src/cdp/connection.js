/**
 * CdpConnection — the CDP session layer on top of one browser WebSocket.
 *
 * Protocol facts that shape every line here:
 *  - Requests are `{id, method, params, sessionId?}`; responses are `{id, result|error, sessionId?}`.
 *  - Events are `{method, params, sessionId?}` and are **never replayed** — miss one and it's gone.
 *  - `id` counts within one connection; `sessionId` is the routing key (top-level field in flatten mode).
 *  - The protocol has **no backpressure**: a flood of `evaluate` calls can kill the renderer —
 *    hence the inflight gate below.
 */
import { EventEmitter } from 'node:events'

class CdpError extends Error {
  constructor(message, { code, data, method } = {}) {
    super(message)
    this.name = 'CdpError'
    this.code = code
    this.data = data
    this.method = method
  }
}

/** -32601 = method not found (used for graceful degradation when a browser lacks a domain) */
export const isUnsupported = (err) => err instanceof CdpError && err.code === -32601

export class CdpConnection extends EventEmitter {
  /**
   * @param {import('../transport/ws.js').WsConnection} ws
   */
  constructor(ws, { label = 'browser', defaultTimeoutMs = 30_000, maxInflight = 64 } = {}) {
    super()
    this.ws = ws
    this.label = label
    this.defaultTimeoutMs = defaultTimeoutMs
    this.maxInflight = maxInflight
    this.setMaxListeners(0)

    this._nextId = 1
    /** @type {Map<number, {resolve: Function, reject: Function, timer: any, method: string, startedAt: number}>} */
    this._pending = new Map()
    /** @type {Error|null} */
    this._closed = null
    this.inflight = 0
    /** @type {Array<() => void>} */
    this._waiters = []
    /** Stats — so status / UI can show "how much went over this connection" */
    this.stats = { sent: 0, received: 0, events: 0, errors: 0, bytesIn: 0, bytesOut: 0 }

    ws.on('message', (buf) => this._onMessage(buf))
    ws.on('close', () => this._failAll(new Error(`CDP connection closed (${this.label})`)))
    ws.on('error', (err) => this._failAll(err))
  }

  get closed() {
    return this._closed
  }

  /**
   * Send one CDP command.
   * @param {string} method
   * @param {object} [params]
   * @param {string} [sessionId]
   */
  async send(method, params = {}, sessionId, { timeoutMs } = {}) {
    if (this._closed) throw this._closed
    const ms = timeoutMs ?? this.defaultTimeoutMs
    await this._acquire()
    const id = this._nextId++
    let entry
    const promise = new Promise((resolve, reject) => {
      entry = {
        resolve,
        reject,
        startedAt: Date.now(),
        method,
        timer: setTimeout(() => {
          this._pending.delete(id)
          reject(new CdpError(`CDP command timed out: ${method} (${ms}ms, session=${sessionId ?? 'browser'})`, { method }))
        }, ms),
      }
      entry.timer.unref?.()
    })
    this._pending.set(id, entry)

    const message = sessionId ? { id, method, params, sessionId } : { id, method, params }
    const text = JSON.stringify(message)
    this.stats.sent++
    this.stats.bytesOut += text.length
    try {
      await this.ws.send(text)
    } catch (err) {
      this._pending.delete(id)
      clearTimeout(entry.timer)
      this._release()
      throw err
    }
    try {
      return await promise
    } finally {
      this._release()
    }
  }

  /** Subscribe to the event stream by prefix (for UI / status) */
  onEvent(handler) {
    this.on('event', handler)
    return () => this.off('event', handler)
  }

  close() {
    return this.ws.close()
  }

  destroy() {
    this.ws.destroy()
  }

  async _acquire() {
    if (this.inflight < this.maxInflight) {
      this.inflight++
      return
    }
    await new Promise((resolve) => this._waiters.push(resolve))
  }

  _release() {
    this.inflight--
    const waiter = this._waiters.shift()
    if (waiter) {
      this.inflight++
      waiter()
    }
  }

  _onMessage(buf) {
    const text = buf.toString('utf8')
    this.stats.bytesIn += text.length
    this.stats.received++
    let msg
    try {
      msg = JSON.parse(text)
    } catch {
      this.emit('protocol-error', new Error(`received a non-JSON message: ${text.slice(0, 200)}`))
      return
    }
    if (msg.id != null && this._pending.has(msg.id)) {
      const entry = this._pending.get(msg.id)
      this._pending.delete(msg.id)
      clearTimeout(entry.timer)
      if (msg.error) {
        this.stats.errors++
        entry.reject(
          new CdpError(
            `${msg.error.message}${msg.error.data ? ` :: ${msg.error.data}` : ''}`,
            { code: msg.error.code, data: msg.error.data, method: entry.method },
          ),
        )
      } else {
        entry.resolve(msg.result ?? {})
      }
      return
    }
    if (msg.method) {
      this.stats.events++
      const evt = {
        method: msg.method,
        params: msg.params ?? {},
        sessionId: msg.sessionId,
        at: Date.now(),
      }
      this.emit('event', evt)
      this.emit(`cdp:${msg.method}`, evt)
    }
  }

  _failAll(err) {
    if (this._closed) return
    this._closed = err
    for (const entry of this._pending.values()) {
      clearTimeout(entry.timer)
      entry.reject(err)
    }
    this._pending.clear()
    this._waiters.length = 0
    this.emit('closed', err)
  }
}
