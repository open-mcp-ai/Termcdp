#!/usr/bin/env node
/**
 * 验收：`fetch` 动词 —— 把 URL 拉进本进程的 result store，再注入浏览器页面。
 *
 * 这条链路解决的是"文件上下文不进 agent context"：下载发生在 termcdp 进程里，
 * 模型拿到的是收据（resultId + bytes + sha256），正文留在 store，只有注入时**按 id 引用**。
 *
 * 为什么不用页面自己下载（fetch+eval / <script src>）：页面 CSP 会拦，而且要 CORS 头。
 * 本套件把这三个对照都跑一遍，证明 fetch 动词是那条"在 CSP 页面上也能用"的路。
 *
 * 靶机全部自带：一个本地 HTTP 服务器扮演 termcp 的 /files/download，
 * 一个 headless 浏览器扮演目标页面。不需要真的 termcp 实例。
 *
 *   node test/verify-fetch.js
 */
import http from 'node:http'
import process from 'node:process'
import { spawn } from 'node:child_process'

const { LocalClient } = await import('../src/engine/local-client.js')
const { launchBrowser, createRunner, assert } = await import('./harness.js')

const PORT = 9371
const SERVE = 9421
const runner = createRunner()
const { step } = runner

const PAYLOAD = `window.__mark=(window.__mark||0)+1;window.__src="served";\n`
const BIG_BYTES = 600_000

let client = null
let browserProc = null
let server = null

/** 扮演 termcp 的 /files/download：大文件走 Range/分片读也一样，这里只需一次 GET */
function startServer() {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      if (req.url.startsWith('/payload.js')) {
        res.writeHead(200, { 'content-type': 'application/javascript' })
        res.end(PAYLOAD)
        return
      }
      if (req.url.startsWith('/big.js')) {
        res.writeHead(200, { 'content-type': 'application/javascript' })
        res.end(`window.__bigLen=${BIG_BYTES};/*${'x'.repeat(BIG_BYTES)}*/`)
        return
      }
      if (req.url.startsWith('/404')) {
        res.writeHead(404, { 'content-type': 'text/plain' })
        res.end('nope')
        return
      }
      const csp = req.url.includes('csp')
      res.writeHead(200, {
        'content-type': 'text/html',
        ...(csp ? { 'content-security-policy': "script-src 'none'; connect-src 'none'" } : {}),
      })
      res.end(`<!doctype html><title>${csp ? 'csp' : 'plain'}</title>`)
    })
    server.listen(SERVE, '127.0.0.1', resolve)
  })
}

const url = (p) => `http://127.0.0.1:${SERVE}${p}`

try {
  await step('准备：本地靶机 + headless 浏览器 + 一个会话', async () => {
    await startServer()
    browserProc = await launchBrowser({ port: PORT })
    client = await LocalClient.open({ actor: 'verify-fetch' })
    await client.call('instances', { action: 'add', name: 'lab1', spec: `127.0.0.1:${PORT}` })
    const { targets } = await client.call('targets', { instance: 'lab1', type: 'page' })
    const { sessionId } = await client.call('attach', { instance: 'lab1', targetId: targets[0].targetId })
    globalThis.__sid = sessionId
    return `页面靶机 :${SERVE}，浏览器 :${PORT}`
  })

  /** 注入用的求值助手：把 payload 直接塞进表达式，绕过收据（测试自己要断言结果） */
  const evalOn = async (expression) => {
    const r = await client.call('call', {
      instance: 'lab1',
      sessionId: globalThis.__sid,
      method: 'Runtime.evaluate',
      params: { expression, returnByValue: true, awaitPromise: true },
      inlineBytes: 4_000_000,
    })
    const text = r.data ?? (await client.call('read', { resultId: r.resultId, maxBytes: 4_000_000 })).data
    const parsed = JSON.parse(text)
    if (parsed.exceptionDetails) {
      return `EXC: ${(parsed.exceptionDetails.exception?.description ?? parsed.exceptionDetails.text).slice(0, 120)}`
    }
    return parsed.result?.value
  }
  const navigate = async (p) => {
    await client.call('call', { instance: 'lab1', sessionId: globalThis.__sid, method: 'Page.navigate', params: { url: url(p) } })
    await new Promise((r) => setTimeout(r, 400))
  }
  /** 按 resultId 把正文读回来（模型侧的动作；这里替代"把源码拷进上下文"） */
  const readBody = async (resultId, maxBytes = 8 * 1024 * 1024) =>
    (await client.call('read', { resultId, offset: 0, maxBytes })).data

  await step('fetch：URL 落进 result store，收据只给 resultId/bytes/sha256', async () => {
    const receipt = await client.call('fetch', { url: url('/payload.js') })
    assert(/^fetch\/\d+$/.test(receipt.resultId), `resultId 形态异常：${receipt.resultId}`)
    assert(receipt.instance === 'fetch' && receipt.method === 'fetch', `收据来源异常：${JSON.stringify(receipt)}`)
    assert(receipt.bytes === Buffer.byteLength(PAYLOAD), `bytes 应等于正文长度 ${Buffer.byteLength(PAYLOAD)}，实际 ${receipt.bytes}`)
    assert(typeof receipt.sha256 === 'string' && receipt.sha256.length === 64, 'sha256 异常')
    assert(receipt.data === PAYLOAD, `小正文应内联完整覆盖（≤inlineBytes 时 data 就是全部）：${JSON.stringify(receipt.data)}`)
    globalThis.__small = receipt
    return `resultId=${receipt.resultId} bytes=${receipt.bytes}（正文没有进调用方）`
  })

  await step('大正文：收据不含 data，按 id 分页 read 拿回来（字节不进 agent context）', async () => {
    const receipt = await client.call('fetch', { url: url('/big.js') })
    assert(receipt.bytes > BIG_BYTES, `大文件 bytes 异常：${receipt.bytes}`)
    assert(receipt.data === undefined, '超过 inlineBytes 时不应内联任何字节（完整或全无）')
    const body = await readBody(receipt.resultId)
    assert(body.includes(`window.__bigLen=${BIG_BYTES}`), '读回来的正文不对')
    assert(Buffer.byteLength(body) === receipt.bytes, `read 的字节数与收据不符：${Buffer.byteLength(body)} != ${receipt.bytes}`)
    // 分页读：第一页 + 偏移续读拼起来必须等于全文
    const first = await client.call('read', { resultId: receipt.resultId, offset: 0, maxBytes: 100_000 })
    const next = await client.call('read', { resultId: receipt.resultId, offset: first.nextOffset, maxBytes: 100_000 })
    assert(first.eof === false && next.offset === first.nextOffset, '分页游标异常')
    assert(body.startsWith(first.data) && body.slice(next.offset).startsWith(next.data.slice(0, 1000)), '分页内容与全文不一致')
    return `bytes=${receipt.bytes}，read 分页游标可用（offset/nextOffset/eof）`
  })

  await step('注入：fetch 的源码直接进 Runtime.evaluate 表达式 —— 没有 CSP 的页面', async () => {
    await navigate('/plain?inject=1')
    const receipt = await client.call('fetch', { url: url('/payload.js') })
    const src = await readBody(receipt.resultId)
    const out = await evalOn(`${src};window.__mark`)
    assert(out === 1, `注入后 window.__mark 应为 1，实际 ${JSON.stringify(out)}`)
    const second = await evalOn(`${src};window.__mark`)
    assert(second === 2, '同一份源码应可重复注入（幂等由脚本自身决定）')
    return `window.__mark=1，且注入用的求值收据不含源码`
  })

  await step('对照：严格 CSP 页面上，页面自己下载/内联脚本两条路都失败，fetch 动词仍可用', async () => {
    await navigate('/csp?inject=2')
    // (a) 页面自己 fetch termcp/目标服务器 —— 被 CSP connect-src 拦
    const pageFetch = await evalOn(
      `fetch('${url('/payload.js')}').then(r=>r.text()).then(t=>{eval(t);return window.__mark}).catch(e=>'ERR '+String(e).slice(0,40))`,
    )
    assert(String(pageFetch).startsWith('ERR'), `CSP 页面上的页面侧 fetch 本该失败，实际：${pageFetch}`)
    // (b) <script src> —— 被 CSP script-src 拦（这条路不需要 CORS，但一样过不去）
    await evalOn('delete window.__mark')
    const tag = await evalOn(
      `(async()=>{const s=document.createElement('script');s.src='${url('/payload.js')}';document.head.append(s);await new Promise(r=>setTimeout(r,400));return window.__mark??null})()`,
    )
    assert(tag === null, `<script src> 在 CSP 页面上本该被拦，实际 __mark=${tag}`)
    // (c) termcdp 侧下载 + 注入 —— 与页面 CSP 无关
    const receipt = await client.call('fetch', { url: url('/payload.js') })
    const out = await evalOn(`${await readBody(receipt.resultId)};window.__mark`)
    assert(out === 1, `fetch 动词在 CSP 页面上应照常注入，实际 ${JSON.stringify(out)}`)
    return '页面侧 fetch 被拦、<script src> 被拦、fetch 动词注入成功'
  })

  await step('注入：Page.addScriptToEvaluateOnNewDocument（导航前生效，且避开 CSP）', async () => {
    // 真实语义（探测出来的，跟直觉不同）：在 Page 域 enable 之前注册并不会丢失，
    // 它只是**不生效**，直到 Page.enable 才连同后来注册的一起生效。
    // 所以“注册了就以为生效了”是这条路唯一的坑 —— 这里把两个阶段都断言出来。
    const before = await client.call('call', {
      instance: 'lab1',
      sessionId: globalThis.__sid,
      method: 'Page.addScriptToEvaluateOnNewDocument',
      params: { source: PAYLOAD },
    })
    assert(before.bytes > 0, '注册会返回 identifier（即使还没 Page.enable）')
    await navigate('/csp?pre-enable=1')
    assert((await evalOn('window.__mark ?? null')) === null, '未 Page.enable 时注册的脚本不应生效')

    await client.call('call', { instance: 'lab1', sessionId: globalThis.__sid, method: 'Page.enable', params: {} })
    const receipt = await client.call('fetch', { url: url('/payload.js') })
    await client.call('call', {
      instance: 'lab1',
      sessionId: globalThis.__sid,
      method: 'Page.addScriptToEvaluateOnNewDocument',
      params: { source: await readBody(receipt.resultId) },
    })
    await navigate('/csp?post-enable=1')
    // 两份注册（enable 前那份也活了）都在新文档里执行 —— 所以是 2
    assert((await evalOn('window.__mark ?? null')) === 2, `Page.enable 后两份注册都应生效（期望 2），实际 ${await evalOn('window.__mark ?? null')}`)
    return 'Page.enable 前注册不生效、enable 后连同新注册一起生效（CSP 页面对它无效）'
  })

  await step('错误面：非 http(s) 拒收、404 报 HTTP 状态、maxBytes 拒绝而不是截断', async () => {
    /** harness 里只有 assert，没有 assert.rejects，所以这里自己收错误 */
    const rejects = async (fn, re) => {
      try {
        await fn()
      } catch (err) {
        assert(re.test(err.message), `错误信息不匹配 /${re.source}/：${err.message}`)
        return
      }
      assert(false, `本该失败却成功了（期望 /${re.source}/）`)
    }
    await rejects(() => client.call('fetch', { url: 'file:///etc/passwd' }), /http\/https/)
    await rejects(() => client.call('fetch', { url: 'data:text/javascript,1' }), /http\/https/)
    await rejects(() => client.call('fetch', { url: 'not a url' }), /valid absolute URL/)
    await rejects(() => client.call('fetch', { url: url('/404') }), /HTTP 404/)
    await rejects(() => client.call('fetch', { url: `http://127.0.0.1:1/x` }), /fetch failed/) // 连不上的端口
    await rejects(() => client.call('fetch', { url: url('/big.js'), maxBytes: 1000 }), /exceeds maxBytes/) // 扁平参数（引擎约定）
    // 被拒绝的下载不应在 store 里留下半截载荷
    const index = await client.call('results', { limit: 50 })
    assert(!index.results.some((r) => r.method === 'fetch' && r.bytes > 1000 && r.bytes < BIG_BYTES), '被拒绝的下载不应进入 store')
    return 'file:/data:/裸字符串/404/连不上/超限 全部明确报错，且不留半截载荷'
  })

  await step('MCP 路径：opts 真的生效（这条曾经坏了 —— 引擎收的是摊平参数，嵌套 opts 被静默忽略）', async () => {
    // 引擎命令收**扁平**参数（见 fetch.js 注释）：`paths.js` 把动词的 opts 摊开，MCP 层也会摊平残留的 opts。
    // 之前的测试直接调 client.call('fetch', {opts:{…}})，所以没发现 MCP 路径上 maxBytes 完全没生效。
    const bin = new URL('../bin/termcdp.js', import.meta.url).pathname.replace(/^\//, '')
    const mcp = spawn(process.execPath, [bin, 'mcp'], { stdio: ['pipe', 'pipe', 'ignore'] })
    let buf = ''
    const msgs = []
    mcp.stdout.on('data', (d) => {
      buf += d
      let i
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.trim()) msgs.push(JSON.parse(line))
      }
    })
    let seq = 0
    const invoke = (path, args = []) => {
      const id = ++seq
      mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'invoke', arguments: { path, args } } }) + '\n')
      return new Promise((res) => {
        const t = setInterval(() => {
          const m = msgs.find((x) => x.id === id)
          if (m) {
            clearInterval(t)
            res(m.result)
          }
        }, 15)
      })
    }
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 'init', method: 'initialize', params: {} }) + '\n')
    await new Promise((r) => setTimeout(r, 500))

    // maxBytes 必须在 MCP 路径上也生效：超限要拒绝，而不是照单全收
    const refused = await invoke('fetch', [url('/big.js'), { maxBytes: 1000 }])
    assert(refused.isError === true, `MCP 路径上 maxBytes 应生效（这是回归点），实际：${String(refused.content?.[0]?.text).slice(0, 120)}`)
    assert(/exceeds maxBytes/.test(refused.content[0].text), `拒绝原因不对：${refused.content[0].text.slice(0, 120)}`)

    // inlineBytes 同理：调小就不该内联正文
    const inlined = await invoke('fetch', [url('/payload.js'), { inlineBytes: 1_000_000 }])
    const receipt = JSON.parse(inlined.content[0].text)
    assert(receipt.data === PAYLOAD, `inlineBytes 调大后应内联全文：${JSON.stringify(receipt).slice(0, 140)}`)
    const noInline = JSON.parse((await invoke('fetch', [url('/payload.js'), { inlineBytes: 4 }])).content[0].text)
    assert(noInline.data === undefined, `inlineBytes 调小后不该内联：${JSON.stringify(noInline).slice(0, 140)}`)

    mcp.stdin.end()
    await new Promise((r) => mcp.on('exit', r))
    return 'maxBytes / inlineBytes 经 MCP 摊平后确实生效'
  })

  await step('help 与路径语法：invoke("fetch", url) 可自描述，也能被 batch 计划', async () => {
    const { describePath } = await import('../src/protocol/paths.js')
    const detail = await describePath(client.registry, 'fetch')
    assert(detail.signature === 'fetch(url, [opts])', `签名异常：${detail.signature}`)
    assert(/result store/.test(detail.summary), 'help 应说明字节落在 result store')
    const root = await describePath(client.registry)
    assert('fetch' in root.verbs, 'fetch 应出现在根命名空间里')
    // batch 走 MCP 的 toCommand（路径 → 引擎命令），这里从真实的 MCP 子进程侧验一遍
    const bin = new URL('../bin/termcdp.js', import.meta.url).pathname.replace(/^\//, '')
    const line = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'invoke', arguments: { path: 'fetch', args: [url('/payload.js')] } },
    })
    const mcp = spawn(process.execPath, [bin, 'mcp'], { stdio: ['pipe', 'pipe', 'ignore'] })
    let out = ''
    mcp.stdout.on('data', (d) => (out += d))
    mcp.stdin.end(`${line}\n`)
    await new Promise((r) => mcp.on('exit', r))
    const reply = JSON.parse(out.trim().split(/\r?\n/)[0])
    assert(reply.result?.isError !== true, `MCP 侧 fetch 应成功：${out.slice(0, 200)}`)
    const receipt = JSON.parse(reply.result.content[0].text)
    assert(receipt.resultId?.startsWith('fetch/'), `MCP 侧收据异常：${JSON.stringify(receipt).slice(0, 160)}`)
    return `signature=${detail.signature}；MCP 子进程可直接 invoke("fetch", url)`
  })
} catch (err) {
  console.error(`\n致命错误：${err?.stack ?? err}`)
  process.exitCode = 1
} finally {
  await client?.close().catch(() => {})
  // 先砍掉 keep-alive 连接再 close：页面侧那几次请求（成功的、撞 CSP 的）会留下常连 socket，
  // 只调 close() 会一直等它们自然断开 —— 实测这部分让本套件多挂了 99 秒。
  server?.closeAllConnections?.()
  await new Promise((r) => (server ? server.close(r) : r()))
  await browserProc?.kill().catch(() => {})
}

runner.summary()
