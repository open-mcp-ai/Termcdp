#!/usr/bin/env node
/**
 * P3 验收：MCP 薄壳（**真实子进程**走 stdio 管道）+ 入口收敛
 *
 * MCP 的真实形态就是 stdio 上的行分隔 JSON-RPC，进程内假装测不到编码/缓冲/退出这类问题，
 * 所以这里必须 spawn 真的 `termcdp mcp`。
 *
 * 模型表面是**一个 invoke 工具**：invoke(path, …args)。这里整篇都按路径语法调用，
 * 顺带验收三档 help、@targetId 一次性会话、以及消歧错误信息。
 *
 * ⚠️ 单进程模型下的一个重要语义（本测试特意验证它）：
 *   **会话（sessionId）是"进程内"的** —— 父进程 attach 拿到的 sessionId，
 *   在子进程（mcp）里无效，因为它们是各自独立的连接与世界。
 *   浏览器里的 target 是共享的（那是浏览器状态），所以子进程能看见 target、但必须自己 attach。
 *
 *   node test/verify-p3.js
 */
import os from 'node:os'
import path from 'node:path'
import { spawn, execFile } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const HOME = await mkdtemp(path.join(os.tmpdir(), 'termcdp-p3-home-'))
process.env.TERMCDP_HOME = HOME

const { LocalClient } = await import('../src/engine/local-client.js')
const { launchBrowser, createRunner, assert, readReceipt, sleep } = await import('./harness.js')
const { startSocks5Server } = await import('./socks5-server.js')

const HERE = path.dirname(fileURLToPath(import.meta.url))
const BIN = process.env.TERMCDP_BIN ?? path.join(HERE, '..', 'bin', 'termcdp.js')
const PORT = 9351
const PORT_B = 9352

const runner = createRunner()
const { step } = runner

let client = null
let browser = null
let browserB = null
let socks = null
let mcp = null

let rpcSeq = 100
const nextRpcId = () => ++rpcSeq
const rpc = (id, method, params) => ({ jsonrpc: '2.0', id, method, params })

/**
 * 子进程那侧的调用函数：走 MCP 唯一的工具 invoke(path, args)。
 * MCP 把结果包在 content[0].text 里，这里把壳拆掉，返回**载荷/收据**本身。
 */
async function invokeCall(path, args = []) {
  mcp.send(rpc(nextRpcId(), 'tools/call', { name: 'invoke', arguments: { path, args } }))
  const msg = await mcp.nextJson()
  const text = msg.result?.content?.[0]?.text
  assert(msg.result?.isError !== true, `invoke("${path}") 失败：${text}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`invoke("${path}") 的返回不是 JSON：${String(text).slice(0, 200)}`)
  }
}

/** invoke 的失败形态：模型靠这段文本自救，所以这里专门收它 */
async function invokeError(path, args = []) {
  mcp.send(rpc(nextRpcId(), 'tools/call', { name: 'invoke', arguments: { path, args } }))
  const msg = await mcp.nextJson()
  assert(msg.result?.isError === true, `invoke("${path}") 本该失败，实际成功了`)
  return msg.result.content[0].text
}

/**
 * 按 resultId 把正文读回来（子进程侧的 read 动词），把 read 的包装拆成载荷本身。
 * 位置参数顺序就是 read 的签名：resultId, offset, maxBytes。
 */
const readVia = (method, params) => invokeCall('read', [params.resultId, params.offset, params.maxBytes])
const readPayload = (resultId, maxBytes = 8 * 1024 * 1024) => readReceipt(readVia, { resultId }, { maxBytes })

/** 起一个子进程，按行收发 JSON */
function spawnChild(args, { env = {}, timeoutMs = 15_000 } = {}) {
  const proc = spawn(process.execPath, [BIN, ...args], {
    env: { ...process.env, TERMCDP_HOME: HOME, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const state = { proc, queue: [], waiters: [], stderr: '', buf: '' }
  proc.stdout.on('data', (chunk) => {
    state.buf += chunk.toString('utf8')
    const parts = state.buf.split('\n')
    state.buf = parts.pop() ?? ''
    for (const raw of parts) {
      const line = raw.replace(/\r$/, '')
      if (!line.trim()) continue
      const waiter = state.waiters.shift()
      if (waiter) waiter.resolve(line)
      else state.queue.push(line)
    }
  })
  proc.stderr.on('data', (chunk) => {
    state.stderr += chunk.toString('utf8')
  })
  proc.on('exit', (code) => {
    for (const w of state.waiters.splice(0)) w.reject(new Error(`子进程已退出(code=${code})；stderr=${state.stderr.slice(-500)}`))
  })
  return {
    proc,
    get stderr() {
      return state.stderr
    },
    send(obj) {
      proc.stdin.write(`${JSON.stringify(obj)}\n`)
    },
    next(timeout = timeoutMs) {
      if (state.queue.length) return Promise.resolve(state.queue.shift())
      return new Promise((resolve, reject) => {
        const entry = {
          resolve: (line) => {
            clearTimeout(timer)
            resolve(line)
          },
          reject,
        }
        const timer = setTimeout(() => {
          const idx = state.waiters.indexOf(entry)
          if (idx >= 0) state.waiters.splice(idx, 1)
          reject(new Error(`等待子进程输出超时（${timeout}ms）；stderr=${state.stderr.slice(-500)}`))
        }, timeout)
        state.waiters.push(entry)
      })
    },
    async nextJson(timeout) {
      const line = await this.next(timeout)
      try {
        return JSON.parse(line)
      } catch {
        throw new Error(`子进程输出的不是 JSON：${line.slice(0, 200)}`)
      }
    },
    close() {
      try {
        proc.stdin.end()
      } catch {
        /* ignore */
      }
      try {
        proc.kill()
      } catch {
        /* ignore */
      }
    },
  }
}

console.log(`\n=== termcdp P3 验收 ===\nTERMCDP_HOME=${HOME}\n`)

try {
  await step('准备：浏览器 + 进程内引擎 + 一个实例（父进程自己 add）', async () => {
    browser = await launchBrowser({ port: PORT })
    client = await LocalClient.open({ actor: 'p3-parent' })
    await client.call('instances', { action: 'add', name: 'lab1', spec: `127.0.0.1:${PORT}` })
    const { instances } = await client.call('instances', { action: 'list' })
    assert(instances[0].status === 'ready', `实例未就绪：${JSON.stringify(instances[0])}`)
    return `lab1 → 127.0.0.1:${PORT}（只在父进程里；子进程待会儿自己 add）`
  })

  // ---------------- MCP ----------------
  // 注意：mcp 是**模块级**变量 —— invokeCall/invokeError 这些辅助要用它，
  // 这里再 let 一个同名的会把它遮住（辅助会取到未初始化的绑定）。

  await step('MCP：initialize 返回能力 + instructions（自描述）', async () => {
    mcp = spawnChild(['mcp'])
    mcp.send(rpc(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'p3', version: '1' } }))
    const res = await mcp.nextJson()
    assert(res.id === 1 && res.result, `initialize 响应异常：${JSON.stringify(res).slice(0, 200)}`)
    assert(res.result.protocolVersion === '2025-06-18', `协议版本未回显：${res.result.protocolVersion}`)
    assert(res.result.capabilities.tools && res.result.capabilities.resources, 'capabilities 缺 tools/resources')
    assert(res.result.serverInfo.name === 'termcdp', 'serverInfo 异常')
    assert(/invoke\(/.test(res.result.instructions) && /socks5/.test(res.result.instructions), 'instructions 应教 invoke 语法')
    assert(/invoke\("help"/.test(res.result.instructions), 'instructions 应指向 help 入口')
    mcp.send({ jsonrpc: '2.0', method: 'notifications/initialized' })
    return `instructions ${res.result.instructions.length} 字符`
  })

  await step('MCP：tools/list 只有 1 个工具 invoke（不枚举 CDP 命令）', async () => {
    mcp.send(rpc(2, 'tools/list', {}))
    const res = await mcp.nextJson()
    const tools = res.result.tools
    const names = tools.map((t) => t.name)
    assert(names.length === 1 && names[0] === 'invoke', `应只有 1 个 invoke 工具，实际：${names}`)
    const schema = tools[0].inputSchema
    assert(schema.type === 'object' && schema.required.includes('path'), 'path 应必填')
    // args 是「变长 + 变类型」的位置参数：MCP 不支持真正的位置参数，
    // array of any 是唯一正解（items:{} 表示任意类型）
    assert(schema.properties.args.type === 'array', 'args 应是数组')
    assert(JSON.stringify(schema.properties.args.items) === '{}', 'args 的元素应是任意类型')
    assert(/invoke\("help"/.test(tools[0].description), '工具描述应指向 help')
    return `${tools.length} 个工具：${names.join(', ')}（args: array of any）`
  })

  await step('MCP：新连接从空开始 —— 模型自己 add 实例（不读任何配置）', async () => {
    // 无状态的核心：mcp 子进程一启动是空的，父进程 add 的 lab1 不会渗进来。
    // 谁用谁 add —— 浏览器还活着，target 是浏览器状态所以共享，但连接要自己建。
    const empty = await invokeCall('instances')
    assert(empty.instances.length === 0, `新连接应从空开始，实际有 ${empty.instances.length} 个：${JSON.stringify(empty).slice(0, 200)}`)

    const added = await invokeCall('instances', ['add', 'lab1', `127.0.0.1:${PORT}`])
    assert(added.name === 'lab1' && added.status === 'ready', `add 后应返回该就绪实例：${JSON.stringify(added).slice(0, 200)}`)

    const list = await invokeCall('instances')
    assert(list.instances.length === 1 && list.instances[0].name === 'lab1', `instances 结果异常：${JSON.stringify(list).slice(0, 200)}`)

    // 裸实例路径 = describe
    const desc = await invokeCall('lab1')
    assert(desc.name === 'lab1' && desc.targets > 0, `裸 lab1 应是 describe：${JSON.stringify(desc).slice(0, 200)}`)

    const t = await invokeCall('lab1.targets', ['page'])
    assert(t.targets.length >= 1, `MCP 应能看到浏览器里的 target：${JSON.stringify(t).slice(0, 200)}`)
    return `空 → add lab1 → ${list.instances.length} 实例 / ${t.targets.length} 个 page target（target 共享，连接各建各的）`
  })

  await step('MCP：help 三档逐层读用法（渐进式文档）', async () => {
    // 第一档：根 —— 列出所有根动词 + 活实例
    const root = await invokeCall('help')
    assert(root.scope === 'root', `help 根档应标 scope=root：${JSON.stringify(root).slice(0, 200)}`)
    for (const name of ['instances', 'events', 'read', 'results', 'status', 'hello', 'batch', 'help']) {
      assert(root.verbs[name], `根档缺少动词 ${name}`)
    }
    assert(root.instances.includes('lab1'), '根档应列出活实例 lab1')

    // 第二档：对象 —— 这个实例有哪些动词 + 活会话/活 target
    const inst = await invokeCall('help', ['lab1'])
    assert(inst.scope === 'instance' && inst.instance === 'lab1', `help 对象档异常：${JSON.stringify(inst).slice(0, 200)}`)
    for (const name of ['targets', 'attach', 'call', 'sessions', 'protocol', 'connect', 'disconnect']) {
      assert(inst.verbs[name], `实例档缺少动词 ${name}`)
    }
    assert(/^targets\(/.test(inst.verbs.targets), `动词应带签名：${inst.verbs.targets}`)

    // 第三档：动词 —— 签名 / 参数表 / 返回 / 示例 / 危险标记
    const verb = await invokeCall('help', ['lab1.call'])
    assert(verb.path === 'lab1.call' && verb.scope === 'instance', `动词档异常：${JSON.stringify(verb).slice(0, 200)}`)
    assert(/^call\(method/.test(verb.signature), `签名异常：${verb.signature}`)
    assert(verb.args.length === 3 && verb.args[0].name === 'method' && verb.args[0].required, '参数表应含必填的 method')
    assert(verb.danger === true, 'call 应标危险')
    assert(verb.examples.length > 0, '动词档应给示例')

    // 宽容档：对象不存在也照常讲动词（模型查签名不该被活状态挡住）
    const lenient = await invokeCall('help', ['ghost.S9.call'])
    assert(lenient.signature === verb.signature, '宽容档讲的应是同一个动词')
    assert(/could not be resolved/i.test(lenient.note), `宽容档应说明对象没解析成功：${lenient.note}`)
    return `根 ${Object.keys(root.verbs).length} 动词 → 实例 ${Object.keys(inst.verbs).length} 动词 → call 签名「${verb.signature}」；宽容档亦可用`
  })

  let mcpTargetId = null
  let mcpSessionId = null

  await step('MCP：自己 createTarget + attach → call → batch → events（全走路径）', async () => {
    // 新契约：call/batch/events 都只回收据，正文用 read 取（子进程那侧同样如此）
    const created = await invokeCall('lab1.call', ['Target.createTarget', { url: 'data:text/html,<title>p3</title>' }])
    assert(created.resultId, `createTarget 应回收据：${JSON.stringify(created)?.slice(0, 200)}`)
    mcpTargetId = (await readPayload(created.resultId)).targetId
    assert(mcpTargetId, 'createTarget 未返回 targetId')

    const attached = await invokeCall('lab1.attach', [mcpTargetId])
    mcpSessionId = attached.sessionId
    assert(mcpSessionId, 'attach 未返回 sessionId')

    // 关键语义：MCP 进程的 sessionId 与父进程的是两套（各自连接）
    const parentSessions = await client.call('sessions', { instance: 'lab1' })
    assert(
      !parentSessions.sessions.some((s) => s.sessionId === mcpSessionId),
      'MCP 子进程的 sessionId 不该出现在父进程的会话表里（会话是 per-process 的）',
    )

    // 路径就是句柄：lab1.<sessionId>.call 同时带上实例和会话，不用再穿参数
    const evalOnce = async (expression) => {
      const receipt = await invokeCall(`lab1.${mcpSessionId}.call`, ['Runtime.evaluate', { expression, returnByValue: true }])
      assert(receipt.resultId, `evaluate 应回收据：${JSON.stringify(receipt)?.slice(0, 200)}`)
      return (await readReceipt(readVia, receipt)).result.value
    }
    assert((await evalOnce('1+1')) === 2, 'Runtime.evaluate 基础能力异常')
    // createTarget 之后页面还需要一点时间 commit 文档，所以这里必须等 —— 这是 CDP 常态，不是 bug
    let title = ''
    for (let i = 0; i < 25 && title !== 'p3'; i++) {
      title = await evalOnce('document.title')
      if (title !== 'p3') await sleep(80)
    }
    assert(title === 'p3', `等页面 commit 后标题应为 p3，实际 ${JSON.stringify(title)}`)

    // 危险动词应在响应里带 _meta.danger（工具级标记没了，改成按路径标记）
    mcp.send(rpc(nextRpcId(), 'tools/call', { name: 'invoke', arguments: { path: `lab1.${mcpSessionId}.call`, args: ['Page.enable'] } }))
    const dangerMsg = await mcp.nextJson()
    assert(dangerMsg.result?._meta?.danger === true, 'call 路径应带 _meta.danger')
    // 只读路径不该带
    mcp.send(rpc(nextRpcId(), 'tools/call', { name: 'invoke', arguments: { path: 'lab1.sessions' } }))
    const safeMsg = await mcp.nextJson()
    assert(safeMsg.result?._meta?.danger === undefined, 'sessions 路径不该带 danger')

    const bt = await invokeCall('batch', [
      {
        calls: [
          { path: `lab1.${mcpSessionId}.call`, args: ['Runtime.evaluate', { expression: '1+1', returnByValue: true }] },
          { path: `lab1.${mcpSessionId}.call`, args: ['Runtime.evaluate', { expression: '2+2', returnByValue: true }] },
        ],
      },
    ])
    assert(bt.summary.ok === 2, `batch 失败：${JSON.stringify(bt)}`)
    assert(bt.results.every((r) => r.resultId), `batch 每项都应带收据：${JSON.stringify(bt.results)?.slice(0, 300)}`)
    const vals = []
    for (const item of bt.results) vals[item.index] = (await readReceipt(readVia, item)).result.value
    assert(JSON.stringify(vals) === JSON.stringify([2, 4]), `batch 每项正文应能 read 回来且顺序一致：${JSON.stringify(vals)}`)

    const evs = await invokeCall('events', [0, { limit: 5 }])
    assert(evs.latest > 0, 'events.latest 应 > 0')
    assert(evs.events.every((e) => e.resultId), `每条事件都应带 resultId：${JSON.stringify(evs.events[0])}`)
    return `target=${mcpTargetId.slice(0, 8)}… session=${mcpSessionId.slice(0, 6)}…（与父进程不同）batch✓ events latest=${evs.latest}`
  })

  await step('MCP：lab1@targetId.call 一次性会话（用完即弃，且不抢已有会话）', async () => {
    // 先造一个**没 attach 过的** target —— 这才是一次性形态的本来用途
    const created = await invokeCall('lab1.call', ['Target.createTarget', { url: 'data:text/html,<title>oneshot</title>' }])
    const freshTargetId = (await readPayload(created.resultId)).targetId

    const before = await invokeCall('lab1.sessions')
    const n0 = before.sessions.length

    // ① 真正的一次性：对没 attach 过的 target，调完会话就消失
    const one = await invokeCall(`lab1@${freshTargetId}.call`, ['Runtime.evaluate', { expression: '"@" + 1', returnByValue: true }])
    const oneVal = (await readPayload(one.resultId)).result.value
    assert(oneVal === '@1', `一次性会话里求值应成功，实际 ${JSON.stringify(oneVal)}`)
    const mid = await invokeCall('lab1.sessions')
    assert(mid.sessions.length === n0, `一次性会话不该留在会话表里（${n0} → ${mid.sessions.length}）`)

    // ② 复用保护：对**已经 attach 着**的 target 用 @，必须沿用已有会话、绝不能把它拆了
    // （Target.attachToTarget 是幂等的，这里一旦拆掉，模型手里的句柄就废了）
    const reused = await invokeCall(`lab1@${mcpTargetId}.call`, ['Runtime.evaluate', { expression: '"@" + 2', returnByValue: true }])
    const reusedVal = (await readPayload(reused.resultId)).result.value
    assert(reusedVal === '@2', `复用已有会话求值应成功，实际 ${JSON.stringify(reusedVal)}`)
    const after = await invokeCall('lab1.sessions')
    assert(after.sessions.length === n0, `@ 不该拆掉已有会话（${n0} → ${after.sessions.length}）`)
    assert(after.sessions.some((s) => s.sessionId === mcpSessionId), '被复用的会话必须还在')
    return `未 attach 的 target：求值=${JSON.stringify(oneVal)}，会话数 ${n0}→${mid.sessions.length}；已 attach 的 target：求值=${JSON.stringify(reusedVal)}，复用且保留（${n0} → ${after.sessions.length}）`
  })

  await step('MCP（打包件）：经 SOCKS5 连第二个实例——代理路径也在 bundle 里', async () => {
    // 这一步的意义在于：子进程跑的是 BIN（默认 bin/termcdp.js，或 TERMCDP_BIN 指向的 dist/termcdp.js），
    // SOCKS5 握手 + RFC1929 + 经代理的 WebSocket 全在打包件里走一遍
    browserB = await launchBrowser({ port: PORT_B })
    socks = await startSocks5Server({ port: 0 })
    const added = await invokeCall('instances', ['add', 'socks-b', `socks5://127.0.0.1:${socks.port}?cdp=127.0.0.1:${PORT_B}`])
    assert(added.name === 'socks-b' && added.status === 'ready', `经代理的实例未就绪：${JSON.stringify(added).slice(0, 200)}`)
    assert(added.via !== null, 'socks-b 应记录经由代理')
    assert(socks.stats.connects >= 1, `代理应至少接过一条 CONNECT，实际 ${socks.stats.connects}`)
    assert(socks.stats.bytesClientToTarget > 0 && socks.stats.bytesTargetToClient > 0, '代理双向都该有流量')

    const t = await invokeCall('socks-b.targets', ['page'])
    assert(t.targets.length >= 1, `经代理拿不到 target：${JSON.stringify(t).slice(0, 200)}`)

    const v = await invokeCall('socks-b.call', ['Browser.getVersion'])
    assert(v.resultId, `经代理的 call 应回收据：${JSON.stringify(v).slice(0, 200)}`)
    const payload = await readPayload(v.resultId)
    assert(payload.product, `经代理的 getVersion 应返回 product：${JSON.stringify(payload).slice(0, 200)}`)
    return `socks5://127.0.0.1:${socks.port}?cdp=127.0.0.1:${PORT_B} → ready，${t.targets.length} 个 target，product=${payload.product}（代理双向流量 ${socks.stats.bytesClientToTarget}/${socks.stats.bytesTargetToClient}）`
  })

  await step('MCP：大对象只回收据（正文不进上下文）', async () => {
    // 先把视口放大：否则截图的 JSON 落在默认 inlineBytes 内，就验证不到「不内联」这件事
    await invokeCall(`lab1.${mcpSessionId}.call`, [
      'Emulation.setDeviceMetricsOverride',
      { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false },
    ])
    const shot = await invokeCall(`lab1.${mcpSessionId}.call`, ['Page.captureScreenshot', { format: 'png' }])
    // 整条 MCP 响应（tool 出参的文本）也不能大：收据只有几个标量字段，
    // 载荷（base64）一旦跟着回来这里会直接涨到几万字符
    const rawText = JSON.stringify(shot)
    assert(rawText.length < 700, `MCP 响应文本过大（${rawText.length} 字符），正文多半进了上下文`)
    // ① 收据形状（MCP 这一路也一样）
    assert(shot.resultId, `截图应回收据：${JSON.stringify(shot)?.slice(0, 200)}`)
    assert(shot.bytes > 4096, `截图应大过默认 inlineBytes：${shot.bytes}`)
    assert(shot.result === undefined, '收据里不该再夹带载荷')
    assert(!JSON.stringify(shot).includes('$externalized'), '旧的 $externalized 协议不该再出现')
    // ② 超过 inlineBytes 的载荷：data 一个字节都不带（不是截断的前缀）
    assert(shot.data === undefined, `超过 inlineBytes 时不应内联任何字节：${JSON.stringify(shot).slice(0, 200)}`)
    assert(shot.truncatedPreview === undefined, '不该再有 truncatedPreview 这个截断 flag')
    // ③ 用 read 能把完整正文取回来
    const full = await readReceipt(readVia, shot)
    assert(typeof full.data === 'string' && JSON.stringify(full).length === shot.bytes, `read 应取回完整正文（${JSON.stringify(full).length} vs ${shot.bytes}）`)
    const decoded = Buffer.from(full.data, 'base64')
    assert(decoded[0] === 0x89 && decoded[1] === 0x50, '不是 PNG')
    return `${shot.bytes} 字节 PNG → MCP 只回收据（不内联）；正文 read 回来 ${decoded.length} 字节`
  })

  await step('MCP：错误信息列出活选项（模型靠它自救）', async () => {
    // ① 未知实例：列出已知实例
    const unknownInstance = await invokeError('ghost.call', ['Browser.getVersion'])
    assert(/unknown instance/i.test(unknownInstance) && /lab1/.test(unknownInstance), `未知实例应列出已知：${unknownInstance}`)

    // ② 段既不是活会话也不是实例动词：两边都要列出来
    const ambiguous = await invokeError('lab1.S2.call', ['Browser.getVersion'])
    assert(/unknown verb/i.test(ambiguous), `未知动词应明说：${ambiguous}`)
    assert(ambiguous.includes(mcpSessionId.slice(0, 8)), `错误应列出活会话：${ambiguous}`)
    assert(/targets|attach|call/.test(ambiguous), `错误应列出实例动词：${ambiguous}`)

    // ③ 会话上用错的动词
    const badSessionVerb = await invokeError(`lab1.${mcpSessionId}.targets`)
    assert(/unknown verb/i.test(badSessionVerb) && /call/.test(badSessionVerb), `会话上的错动词应提示可用动词：${badSessionVerb}`)

    // ④ 根动词下不该再接对象
    const tooLong = await invokeError('events.foo')
    assert(/root verb/i.test(tooLong), `根动词下接对象应报错：${tooLong}`)

    // ⑤ 实例名带点：路径语法会歧义，add 时就拒绝
    const badName = await invokeError('instances', ['add', 'a.b', '127.0.0.1:9222'])
    assert(/must not contain/i.test(badName), `实例名带点应被拒绝：${badName}`)

    // ⑥ 保留根词不能做实例名
    const reserved = await invokeError('instances', ['add', 'events', '127.0.0.1:9222'])
    assert(/reserved/i.test(reserved), `保留根词应被拒绝：${reserved}`)

    // ⑦ 参数类型/数量：模型会数错参数，这里得给可读提示
    const wrongType = await invokeError('read', [12345])
    assert(/arg 1/i.test(wrongType), `参数类型错误应指明位置：${wrongType}`)
    return '7 类错误都给出活选项 / 具体位置'
  })

  await step('MCP：resources/list + templates + read（协议资源按需读）', async () => {
    mcp.send(rpc(13, 'resources/list', {}))
    const list = await mcp.nextJson()
    const uris = list.result.resources.map((r) => r.uri)
    // cdp://results 是结果索引（只看收据，正文用 read 动词取）；
    // 状态类资源就这 5 个，这里按「集合 + 数量」双向锁住
    const expected = ['cdp://instances', 'cdp://sessions', 'cdp://protocol', 'cdp://status', 'cdp://results']
    for (const u of expected) assert(uris.includes(u), `缺少资源 ${u}（实际 ${uris}）`)
    assert(uris.length === expected.length, `资源数量应为 ${expected.length}，实际 ${uris.length}：${uris}`)
    mcp.send(rpc(14, 'resources/templates/list', {}))
    const tpl = await mcp.nextJson()
    assert(tpl.result.resourceTemplates.some((t) => t.uriTemplate === 'cdp://protocol/{domain}'), '缺少协议域模板')

    mcp.send(rpc(15, 'resources/read', { uri: 'cdp://instances' }))
    const inst = await mcp.nextJson()
    assert(JSON.parse(inst.result.contents[0].text).instances[0].name === 'lab1', 'resources/read instances 内容异常')

    // protocol 是 per-instance 资源：现在有两个实例连着（lab1 + socks-b），
    // 不指定时服务器必须拒绝替模型猜，并给出 ?instance=name 这个出路
    mcp.send(rpc(16, 'resources/read', { uri: 'cdp://protocol/Fetch' }))
    const ambiguous = await mcp.nextJson()
    assert(ambiguous.error?.code === -32002, `多实例时读 protocol 该报 -32002，实际 ${JSON.stringify(ambiguous.error).slice(0, 200)}`)
    assert(/\?instance=name/.test(ambiguous.error.message), '错误信息应指出可以用 ?instance=name 消歧')

    mcp.send(rpc(17, 'resources/read', { uri: 'cdp://protocol/Fetch?instance=lab1' }))
    const fetchRes = await mcp.nextJson()
    const fetchJson = JSON.parse(fetchRes.result.contents[0].text)
    const names = fetchJson.commands.map((c) => c.name)
    assert(names.includes('continueRequest') && names.includes('fulfillRequest'), `Fetch 签名异常：${names}`)
    assert(fetchJson.commands.find((c) => c.name === 'continueRequest').parameters.some((p) => p.name === 'requestId'), '参数缺失')

    mcp.send(rpc(19, 'resources/read', { uri: 'cdp://status' }))
    const statusRes = await mcp.nextJson()
    const statusJson = JSON.parse(statusRes.result.contents[0].text)
    assert(statusJson.pid > 0 && statusJson.eventLog, `resources/read status 内容异常：${JSON.stringify(statusJson).slice(0, 200)}`)

    // cdp://results：索引只给收据（不给内容），且能对上前面的调用
    mcp.send(rpc(20, 'resources/read', { uri: 'cdp://results' }))
    const resultsRes = await mcp.nextJson()
    const resultsJson = JSON.parse(resultsRes.result.contents[0].text)
    assert(Array.isArray(resultsJson.results) && resultsJson.results.length > 0, `cdp://results 应给出收据索引：${JSON.stringify(resultsJson).slice(0, 200)}`)
    assert(resultsJson.results.every((r) => r.resultId && typeof r.bytes === 'number'), '索引里的每条都应是元数据收据（resultId + bytes，不含内容）')
    assert(resultsJson.store && typeof resultsJson.store.count === 'number' && resultsJson.store.maxBytes > 0, `应带结果仓规模：${JSON.stringify(resultsJson.store)}`)

    mcp.send(rpc(21, 'resources/read', { uri: 'cdp://nope' }))
    const bad = await mcp.nextJson()
    assert(bad.error?.code === -32002, `未知资源应回 -32002，实际 ${JSON.stringify(bad.error)}`)
    return `${uris.length} 个资源 + 1 个模板；多实例消歧 → -32002 带 ?instance=name 提示；Fetch 域 ${names.length} 条命令；结果索引 ${resultsJson.results.length} 条`
  })

  await step('MCP：未知方法回 -32601', async () => {
    mcp.send(rpc(18, 'no/such/method', {}))
    const res = await mcp.nextJson()
    assert(res.error?.code === -32601, `未知方法错误码异常：${JSON.stringify(res.error)}`)
    return 'code = -32601'
  })

  await step('CLI：只有一个入口 mcp —— 未知入口给出可读提示，help 讲路径语法', async () => {
    const run = (args) =>
      new Promise((resolve) => {
        execFile(process.execPath, [BIN, ...args], { env: { ...process.env, TERMCDP_HOME: HOME } }, (err, stdout, stderr) =>
          resolve({ code: err?.code ?? 0, stdout: stdout ?? '', stderr: stderr ?? '' }),
        )
      })
    const bad = await run(['targets'])
    assert(bad.code === 2, `未知入口应退出码 2，实际 ${bad.code}`)
    assert(/only one entry point/i.test(bad.stderr) && /mcp/.test(bad.stderr), `提示不清晰：${bad.stderr}`)

    // help 文本讲的是 invoke 路径语法，不再是逐工具清单
    const help = await run(['--help'])
    assert(/invoke\("instances"/.test(help.stdout), 'help 应给出 invoke 路径示例')
    assert(/PATHS/.test(help.stdout), 'help 应有 PATHS 一节')
    assert(/ENGINE COMMANDS/.test(help.stdout), 'help 应把命令表标成引擎层')

    const json = await run(['help', '--json'])
    const parsed = JSON.parse(json.stdout)
    assert(parsed.commands.length >= 13, `方法表过小：${parsed.commands.length}`)
    assert(parsed.commands.every((c) => Array.isArray(c.examples) && c.examples.length > 0), '每个方法都应给 JSON 示例')
    assert(!parsed.commands.some((c) => c.name === 'subscribe'), 'subscribe 应已随 stream/watch 一起删除')
    const methodNames = parsed.commands.map((c) => c.name)
    // read / results 在引擎命令表里（模型经由 invoke 路径用到它们）
    for (const name of ['read', 'results']) assert(methodNames.includes(name), `命令表缺少 ${name}：${methodNames}`)
    // 落盘三件套不是本进程的能力：命令表里不该有它们
    for (const gone of ['export', 'audit']) assert(!methodNames.includes(gone), `命令表不该再有 ${gone}`)
    // 工具不再由命令表派生：tool 字段已随 MCP_TOOLS 一起删掉
    assert(!parsed.commands.some((c) => 'tool' in c), '命令表不该再带 tool 字段（工具表面已改为单个 invoke）')
    return `未知入口 → 退出码 ${bad.code} 且指向 mcp；help 讲路径语法；--json 有 ${parsed.commands.length} 个引擎命令（无 tool 字段）`
  })

  await step('清理', async () => {
    mcp?.close()
    await sleep(100)
    await client.close()
    return 'done'
  })
} catch (err) {
  console.error(`\n致命错误：${err?.stack ?? err}`)
} finally {
  await client?.close().catch(() => {})
  await browser?.kill().catch(() => {})
  await browserB?.kill().catch(() => {})
  if (socks) await socks.close().catch(() => {})
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
}

runner.summary()
