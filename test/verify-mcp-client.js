#!/usr/bin/env node
/**
 * 集成验收：用**官方** @modelcontextprotocol/sdk 的客户端真的连一次 termcdp。
 *
 * p3 是自己拼 JSON-RPC 帧，能覆盖协议细节；本文件覆盖的是另一回事：
 * 一个真实的 MCP 客户端库（它怎么初始化、怎么校验 inputSchema、怎么解析
 * resources/templates、怎么处理 isError 和 _meta）能否正常驱动这个服务器。
 *
 * 与默认验收的关系：本仓库**零运行时依赖**，SDK 只是 dev 依赖，
 * `npm run verify` 只有在 SDK 已安装时才把本套件算进去；没装就跳过，不算失败。
 *   npm i -D @modelcontextprotocol/sdk
 *   node test/verify-mcp-client.js
 */
import path from 'node:path'
import os from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import process from 'node:process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = process.env.TERMCDP_BIN ?? path.join(HERE, '..', 'bin', 'termcdp.js')
const PORT = 9361

const HOME = await mkdtemp(path.join(os.tmpdir(), 'termcdp-mcp-home-'))
process.env.TERMCDP_HOME = HOME

// ---- SDK 缺席时优雅跳过（保持默认验收的零依赖可跑性）----
let Client, StdioClientTransport
try {
  const require = createRequire(import.meta.url)
  ;({ Client } = require('@modelcontextprotocol/sdk/client/index.js'))
  ;({ StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js'))
} catch {
  console.log('跳过 verify-mcp-client：未安装 @modelcontextprotocol/sdk（dev 依赖，仓库本身零依赖）')
  console.log('  npm i -D @modelcontextprotocol/sdk  →  本套件进入 npm run verify')
  console.log('=== 结果：跳过（0/0，SDK 未安装，不算失败）===')
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
  process.exit(0)
}

const { launchBrowser, createRunner, assert, readReceipt } = await import('./harness.js')
const { step, summary } = createRunner()

let browser = null
let transport = null
let client = null

/** 封装：调一次 invoke 工具，拆掉 content 包装，返回解析后的 JSON */
async function invoke(path, args = []) {
  const res = await client.callTool({ name: 'invoke', arguments: { path, args } })
  const text = res.content?.[0]?.text
  assert(res.isError !== true, `invoke("${path}") 失败：${text}`)
  try {
    return { meta: res._meta, json: JSON.parse(text) }
  } catch {
    throw new Error(`invoke("${path}") 返回不是 JSON：${String(text).slice(0, 200)}`)
  }
}

/** 失败形态：客户端 SDK 应把 isError: true 透出来，文本给模型看 */
async function invokeErr(path, args = []) {
  const res = await client.callTool({ name: 'invoke', arguments: { path, args } })
  assert(res.isError === true, `invoke("${path}") 本该失败，实际成功了`)
  return res.content?.[0]?.text ?? ''
}

try {
  await step('SDK 客户端：connect + initialize，拿到 instructions 与能力', async () => {
    browser = await launchBrowser({ port: PORT })
    transport = new StdioClientTransport({
      command: process.execPath,
      args: [BIN, 'mcp'],
      env: { ...process.env, TERMCDP_HOME: HOME },
    })
    client = new Client({ name: 'verify-mcp-client', version: '1.0.0' }, { capabilities: {} })
    await client.connect(transport)
    assert(client.getServerVersion().name === 'termcdp', `serverInfo 异常：${JSON.stringify(client.getServerVersion())}`)
    const instructions = client.getInstructions()
    assert(/invoke\(/.test(instructions) && /invoke\("help"/.test(instructions), 'instructions 应教 invoke 语法并指向 help')
    const caps = client.getServerCapabilities()
    assert(caps.tools && caps.resources, 'capabilities 应声明 tools 与 resources')
    return `serverVersion=${client.getServerVersion().name}/${client.getServerVersion().version}，instructions ${instructions.length} 字符`
  })

  await step('SDK 客户端：listTools 只有一个 invoke，且 inputSchema 不被客户端拒绝', async () => {
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name)
    assert(names.length === 1 && names[0] === 'invoke', `应只有 invoke，实际：${names}`)
    const schema = tools[0].inputSchema
    assert(schema.required?.includes('path'), 'path 应必填')
    assert(schema.properties.args.type === 'array', 'args 应是数组（变长位置参数）')
    return `${tools.length} 个工具：${names.join(', ')}`
  })

  await step('SDK 客户端：全程路径操作 —— add → targets → attach → call → read', async () => {
    const added = await invoke('instances', ['add', 'lab1', `127.0.0.1:${PORT}`])
    assert(added.json.name === 'lab1' && added.json.status === 'ready', `add 后应就绪：${JSON.stringify(added.json).slice(0, 200)}`)

    const t = await invoke('lab1.targets', ['page'])
    const targetId = t.json.targets[0]?.targetId
    assert(targetId, `SDK 客户端应拿到 target：${JSON.stringify(t.json).slice(0, 200)}`)

    const attached = await invoke('lab1.attach', [targetId])
    const sessionId = attached.json.sessionId
    assert(sessionId, 'attach 应返回 sessionId')

    const receipt = await invoke(`lab1.${sessionId}.call`, ['Runtime.evaluate', { expression: '"sdk" + 1', returnByValue: true }])
    assert(receipt.json.resultId, 'call 应回收据')
    // 客户端把 resultId 透传回来后，模型自己按需 read；这里复用引擎里的 read 助手
    // （readReceipt 期望裸的 read 响应 {offset, eof, data…}，所以这里剥掉一层包装）
    const viaRead = async (method, params) => (await invoke('read', [params.resultId, params.offset, params.maxBytes])).json
    const val = (await readReceipt(viaRead, receipt.json)).result.value
    assert(val === 'sdk1', `SDK 客户端走完全程后求值应为 sdk1，实际 ${JSON.stringify(val)}`)
    // 危险标记：SDK 应回传 _meta.danger（call 是会改页面的动词）
    assert(receipt.meta?.danger === true, 'call 路径应带 _meta.danger')
    const safe = await invoke('lab1')
    assert(safe.meta?.danger === undefined, '只读路径不该带 danger')
    return `targets → attach → evaluate = ${JSON.stringify(val)}；danger 标记按路径正确（call 带，只读不带）`
  })

  await step('SDK 客户端：@targetId 一次性调用 + batch 扇出', async () => {
    const before = await invoke('lab1.sessions')
    const { targets } = (await invoke('lab1.targets', ['page'])).json
    // 找一个当前没 attach 的 target：listTargets 里 attached=false 的那个
    const row = targets.find((x) => !x.attached) ?? targets[0]
    const one = await invoke(`lab1@${row.targetId}.call`, ['Browser.getVersion'])
    assert(one.json.resultId, '一次性调用应回收据')
    const after = await invoke('lab1.sessions')
    assert(after.json.sessions.length === before.json.sessions.length, '@ 调用不应改变会话表')

    const bt = await invoke('batch', [
      {
        calls: [
          { path: 'lab1.call', args: ['Browser.getVersion'] },
          { path: 'lab1.call', args: ['Browser.getVersion'] },
        ],
      },
    ])
    assert(bt.json.summary.ok === 2, `batch 应全成功：${JSON.stringify(bt.json).slice(0, 200)}`)
    return `@${row.targetId.slice(0, 8)}… 一次性✓；会话数 ${before.json.sessions.length}→${after.json.sessions.length}；batch ok=${bt.json.summary.ok}`
  })

  await step('SDK 客户端：help 三档在真实客户端里能逐层读到', async () => {
    const root = await invoke('help')
    assert(root.json.scope === 'root' && root.json.instances.includes('lab1'), '根档应列出实例')
    const inst = await invoke('help', ['lab1'])
    assert(inst.json.scope === 'instance' && inst.json.verbs.call, '对象档应列出动词')
    const verb = await invoke('help', ['lab1.call'])
    assert(verb.json.signature.startsWith('call(method'), '动词档应给签名')
    return `根 → 实例（${Object.keys(inst.json.verbs).length} 动词）→ 「${verb.json.signature}」`
  })

  await step('SDK 客户端：listResources/readResource/templates 走资源通道', async () => {
    const { resources } = await client.listResources()
    const uris = resources.map((r) => r.uri)
    for (const u of ['cdp://instances', 'cdp://sessions', 'cdp://protocol', 'cdp://status', 'cdp://results']) {
      assert(uris.includes(u), `缺少资源 ${u}（实际 ${uris}）`)
    }
    const { resourceTemplates } = await client.listResourceTemplates()
    assert(resourceTemplates.some((t) => t.uriTemplate === 'cdp://protocol/{domain}'), '缺少协议域模板')

    const read = await client.readResource({ uri: 'cdp://status' })
    const status = JSON.parse(read.contents[0].text)
    assert(status.pid > 0 && status.instances?.length === 1, `status 资源内容异常：${JSON.stringify(status).slice(0, 200)}`)

    const proto = await client.readResource({ uri: 'cdp://protocol/Runtime?instance=lab1' })
    const runtime = JSON.parse(proto.contents[0].text)
    assert(runtime.commands.some((c) => c.name === 'evaluate'), `Runtime 域应含 evaluate：${JSON.stringify(runtime).slice(0, 200)}`)
    return `${uris.length} 个资源 + 1 模板；status pid=${status.pid}；Runtime 域 ${runtime.commands.length} 条命令`
  })

  await step('SDK 客户端：错误经 isError 透出，客户端拿到的就是可读文本', async () => {
    const err = await invokeErr('ghost.call', ['Browser.getVersion'])
    assert(/unknown instance/i.test(err) && /lab1/.test(err), `未知实例应列出已知：${err}`)
    const badTool = await client.callTool({ name: 'nope', arguments: {} }).catch((e) => e)
    // 未知工具在协议层是 isError（不是 JSON-RPC 异常），客户端不应抛
    assert(badTool?.isError === true || badTool?.message, '未知工具应返回 isError 或抛出可读异常')
    return 'isError 透出正常'
  })

  await step('SDK 客户端：关连接、关进程，无残留', async () => {
    await client.close()
    await browser.kill()
    await rm(HOME, { recursive: true, force: true }).catch(() => {})
    return 'done'
  })
} catch (err) {
  console.error(`\n致命错误：${err?.stack ?? err}`)
  await client?.close().catch(() => {})
  await browser?.kill().catch(() => {})
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
}

summary()
