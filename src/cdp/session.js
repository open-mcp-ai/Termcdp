/**
 * CdpSession — one flatten session on a target (the `sessionId` from `Target.attachToTarget`).
 *
 * Key design: **desired state lives on the target, not on the session.**
 * Sessions vanish on disconnect/reconnect, while "this tab should have Runtime/Network enabled
 * and should use this Emulation setup" is a fact that outlives any single session. `replay()`
 * re-applies that fact to a fresh session — something neither puppeteer nor CRI does, but that
 * a long-lived multi-instance console must do.
 */
import { EventEmitter } from 'node:events'
import { readStream } from './objects.js'

/** Pull the value out of a `Runtime.evaluate` response and turn exceptions into readable errors */
function unwrapEvaluate(response) {
  if (!response) return undefined
  if (response.exceptionDetails) {
    const ex = response.exceptionDetails
    const text = ex.exception?.description ?? ex.text ?? 'Runtime exception'
    const err = new Error(text)
    err.name = 'EvaluationError'
    err.exceptionDetails = ex
    throw err
  }
  const r = response.result ?? {}
  if (r.type === 'undefined') return undefined
  if ('value' in r) return r.value
  return r.description ?? r.objectId
}

export class CdpSession extends EventEmitter {
  constructor(browser, { sessionId, targetId, targetInfo, state }) {
    super()
    this.setMaxListeners(0)
    this.browser = browser
    this.sessionId = sessionId
    this.targetId = targetId
    this.targetInfo = targetInfo
    /** @type {{ enabled: Set<string>, emulation: Map<string, object>, waitingForDebugger: boolean }} */
    this.state = state
    this.closed = false
    this.createdAt = Date.now()
    this.closeReason = null
  }

  get url() {
    return this.targetInfo?.url
  }

  get type() {
    return this.targetInfo?.type
  }

  send(method, params, opts) {
    if (this.closed) throw new Error(`session closed (${this.sessionId.slice(0, 6)}…, ${this.closeReason ?? 'unknown'})`)
    return this.browser.connection.send(method, params, this.sessionId, opts)
  }

  /**
   * Enable domains (idempotent; recorded as desired state so a reconnect can replay it).
   * @param {...string} domains
   */
  async enable(...domains) {
    for (const domain of domains) {
      if (this.state.enabled.has(domain)) continue
      await this.send(`${domain}.enable`)
      this.state.enabled.add(domain)
    }
    return this
  }

  /** `Emulation.*` is session-scoped in the protocol and is lost on disconnect, so track it too */
  async setEmulation(method, params) {
    const full = method.startsWith('Emulation.') ? method : `Emulation.${method}`
    await this.send(full, params)
    this.state.emulation.set(full, params)
    return this
  }

  /** Re-apply the desired state to this session (after a reconnect / on a fresh session) */
  async replay() {
    const report = { enabled: [], emulation: [], failed: [] }
    for (const domain of this.state.enabled) {
      try {
        await this.send(`${domain}.enable`)
        report.enabled.push(domain)
      } catch (err) {
        report.failed.push({ what: `${domain}.enable`, error: err.message })
      }
    }
    for (const [method, params] of this.state.emulation) {
      try {
        await this.send(method, params)
        report.emulation.push(method)
      } catch (err) {
        report.failed.push({ what: method, error: err.message })
      }
    }
    if (this.state.waitingForDebugger) {
      await this.runIfWaitingForDebugger()
    }
    return report
  }

  async runIfWaitingForDebugger() {
    await this.send('Runtime.runIfWaitingForDebugger').catch(() => {})
    this.state.waitingForDebugger = false
    return this
  }

  /** Evaluate (awaiting the result by default, returning the value; exceptions become errors) */
  async evaluate(expression, { returnByValue = true, awaitPromise = true, userGesture = false, timeoutMs } = {}) {
    const res = await this.send(
      'Runtime.evaluate',
      { expression, returnByValue, awaitPromise, userGesture, replMode: false },
      { timeoutMs },
    )
    return unwrapEvaluate(res)
  }

  /**
   * Navigate, then wait for the page to settle on a CDP lifecycle event rather than sleeping.
   * @param {string} url
   * @param {{ waitUntil?: 'load'|'domContentLoaded'|'networkIdle', timeoutMs?: number }} [opts]
   */
  async navigate(url, { waitUntil = 'load', timeoutMs = 30_000 } = {}) {
    await this.enable('Page')
    await this.send('Page.setLifecycleEventsEnabled', { enabled: true })
    const wanted =
      waitUntil === 'networkIdle'
        ? ['networkIdle', 'networkAlmostIdle', 'load']
        : waitUntil === 'domContentLoaded'
          ? ['DOMContentLoaded', 'load']
          : ['load']
    const settled = this.waitForEvent(
      'Page.lifecycleEvent',
      (e) => wanted.includes(e.params.name),
      timeoutMs,
    ).catch(() => null)
    const result = await this.send('Page.navigate', { url })
    if (result.errorText) throw new Error(`navigation failed: ${result.errorText} (${url})`)
    await settled
    return result
  }

  /**
   * Wait for an event belonging to this session.
   * @param {string} method
   * @param {(evt: object) => boolean} [predicate]
   */
  waitForEvent(method, predicate, timeoutMs = 15_000) {
    return new Promise((resolve, reject) => {
      const onEvent = (evt) => {
        if (evt.method !== method || evt.sessionId !== this.sessionId) return
        if (predicate && !predicate(evt)) return
        cleanup()
        resolve(evt)
      }
      const timer = timeoutMs
        ? setTimeout(() => {
            cleanup()
            reject(new Error(`timed out waiting for event: ${method} (${timeoutMs}ms)`))
          }, timeoutMs)
        : null
      timer?.unref?.()
      const cleanup = () => {
        this.browser.connection.off('event', onEvent)
        if (timer) clearTimeout(timer)
      }
      this.browser.connection.on('event', onEvent)
    })
  }

  /** Screenshot → Buffer (in memory; the CDP layer never touches disk) */
  async screenshotBuffer(params = {}) {
    const shot = await this.send('Page.captureScreenshot', { format: 'png', ...params })
    return Buffer.from(shot.data, 'base64')
  }

  /** Read any CDP stream handle (Fetch.takeResponseBodyAsStream / Tracing / HeapProfiler …) */
  readStreamHandle(handle, opts) {
    return readStream(this, handle, opts)
  }

  /** Session-level state snapshot (for UI / status) */
  describe() {
    return {
      sessionId: this.sessionId,
      targetId: this.targetId,
      type: this.type,
      url: this.url,
      title: this.targetInfo?.title,
      attached: !this.closed,
      enabledDomains: [...this.state.enabled],
      emulation: [...this.state.emulation.keys()],
      ageMs: Date.now() - this.createdAt,
    }
  }

  close() {
    return this.browser.detach(this.sessionId)
  }

  /** @internal called by Browser */
  _markClosed(reason) {
    if (this.closed) return
    this.closed = true
    this.closeReason = reason
    this.emit('closed', reason)
  }
}
