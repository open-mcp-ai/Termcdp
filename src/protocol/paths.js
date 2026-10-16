/**
 * paths — the `invoke(path, …args)` addressing layer: the model-facing surface is **one tool**.
 *
 * A path is a dotted object location whose **last segment is the verb** (function call);
 * the args after it are positional. Resolution walks live state left to right:
 *
 *   invoke("instances.list")
 *   invoke("instances.add", "lab1", "127.0.0.1:9222")
 *   invoke("lab1")                                   ← bare instance = describe
 *   invoke("lab1.targets", "page")
 *   invoke("lab1.attach", targetId) → returns a sessionId
 *   invoke("lab1.S1.call", "Runtime.evaluate", {expression: "1+1"})
 *   invoke("lab1.S1.detach")
 *   invoke("lab1@ABC123.call", "Page.reload")        ← transient session (one-shot)
 *   invoke("read", resultId, offset?, maxBytes?)
 *   invoke("events", since?, {instance, prefix, limit…})
 *   invoke("help")  invoke("help", "lab1")  invoke("help", "lab1.S1.call")
 *
 * Why one tool: with eight tools the model had to thread `{instance, sessionId}` through every
 * call by hand. Here the path *is* the handle — `lab1.S1.call` carries both halves, and
 * `lab1@targetId.call` makes one-shot commands need no handle at all. The usage docs live
 * behind `help` (progressive disclosure) instead of a fat tool hint.
 *
 * Layering: this is a pure addressing layer — it holds no state and owns no capability. Every
 * verb resolves to one of the engine commands in `commands.js` (the transient form is literally
 * attach → call → detach), so the engine below is untouched. What the CLI `help` shows and what
 * the MCP tool exposes are both generated from this same table.
 *
 * Disambiguation: a segment is a verb when it is a known verb **and** it is the last segment;
 * otherwise it is an object id (session id / @targetId). Instance names cannot contain `.` or
 * `@`, and cannot shadow a reserved root word (enforced in `registry.add`), so the grammar is
 * unambiguous. Errors are the model's way to self-heal, so they list what *is* there.
 */
import { TermcdpError } from '../engine/errors.js'

/**
 * @typedef {object} ArgSpec
 * @property {string} name
 * @property {'string'|'number'|'boolean'|'object'|'array'} type
 * @property {boolean} [required]
 * @property {string} desc
 *
 * @typedef {object} VerbSpec
 * @property {string} name
 * @property {string|null} command        Engine command this verb resolves to (null = served by the MCP layer itself)
 * @property {string} summary             One-line description (help text)
 * @property {ArgSpec[]} [args]           Positional args, in order
 * @property {string} [returns]           Return-value description
 * @property {boolean} [danger]           Whether it may alter pages / touch sensitive data
 * @property {string[]} [examples]        Usage examples (already rendered as invoke calls)
 * @property {'call'|'read'|'help'|'transient-call'} [kind] Internal: how the MCP layer dispatches it
 */

/** Render the positional signature of a verb: `call(method, [params], [opts])` */
export function signatureOf(verb) {
  const args = (verb.args ?? []).map((a) => (a.required ? a.name : `[${a.name}]`))
  return `${verb.name}(${args.join(', ')})`
}

// ---------- Arg binding: positional args → the named params the engine commands take ----------

const TYPE_NAMES = { string: 'a string', number: 'a number', boolean: 'a boolean', object: 'an object', array: 'an array' }

function typeMatches(value, type) {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'number':
      return typeof value === 'number'
    case 'boolean':
      return typeof value === 'boolean'
    case 'object':
      return typeof value === 'object' && value !== null && !Array.isArray(value)
    case 'array':
      return Array.isArray(value)
    default:
      return true
  }
}

/** Bind positional args onto a verb's declared arg list, validating types. */
export function bindArgs(verb, args, pathForErrors) {
  const declared = verb.args ?? []
  const out = {}
  if (args !== undefined && args !== null) {
    if (!Array.isArray(args)) throw new TermcdpError(`args to invoke("${pathForErrors}") must be an array, got ${typeof args}`, 'invalid')
    for (let i = 0; i < args.length; i++) {
      const spec = declared[i]
      if (!spec) throw new TermcdpError(`invoke("${pathForErrors}") takes at most ${declared.length} arg${declared.length === 1 ? '' : 's'} but got ${args.length}: ${signatureOf(verb)}`, 'invalid')
      const value = args[i]
      if (value === undefined || value === null) {
        if (spec.required) throw new TermcdpError(`invoke("${pathForErrors}"): arg ${i + 1} (${spec.name}) is required — ${signatureOf(verb)}`, 'invalid')
        continue
      }
      if (!typeMatches(value, spec.type)) {
        const got = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
        throw new TermcdpError(`invoke("${pathForErrors}"): arg ${i + 1} (${spec.name}) must be ${TYPE_NAMES[spec.type]}, got ${got}`, 'invalid')
      }
      out[spec.name] = value
    }
  }
  for (let i = 0; i < declared.length; i++) {
    const spec = declared[i]
    if (out[spec.name] === undefined && spec.required) {
      throw new TermcdpError(`invoke("${pathForErrors}"): missing arg ${i + 1} (${spec.name}) — ${signatureOf(verb)}`, 'invalid')
    }
  }
  return out
}

// ---------- The verb table (single source of truth for the invoke surface) ----------
//
// `bind` maps the bound positional args onto the params object the engine command takes.
// Each verb is reached at a specific *scope* (see ROOT/INSTANCE/SESSION verbs below), which is
// what makes `call` at instance scope and `call` at session scope different commands.

const callArgs = [
  { name: 'method', type: 'string', required: true, desc: 'CDP method, e.g. Page.navigate / Runtime.evaluate / Network.enable' },
  { name: 'params', type: 'object', desc: 'CDP params object (fill per the live signature — read cdp://protocol/{Domain} first)' },
  { name: 'opts', type: 'object', desc: '{timeoutMs?, inlineBytes?} — inlineBytes sets the threshold below which the whole payload is returned inline (default 4096)' },
]

const callReturns =
  'A **receipt**: {resultId, instance, sessionId?, method, at, bytes, sha256, data?}. The payload lives in the in-memory result store; ' +
  '`data` appears only when the whole thing fits inlineBytes (complete or nothing, never truncated). When it is absent, page through it with ' +
  'invoke("read", resultId, offset) — you manage the cursor. That way a 46KB DOM tree or a 300KB string never lands in your context.'

const callExamples = [
  'invoke("lab1.S1.call", "Runtime.evaluate", {expression: "document.title", returnByValue: true})',
  'invoke("lab1.call", "Browser.getVersion")',
  'invoke("lab1@ABC123.call", "Page.reload")',
]

/** Root scope: no instance involved. */
const ROOT_VERBS = {
  instances: {
    name: 'instances',
    kind: 'call',
    command: 'instances',
    summary: 'The instance collection. Bare `instances` = list',
    args: [
      { name: 'action', type: 'string', enum: ['list', 'add', 'remove', 'connect', 'connect-all', 'disconnect'], desc: 'What to do (default list, i.e. a bare invoke("instances"))' },
      { name: 'name', type: 'string', desc: 'Instance name (required for add; selects the instance for the other actions)' },
      { name: 'spec', type: 'string', desc: 'Endpoint spec (required for add): `127.0.0.1:9222` or `socks5://127.0.0.1:1080?cdp=127.0.0.1:9222` (the cross-machine path)' },
    ],
    returns: 'instance list (with connection state, product, target/session counts)',
    examples: [
      'invoke("instances")',
      'invoke("instances", "add", "lab1", "127.0.0.1:9222")',
      'invoke("instances", "add", "win10", "socks5://127.0.0.1:1080?cdp=127.0.0.1:9222")',
      'invoke("instances", "disconnect", "lab1")',
    ],
    bind: (a) => ({ action: a.action ?? 'list', ...(a.name !== undefined ? { name: a.name } : {}), ...(a.spec !== undefined ? { spec: a.spec } : {}) }),
  },
  fetch: {
    name: 'fetch',
    kind: 'call',
    command: 'fetch',
    summary:
      'Download a URL into this process\'s result store (http/https) and get a **receipt** instead of the bytes — the download half of "inject a remote script into a page": ' +
      'fetch it, then pass the source to Runtime.evaluate without pasting the file into your context. Do it here rather than in the page: a page-side fetch or <script src> is blocked by the page\'s CSP. Nothing is written to disk',
    args: [
      { name: 'url', type: 'string', required: true, desc: 'absolute http/https URL (file:/data: are refused — this runs on the host, not in the page)' },
      { name: 'opts', type: 'object', desc: '{inlineBytes? (default 4096), maxBytes? (default 64MiB, refused rather than truncated), timeoutMs? (default 30000), headers?}' },
    ],
    returns: 'A **receipt** {resultId, instance: "fetch", method: "fetch", url, contentType, bytes, sha256, data?} — body in the result store, page it with `read`',
    examples: [
      'invoke("fetch", "https://cdn.example.com/lib.js")',
      'invoke("fetch", "http://localhost:18765/api/sessions/abc123/files/download?path=%2Ftmp%2Fa.js")',
    ],
    // opts is spread flat: the engine command takes flat params (same as `targets` / `events`)
    bind: (a) => ({ url: a.url, ...(a.opts ?? {}) }),
  },
  events: {
    name: 'events',
    kind: 'call',
    command: 'events',
    summary:
      'Read **this process\'s** event stream (CDP has no event replay, so each process keeps its own ring log with ' +
      '**monotonic sequence numbers n**). Remember `latest` from the response and pass it as `since` next time to pull only the new tail. ' +
      '**Event params go through the receipt too**: every entry carries a resultId — read the body with `read` so fetching a few dozen events ' +
      'does not dump hundreds of KB of params into your context',
    args: [
      { name: 'since', type: 'number', desc: 'Only return events with n > since (continuation cursor; default 0)', default: 0 },
      { name: 'opts', type: 'object', desc: '{instance?, sessionId?, method?, prefix?, limit? (default 50), order? (asc|desc), inlineBytes? (default 512)}' },
    ],
    returns: 'events[]: receipts (n, resultId, instance, sessionId, method, at, bytes, data?); plus latest (the next since)',
    examples: ['invoke("events", 0, {prefix: "Network.", limit: 20})', 'invoke("events", 42)'],
    bind: (a) => ({ since: a.since ?? 0, ...(a.opts ?? {}) }),
  },
  read: {
    name: 'read',
    kind: 'read',
    command: 'read',
    summary:
      'Page through a payload by resultId. If a receipt already carries `data`, that is the whole content and you do not need this — ' +
      'use it only when data was absent (the payload exceeded inlineBytes). Command results and event params both live in the result store; ' +
      'how much you fetch is entirely up to you',
    args: [
      { name: 'resultId', type: 'string', required: true, desc: 'the id from a receipt, e.g. "lab1/42"' },
      { name: 'offset', type: 'number', desc: 'start byte, default 0' },
      { name: 'maxBytes', type: 'number', desc: 'how many bytes to fetch this time, default 65536' },
    ],
    returns: '{resultId, offset, nextOffset, eof, totalBytes, data}',
    examples: ['invoke("read", "lab1/42")', 'invoke("read", "lab1/42", 65536, 65536)'],
    bind: (a) => a,
  },
  results: {
    name: 'results',
    kind: 'call',
    command: 'results',
    summary: 'Result index: which payloads came through recently (**receipts only, no bodies**). Use it when you forgot an id or want to see what was captured earlier',
    args: [
      { name: 'since', type: 'number', desc: 'Only receipts with seq > since', default: 0 },
      { name: 'limit', type: 'number', desc: 'How many at most (default 50)', default: 50 },
    ],
    returns: '{results:[receipts], latest, store:{count,bytes,maxBytes,seq,evicted}}',
    examples: ['invoke("results", 0, 20)'],
    bind: (a) => a,
  },
  status: {
    name: 'status',
    kind: 'call',
    command: 'status',
    summary: 'Overview of this process: uptime, instances, sessions, event-log size, result-store size',
    args: [],
    returns: 'process status',
    examples: ['invoke("status")'],
    bind: () => ({}),
  },
  hello: {
    name: 'hello',
    kind: 'call',
    command: 'hello',
    summary: 'Handshake: returns the protocol version, the engine command table, and the instance list. Any client or model calls this first to self-describe the surface',
    args: [],
    returns: 'protocol, commands[] (with param descriptions), instances[]',
    examples: ['invoke("hello")'],
    bind: () => ({}),
  },
  batch: {
    name: 'batch',
    kind: 'call',
    command: 'batch',
    summary: 'Run many commands in one round trip; can fan out across instances (do the same thing to several browsers at once)',
    args: [
      {
        name: 'entries',
        type: 'object',
        required: true,
        desc: '{calls: [{path, args}, …] — each resolves like a top-level invoke; mode? (parallel|sequential, default parallel); failFast?}',
      },
    ],
    returns: 'results[]: each entry ok/ms plus a receipt (resultId…), in the same order as the input',
    examples: [
      'invoke("batch", {calls: [{path: "lab1.S1.call", args: ["Page.reload"]}, {path: "win10.S2.call", args: ["Page.reload"]}]})',
    ],
    // The entries object *is* the engine command's params
    bind: (a) => a.entries,
  },
  help: {
    name: 'help',
    kind: 'help',
    command: null,
    summary: 'Learn the surface by drilling in: `help` lists the roots and live instances; `help("lab1")` lists what one instance offers; `help("lab1.S1.call")` shows one verb\'s signature',
    args: [{ name: 'path', type: 'string', desc: 'A path to document (omit = the root listing)' }],
    returns: 'the namespace at that path: verbs and the live children available under it',
    examples: ['invoke("help")', 'invoke("help", "lab1")', 'invoke("help", "lab1.S1.call")'],
    bind: (a) => a,
  },
}

/** Instance scope: the path so far has resolved to a connected (or connectable) instance. */
const INSTANCE_VERBS = {
  targets: {
    name: 'targets',
    kind: 'call',
    command: 'targets',
    summary: 'List targets (tabs / workers / iframes) of this instance',
    args: [
      { name: 'type', type: 'string', desc: 'Filter by type, e.g. page / service_worker / iframe' },
      { name: 'opts', type: 'object', desc: '{attach? (also report each target\'s sessionId)}' },
    ],
    returns: 'targets[]: instance, targetId, type, title, url, attached[, sessionId]',
    examples: ['invoke("lab1.targets", "page")', 'invoke("lab1.targets", "page", {attach: true})'],
    bind: (a) => ({ ...(a.type !== undefined ? { type: a.type } : {}), ...(a.opts ?? {}) }),
  },
  attach: {
    name: 'attach',
    kind: 'call',
    command: 'attach',
    summary: 'Open a CDP session (flatten) for a target and return the sessionId — every command aimed at that page carries it afterwards. The sessionId is only valid **within the current process**',
    args: [{ name: 'targetId', type: 'string', required: true, desc: 'target id (from targets)' }],
    returns: 'sessionId and other session info',
    examples: ['invoke("lab1.attach", "ABC123")'],
    bind: (a) => ({ targetId: a.targetId }),
  },
  call: {
    name: 'call',
    kind: 'call',
    command: 'call',
    summary: '**Run any CDP command** at the browser level (no session). This is how we avoid enumerating the whole protocol — fetch a domain\'s signature with `protocol` first, then fill in method and params accordingly. Use `lab1.S1.call` for page-level commands',
    args: callArgs,
    danger: true,
    returns: callReturns,
    examples: callExamples.filter((e) => !e.includes('S1.')),
    bind: (a) => ({ method: a.method, params: a.params, opts: a.opts }),
  },
  sessions: {
    name: 'sessions',
    kind: 'call',
    command: 'sessions',
    summary: 'List all sessions currently held by this instance, including enabled domains and the Emulation expectation state',
    args: [],
    returns: 'sessions[]',
    examples: ['invoke("lab1.sessions")'],
    bind: () => ({}),
  },
  protocol: {
    name: 'protocol',
    kind: 'call',
    command: 'protocol',
    summary: 'Fetch the **live** CDP protocol signature from the browser itself (its /json/protocol endpoint, not something we hardcode). Without a domain it returns the domain list; with one, that domain\'s commands / events / types',
    args: [
      { name: 'domain', type: 'string', desc: 'e.g. Page / Network / Fetch; omit = list domains and their sizes only' },
      { name: 'opts', type: 'object', desc: '{search? (fuzzy-search command names within that domain)}' },
    ],
    returns: 'domains[] or one domain\'s detailed signature',
    examples: ['invoke("lab1.protocol")', 'invoke("lab1.protocol", "Fetch")'],
    bind: (a) => ({ ...(a.domain !== undefined ? { domain: a.domain } : {}), ...(a.opts ?? {}) }),
  },
  connect: {
    name: 'connect',
    kind: 'call',
    command: 'instances',
    summary: 'Reconnect this instance after a deliberate `disconnect` (or after a failed first connect)',
    args: [],
    returns: 'the instance description',
    examples: ['invoke("lab1.connect")'],
    bind: () => ({}),
  },
  disconnect: {
    name: 'disconnect',
    kind: 'call',
    command: 'instances',
    summary: 'Disconnect deliberately. This is **sticky**: afterwards the instance will not auto-reconnect, and its verbs return `instance-disconnected` until you `connect` again',
    args: [],
    returns: 'the instance description',
    examples: ['invoke("lab1.disconnect")'],
    bind: () => ({}),
  },
}

/** Session scope: `lab1.S1.…` — a session id resolved from live state. */
const SESSION_VERBS = {
  call: {
    name: 'call',
    kind: 'call',
    command: 'call',
    summary: '**Run any CDP command** in this session (page-level: Page / Runtime / Network …). This is how we avoid enumerating the whole protocol — fetch a domain\'s signature with `protocol` first, then fill in method and params accordingly',
    args: callArgs,
    danger: true,
    returns: callReturns,
    examples: callExamples.filter((e) => e.includes('S1.')),
    bind: (a) => ({ method: a.method, params: a.params, opts: a.opts }),
  },
  detach: {
    name: 'detach',
    kind: 'call',
    command: 'detach',
    summary: 'Close this session (does not close the tab)',
    args: [],
    returns: '{ detached: true }',
    examples: ['invoke("lab1.S1.detach")'],
    bind: () => ({}),
  },
}

/** Transient scope: `lab1@targetId.…` — attach for this one call, detach right after. */
const TRANSIENT_VERBS = {
  call: {
    name: 'call',
    kind: 'transient-call',
    command: 'call',
    summary:
      '**Run one CDP command** on a target with a throwaway session: attach → call → detach. ' +
      'No sessionId to manage, no session left behind. Only for **one-shot** commands — cross-call state ' +
      '(domain enablement, emulation, network subscriptions) is lost the moment the call returns; ' +
      'for anything multi-step use `attach` and keep the sessionId. ' +
      'If the target already has a live session it is **reused and left in place** (attaching is idempotent, ' +
      'so a one-shot never tears down a handle somebody else is keeping — the response notes when this happens)',
    args: callArgs,
    danger: true,
    returns: callReturns,
    examples: ['invoke("lab1@ABC123.call", "Page.reload")'],
    bind: (a) => ({ method: a.method, params: a.params, opts: a.opts }),
  },
}

/** Every verb table, keyed by the scope name (used for `help` and error messages). */
export const SCOPES = {
  root: ROOT_VERBS,
  instance: INSTANCE_VERBS,
  session: SESSION_VERBS,
  transient: TRANSIENT_VERBS,
}

/** Reserved root words — an instance name cannot shadow these (checked in registry.add) */
export const PATH_RESERVED = new Set(Object.keys(ROOT_VERBS))

// ---------- Path parsing ----------

/**
 * Parse `a.b.c` into segments. `@` is only allowed as the **first** segment's prefix
 * (`@targetId`), never inside a later segment — the last segment is always the verb.
 */
export function parsePath(path) {
  if (typeof path !== 'string' || !path.trim()) {
    throw new TermcdpError('invoke needs a path — try invoke("help")', 'invalid')
  }
  const raw = path.trim()
  const parts = raw.split('.')
  if (parts.length > 3) {
    throw new TermcdpError(`path has ${parts.length} segments (max 3: instance.session.verb): ${raw}`, 'invalid')
  }
  const segments = parts.map((s) => s.trim())
  if (segments.some((s) => !s)) throw new TermcdpError(`empty segment in path: ${raw}`, 'invalid')
  // '@' is only meaningful in the first segment (instance@targetId); a verb never contains one
  for (let i = 1; i < segments.length; i++) {
    if (segments[i].includes('@')) throw new TermcdpError(`'@' is only allowed in the first segment: ${raw}`, 'invalid')
  }
  return { raw, segments }
}

/**
 * Split `instance@targetId` out of the first segment, if present.
 * Returns {segments, transient: targetId|null} — the instance name takes the first slot.
 */
function splitTransient(segments) {
  const at = segments[0].indexOf('@')
  if (at < 0) return { segments, transient: null }
  const instance = segments[0].slice(0, at)
  const targetId = segments[0].slice(at + 1)
  if (!instance) throw new TermcdpError(`'@' needs an instance name before it: use lab1@ABC123.call`, 'invalid')
  if (!targetId) throw new TermcdpError(`'@' needs a targetId: use lab1@ABC123.call (the targetId comes from targets)`, 'invalid')
  if (targetId.includes('@')) throw new TermcdpError(`only one '@' per path: use lab1@ABC123.call`, 'invalid')
  return { segments: [instance, ...segments.slice(1)], transient: targetId }
}

// ---------- Resolution: path + live registry state → a command to run ----------

/**
 * Resolve a path against the live registry.
 *
 * @param {import('../engine/registry.js').Registry} reg
 * @param {string} path
 * @returns {Promise<{scope: string, verb: VerbSpec, instance?: string, sessionId?: string, targetId?: string, params: object}>}
 *   `scope` is which verb table applies; the caller dispatches from it.
 */
export async function resolve(reg, path) {
  const { raw, segments } = parsePath(path)
  const { segments: rest, transient } = splitTransient(segments)
  const [a, b, c] = rest

  // --- root scope: `instances` / `events` / `read` / ... ---
  // hasOwn, not `in`: an inherited key like `toString` must not pose as a root verb
  if (transient === null && Object.hasOwn(ROOT_VERBS, a)) {
    const verb = ROOT_VERBS[a]
    if (b) {
      throw new TermcdpError(`'${a}' is a root verb and takes no object under it (got '${b}') — did you mean invoke("${a}", …)?`, 'invalid')
    }
    if (c) throw new TermcdpError(`path too long at root scope: ${raw}`, 'invalid')
    return { scope: 'root', verb, params: {} }
  }

  // --- instance scope ---
  if (!transient) {
    // `a` must be an instance name
    const state = reg.getInstance(a) // throws with the known-instance list
    const instance = a
    if (!b) {
      // bare `lab1` = describe the instance
      return { scope: 'instance', instance, verb: null, describe: true, params: {} }
    }
    // `lab1.S1.…` — is `b` a live session id?
    const browser = state.browser
    const connected = !!browser && !browser.connection.closed
    const session = connected ? browser.sessions.get(b) : null
    if (session) {
      if (!c) {
        // bare `lab1.S1` = describe the session
        return { scope: 'session', instance, sessionId: b, verb: null, describe: true, params: {} }
      }
      const verb = Object.hasOwn(SESSION_VERBS, c) ? SESSION_VERBS[c] : null
      if (!verb) {
        throw new TermcdpError(
          `unknown verb '${c}' on session ${b} of ${instance} (available: ${Object.keys(SESSION_VERBS).join(', ')})`,
          'unknown-verb',
        )
      }
      return { scope: 'session', instance, sessionId: b, verb, params: {} }
    }
    // not a session: `b` must be an instance verb
    const verb = Object.hasOwn(INSTANCE_VERBS, b) ? INSTANCE_VERBS[b] : null
    if (!verb) {
      const liveSessions = connected ? [...browser.sessions.keys()] : []
      const hint = connected
        ? liveSessions.length
          ? `live sessions on ${instance}: ${liveSessions.slice(0, 8).join(', ')}${liveSessions.length > 8 ? '…' : ''}`
          : `${instance} has no live sessions yet — invoke("${instance}.attach", targetId) to open one`
        : `${instance} is not connected, so it has no sessions; instance verbs are ${Object.keys(INSTANCE_VERBS).join(', ')}`
      throw new TermcdpError(
        `unknown verb '${b}' on instance ${instance} (instance verbs: ${Object.keys(INSTANCE_VERBS).join(', ')}). ${hint}`,
        'unknown-verb',
      )
    }
    if (c) throw new TermcdpError(`path too long: '${b}' is a verb, not an object — ${raw}`, 'invalid')
    return { scope: 'instance', instance, verb, params: {} }
  }

  // --- transient scope: `lab1@targetId.call` ---
  const instance = a
  reg.getInstance(instance) // throws with the known-instance list
  const verb = b ? (Object.hasOwn(TRANSIENT_VERBS, c ?? b) ? TRANSIENT_VERBS[c ?? b] : null) : null
  if (!b) {
    throw new TermcdpError(
      `bare '@${transient}' is not a call — use ${instance}@${transient}.call(method, params) to run one command on that target`,
      'invalid',
    )
  }
  if (!verb) {
    throw new TermcdpError(
      `unknown verb '${c ?? b}' on transient target (available: ${Object.keys(TRANSIENT_VERBS).join(', ')})`,
      'unknown-verb',
    )
  }
  if (c) throw new TermcdpError(`path too long: transient verbs take no object under them — ${raw}`, 'invalid')
  return { scope: 'transient', instance, targetId: transient, verb, params: {} }
}

/**
 * The verbs reachable at a resolved scope (used for bare-object reads and `help`).
 * Root scope also lists the live instances as callable objects.
 */
export function describeScope(reg, target) {
  const { scope, instance, sessionId, targetId } = target
  if (scope === 'root') {
    const names = [...reg.instances.keys()]
    return {
      scope: 'root',
      verbs: Object.fromEntries(Object.keys(ROOT_VERBS).map((k) => [k, signatureOf(ROOT_VERBS[k])])),
      instances: names,
      note: names.length
        ? 'Each instance name is also a callable object: invoke("lab1.targets"), invoke("lab1.S1.call", …). invoke("help", "lab1") to drill in.'
        : 'No instances yet — invoke("instances", "add", name, spec) to add one.',
    }
  }
  if (scope === 'instance') {
    const state = reg.getInstance(instance)
    const browser = state.browser
    const connected = !!browser && !browser.connection.closed
    return {
      scope: 'instance',
      instance,
      status: state.status,
      verbs: Object.fromEntries(Object.keys(INSTANCE_VERBS).map((k) => [k, signatureOf(INSTANCE_VERBS[k])])),
      sessions: connected ? [...browser.sessions.keys()] : [],
      targets: connected ? [...browser.targets.keys()] : [],
      note: connected
        ? 'Pick a sessionId from the list above (or attach a target first) and call invoke("lab1.S1.call", …); lab1@targetId.call is the one-shot form.'
        : 'Not connected yet — verbs that talk to the browser connect on demand.',
    }
  }
  if (scope === 'session') {
    return {
      scope: 'session',
      instance,
      sessionId,
      verbs: Object.fromEntries(Object.keys(SESSION_VERBS).map((k) => [k, signatureOf(SESSION_VERBS[k])])),
    }
  }
  return {
    scope: 'transient',
    instance,
    targetId,
    verbs: Object.fromEntries(Object.keys(TRANSIENT_VERBS).map((k) => [k, signatureOf(TRANSIENT_VERBS[k])])),
  }
}

/** Which verb table applies to a path of this shape (for the lenient `help` fallback) */
function scopeTableFor({ length }, transient) {
  if (transient) return { name: 'transient', verbs: TRANSIENT_VERBS }
  if (length <= 1) return { name: 'root', verbs: ROOT_VERBS }
  if (length === 2) return { name: 'instance', verbs: INSTANCE_VERBS }
  return { name: 'session', verbs: SESSION_VERBS }
}

/** Full documentation for one verb (help tier 3) */
function verbDetail(path, verb, scopeName) {
  const args = (verb.args ?? []).map((a) => ({
    name: a.name,
    type: a.type,
    ...(a.required ? { required: true } : {}),
    ...(a.default !== undefined ? { default: a.default } : {}),
    ...(a.enum ? { enum: a.enum } : {}),
    desc: a.desc,
  }))
  return {
    path,
    scope: scopeName,
    summary: verb.summary,
    signature: signatureOf(verb),
    ...(args.length ? { args } : {}),
    returns: verb.returns,
    ...(verb.danger ? { danger: true } : {}),
    examples: verb.examples,
  }
}

/**
 * `invoke("help", path?)` — progressive disclosure, three tiers:
 *   no path   → the root listing (root verbs + live instances)
 *   an object → what it offers (verbs + live children)
 *   a verb    → signature, args, returns, examples, danger flag
 *
 * Tier 3 is **lenient**: documenting a verb does not require the object in the path to exist
 * (`help("nope.S9.call")` still documents `call`), because the point is to learn the verb.
 */
export async function describePath(reg, path) {
  if (!path) return describeScope(reg, { scope: 'root' })

  let target
  try {
    target = await resolve(reg, path)
  } catch (err) {
    // Lenient tier 3: the last segment may still name a real verb
    const { segments } = parsePath(path)
    const { segments: rest, transient } = splitTransient(segments)
    const scope = scopeTableFor(rest, transient)
    const last = rest[rest.length - 1]
    const verb = Object.hasOwn(scope.verbs, last) ? scope.verbs[last] : null
    if (verb) {
      const detail = verbDetail(path, verb, scope.name)
      detail.note = `the object in this path could not be resolved (${err.message.split('\n')[0]}); the verb is documented anyway`
      return detail
    }
    throw err
  }
  if (target.verb) return verbDetail(path, target.verb, target.scope)
  return describeScope(reg, target)
}

