/**
 * Command table — the **engine API**: the internal RPC the process speaks with itself.
 *
 * It drives two things, so they can never drift:
 *   - MCP `hello` (self-description: a client or model learns the surface first thing)
 *   - the `termcdp --help` / `--help --json` output
 *
 * It is deliberately **not** the model-facing surface anymore: that is the invoke path grammar in
 * `paths.js`, and every path resolves to one of the commands here. Keeping the two separate is
 * what let the surface become one tool without touching the engine.
 *
 * Note: there is **no CLI subcommand**. Every method is "a JSON request sent into one
 * long-lived process", because CDP sessions (sessionId) belong to the process —
 * see README for the per-process semantics.
 */
export const PROTOCOL_VERSION = 1

const p = {
  instance: (desc, required = false) => ({ type: 'string', desc, required }),
  sessionId: (desc, required = false) => ({ type: 'string', desc, required }),
  method: (desc, required = true) => ({ type: 'string', desc, required }),
  params: (desc) => ({ type: 'object', desc }),
  since: (desc) => ({ type: 'number', desc, default: 0 }),
  limit: (desc) => ({ type: 'number', desc, default: 50 }),
}

/** Render a JSON request as an example (exactly the form a raw JSON-RPC call takes). */
const ex = (method, params) => JSON.stringify({ method, params })

/**
 * @typedef {object} CommandSpec
 * @property {string} name          Method name (sent as `method` in JSON-RPC)
 * @property {string} summary       One-line description — the same text for humans and for the model
 * @property {object} params        Param shorthand
 * @property {boolean} [danger]     Whether it may destroy / touch sensitive data (surfaced to the model as a warning)
 * @property {string[]} [examples]  Examples (as JSON requests)
 * @property {string} [returns]     Return-value description
 */

/** @type {CommandSpec[]} */
export const COMMANDS = [
  {
    name: 'hello',
    summary: 'Handshake: returns the protocol version, the command table, and the instance list. Any client or model calls this first to self-describe the surface',
    params: {},
    examples: [ex('hello', {})],
    returns: 'protocol, commands[] (with param descriptions), instances[]',
  },
  {
    name: 'status',
    summary: 'Overview of this process: uptime, instances, sessions, event-log size, result-store size',
    params: {},
    examples: [ex('status', {})],
    returns: 'process status',
  },
  {
    name: 'instances',
    summary:
      'Manage CDP instances (endpoints). action=list|add|remove|connect|connect-all|disconnect. ' +
      'A spec looks like `127.0.0.1:9222` (direct) or `socks5://127.0.0.1:1080?cdp=127.0.0.1:9222` (via proxy — the cross-machine path). ' +
      'disconnect is **sticky**: after it the instance will not reconnect (autoReconnect does not cover it either), ' +
      'and subsequent call/targets/sessions/protocol return `instance-disconnected`; reconnecting requires an explicit connect. ' +
      'The `manuallyDisconnected` flag in describe distinguishes "deliberately disconnected" from "crashed"',
    params: {
      action: {
        type: 'string',
        enum: ['list', 'add', 'remove', 'connect', 'connect-all', 'disconnect'],
        desc: 'What to do',
        required: true,
      },
      name: { type: 'string', desc: 'Instance name (required for add; selects the target for the other actions)' },
      spec: { type: 'string', desc: 'Endpoint spec string (required for add)' },
      connect: { type: 'boolean', desc: 'Connect immediately after adding', default: true },
    },
    examples: [
      ex('instances', { action: 'add', name: 'lab1', spec: '127.0.0.1:9222' }),
      ex('instances', { action: 'add', name: 'win10', spec: 'socks5://127.0.0.1:1080?cdp=127.0.0.1:9222' }),
      ex('instances', { action: 'list' }),
    ],
    returns: 'instance list (with connection state, product, target/session counts)',
  },
  {
    name: 'targets',
    summary: 'List targets (tabs / workers / iframes). Without an instance it aggregates **all** instances',
    params: {
      instance: p.instance('Instance name; omit = all instances'),
      type: { type: 'string', desc: 'Filter by type, e.g. page / service_worker / iframe' },
      attach: { type: 'boolean', desc: 'Also report whether each target already has a session', default: false },
    },
    examples: [ex('targets', {}), ex('targets', { instance: 'win10', type: 'page' })],
    returns: 'targets[]: instance, targetId, type, title, url, attached',
  },
  {
    name: 'attach',
    summary:
      'Open a CDP session (flatten) for a target and return the sessionId — every command after this carries it. ' +
      'Note: the sessionId is only valid **within the current process**; a new process must attach again',
    params: {
      instance: p.instance('Instance name', true),
      targetId: { type: 'string', desc: 'target id (from targets)', required: true },
    },
    examples: [ex('attach', { instance: 'lab1', targetId: 'ABC123' })],
    returns: 'sessionId and other session info',
  },
  {
    name: 'detach',
    summary: 'Close a session (does not close the tab)',
    params: {
      instance: p.instance('Instance name', true),
      sessionId: p.sessionId('session id', true),
    },
    examples: [ex('detach', { instance: 'lab1', sessionId: 'S1' })],
    returns: '{ detached: true }',
  },
  {
    name: 'sessions',
    summary: 'List all sessions currently held by **this process**, including enabled domains and the Emulation expectation state',
    params: { instance: p.instance('Instance name; omit = all') },
    examples: [ex('sessions', {})],
    returns: 'sessions[]',
  },
  {
    name: 'call',
    summary:
      '**Run any CDP command** (this is how we avoid enumerating the whole protocol). ' +
      'Fetch a domain\'s signature with `protocol` first, then fill in method and params accordingly',
    params: {
      instance: p.instance('Instance name', true),
      sessionId: p.sessionId('session id; omit = browser-level command (Browser. / Target. etc.)'),
      method: p.method('CDP method name, e.g. Page.navigate / Runtime.evaluate / Network.enable'),
      params: p.params('CDP params object (fill per the protocol signature)'),
      timeoutMs: { type: 'number', desc: 'timeout in ms, default 30000' },
      inlineBytes: {
        type: 'number',
        desc:
          'When the payload is ≤ this many bytes, the whole content comes back in the receipt\'s data field; ' +
          'above it, not a single byte is inlined — use read instead. ' +
          'Default 4096 — results like `{}` from Runtime.enable or the frameId from Page.navigate arrive complete in one round trip; only large payloads go through read',
        default: 4096,
      },
    },
    danger: true,
    examples: [
      ex('call', { instance: 'lab1', sessionId: 'S1', method: 'Runtime.evaluate', params: { expression: 'document.title', returnByValue: true } }),
      ex('call', { instance: 'lab1', sessionId: 'S1', method: 'Page.navigate', params: { url: 'https://example.com' } }),
      ex('call', { instance: 'lab1', method: 'Browser.getVersion' }),
    ],
    returns:
      'A **receipt**: {resultId, instance, sessionId?, method, at, bytes, sha256, data?}. ' +
      'The payload body lives in the result store (in-memory, bounded, FIFO eviction) — `data` is present only when ' +
      'the whole thing fits inlineBytes (complete or nothing, never truncated). When it is absent, page through it with ' +
      'read by resultId',
  },
  {
    name: 'batch',
    summary: 'Run many commands in one round trip; can fan out across instances (do the same thing to several browsers at once)',
    params: {
      calls: {
        type: 'array',
        items: { type: 'object' },
        desc: 'Array, one entry per call: {instance, sessionId?, method, params?, inlineBytes?} (inlineBytes omitted → call\'s default)',
        required: true,
      },
      mode: { type: 'string', enum: ['parallel', 'sequential'], desc: 'default parallel', default: 'parallel' },
      failFast: { type: 'boolean', desc: 'Abort on first error (effective in sequential mode)', default: false },
    },
    examples: [
      ex('batch', {
        calls: [
          { instance: 'lab1', sessionId: 'S1', method: 'Page.reload' },
          { instance: 'win10', sessionId: 'S2', method: 'Page.reload' },
        ],
      }),
    ],
    returns: 'results[]: each entry ok/ms plus a receipt (resultId…), in the same order as the input',
  },
  {
    name: 'events',
    summary:
      'Read **this process\'s** event stream (CDP has no event replay, so each process keeps its own ring log with ' +
      '**monotonic sequence numbers n**). Remember latest from the response and pass it as since next time to pull only ' +
      'the new tail. **Event params go through the receipt too**: every entry carries a resultId, and you read the body ' +
      'with read — that way fetching a few dozen events does not dump hundreds of KB of params into your context',
    params: {
      since: p.since('Only return events with n > since (continuation cursor)'),
      instance: p.instance('Only this instance'),
      sessionId: p.sessionId('Only this session'),
      method: { type: 'string', desc: 'Match one CDP event method name exactly' },
      prefix: { type: 'string', desc: 'Match by prefix, e.g. Network. or Page.' },
      limit: p.limit('How many entries at most (default 50, the newest)'),
      order: { type: 'string', enum: ['asc', 'desc'], desc: 'default asc', default: 'asc' },
      inlineBytes: {
        type: 'number',
        desc:
          'When the event params are ≤ this many bytes the full data comes with the receipt; above it, nothing — use read. ' +
          'Default 512 — events are read in batches (default 50), so a large window would eat tens of KB of context at once; ' +
          'raise it for big events like full headers, or just read them',
        default: 512,
      },
    },
    examples: [ex('events', { since: 0, prefix: 'Network.', limit: 20 })],
    returns: 'events[]: receipts (n, resultId, instance, sessionId, method, at, bytes, data?); plus latest (the next since)',
  },
  {
    name: 'read',
    summary:
      'Page through a payload by resultId (you manage the offset cursor yourself). If a receipt already carries data, ' +
      'that is the whole content and you do not need this — use it only when data was absent (payload exceeded inlineBytes). ' +
      'Command results and event params both live in the result store; how much you fetch is entirely up to you',
    params: {
      resultId: { type: 'string', required: true, desc: 'the id from a receipt, e.g. win10/42' },
      offset: { type: 'number', desc: 'start byte, default 0' },
      maxBytes: { type: 'number', desc: 'how many bytes to fetch this time, default 65536' },
    },
    examples: [ex('read', { resultId: 'win10/42' }), ex('read', { resultId: 'win10/42', offset: 65536 })],
    returns: '{resultId, offset, nextOffset, eof, totalBytes, data}',
  },
  {
    name: 'results',
    summary: 'Result index: which payloads have come through recently (receipts only, no bodies). Use it when you forgot an id or want to see what was captured earlier',
    params: {
      since: p.since('Only receipts with seq > since'),
      instance: p.instance('Only this instance'),
      limit: p.limit('How many at most (default 50)'),
    },
    examples: [ex('results', { limit: 20 })],
    returns: '{results:[receipts], latest, store:{count,bytes,maxBytes,seq,evicted}}',
  },
  {
    name: 'protocol',
    summary:
      'Fetch the **live** CDP protocol signature from the browser itself (its /json/protocol endpoint, not something we hardcode). ' +
      'Without a domain it returns the domain list; with one, that domain\'s commands / events / types',
    params: {
      instance: p.instance('Instance name', true),
      domain: { type: 'string', desc: 'e.g. Page / Network / Fetch; omit = list domains and their sizes only' },
      search: { type: 'string', desc: 'Fuzzy-search command names within that domain' },
    },
    examples: [ex('protocol', { instance: 'lab1' }), ex('protocol', { instance: 'lab1', domain: 'Fetch' })],
    returns: 'domains[] or one domain\'s detailed signature',
  },
]

/** name → definition */
export const COMMAND_MAP = new Map(COMMANDS.map((c) => [c.name, c]))

/** Machine-readable description, used by `hello` and the help output */
export function describeCommands() {
  return COMMANDS.map((c) => ({
    name: c.name,
    summary: c.summary,
    params: Object.fromEntries(
      Object.entries(c.params).map(([k, v]) => [
        k,
        { type: v.type ?? 'string', required: !!v.required, enum: v.enum, desc: v.desc, default: v.default },
      ]),
    ),
    danger: !!c.danger,
    returns: c.returns,
    examples: c.examples,
  }))
}

