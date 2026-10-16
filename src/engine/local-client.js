/**
 * LocalClient — an **in-process** client: no socket, no serialization, just direct function calls.
 *
 * This file holds two things (it has exactly one consumer — `termcdp mcp` — which is why they are
 * together on purpose):
 *   1) `LocalClient`: one `open()` is a "session world" — it holds the browser connections (each one
 *      a browser WebSocket) and the event log. Nothing is read from or written to disk: instances are
 *      added by the caller at runtime, and process exit drops the connections (no daemon, so no
 *      orphan processes, and no leftover state).
 *   2) `createDispatcher`: the command-table executor. It maps a command name onto a Registry method.
 *
 * There is no callback push for events: the CDP event stream is read by monotonic sequence number
 * with `events {since}`, which all a client needs.
 */
import { EventEmitter } from 'node:events'
import { Registry } from './registry.js'
import { TermcdpError } from './errors.js'
import { COMMAND_MAP, describeCommands, PROTOCOL_VERSION } from '../protocol/commands.js'
import { withTimeout } from '../util/async.js'

export class LocalClient extends EventEmitter {
  constructor({ registry, dispatch, actor, hello }) {
    super()
    this.setMaxListeners(0)
    this.registry = registry
    this.dispatch = dispatch
    this.actor = actor
    this.hello = hello
    this.closed = false
  }

  /**
   * @param {{ actor?: string, eventCapacity?: number, autoReconnect?: boolean }} [opts]
   */
  static async open({ actor = 'local', eventCapacity = 20_000, autoReconnect = true } = {}) {
    const registry = new Registry({ eventCapacity, autoReconnect })
    const dispatch = createDispatcher({ registry, actor })
    const hello = await dispatch('hello')
    const client = new LocalClient({ registry, dispatch, actor, hello })

    // Forward only "log" and "instance state" events (the MCP side has no use for callback pushes,
    // but log lines and instance state changes are worth being able to subscribe to)
    registry.on('log', (rec) => client.emit('log', rec))
    registry.on('instance-changed', (inst) => client.emit('instance', inst))

    return client
  }

  /** Kept under the same name as the remote client (some callers await it) */
  async waitHello() {
    return this.hello
  }

  async call(method, params = {}, { timeoutMs = 120_000 } = {}) {
    if (this.closed) throw new Error('local client is closed')
    return withTimeout(this.dispatch(method, params), timeoutMs, `command timed out: ${method} (${timeoutMs}ms)`)
  }

  describe() {
    return {
      actor: this.actor,
      mode: 'standalone',
      instances: this.registry.list(),
    }
  }

  async close() {
    if (this.closed) return
    this.closed = true
    await this.registry.closeAll().catch(() => {})
    this.emit('close')
  }
}

// ---------- The command-table executor ----------

/**
 * Dispatch "command name + params" onto the Registry.
 * @param {{ registry: import('./registry.js').Registry, actor?: string }} deps
 * @returns {(method: string, params?: object) => Promise<any>}
 */
function createDispatcher({ registry, actor = 'local' }) {
  const hello = () => ({
    protocol: PROTOCOL_VERSION,
    actor,
    mode: 'standalone',
    pid: process.pid,
    commands: describeCommands(),
    instances: registry.list(),
    results: registry.results.stats(),
  })

  const instances = async ({ action, name, spec, connect } = {}) => {
    switch (action) {
      case 'list':
        return { instances: registry.list() }
      case 'add':
        return registry.add({ name, spec, connect: connect !== false })
      case 'remove':
        return registry.remove(name)
      case 'connect': {
        await registry.ensure(name, { force: true })
        return { instance: registry.describe(registry.instances.get(name)) }
      }
      case 'connect-all': {
        const report = await registry.ensureAll()
        return { instances: registry.list(), report }
      }
      case 'disconnect':
        return registry.disconnect(name)
      default:
        throw new TermcdpError(
          `invalid instances action: ${action} (list/add/remove/connect/connect-all/disconnect)`,
          'invalid',
        )
    }
  }

  const handle = async (method, params) => {
    switch (method) {
      case 'hello':
        return hello()
      case 'status':
        return {
          ...registry.status(),
          actor,
          pid: process.pid,
          mode: 'standalone',
        }
      case 'instances':
        return instances(params)
      case 'targets':
        return registry.targets(params)
      case 'attach':
        return registry.attach(params)
      case 'detach':
        return registry.detach(params)
      case 'sessions':
        return registry.sessions(params)
      case 'call':
        return registry.call(params)
      case 'batch':
        return registry.batch(params)
      case 'events':
        return registry.events(params)
      case 'read':
        return registry.read(params)
      case 'results':
        return registry.resultIndex(params)
      case 'fetch':
        return registry.fetch(params)
      case 'protocol':
        return registry.protocol(params)
      default: {
        const known = [...COMMAND_MAP.keys()].join(', ')
        throw new TermcdpError(`unknown method: ${method} (available: ${known})`, 'unknown-method')
      }
    }
  }

  return async function dispatch(method, params = {}) {
    return handle(method, params)
  }
}
