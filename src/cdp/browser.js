/**
 * Browser — one CDP endpoint's browser WebSocket, plus every session it owns.
 *
 * Protocol facts that shape this structure:
 *  - **Connection count = browser count, not tab count**: one browser WebSocket plus flatten
 *    sessions covers every tab/worker.
 *  - `Target.setAutoAttach(flatten)` gives new targets a session automatically (new tab, iframe, worker).
 *  - Events are never replayed → a SeqLog keeps a numbered history so consumers can resume by `since`.
 *  - A disconnect invalidates every sessionId → `reconnect()` re-attaches and `replay()`s the
 *    desired state.
 */
import { EventEmitter } from 'node:events'
import { connectBrowser, dialCdp, listTargets } from '../transport/endpoint.js'
import { httpGetJson } from '../transport/http.js'
import { CdpConnection, isUnsupported } from './connection.js'
import { CdpSession } from './session.js'
import { SeqLog } from '../util/seq-log.js'

export class Browser extends EventEmitter {
  /**
   * Connect to an endpoint.
   * @param {object} endpoint the result of parseEndpoint(...)
   */
  static async connect(endpoint, { timeoutMs = 15_000, eventCapacity = 5000, label } = {}) {
    const { ws, version } = await connectBrowser(endpoint, { timeoutMs })
    const browser = new Browser(endpoint, new CdpConnection(ws, { label: label ?? endpoint.name }), version, {
      eventCapacity,
    })
    await browser.init()
    return browser
  }

  constructor(endpoint, conn, version, { eventCapacity = 5000 } = {}) {
    super()
    this.setMaxListeners(0)
    this.endpoint = endpoint
    this.version = version
    this.events = new SeqLog({ capacity: eventCapacity })
    /** @type {Map<string, CdpSession>} sessionId → session */
    this.sessions = new Map()
    /** @type {Map<string, string>} targetId → sessionId */
    this.byTarget = new Map()
    /** The targetIds we want to stay attached to (replayed by them on reconnect) */
    this.attached = new Set()
    /** @type {Map<string, object>} targetId → desired state (outlives any single session) */
    this.targetStates = new Map()
    /** @type {Map<string, object>} targetId → targetInfo */
    this.targets = new Map()
    this.connectedAt = Date.now()
    this.reconnects = 0
    this._autoAttach = null
    this._protocol = null
    this._wire(conn)
  }

  get name() {
    return this.endpoint.name
  }

  get connection() {
    return this._conn
  }

  get product() {
    return this.version?.Browser ?? this.version?.product ?? '?'
  }

  async init() {
    await this.setDiscoverTargets(true)
    await this.refreshTargets()
    return this
  }

  // ---------- Events ----------

  _wire(conn) {
    this._conn = conn
    this._onEvent = (evt) => this._handleEvent(evt)
    this._onClosed = (err) => {
      for (const s of this.sessions.values()) s._markClosed('connection closed')
      this.emit('disconnected', err)
    }
    conn.on('event', this._onEvent)
    conn.on('closed', this._onClosed)
  }

  _unwire() {
    this._conn?.off('event', this._onEvent)
    this._conn?.off('closed', this._onClosed)
  }

  _handleEvent(evt) {
    const rec = this.events.push({
      instance: this.name,
      method: evt.method,
      params: evt.params,
      sessionId: evt.sessionId,
      at: evt.at,
    })
    this.emit('event', rec)

    switch (evt.method) {
      case 'Target.attachedToTarget': {
        const { sessionId, targetInfo, waitingForDebugger } = evt.params
        this._adoptSession(sessionId, targetInfo, { waitingForDebugger })
        break
      }
      case 'Target.detachedFromTarget': {
        this._dropSession(evt.params.sessionId, 'detachedFromTarget')
        break
      }
      case 'Inspector.detached': {
        if (evt.sessionId) this._dropSession(evt.sessionId, `inspector: ${evt.params.reason ?? 'detached'}`)
        break
      }
      case 'Target.targetCreated':
      case 'Target.targetInfoChanged': {
        const info = evt.params.targetInfo
        if (info) this.targets.set(info.targetId, info)
        break
      }
      case 'Target.targetDestroyed': {
        this.targets.delete(evt.params.targetId)
        this.attached.delete(evt.params.targetId)
        break
      }
      case 'Target.targetCrashed': {
        this.emit('target-crashed', evt.params)
        break
      }
      default:
        break
    }
  }

  _stateFor(targetId) {
    let state = this.targetStates.get(targetId)
    if (!state) {
      state = { enabled: new Set(), emulation: new Map(), waitingForDebugger: false }
      this.targetStates.set(targetId, state)
    }
    return state
  }

  _adoptSession(sessionId, targetInfo, { waitingForDebugger = false } = {}) {
    const existing = this.sessions.get(sessionId)
    if (existing) return existing
    const targetId = targetInfo?.targetId ?? this.byTarget.get(sessionId) ?? sessionId
    const state = this._stateFor(targetId)
    if (waitingForDebugger) state.waitingForDebugger = true
    const session = new CdpSession(this, { sessionId, targetId, targetInfo, state })
    this.sessions.set(sessionId, session)
    this.byTarget.set(targetId, sessionId)
    if (targetInfo) this.targets.set(targetId, targetInfo)
    this.emit('session', session)
    if (waitingForDebugger) session.runIfWaitingForDebugger().catch(() => {})
    return session
  }

  _dropSession(sessionId, reason) {
    const session = this.sessions.get(sessionId)
    if (!session) return
    session._markClosed(reason)
    this.sessions.delete(sessionId)
    if (this.byTarget.get(session.targetId) === sessionId) this.byTarget.delete(session.targetId)
    this.emit('session-closed', { session, reason })
  }

  /** Events with a sequence number greater than `since` (for consumers resuming) */
  eventsSince(since = 0, opts = {}) {
    return this.events.since(since, opts)
  }

  /**
   * Wait for a **new session** (the Browser `session` event, not a CDP method name).
   * This is how you catch a tab opened by autoAttach — more reliable than guessing a targetId,
   * since the event can arrive before the `createTarget` response does.
   */
  waitForSession(predicate, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const onSession = (session) => {
        if (predicate && !predicate(session)) return
        cleanup()
        resolve(session)
      }
      const timer = timeoutMs
        ? setTimeout(() => {
            cleanup()
            reject(new Error(`timed out waiting for a new session (${timeoutMs}ms)`))
          }, timeoutMs)
        : null
      timer?.unref?.()
      const cleanup = () => {
        this.off('session', onSession)
        if (timer) clearTimeout(timer)
      }
      this.on('session', onSession)
    })
  }

  // ---------- Commands ----------

  send(method, params, { sessionId, timeoutMs } = {}) {
    return this._conn.send(method, params, sessionId, { timeoutMs })
  }

  async refreshTargets() {
    let targetInfos
    try {
      ({ targetInfos } = await this.send('Target.getTargets'))
    } catch (err) {
      if (!isUnsupported(err)) throw err
      // No Target domain (e.g. Node's V8 inspector exposes only Runtime/Debugger/Profiler/...)
      // — fall back to HTTP discovery, which every CDP server answers.
      const list = await listTargets(this.endpoint).catch(() => [])
      targetInfos = list.map((t) => ({ targetId: t.id, type: t.type, title: t.title, url: t.url, attached: true }))
    }
    for (const info of targetInfos ?? []) this.targets.set(info.targetId, info)
    return [...this.targets.values()]
  }

  listTargets({ type, exclude } = {}) {
    let list = [...this.targets.values()]
    if (type) {
      const wanted = Array.isArray(type) ? type : [type]
      list = list.filter((t) => wanted.includes(t.type))
    }
    if (exclude) {
      const bad = Array.isArray(exclude) ? exclude : [exclude]
      list = list.filter((t) => !bad.includes(t.type))
    }
    return list
  }

  async createTarget({ url = 'about:blank', ...rest } = {}) {
    const { targetId } = await this.send('Target.createTarget', { url, ...rest })
    return targetId
  }

  async closeTarget(targetId) {
    const res = await this.send('Target.closeTarget', { targetId }).catch((err) => {
      if (isUnsupported(err)) throw err
      return { success: false }
    })
    this.attached.delete(targetId)
    return res
  }

  /** Explicitly attach a target (idempotent: returns the existing session if already attached) */
  async attach(targetId) {
    // Register the intent *first*: autoAttach may already have created the session, in which case
    // we take the early return below — registering after would miss this target on reconnect.
    this.attached.add(targetId)
    const existingId = this.byTarget.get(targetId)
    if (existingId) {
      const existing = this.sessions.get(existingId)
      if (existing && !existing.closed) return existing
    }
    const { sessionId } = await this.send('Target.attachToTarget', { targetId, flatten: true })
    const info = this.targets.get(targetId) ?? { targetId, type: 'unknown', url: '' }
    return this._adoptSession(sessionId, info)
  }

  async detach(sessionId) {
    const session = this.sessions.get(sessionId)
    if (!session) return
    this.attached.delete(session.targetId)
    await this.send('Target.detachFromTarget', { sessionId }).catch(() => {})
    this._dropSession(sessionId, 'detached by client')
  }

  async setAutoAttach({ autoAttach = true, waitForDebuggerOnStart = false, filter } = {}) {
    const params = { autoAttach, waitForDebuggerOnStart, flatten: true }
    if (filter) params.filter = filter
    await this.send('Target.setAutoAttach', params)
    this._autoAttach = params
    return params
  }

  async setDiscoverTargets(discover = true) {
    try {
      await this.send('Target.setDiscoverTargets', { discover })
    } catch (err) {
      if (!isUnsupported(err)) throw err
    }
  }

  // ---------- Protocol bootstrap ----------

  /** Fetch the live protocol (cached). This is what "don't hardcode the command list" rests on */
  async loadProtocol({ force = false } = {}) {
    if (this._protocol && !force) return this._protocol
    const socket = await dialCdp(this.endpoint)
    try {
      this._protocol = await httpGetJson(socket, this.endpoint.cdp.host, this.endpoint.cdp.port, '/json/protocol')
    } finally {
      socket.destroy()
    }
    return this._protocol
  }

  /**
   * Reconnect after a dropped connection: re-dial → rebuild the connection → re-attach the
   * previously attached targets → replay the expectation state.
   * @returns {Promise<{reattached: string[], failed: Array<{targetId: string, error: string}>}>}
   */
  async reconnect({ timeoutMs = 15_000 } = {}) {
    if (this._reconnecting) return this._reconnecting
    this._reconnecting = (async () => {
      const wanted = [...this.attached]
      this._unwire()
      try {
        this._conn.destroy()
      } catch {
        /* ignore */
      }
      const { ws, version } = await connectBrowser(this.endpoint, { timeoutMs })
      this.version = version
      this._wire(new CdpConnection(ws, { label: this.name }))
      this.sessions.clear()
      this.byTarget.clear()
      this.targets.clear()
      this.reconnects++

      const report = { reattached: [], failed: [], autoAttach: false }
      await this.setDiscoverTargets(true)
      if (this._autoAttach) {
        try {
          await this.send('Target.setAutoAttach', this._autoAttach)
          report.autoAttach = true
        } catch (err) {
          report.failed.push({ targetId: '(autoAttach)', error: err.message })
        }
      }
      for (const targetId of wanted) {
        try {
          const session = await this.attach(targetId)
          await session.replay()
          report.reattached.push(targetId)
        } catch (err) {
          report.failed.push({ targetId, error: err.message })
        }
      }
      this.emit('reconnected', report)
      return report
    })().finally(() => {
      this._reconnecting = null
    })
    return this._reconnecting
  }

  async close() {
    for (const session of this.sessions.values()) session._markClosed('browser closed')
    this.sessions.clear()
    this.byTarget.clear()
    this.attached.clear()
    await this._conn.close().catch(() => {})
  }

  describe() {
    return {
      instance: this.name,
      endpoint: this.endpoint.raw ?? `${this.endpoint.cdp.host}:${this.endpoint.cdp.port}`,
      kind: this.endpoint.kind,
      product: this.product,
      protocolVersion: this.version?.['Protocol-Version'] ?? this.version?.protocolVersion,
      connected: !this._conn.closed,
      connectedForMs: Date.now() - this.connectedAt,
      reconnects: this.reconnects,
      targets: this.targets.size,
      sessions: this.sessions.size,
      autoAttach: this._autoAttach ?? null,
      clientStats: this._conn.stats,
      eventLog: this.events.stats(),
    }
  }
}
