#!/usr/bin/env node
/**
 * termcdp — **MCP is the only entry point**.
 *
 * Why only one path: CDP sessions (sessionId), the subscriptions created by `enable`,
 * and the event stream all **belong to the process** — and an MCP client spawns this
 * process and **keeps it alive**. So multi-step work comes for free; there is no need
 * to maintain a second private protocol on top.
 *
 *   termcdp           brief help
 *   termcdp --help    full help (every method, params, examples)
 *   termcdp mcp       the only entry point: MCP over stdio (line-delimited JSON-RPC)
 *
 * Nothing is persisted: the process starts empty, the model adds the instances it needs,
 * and exit drops everything. No config file, no audit log, no export directory.
 */
import process from 'node:process'
import { COMMANDS, describeCommands } from '../src/protocol/commands.js'

const argv = process.argv.slice(2)

/** Brief help: what to type, nothing else. */
function renderBrief() {
  return [
    'termcdp — zero-dependency CDP console: many browsers at once, local or remote, from one process.',
    '',
    'Usage:',
    '  termcdp mcp         Start the MCP server over stdio. This is the only entry point.',
    '  termcdp             Show this brief help.',
    '  termcdp --help      Full help: every method, its params and examples.',
    '',
    'Register it with an MCP client:',
    '  { "mcpServers": { "termcdp": { "command": "npx", "args": ["-y", "@open-mcp-ai/termcdp", "mcp"] } } }',
    '',
    'Or drive it by hand — it is plain line-delimited JSON-RPC on stdio:',
    `  echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"invoke","arguments":{"path":"instances","args":["add","local","127.0.0.1:9222"]}}}' \\`,
    '    | termcdp mcp',
    '',
  ].join('\n')
}

/** Full help: the whole surface, with a heading per section. */
function renderHelp() {
  const L = []
  L.push('termcdp — zero-runtime-dependency CDP console')
  L.push('  Cross-machine SOCKS5 transport + multi-instance aggregation + an MCP interface.')
  L.push('  Pure Node (hand-written SOCKS5 / WebSocket / IO.read, no puppeteer/playwright).')
  L.push('  One browser WebSocket governs every tab of a browser (flatten sessions),')
  L.push('  so many instances run at once — local or remote.')
  L.push('')
  L.push('================================================================================')
  L.push('HOW TO RUN')
  L.push('================================================================================')
  L.push('  termcdp mcp        The only entry point: MCP over stdio (line-delimited JSON-RPC).')
  L.push('                     For AI clients: one tool — invoke(path, …args) — plus 5 cdp:// resources.')
  L.push('  termcdp            Brief help.      termcdp --help --json   machine-readable engine command table.')
  L.push('')
  L.push('Without an MCP client, speak MCP directly (it is line-delimited JSON-RPC):')
  L.push(`  echo '{"jsonrpc":"2.0","id":1,"method":"tools/call",`)
  L.push('         "params":{"name":"invoke","arguments":{"path":"instances","args":["list"]}}}\' | termcdp mcp')
  L.push('')
  L.push('Why there are no subcommands: sessions belong to the process, and an MCP client')
  L.push('spawns this process and keeps it alive — so multi-step flows already work inside it.')
  L.push('A second private protocol would just be a second implementation with a second set of bugs.')
  L.push('')
  L.push('Registering it with an MCP client:')
  L.push('  { "mcpServers": { "termcdp": { "command": "npx", "args": ["-y", "@open-mcp-ai/termcdp", "mcp"] } } }')
  L.push('')
  L.push('================================================================================')
  L.push('PATHS — how the model addresses things')
  L.push('================================================================================')
  L.push('There is one tool, invoke(path, …args). The path is a dotted object location whose **last')
  L.push('segment is the verb**; the args are positional. A bare object is a read (list / describe).')
  L.push('')
  L.push('  invoke("instances")                              list instances')
  L.push('  invoke("instances", "add", "lab1", "127.0.0.1:9222")')
  L.push('  invoke("lab1")                                   describe one instance')
  L.push('  invoke("lab1.targets", "page")                   list targets → targetId')
  L.push('  invoke("lab1.attach", targetId)                  → sessionId')
  L.push('  invoke("lab1.S1.call", "Runtime.evaluate", {expression:"1+1"})')
  L.push('  invoke("lab1@ABC123.call", "Page.reload")        one-shot: attach → call → detach')
  L.push('  invoke("events", since)                          event stream (continue with `since`)')
  L.push('  invoke("read", resultId, offset, maxBytes)       page through a payload')
  L.push('  invoke("batch", {calls:[{path:…, args:…}, …]})  fan out, across instances')
  L.push('')
  L.push('Usage is documented progressively inside the tool itself:')
  L.push('  invoke("help")                    the roots + the live instances')
  L.push('  invoke("help", "lab1")            what one instance offers (verbs + live sessions)')
  L.push('  invoke("help", "lab1.S1.call")    one verb: signature, args, returns, examples')
  L.push('')
  L.push('Disambiguation: a segment is a verb when it is a known verb **and** the last segment,')
  L.push('otherwise it is an object id (a live session id, or instance@targetId for the one-shot')
  L.push('form). Instance names cannot contain "." or "@" (validated at add time), so the grammar')
  L.push('is unambiguous — and unknown segments error with the live alternatives listed.')
  L.push('')
  L.push('================================================================================')
  L.push('ENGINE COMMANDS — what paths resolve to')
  L.push('================================================================================')
  L.push('Every path above resolves to one of the commands below (the same table the CLI `hello`')
  L.push('and `--json` describe). They are the engine API, not the model-facing surface:')
  L.push('  {"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"invoke","arguments":{"path":"…","args":[…]}}}')
  L.push('')
  for (const cmd of COMMANDS) {
    const params = Object.entries(cmd.params ?? {})
    L.push(`${cmd.name}${params.length ? `  (${params.map(([k, v]) => (v.required ? k : `[${k}]`)).join(', ')})` : ''}`)
    L.push(`    ${cmd.summary}`)
    if (cmd.returns) L.push(`    returns: ${cmd.returns}`)
    if (cmd.danger) L.push('    ⚠ dangerous: alters pages or touches sensitive data')
    for (const exa of cmd.examples ?? []) L.push(`    e.g. ${exa}`)
    L.push('')
  }
  L.push('================================================================================')
  L.push('INSTANCES')
  L.push('================================================================================')
  L.push('The process starts **empty** — nothing is read from disk. Add an instance and the')
  L.push('connection is made immediately:')
  L.push('  {action:"add", name:"lab1", spec:"127.0.0.1:9222"}')
  L.push('  {action:"add", name:"win10", spec:"socks5://127.0.0.1:1080?cdp=127.0.0.1:9222"}   ← the cross-machine path')
  L.push('  The cdp= host in a spec must be an IP or localhost (DevTools validates the Host')
  L.push('  header; a domain name gets a 500)')
  L.push('')
  L.push('Nothing survives exit: no config file, no audit log, no export directory. On the next')
  L.push('connection the model adds its instances again. The process is a stateless translator.')
  L.push('')
  L.push('================================================================================')
  L.push('EVENTS')
  L.push('================================================================================')
  L.push('The event stream lives **in-process** (CDP has no event replay). Use invoke("events", since)')
  L.push('and continue with `since`: every entry carries a monotonic sequence number n — remember')
  L.push('latest from the response and pass it as since next time to get only the new tail.')
  L.push('')
  return L.join('\n')
}

async function main() {
  const first = argv[0]

  if (first === 'mcp') {
    const { runMcpServer } = await import('../src/mcp/server.js')
    return runMcpServer({ actor: 'mcp' })
  }

  if (first === '--help' || first === '-h' || first === 'help') {
    if (argv.includes('--json')) {
      process.stdout.write(
        `${JSON.stringify({ protocol: 1, mode: 'standalone', commands: describeCommands() }, null, 2)}\n`,
      )
      return 0
    }
    process.stdout.write(`${renderHelp()}\n`)
    return 0
  }

  if (!first) {
    process.stdout.write(`${renderBrief()}\n`)
    return 0
  }

  process.stderr.write(
    `Unknown entry point: ${first}\n\n` +
      'termcdp has only one entry point:\n' +
      '  termcdp mcp     Start the MCP server (MCP over stdio)\n\n' +
      '  termcdp         Brief help\n' +
      '  termcdp --help  Full help\n\n' +
      'Why there are no subcommands: CDP sessions belong to the process, and an MCP client spawns this process and keeps it alive.\n' +
      'To drive it without an MCP client, speak MCP directly (it is line-delimited JSON-RPC):\n' +
      `  echo '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"invoke","arguments":{"path":"instances","args":["list"]}}}' | termcdp mcp\n\n` +
      'For all methods and examples: termcdp --help\n',
  )
  return 2
}

main()
  .then((code) => process.exit(code ?? 0))
  .catch((err) => {
    process.stderr.write(`error: ${err?.message ?? err}\n`)
    if (process.env.TERMCDP_DEBUG) process.stderr.write(`${err?.stack}\n`)
    process.exit(1)
  })
