/**
 * event-wiring — the event plumbing: funnel each instance's Browser events into the global log,
 * and own the reconnect timers.
 *
 * What lives here:
 *  - events into the ring (`pushGlobal`: params into the result store, only receipts in the ring);
 *  - listener attach/detach (`wireOn` / `unwire`);
 *  - exponential-backoff reconnect after an *unintended* disconnect (`scheduleReconnect` / `cancelReconnect`).
 *
 * Why separate from registry: the registry is "which state is authoritative" (instances / results /
 * lifecycle CRUD), while this module is "listeners and timers hung off someone else's objects" —
 * a distinct set of ordering hazards (backfill order, detach-before-close, the `intentional` guard,
 * reconnect dedup) that would be invisible inside a registry doing all of it.
 *
 * Convention: these functions hold no state of their own; state lives on the registry's `state`.
 * `reg` is the Registry, used only for `reg.results` / `reg.eventLog` / `reg.emit` /
 * `reg.changed()` / `reg.logLine()` / `reg.ensure()` / `reg.instances` / `reg.autoReconnect`.
 */

/**
 * Funnel one Browser event into the global log.
 *
 * ⚠️ Backfill is mandatory: `Browser.connect()` runs its init (setDiscoverTargets / refreshTargets)
 * *before* the listener below is attached, so without backfill those connection-time events would
 * be lost forever. `state.lastEventN` dedupes, so a reconnect doesn't push them twice.
 *
 * The ring holds **metadata only** (resultId / method / session / time); the payload lives in the
 * result store. That avoids storing every event's bytes twice, and it makes inline size a
 * *read-time* decision — `events {inlineBytes}` decides when reading, not when inserting.
 */
function pushGlobal(reg, state, rec) {
  if (state.lastEventN != null && rec.n <= state.lastEventN) return
  state.lastEventN = rec.n
  const receipt = reg.results.put(state.name, JSON.stringify(rec.params ?? null), {
    kind: 'event',
    method: rec.method,
    sessionId: rec.sessionId ?? null,
  })
  const global = reg.eventLog.push({
    resultId: receipt.resultId,
    instance: receipt.instance,
    method: receipt.method,
    sessionId: receipt.sessionId ?? null,
    at: receipt.at,
  })
  reg.emit('event', global)
}

/**
 * Attach the listeners.
 * Ordering is part of the contract: **backfill first, then attach** (see `pushGlobal`).
 */
export function wireOn(reg, state, browser) {
  // Backfill connection-time events first (see pushGlobal), then attach
  for (const rec of browser.events.since(state.lastEventN ?? 0)) pushGlobal(reg, state, rec)

  const listeners = [
    ['event', (rec) => pushGlobal(reg, state, rec)],
    ['session', (session) => reg.emit('session', { instance: state.name, session: session.describe() })],
    [
      'session-closed',
      ({ session, reason }) =>
        reg.emit('session-closed', { instance: state.name, sessionId: session.sessionId, reason }),
    ],
    [
      'disconnected',
      (err) => {
        // Only an *unintended* disconnect reaches here. Deliberate close (disconnect / remove /
        // closeAll) calls `unwire()` first — otherwise `close()` would also trip this handler,
        // mark the instance dead and silently arm a reconnect.
        state.status = 'dead'
        state.error = err?.message ?? 'disconnected'
        reg.logLine(`instance ${state.name} disconnected: ${state.error}`, 'warn')
        reg.changed(state)
        scheduleReconnect(reg, state)
      },
    ],
    [
      'reconnected',
      (report) => {
        state.status = 'ready'
        state.error = null
        state.intentional = false
        reg.logLine(
          `instance ${state.name} reconnected: replayed ${report.reattached.length} session(s)` +
            (report.failed.length ? `, ${report.failed.length} failed` : ''),
        )
        reg.changed(state)
      },
    ],
  ]
  for (const [evt, fn] of listeners) browser.on(evt, fn)
  state.listeners = listeners
}

/**
 * Detach the listeners hung on the Browser.
 * **Must be called before a deliberate close**, otherwise `close()` is absorbed by the
 * "connection lost" path (see the `disconnected` handler above).
 */
export function unwire(state) {
  const browser = state.browser
  if (browser && state.listeners) {
    for (const [evt, fn] of state.listeners) browser.off(evt, fn)
  }
  state.listeners = null
}

function scheduleReconnect(reg, state) {
  if (!reg.autoReconnect) return
  if (state.intentional) return
  if (state.reconnectTimer) return
  const delay = Math.min(30_000, 1000 * 2 ** Math.min(state.reconnectAttempts, 5))
  state.reconnectAttempts++
  state.reconnectTimer = setTimeout(async () => {
    state.reconnectTimer = null
    if (!reg.instances.has(state.name)) return
    try {
      if (state.browser && !state.browser.connection.closed) return
      if (state.browser) {
        await state.browser.reconnect()
      } else {
        await reg.ensure(state.name)
      }
    } catch (err) {
      state.error = err.message
      reg.changed(state)
      scheduleReconnect(reg, state)
    }
  }, delay)
  state.reconnectTimer.unref?.()
}

export function cancelReconnect(state) {
  if (state.reconnectTimer) {
    clearTimeout(state.reconnectTimer)
    state.reconnectTimer = null
  }
}
