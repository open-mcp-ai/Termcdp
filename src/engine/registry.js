/**
 * Registry — the multi-instance registry: the single authority on endpoint × browser × target ×
 * session, plus the **result store** (every CDP payload is handed out as a receipt + id; see
 * `results.js`).
 *
 * Event sequence numbers are **globally monotonic** (not per-browser), so `events --since n` works
 * across instances.
 *
 * **Nothing is persisted.** Instances live in memory only: each MCP connection starts empty, the
 * model adds the instances it needs, and process exit drops them all. There is no config file,
 * no audit log, no export directory — the process is a pure, stateless translator from MCP to CDP.
 *
 * This file keeps only "authoritative state + lifecycle":
 *  - state: `instances` (Map), `results` (the store), `eventLog`;
 *  - lifecycle: add / remove / ensure / ensureAll / disconnect / closeAll;
 *  - read-only views: describe / list / events / protocol / status.
 *
 * Three other concerns have been split out (pure relocation — behavior, error codes and event
 * ordering unchanged; each file header says why):
 *  - `event-wiring.js` — event ring wiring and the reconnect timers (attach/detach listeners, backoff);
 *  - `routing.js`       — command routing (targets/attach/detach/sessions/call/batch);
 *  - `results.js`       — the result read side (read/resultIndex).
 *  The private methods they needed across modules are now "public but documented as internal":
 *  `#get`→`getInstance`, `#changed`→`changed`, `#log`→`logLine` (`#register` stays private; only
 *  `add` uses it).
 *
 * ⚠️ The one-line forwarding methods below **are** the public API itself (the dispatcher in
 * `local-client.js` calls them by name) — do not "simplify" callers into using routing/results
 * directly just because these only forward; that would change the calling contract.
 */
import { EventEmitter } from 'node:events'
import { parseEndpoint, describeEndpoint } from '../transport/endpoint.js'
import { Browser } from '../cdp/browser.js'
import { SeqLog } from '../util/seq-log.js'
import { ResultStore, readResult, listResults, DEFAULT_EVENT_INLINE_BYTES } from './results.js'
import { TermcdpError } from './errors.js'
import { PATH_RESERVED } from '../protocol/paths.js'
import * as routing from './routing.js'
import { wireOn, unwire, cancelReconnect } from './event-wiring.js'
import { fetchUrl } from './fetch.js'

const firstLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().split(/(?<=\.)\s/)[0].slice(0, 200)

export class Registry extends EventEmitter {
  constructor({
    eventCapacity = 20_000,
    autoReconnect = true,
    storeBytes,
    store,
  } = {}) {
    super()
    this.setMaxListeners(0)
    /** The result store: where every CDP payload lives (receipts + ids) */
    this.results = store ?? new ResultStore(storeBytes ? { maxBytes: storeBytes } : {})
    // Note: deliberately not this.events — that would shadow the events() method below
    this.eventLog = new SeqLog({ capacity: eventCapacity })
    /** @type {Map<string, any>} */
    this.instances = new Map()
    this.autoReconnect = autoReconnect
    this.startedAt = Date.now()
  }

  // ---------- Instance CRUD ----------

  /** Internal: only for `add`, not part of the public surface */
  #register(name, spec) {
    if (this.instances.has(name)) throw new TermcdpError(`instance already exists: ${name}`, 'exists')
    const endpoint = parseEndpoint(spec, name)
    endpoint.name = name
    const state = {
      name,
      spec,
      endpoint,
      browser: null,
      status: 'idle',
      error: null,
      connecting: null,
      connectedAt: null,
      reconnectTimer: null,
      reconnectAttempts: 0,
      /** true = disconnected deliberately via instances disconnect → no auto-reconnect, and lazy-connect paths refuse too */
      intentional: false,
      /** @type {Array<[string, Function]>|null} listeners attached to the Browser; must be removed before a deliberate close */
      listeners: null,
    }
    this.instances.set(name, state)
    return state
  }

  async add({ name, spec, connect = true }) {
    if (!name || !spec) throw new TermcdpError('add requires name and spec', 'invalid')
    // The invoke path grammar is dotted (`lab1.S1.call`) with `@` marking a transient target
    // (lab1@targetId.call), so a name carrying either would be ambiguous; reserved root words are
    // refused for the same reason — `instances.add` would never be reachable otherwise.
    if (/[.@\s]/.test(name)) {
      throw new TermcdpError(`instance name must not contain '.', '@' or whitespace: ${JSON.stringify(name)}`, 'invalid')
    }
    if (PATH_RESERVED.has(name)) {
      throw new TermcdpError(`instance name is reserved (it is a root word of the invoke path grammar): ${name}`, 'invalid')
    }
    const state = this.#register(name, spec)
    this.changed(state)
    if (connect) {
      await this.ensure(name, { force: true }).catch(() => {})
    }
    return this.describe(state)
  }

  async remove(name) {
    const state = this.getInstance(name)
    // Deliberate removal → **unwire the listeners before close**. Otherwise close() trips the
    // "connection lost" path and pushes a `dead` event for an instance that no longer exists.
    state.intentional = true
    cancelReconnect(state)
    unwire(state)
    await state.browser?.close().catch(() => {})
    state.browser = null
    this.instances.delete(name)
    return { removed: name }
  }

  /** Internal: cross-module access to instance state (formerly `#get`; routing / the read side need it). `describe` remains the public view. */
  getInstance(name) {
    const state = this.instances.get(name)
    if (!state) {
      const known = [...this.instances.keys()]
      throw new TermcdpError(
        known.length ? `unknown instance: ${name} (known: ${known.join(', ')})` : `unknown instance: ${name} (no instances at all yet — add one with instances add first)`,
        'unknown-instance',
      )
    }
    return state
  }

  /** Internal: state-change broadcast (formerly `#changed`); `local-client` depends on this emit semantics */
  changed(state) {
    this.emit('instance-changed', this.describe(state))
  }

  /** Internal: log broadcast (formerly `#log`); `local-client` depends on this emit semantics */
  logLine(message, level = 'info') {
    this.emit('log', { at: Date.now(), level, message })
  }

  describe(state) {
    const browser = state.browser
    const connected = !!browser && !browser.connection.closed
    return {
      name: state.name,
      spec: state.spec,
      kind: state.endpoint.kind,
      target: `${state.endpoint.cdp.host}:${state.endpoint.cdp.port}`,
      via: state.endpoint.kind === 'socks5' ? `${state.endpoint.proxy.host}:${state.endpoint.proxy.port}` : null,
      status: state.status,
      error: state.error,
      /** true = disconnected deliberately via instances disconnect (not a crash) */
      manuallyDisconnected: !!state.intentional,
      connected,
      product: connected ? browser.product : null,
      targets: connected ? browser.targets.size : 0,
      sessions: connected ? browser.sessions.size : 0,
      attachedTargets: connected ? browser.attached.size : 0,
      reconnects: connected ? browser.reconnects : 0,
      connectedForMs: state.connectedAt ? Date.now() - state.connectedAt : null,
      autoAttach: connected ? (browser._autoAttach ?? null) : null,
    }
  }

  list() {
    return [...this.instances.values()].map((st) => this.describe(st))
  }

  /**
   * Connect an instance (with concurrent-call dedup).
   *
   * `force: true` is only for **explicit** connects (instances connect / connect-all / add).
   * The lazy-connect paths (call / attach / targets / protocol) do not pass it, so an instance that
   * was deliberately disconnected by instances disconnect is **never silently reconnected** — it
   * errors out explicitly instead. Without this, a single call right after a disconnect would bring
   * it back within milliseconds.
   */
  async ensure(name, { timeoutMs = 15_000, force = false } = {}) {
    const state = this.getInstance(name)
    if (state.browser && !state.browser.connection.closed) return state.browser
    if (state.intentional && !force) {
      throw new TermcdpError(
        `instance ${name} was disconnected deliberately (instances disconnect); run instances connect to reconnect`,
        'instance-disconnected',
      )
    }
    if (force) state.intentional = false
    if (state.connecting) return state.connecting
    state.connecting = (async () => {
      state.status = 'connecting'
      state.error = null
      this.changed(state)
      try {
        const browser = await Browser.connect(state.endpoint, { timeoutMs, label: name })
        wireOn(this, state, browser)
        state.browser = browser
        state.status = 'ready'
        state.intentional = false
        state.connectedAt = Date.now()
        state.reconnectAttempts = 0
        this.logLine(`instance ${name} connected (${describeEndpoint(state.endpoint)})`)
        this.changed(state)
        return browser
      } catch (err) {
        state.status = 'error'
        state.error = err.message
        this.changed(state)
        throw new TermcdpError(`failed to connect instance ${name}: ${err.message}`, 'connect-failed')
      } finally {
        state.connecting = null
      }
    })()
    return state.connecting
  }

  /**
   * Connect every registered instance (concurrently; failures are recorded per instance, never thrown).
   * A one-shot CLI command must call this: right after startup there are no connections at all, and
   * without it the aggregated `targets` view would come back empty.
   */
  async ensureAll({ timeoutMs = 15_000 } = {}) {
    const names = [...this.instances.keys()]
    const report = { connected: [], failed: [] }
    await Promise.all(
      names.map(async (name) => {
        try {
          await this.ensure(name, { timeoutMs, force: true })
          report.connected.push(name)
        } catch (err) {
          report.failed.push({ name, error: err.message })
        }
      }),
    )
    return report
  }

  /**
   * Deliberately disconnect an instance (**sticky**): the listeners are unwired before close, so the
   * "connection lost" path never takes over. With `intentional` set there is no auto-reconnect, and
   * the lazy-connect paths report an explicit error instead of reconnecting in silence.
   */
  async disconnect(name) {
    const state = this.getInstance(name)
    state.intentional = true
    cancelReconnect(state)
    unwire(state)
    if (state.browser) {
      await state.browser.close().catch(() => {})
      state.browser = null
    }
    state.status = 'idle'
    state.error = null
    state.connectedAt = null
    this.logLine(`instance ${name} disconnected manually (no auto-reconnect; run instances connect to reconnect)`)
    this.changed(state)
    return this.describe(state)
  }

  async closeAll() {
    for (const state of this.instances.values()) {
      state.intentional = true
      cancelReconnect(state)
      unwire(state)
      await state.browser?.close().catch(() => {})
      state.browser = null
      state.status = 'idle'
    }
  }

  // ---------- target / session / execution: forwarded to routing ----------
  // Each is a one-line forward: the signature and return shape must stay **verbatim** as before the
  // split (the dispatcher calls them by name).

  async targets(opts) {
    return routing.targets(this, opts)
  }

  async attach(opts) {
    return routing.attach(this, opts)
  }

  async detach(opts) {
    return routing.detach(this, opts)
  }

  async sessions(opts) {
    return routing.sessions(this, opts)
  }

  async call(spec) {
    return routing.call(this, spec)
  }

  async batch(opts) {
    return routing.batch(this, opts)
  }

  // ---------- Receipt read side: forwarded to results ----------

  read(opts) {
    return readResult(this.results, opts)
  }

  resultIndex(opts) {
    return listResults(this.results, opts)
  }

  // ---------- Fetch: pull a URL into the store (no instance involved) ----------

  async fetch(opts) {
    return fetchUrl(this, opts)
  }

  // ---------- Events and protocol ----------

  events({
    since = 0,
    instance,
    sessionId,
    method,
    prefix,
    limit = 50,
    order = 'asc',
    inlineBytes = DEFAULT_EVENT_INLINE_BYTES,
  } = {}) {
    const list = this.eventLog.since(since, { instance, sessionId, method, prefix, limit, order })
    // The ring holds metadata only; the body is fetched on demand against the caller's inlineBytes
    // (complete or nothing)
    const events = list.map((e) => {
      const receipt = this.results.receipt(e.resultId, { inlineBytes, missingOk: true })
      // When the payload has been FIFO-evicted from the store, the event itself is still visible
      // (its sequence number and filter fields are in the ring) — only the body is gone
      return { n: e.n, ...(receipt ?? { resultId: e.resultId, instance: e.instance, at: e.at, evicted: true }) }
    })
    return { events, latest: this.eventLog.latest, log: this.eventLog.stats() }
  }

  /** Protocol bootstrap: fetch signatures from the **live browser** (the command list is never hardcoded) */
  async protocol({ instance, domain, search } = {}) {
    if (!instance) throw new TermcdpError('protocol requires instance', 'invalid')
    const browser = await this.ensure(instance)
    const proto = await browser.loadProtocol()
    const domains = proto.domains ?? []
    if (!domain) {
      return {
        instance,
        protocolVersion: proto.version,
        domains: domains.map((d) => ({
          domain: d.domain,
          commands: (d.commands ?? []).length,
          events: (d.events ?? []).length,
          types: (d.types ?? []).length,
          experimental: !!d.experimental,
          description: firstLine(d.description),
        })),
      }
    }
    const found = domains.find((d) => d.domain.toLowerCase() === String(domain).toLowerCase())
    if (!found) {
      throw new TermcdpError(
        `no domain ${domain} in the live protocol (available: ${domains.map((d) => d.domain).join(', ')})`,
        'unknown-domain',
      )
    }
    let commands = found.commands ?? []
    if (search) {
      const q = String(search).toLowerCase()
      commands = commands.filter((c) => c.name.toLowerCase().includes(q))
    }
    return {
      instance,
      domain: found.domain,
      description: firstLine(found.description),
      experimental: !!found.experimental,
      commands: commands.map((c) => ({
        name: c.name,
        parameters: (c.parameters ?? []).map((x) => ({
          name: x.name,
          type: x.type,
          optional: !!x.optional,
          description: firstLine(x.description),
        })),
        returns: (c.returns ?? []).map((x) => ({ name: x.name, type: x.type })),
        experimental: !!c.experimental,
        deprecated: !!c.deprecated,
        description: firstLine(c.description),
      })),
      events: (found.events ?? []).map((e) => ({
        name: e.name,
        parameters: (e.parameters ?? []).map((x) => ({ name: x.name, type: x.type, optional: !!x.optional })),
        description: firstLine(e.description),
      })),
      types: (found.types ?? []).map((t) => ({ id: t.id, type: t.type })),
    }
  }

  status() {
    return {
      startedAt: this.startedAt,
      uptimeMs: Date.now() - this.startedAt,
      instances: this.list(),
      sessions: [...this.instances.values()].reduce(
        (n, st) => n + (st.browser && !st.browser.connection.closed ? st.browser.sessions.size : 0),
        0,
      ),
      eventLog: this.eventLog.stats(),
      results: this.results.stats(),
    }
  }
}
