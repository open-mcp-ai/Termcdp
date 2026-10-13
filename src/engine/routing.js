/**
 * routing — **command dispatch**: land a command on "instance → target → session" and collect
 * payloads uniformly.
 *
 * What lives here:
 *  - queries: `targets` / `sessions`;
 *  - sessions: `attach` / `detach` (including resolving "sessionId only, find it across instances");
 *  - execution: `call` / `batch` (one uniform exit: payload into the result store, caller gets a receipt).
 *
 * Why separate from registry: the registry owns "which instances exist and what state are they in";
 * this layer owns "who does this command go to, and what error is honest when it can't". The latter
 * is almost entirely error branches (not connected / manually disconnected / unknown session /
 * ambiguous session / missing arguments), which are easier to see all at once in their own file
 * than scattered through lifecycle code.
 *
 * Convention: the first argument `reg` is the Registry, using only its
 * `reg.instances` / `reg.describe()` / `reg.getInstance()` / `reg.ensure()` / `reg.results`;
 * `batch` is the exception — it calls `reg.call()` (the one-line forwarder on the registry) rather
 * than `call()` here, so batch and single-shot share **one** exit path.
 */
import { TermcdpError } from './errors.js'
import { DEFAULT_INLINE_BYTES } from './results.js'

/** The uniform "not connected" error: manual disconnect and "never connected / dropped" stay distinguishable (no `reg` needed) */
function notConnectedError(state) {
  if (state.intentional) {
    return new TermcdpError(
      `instance ${state.name} was disconnected deliberately (instances disconnect); run instances connect to reconnect`,
      'instance-disconnected',
    )
  }
  return new TermcdpError(`instance ${state.name} is not connected (run instances connect)`, 'not-connected')
}

/**
 * Resolve `{instance?, sessionId}` into `{browser, state, session}`.
 * Without an instance, every connected instance is searched: not found / matched by more than one
 * are both explicit errors (the latter requires an explicit `instance`).
 */
function resolveSession(reg, { instance, sessionId }) {
  if (instance) {
    const state = reg.getInstance(instance)
    const browser = state.browser
    if (!browser || browser.connection.closed) throw new TermcdpError(`instance ${instance} is not connected`, 'not-connected')
    const session = browser.sessions.get(sessionId)
    if (!session) throw new TermcdpError(`no such session on instance ${instance}: ${sessionId}`, 'unknown-session')
    return { browser, state, session }
  }
  const hits = []
  for (const state of reg.instances.values()) {
    const browser = state.browser
    if (!browser || browser.connection.closed) continue
    const session = browser.sessions.get(sessionId)
    if (session) hits.push({ browser, state, session })
  }
  if (hits.length === 0) throw new TermcdpError(`session not found: ${sessionId}`, 'unknown-session')
  if (hits.length > 1) {
    throw new TermcdpError(
      `session id ${sessionId} exists on several instances at once (${hits.map((h) => h.state.name).join(', ')}); pass instance explicitly`,
      'ambiguous-session',
    )
  }
  return hits[0]
}

export async function targets(reg, { instance, type, attach = false } = {}) {
  const states = instance ? [reg.getInstance(instance)] : [...reg.instances.values()]
  const targets = []
  const instances = []
  for (const state of states) {
    instances.push(reg.describe(state))
    const browser = state.browser
    if (!browser || browser.connection.closed) {
      if (instance) throw notConnectedError(state)
      continue
    }
    await browser.refreshTargets().catch(() => {})
    for (const t of browser.listTargets({ type })) {
      targets.push({
        instance: state.name,
        targetId: t.targetId,
        type: t.type,
        title: t.title,
        url: t.url,
        attached: browser.byTarget.has(t.targetId),
        ...(attach ? { sessionId: browser.byTarget.get(t.targetId) ?? null } : {}),
      })
    }
  }
  return { instances, targets }
}

export async function attach(reg, { instance, targetId }) {
  if (!instance || !targetId) throw new TermcdpError('attach requires instance and targetId', 'invalid')
  const browser = await reg.ensure(instance)
  const session = await browser.attach(targetId)
  return { instance, ...session.describe() }
}

export async function detach(reg, { instance, sessionId }) {
  if (!sessionId) throw new TermcdpError('detach requires sessionId', 'invalid')
  const { browser, state } = resolveSession(reg, { instance, sessionId })
  await browser.detach(sessionId)
  return { instance: state.name, detached: true, sessionId }
}

export async function sessions(reg, { instance } = {}) {
  const states = instance ? [reg.getInstance(instance)] : [...reg.instances.values()]
  const out = []
  for (const state of states) {
    const browser = state.browser
    if (!browser || browser.connection.closed) {
      // Asking about one named instance while it can't connect → explicit error;
      // in aggregate mode just skip it
      if (instance) throw notConnectedError(state)
      continue
    }
    for (const session of browser.sessions.values()) {
      out.push({ instance: state.name, ...session.describe() })
    }
  }
  return { sessions: out }
}

export async function call(reg, { instance, sessionId, method, params, timeoutMs, inlineBytes } = {}) {
  if (!instance) throw new TermcdpError('call requires instance', 'invalid')
  if (!method) throw new TermcdpError('call requires method', 'invalid')
  const browser = await reg.ensure(instance)
  let result
  if (sessionId) {
    const { session } = resolveSession(reg, { instance, sessionId })
    result = await session.send(method, params ?? {}, { timeoutMs })
  } else {
    result = await browser.send(method, params ?? {}, { timeoutMs })
  }
  // The single way out: the payload goes into the result store and the caller gets only a receipt
  // (whether to inline, how much to read — all decided on the reading side)
  return reg.results.put(instance, JSON.stringify(result ?? null), {
    method,
    sessionId: sessionId ?? null,
    inlineBytes: inlineBytes ?? DEFAULT_INLINE_BYTES,
  })
}

export async function batch(reg, { calls, mode = 'parallel', failFast = false } = {}) {
  if (!Array.isArray(calls)) throw new TermcdpError('batch requires a calls array', 'invalid')
  const results = new Array(calls.length)
  // Goes through the registry's public call() (= this file's call()): batch and single-shot share
  // **one and the same** egress
  const runOne = async (spec, index) => {
    const t0 = Date.now()
    try {
      const out = await reg.call(spec)
      results[index] = { index, ok: true, ms: Date.now() - t0, ...out }
      return true
    } catch (err) {
      results[index] = {
        index,
        ok: false,
        instance: spec?.instance,
        method: spec?.method,
        ms: Date.now() - t0,
        error: err.message,
      }
      return false
    }
  }
  if (mode === 'sequential') {
    for (let i = 0; i < calls.length; i++) {
      const ok = await runOne(calls[i], i)
      if (!ok && failFast) break
    }
    for (let i = 0; i < calls.length; i++) if (!results[i]) results[i] = { index: i, ok: false, error: 'skipped (failFast)' }
  } else {
    await Promise.all(calls.map((spec, i) => runOne(spec, i)))
  }
  return { results, summary: { total: results.length, ok: results.filter((r) => r.ok).length } }
}
