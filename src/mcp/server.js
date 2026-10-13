/**
 * MCP server over stdio — a **thin shell**: a path in → a command executed → a result out,
 * plus the description layer (one tool / resources / instructions).
 *
 * Three hard constraints (they keep logic from ending up in the wrong layer):
 *   1) It holds no state: instances, sessions, event history and the result store all live in the
 *      Registry. The process can be restarted at any time.
 *   2) The model-facing surface is **one tool**, `invoke(path, …args)`. Everything it can do is
 *      expressed as a path; the path layer (`src/protocol/paths.js`) resolves that into an engine
 *      command from `commands.js`. No capability lives here, and none is hidden from the CLI.
 *   3) It does not enumerate CDP commands: one tool, 5 resources and 1 template. When the model
 *      needs a signature it reads `cdp://protocol/{Domain}` instead of pulling the whole protocol
 *      into context.
 *
 * MCP over stdio is **line-delimited JSON-RPC** (no raw newlines inside a message —
 * JSON.stringify already guarantees that).
 *
 * ⚠️ **After stdin closes, in-flight requests must finish writing their responses before we exit**
 * (see `inflight` below) — otherwise `echo '<one-line JSON-RPC>' | termcdp mcp` would silently
 * print nothing at all.
 */
import process from 'node:process'
import { LocalClient } from '../engine/local-client.js'
import { TermcdpError } from '../engine/errors.js'
import { resolve, bindArgs, describePath } from '../protocol/paths.js'

// ---------- Description layer ----------
//
// One tool whose usage is disclosed progressively through `invoke("help", …)`, plus protocol
// resources. This is what keeps it lean: it does **not enumerate the CDP protocol** — when the
// model needs a signature it reads `cdp://protocol/{Domain}` instead.

const INVOKE_TOOL = {
  name: 'invoke',
  description: [
    'The browser console — use it whenever you need to look at, drive or inspect a browser page (or a Node V8 inspector): open pages, read and change the DOM, capture network traffic, evaluate JS, take screenshots, listen to events.',
    '',
    'Call it as invoke(path, …args): a dotted object location whose **last segment is the verb**, the args positional —',
    '  invoke("instances", "add", "lab1", "127.0.0.1:9222")',
    '  invoke("lab1.targets", "page")',
    '  invoke("lab1.S1.call", "Runtime.evaluate", {expression: "document.title"})',
    'Usage is documented progressively: invoke("help") lists the roots and the live instances, invoke("help", "lab1") drills into one object, invoke("help", "lab1.S1.call") documents one verb. Read the level you need instead of guessing.',
  ].join('\n'),
  inputSchema: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description:
          'Object location, dotted, verb last: `instances`, `lab1`, `lab1.targets`, `lab1.attach`, `lab1.S1.call`, `lab1@targetId.call`, `events`, `read`, `help` — a bare object is a read (list / describe)',
      },
      args: {
        type: 'array',
        items: {},
        description: 'Positional args for the verb, in the order its signature lists (see invoke("help", path)). May be empty or omitted.',
      },
    },
    required: ['path'],
    additionalProperties: false,
  },
}

function buildTools() {
  return [INVOKE_TOOL]
}


/** Fixed resources: state snapshots (state is not an "action", so these are resources, not tools) */
const RESOURCES = [
  {
    uri: 'cdp://instances',
    name: 'instances',
    description: 'All current CDP instances and their connection state (product / target count / session count / proxied or not)',
    mimeType: 'application/json',
  },
  {
    uri: 'cdp://sessions',
    name: 'sessions',
    description: 'All current sessions (across instances), with their enabled domains and Emulation expectation state',
    mimeType: 'application/json',
  },
  {
    uri: 'cdp://protocol',
    name: 'protocol',
    description:
      'Live CDP protocol overview: every domain name with its command / event / type counts. ' +
      'For one domain\'s detailed signature read cdp://protocol/{Domain} (e.g. cdp://protocol/Fetch)',
    mimeType: 'application/json',
  },
  {
    uri: 'cdp://status',
    name: 'status',
    description:
      'Process overview: uptime, instance / session counts, event-log size, result-store size (count/bytes/maxBytes/evicted), pid. ' +
      'Read this first when asking "is it alive / how many are connected / is the store evicting"',
    mimeType: 'application/json',
  },
  {
    uri: 'cdp://results',
    name: 'results',
    description:
      'Result index: which payloads came through recently (metadata receipts only: resultId / instance / method / bytes, no bodies). ' +
      'Read it when you forgot an id or want to see what was captured earlier; page through a body with the read tool by resultId',
    mimeType: 'application/json',
  },
]

const RESOURCE_TEMPLATES = [
  {
    uriTemplate: 'cdp://protocol/{domain}',
    name: 'protocol-domain',
    description:
      'The **live** signature of one CDP domain (from the browser\'s own /json/protocol): command names, params, ' +
      'required/optional, return values, events. Read it to learn the signature, then use call to execute. ' +
      'Append ?instance=name to pick an instance',
    mimeType: 'application/json',
  },
]

/** Instructions handed to the model at initialization */
function buildInstructions() {
  return [
    'termcdp is a cross-machine CDP console: it stays resident and holds long-lived browser connections, and you drive it through **one tool** — invoke(path, …args). The path is the handle: `lab1.S1.call` carries both the instance and the session, so you never thread ids through params.',
    '',
    'Learn it by drilling in, level by level: invoke("help") → the roots and the live instances; invoke("help", "lab1") → what one instance offers (verbs + live sessions); invoke("help", "lab1.S1.call") → one verb\'s signature, args, returns and examples. Do not guess a signature — read it.',
    '',
    'Typical flow:',
    '1) invoke("instances", "add", "lab1", "127.0.0.1:9222") — the spec is `host:port`, or `socks5://host:port?cdp=host:port` to reach a remote machine\'s loopback port through SOCKS5',
    '2) invoke("lab1.targets", "page") → a targetId',
    '3) invoke("lab1.attach", targetId) → a sessionId. (Or skip both: `lab1@targetId.call(…)` is a one-shot form that attaches, calls and detaches.)',
    '4) invoke("lab1.S1.call", "Page.navigate", {url}) — **any** CDP command. If you do not know the signature, read the resource `cdp://protocol/{Domain}` first (e.g. cdp://protocol/Fetch).',
    '5) invoke("events", since) — the event stream. Every entry has a monotonic n and a resultId; remember `latest` from the response and pass it back as since to get only the new tail.',
    '',
    'Receipts (read this once): call / batch / events return **receipts, not content**. A receipt carries resultId / bytes / sha256, and `data` only when the whole payload fits inlineBytes (4KB for commands, 512B for events). If data is there, it is the entire content and you need nothing more; if not, page through it yourself with invoke("read", resultId, offset) — you manage the cursor. That way a 46KB DOM tree or a 300KB string never lands in your context: whether to read it, and how much, is your call.',
    '',
    'Things worth knowing:',
    '- Events require enabling a domain first (Runtime.enable / Network.enable / Page.enable) — otherwise nothing arrives',
    '- Do not sleep to wait for a page load: after calling Page.navigate, read events with prefix "Page.lifecycleEvent" and wait for load / networkIdle',
    '- `lab1@targetId.call` is one-shot only — cross-call state (domain enablement, emulation, network subscriptions) does not survive the call. For anything multi-step, attach and keep the sessionId.',
    '- `call` may alter pages or touch sensitive data: say what you are doing before running one.',
    '- The process holds **no state on disk**: no config file, no audit log, no export directory. Every connection starts empty — add the instances you need; on exit they are gone and you add them again next time.',
    '',
    'When a human needs to judge or intervene (captcha, risk control, a decision to make), do not expect anyone to watch a CDP call stream — ' +
    'tell the human directly through whatever notification channel you have (in this workspace, termcp\'s notify_user). ' +
    'Note that is a channel for *notifying a human*, unrelated to *driving a browser*: driving the browser is this invoke tool, ' +
    'and it does not go through termcp.',
  ].join('\n')
}


const SERVER_INFO = { name: 'termcdp', version: '0.0.1' }
const DEFAULT_PROTOCOL = '2025-06-18'

/** Parse a cdp:// resource URI → {kind, arg, params} */
function parseResourceUri(uri) {
  const u = new URL(uri)
  if (u.protocol !== 'cdp:') throw new Error(`unsupported resource protocol: ${u.protocol} (only cdp:// is supported)`)
  const kind = u.hostname
  const arg = u.pathname.replace(/^\//, '') || null
  const params = Object.fromEntries(u.searchParams.entries())
  return { kind, arg, params }
}

export async function runMcpServer({ actor = 'mcp', input = process.stdin, output = process.stdout } = {}) {
  /** @type {LocalClient|null} */
  let client = null
  let helloInfo = null

  const ensureClient = async () => {
    if (client && !client.closed) return client
    client = await LocalClient.open({ actor })
    helloInfo = client.hello
    return client
  }

  const write = (obj) => {
    output.write(`${JSON.stringify(obj)}\n`)
  }
  const reply = (id, result) => write({ jsonrpc: '2.0', id, result })
  const replyError = (id, code, message, data) => write({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } })

  /** Default instance: when none is specified and exactly one instance is connected, use it */
  const resolveInstance = async (explicit) => {
    if (explicit) return explicit
    const c = await ensureClient()
    const { instances } = await c.call('instances', { action: 'list' })
    const ready = instances.filter((i) => i.status === 'ready')
    if (ready.length === 1) return ready[0].name
    if (ready.length === 0) {
      throw new Error(
        instances.length
          ? `no connected instance (existing: ${instances.map((i) => `${i.name}[${i.status}]`).join(', ')}). Connect it with instances {action:"connect", name}, or add one with {action:"add", name, spec}`
          : 'no instances at all yet. Add one with instances {action:"add", name, spec} — a spec like 127.0.0.1:9222 or socks5://127.0.0.1:1080?cdp=127.0.0.1:9222',
      )
    }
    throw new Error(
      `several instances are connected (${ready.map((i) => i.name).join(', ')}); pass instance explicitly in the params (a resource URI can take ?instance=name)`,
    )
  }

  const readResource = async (uri) => {
    const { kind, arg, params } = parseResourceUri(uri)
    const c = await ensureClient()
    if (kind === 'instances') {
      return { json: await c.call('instances', { action: 'list' }) }
    }
    if (kind === 'sessions') {
      return { json: await c.call('sessions', params.instance ? { instance: params.instance } : {}) }
    }
    if (kind === 'status') {
      return { json: await c.call('status', {}) }
    }
    if (kind === 'results') {
      return {
        json: await c.call('results', {
          ...(params.instance ? { instance: params.instance } : {}),
          ...(params.since ? { since: Number(params.since) } : {}),
          limit: Number(params.limit ?? 50),
        }),
      }
    }
    if (kind === 'protocol') {
      const instance = await resolveInstance(params.instance)
      return { json: await c.call('protocol', arg ? { instance, domain: arg } : { instance }) }
    }
    throw new Error(
      `unknown resource: ${uri} (available: cdp://instances, cdp://sessions, cdp://protocol[/Domain], cdp://status, cdp://results)`,
    )
  }

  // ---------- The invoke layer ----------
  //
  // `invoke(path, …args)` is the whole tool surface. `paths.js` resolves the path against the live
  // registry into an engine command; this function is the glue that runs it and handles the two
  // verbs that are **not** engine commands: `help` (served from the path tables) and the transient
  // `@targetId` form (attach → call → detach, which the engine has no single command for).

  /**
   * Resolve a path + positional args into an engine command + params (no execution).
   * @returns {Promise<{command: string, params: object, danger: boolean}>}
   */
  const toCommand = async (reg, path, args) => {
    const target = await resolve(reg, path)
    if (target.describe) {
      throw new TermcdpError(
        `"${path}" is an object, not a call — nothing to run. Read it (a bare object is a read) or pick a verb: invoke("help", "${path}")`,
        'invalid',
      )
    }
    const verb = target.verb
    if (!verb.command) {
      throw new TermcdpError(
        `${verb.name} is not a runnable command here (it is served by the invoke layer directly — call it as invoke("${path}", …))`,
        'invalid',
      )
    }
    if (target.scope === 'transient') {
      throw new TermcdpError(
        `transient paths (${path}) cannot be planned — they attach and detach around one call. Use invoke("${path}", …) directly, not inside batch`,
        'invalid',
      )
    }
    const params = verb.bind(bindArgs(verb, args, path))
    const engine = { ...params }
    if (target.scope === 'instance') engine.instance = target.instance
    if (target.scope === 'session') {
      engine.instance = target.instance
      engine.sessionId = target.sessionId
    }
    // connect / disconnect at instance scope are the `instances` command in disguise
    if (target.scope === 'instance' && verb.command === 'instances') {
      engine.action = verb.name
      engine.name = target.instance
    }
    // Verbs that take a trailing {…} options bag hand its keys to the engine command itself
    if (engine.opts && typeof engine.opts === 'object') {
      Object.assign(engine, engine.opts)
      delete engine.opts
    }
    return { command: verb.command, params: engine, danger: !!verb.danger }
  }

  /** Read a bare object path (list / describe) — the default when a path names an object, not a verb */
  const readObject = async (c, target) => {
    if (target.scope === 'instance') {
      const { instances } = await c.call('instances', { action: 'list' })
      const found = instances.find((i) => i.name === target.instance)
      if (!found) throw new TermcdpError(`instance ${target.instance} vanished while describing it`, 'unknown-instance')
      return found
    }
    const { sessions } = await c.call('sessions', { instance: target.instance })
    const found = sessions.find((s) => s.sessionId === target.sessionId)
    if (!found) throw new TermcdpError(`session ${target.sessionId} is no longer live on ${target.instance}`, 'unknown-session')
    return found
  }

  /**
   * Run one invoke. Returns the engine result, plus `danger` when the verb may alter pages.
   * @returns {Promise<{result: any, danger: boolean}>}
   */
  const runInvoke = async (path, args) => {
    const c = await ensureClient()
    const reg = c.registry
    const target = await resolve(reg, path)

    if (target.describe) return { result: await readObject(c, target), danger: false }

    const verb = target.verb
    if (verb.kind === 'help') {
      const bound = verb.bind(bindArgs(verb, args, path))
      return { result: await describePath(reg, bound.path), danger: false }
    }
    if (verb.name === 'batch') {
      // The entries object is the engine command's params verbatim ({calls, mode, failFast});
      // each entry resolves like a top-level invoke
      const { calls, ...rest } = verb.bind(bindArgs(verb, args, path))
      if (!Array.isArray(calls)) throw new TermcdpError('batch requires a calls array: {calls: [{path, args}, …]}', 'invalid')
      const planned = []
      for (let i = 0; i < calls.length; i++) {
        const e = calls[i]
        if (!e || typeof e.path !== 'string') {
          throw new TermcdpError(`batch entry ${i + 1} must be {path, args}, got ${JSON.stringify(e)?.slice(0, 160)}`, 'invalid')
        }
        planned.push((await toCommand(reg, e.path, e.args ?? [])).params)
      }
      const result = await c.call('batch', { calls: planned, ...rest }, { timeoutMs: 120_000 })
      return { result, danger: planned.some((s) => s.method) }
    }
    if (target.scope === 'transient') {
      // attach → call → detach, but **only detach a session we created**: `Target.attachToTarget`
      // is idempotent, so if this target already has a live session we reuse it and leave it alone
      // — tearing it down here would silently kill a handle the caller is keeping.
      const bound = verb.bind(bindArgs(verb, args, path))
      const engine = { ...bound }
      if (engine.opts && typeof engine.opts === 'object') {
        Object.assign(engine, engine.opts)
        delete engine.opts
      }
      const { targets } = await c.call('targets', { instance: target.instance, targetId: target.targetId, attach: true })
      const existing = (targets.find((t) => t.targetId === target.targetId) ?? {}).sessionId ?? null
      const attached = await c.call('attach', { instance: target.instance, targetId: target.targetId })
      const sessionId = attached.sessionId
      const borrowed = sessionId === existing
      try {
        const result = await c.call(
          'call',
          { instance: target.instance, sessionId, ...engine },
          { timeoutMs: engine.timeoutMs ?? 120_000 },
        )
        return { result, danger: true, ...(borrowed ? { note: `target ${target.targetId} already had session ${sessionId}, so it was reused and left attached` } : {}) }
      } finally {
        if (!borrowed) await c.call('detach', { instance: target.instance, sessionId }).catch(() => {})
      }
    }
    const { command, params, danger } = await toCommand(reg, path, args)
    const result = await c.call(command, params, { timeoutMs: params.timeoutMs ?? 120_000 })
    return { result, danger }
  }

  const callTool = async (name, args = {}) => {
    if (name !== 'invoke') throw new Error(`unknown tool: ${name} (available: invoke)`)
    const path = args?.path
    const toolArgs = args?.args
    const out = await runInvoke(path, toolArgs)
    return { result: out.result, danger: out.danger, note: out.note }
  }

  const handle = async (msg) => {
    const { id, method, params } = msg
    const isNotification = id === undefined || id === null
    try {
      switch (method) {
        case 'initialize': {
          const protocolVersion = params?.protocolVersion ?? DEFAULT_PROTOCOL
          reply(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false }, resources: { subscribe: false, listChanged: false } },
            serverInfo: SERVER_INFO,
            instructions: buildInstructions(),
          })
          return
        }
        case 'notifications/initialized':
        case 'notifications/cancelled':
        case 'notifications/roots/list_changed':
          return
        case 'ping':
          reply(id, {})
          return
        case 'logging/setLevel':
          reply(id, {})
          return
        case 'tools/list':
          reply(id, { tools: buildTools() })
          return
        case 'tools/call': {
          const name = params?.name
          const args = params?.arguments ?? {}
          try {
            const { result, danger, note } = await callTool(name, args)
            // danger is per-verb (the path the model picked decides, e.g. any .call), not per-tool;
            // note is the invoke layer's say-what-you-mean channel (e.g. "@ reused an existing session")
            const meta = { ...(danger ? { danger: true } : {}), ...(note ? { note } : {}) }
            reply(id, {
              content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
              isError: false,
              ...(Object.keys(meta).length ? { _meta: meta } : {}),
            })
          } catch (err) {
            // Tool-level failure: the MCP convention is isError rather than a JSON-RPC error,
            // so the model can see the reason and recover on its own
            reply(id, {
              content: [{ type: 'text', text: `tool failed: ${err.message}` }],
              isError: true,
            })
          }
          return
        }
        case 'resources/list':
          reply(id, { resources: RESOURCES })
          return
        case 'resources/templates/list':
          reply(id, { resourceTemplates: RESOURCE_TEMPLATES })
          return
        case 'resources/read': {
          const uri = params?.uri
          try {
            const { json } = await readResource(uri)
            reply(id, { contents: [{ uri, mimeType: 'application/json', text: JSON.stringify(json, null, 2) }] })
          } catch (err) {
            replyError(id, -32002, `failed to read resource: ${err.message}`, { uri })
          }
          return
        }
        case 'prompts/list':
          reply(id, { prompts: [] })
          return
        default: {
          if (isNotification) return
          replyError(id, -32601, `unsupported method: ${method}`)
        }
      }
    } catch (err) {
      if (!isNotification) replyError(id, -32603, `internal error: ${err?.message ?? err}`)
      else process.stderr.write(`[termcdp mcp] notification handler failed: ${err?.message ?? err}\n`)
    }
  }

  // ---- Line reading (JSON-RPC over stdio, one message per line) ----
  /**
   * In-flight requests. After stdin closes we must **wait until they have written their responses**
   * before exiting — otherwise the "drive it without a client" usage
   * (`echo '<one-line JSON-RPC>' | termcdp mcp`) would silently print nothing: the request would
   * barely be dispatched and the process would already be gone on the stdin EOF.
   */
  const inflight = new Set()
  let buffer = Buffer.alloc(0)
  const onData = (chunk) => {
    buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk
    for (;;) {
      const at = buffer.indexOf(10)
      if (at < 0) break
      const line = buffer.subarray(0, at).toString('utf8').replace(/\r$/, '')
      buffer = buffer.subarray(at + 1)
      if (!line.trim()) continue
      let msg
      try {
        msg = JSON.parse(line)
      } catch {
        replyError(null, -32700, 'request line is not valid JSON')
        continue
      }
      // Deliberately not awaited: handle concurrently (MCP allows out-of-order responses, keyed by id)
      const task = handle(msg).catch((err) => process.stderr.write(`[termcdp mcp] ${err?.stack ?? err}\n`))
      inflight.add(task)
      task.finally(() => inflight.delete(task))
    }
  }

  input.on('data', onData)
  const closed = new Promise((resolve) => {
    input.on('end', resolve)
    input.on('close', resolve)
  })
  await closed
  if (inflight.size) {
    // Capped at 10 seconds: if the client died abnormally we must not hang forever
    await Promise.race([
      Promise.allSettled([...inflight]),
      new Promise((resolve) => {
        setTimeout(resolve, 10_000).unref?.()
      }),
    ])
  }
  client?.close()
  return 0
}
