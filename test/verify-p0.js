#!/usr/bin/env node
/**
 * P0 验收：零依赖传输层全链路（直连 + 经 SOCKS5），并顺带压 flatten 会话与事件流。
 *
 *   1. 起一个本地 headless 浏览器（Edge/Chrome 自动探测，或 TERMCDP_BROWSER 指定）
 *   2. 起一个自建 SOCKS5 服务器（**带 RFC1929 用户名/口令**，覆盖认证分支）
 *   3. 直连 endpoint：/json/version → browser WebSocket → Browser.getVersion
 *   4. 经 SOCKS5：同样一套（证明"跨机传输"这条链）
 *   5. 一条 socket 上并发 attach 3 个 target 并各自 evaluate（证明多路复用）
 *   6. 生命周期事件 / 导航 / 截图 / 网络事件
 *   7. 打印 SOCKS5 代理的字节计数（证明流量确实过了代理）
 *
 *   node test/verify-p0.js [--port 9333] [--keep]
 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

import { parseEndpoint, discover, listTargets, connectBrowser, describeEndpoint } from '../src/transport/endpoint.js'
import { CdpConnection } from '../src/cdp/connection.js'
import { startSocks5Server } from './socks5-server.js'

const argv = process.argv.slice(2)
const opt = {
  port: 9333,
  keep: argv.includes('--keep'),
  browser: process.env.TERMCDP_BROWSER ?? null,
}
{
  const at = argv.indexOf('--port')
  if (at >= 0) opt.port = Number(argv[at + 1])
}

// ---------- 小测试台 ----------
const results = []
let stepNo = 0
async function step(name, fn) {
  stepNo++
  const label = `${String(stepNo).padStart(2, '0')}. ${name}`
  const t0 = Date.now()
  try {
    const info = await fn()
    const ms = Date.now() - t0
    results.push({ label, ok: true, ms })
    console.log(`PASS  ${label}${info ? `  — ${info}` : ''}  (${ms}ms)`)
    return true
  } catch (err) {
    const ms = Date.now() - t0
    results.push({ label, ok: false, ms, err: err?.message ?? String(err) })
    console.log(`FAIL  ${label}  — ${err?.message ?? err}  (${ms}ms)`)
    return false
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

const exists = async (p) => existsSync(p)

function detectBrowser() {
  if (opt.browser) return opt.browser
  const candidates =
    process.platform === 'win32'
      ? [
          'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
          'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
          'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
        ]
      : process.platform === 'darwin'
        ? [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
          ]
        : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser']
  return candidates.find((p) => existsSync(p))
}

async function waitForCdp(port, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs
  let lastErr
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`)
      if (res.ok) return await res.json()
      lastErr = new Error(`HTTP ${res.status}`)
    } catch (err) {
      lastErr = err
    }
    await new Promise((r) => setTimeout(r, 250))
  }
  throw new Error(`浏览器 CDP 未就绪（:${port}）：${lastErr?.message ?? 'unknown'}`)
}

function killTree(pid) {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' })
    } else {
      process.kill(pid, 'SIGKILL')
    }
  } catch {
    /* ignore */
  }
}

function waitForEvent(cdp, method, predicate, timeoutMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cdp.off('event', onEvent)
      reject(new Error(`等待事件超时：${method}（${timeoutMs}ms）`))
    }, timeoutMs)
    const onEvent = (e) => {
      if (e.method !== method) return
      if (predicate && !predicate(e)) return
      clearTimeout(timer)
      cdp.off('event', onEvent)
      resolve(e)
    }
    cdp.on('event', onEvent)
  })
}

// ---------- 主流程 ----------
let browserProc = null
let userDataDir = null
let socks = null
let cdp = null
/** 截图写进系统临时目录（不是仓库里），跑完即清 */
let shotDir = null
let savedShot = null

try {
  const browserPath = detectBrowser()
  console.log(`\n=== termcdp P0 验收 ===`)
  console.log(`浏览器: ${browserPath ?? '(未找到)'}`)
  console.log(`平台: ${process.platform} / node ${process.version}\n`)
  shotDir = await mkdtemp(path.join(os.tmpdir(), 'termcdp-p0-shots-'))

  assert(browserPath, '未找到浏览器，请用 TERMCDP_BROWSER=/path/to/chrome 指定')

  await step('启动 headless 浏览器并等待 CDP 就绪', async () => {
    userDataDir = await mkdtemp(path.join(os.tmpdir(), 'termcdp-p0-'))
    browserProc = spawn(
      browserPath,
      [
        '--headless=new',
        `--remote-debugging-port=${opt.port}`,
        `--user-data-dir=${userDataDir}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-crash-reporter',
        '--disable-breakpad',
        '--disable-extensions',
        '--disable-sync',
        '--disable-background-networking',
        'about:blank',
      ],
      { stdio: 'ignore', detached: false },
    )
    const version = await waitForCdp(opt.port)
    return `${version.Browser} · protocol ${version['Protocol-Version']}`
  })

  await step('启动自建 SOCKS5 服务器（含 RFC1929 认证）', async () => {
    socks = await startSocks5Server({
      port: 0,
      auth: { user: 'termcdp', pass: 's3cr3t' },
      onLog: process.env.TERMCDP_DEBUG ? (m) => console.log(`      ${m}`) : undefined,
    })
    return `127.0.0.1:${socks.port}`
  })

  const direct = parseEndpoint(`direct=127.0.0.1:${opt.port}`)
  const viaSocks = parseEndpoint(`viProxy=socks5://termcdp:s3cr3t@127.0.0.1:${socks.port}?cdp=127.0.0.1:${opt.port}`)

  await step('解析 endpoint 说明串', async () => {
    assert(direct.kind === 'direct' && direct.cdp.port === opt.port, 'direct 解析错误')
    assert(viaSocks.kind === 'socks5' && viaSocks.proxy.user === 'termcdp', 'socks5 解析错误')
    assert(viaSocks.proxy.pass === 's3cr3t', 'socks5 口令解析错误')
    return `${describeEndpoint(direct)} | ${describeEndpoint(viaSocks)}`
  })

  await step('直连：HTTP 发现 /json/version', async () => {
    const d = await discover(direct)
    assert(d.version.webSocketDebuggerUrl, '缺少 webSocketDebuggerUrl')
    assert(d.wsUrl.includes('/devtools/browser/'), `wsUrl 异常：${d.wsUrl}`)
    return d.wsUrl.replace(/\/devtools\/browser\/.*/, '/devtools/browser/…')
  })

  await step('经 SOCKS5（带认证）：HTTP 发现 /json/version', async () => {
    const d = await discover(viaSocks)
    assert(d.version.Browser, '缺少 Browser 字段')
    return `${d.version.Browser}（经代理）`
  })

  await step('经 SOCKS5：/json/list 列 target', async () => {
    const list = await listTargets(viaSocks)
    assert(Array.isArray(list) && list.length >= 1, `target 列表异常：${JSON.stringify(list).slice(0, 120)}`)
    return `${list.length} 个 target（${list.map((t) => t.type).join(',')}）`
  })

  await step('经 SOCKS5：手搓 WebSocket 升级 + Browser.getVersion', async () => {
    const { ws, version } = await connectBrowser(viaSocks)
    cdp = new CdpConnection(ws, { label: 'p0' })
    const got = await cdp.send('Browser.getVersion')
    assert(got.product, 'Browser.getVersion 无 product')
    assert(got.product === version.Browser, `两次得到的 product 不一致：${got.product} vs ${version.Browser}`)
    return `${got.product} · ${got.protocolVersion}`
  })

  let sessionIds = []
  let targetIds = []

  await step('一条 socket 上开 3 个 tab 并各自 flatten attach', async () => {
    for (let i = 0; i < 3; i++) {
      const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' })
      targetIds.push(targetId)
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true })
      assert(sessionId, 'attachToTarget 未返回 sessionId')
      sessionIds.push(sessionId)
    }
    assert(new Set(sessionIds).size === 3, 'sessionId 重复')
    return `3 sessions on 1 ws：${sessionIds.map((s) => s.slice(0, 6)).join(' ')}`
  })

  await step('3 个会话并发 Runtime.evaluate（多路复用 + 并发闸）', async () => {
    await Promise.all(sessionIds.map((sid) => cdp.send('Runtime.enable', {}, sid)))
    const outs = await Promise.all(
      sessionIds.map((sid, i) => cdp.send('Runtime.evaluate', { expression: `${i} * 111`, returnByValue: true }, sid)),
    )
    const values = outs.map((o) => o.result.value)
    assert(JSON.stringify(values) === JSON.stringify([0, 111, 222]), `并发结果错位：${JSON.stringify(values)}`)
    return `values=[${values.join(',')}]（sessionId 路由正确）`
  })

  const sid0 = sessionIds[0]

  await step('Page.enable + 生命周期事件（等 networkIdle/load，不 sleep）', async () => {
    await cdp.send('Page.enable', {}, sid0)
    await cdp.send('Page.setLifecycleEventsEnabled', { enabled: true }, sid0)
    const names = []
    const onEvt = (e) => {
      if (e.method === 'Page.lifecycleEvent' && e.sessionId === sid0) names.push(e.params.name)
    }
    cdp.on('event', onEvt)
    const loaded = waitForEvent(cdp, 'Page.lifecycleEvent', (e) => e.sessionId === sid0 && e.params.name === 'load', 15_000)
    await cdp.send('Page.navigate', { url: 'data:text/html,<title>termcdp</title><h1>hi</h1>' }, sid0)
    await loaded
    cdp.off('event', onEvt)
    assert(names.length > 0, '未收到任何 lifecycleEvent')
    return `收到 ${names.length} 个 lifecycle：${[...new Set(names)].slice(0, 6).join(',')}`
  })

  await step('读回页面标题', async () => {
    const out = await cdp.send('Runtime.evaluate', { expression: 'document.title', returnByValue: true }, sid0)
    assert(out.result.value === 'termcdp', `标题异常：${JSON.stringify(out.result.value)}`)
    return `document.title = ${out.result.value}`
  })

  await step('Page.captureScreenshot（base64 大对象）', async () => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sid0)
    const buf = Buffer.from(shot.data, 'base64')
    assert(buf.length > 100, `截图过小：${buf.length}`)
    assert(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47, 'PNG 魔数不对')
    savedShot = path.join(shotDir, `p0-shot-${Date.now()}.png`)
    await mkdir(path.dirname(savedShot), { recursive: true })
    await writeFile(savedShot, buf)
    const again = await readFile(savedShot)
    assert(again.length === buf.length, '写盘后长度不一致')
    return `${buf.length} 字节 PNG → ${path.relative(process.cwd(), savedShot)}`
  })

  await step('Network 事件流（enable → 导航 → 计数）', async () => {
    const seen = new Map()
    const onEvt = (e) => {
      if (e.sessionId !== sid0 || !e.method.startsWith('Network.')) return
      seen.set(e.method, (seen.get(e.method) ?? 0) + 1)
    }
    cdp.on('event', onEvt)
    await cdp.send('Network.enable', {}, sid0)
    await cdp.send('Page.navigate', { url: 'data:text/html,<h1>net</h1><script>fetch("data:text/plain,ok")</script>' }, sid0)
    await new Promise((r) => setTimeout(r, 800))
    cdp.off('event', onEvt)
    const total = [...seen.values()].reduce((a, b) => a + b, 0)
    assert(total > 0, '未收到任何 Network 事件')
    return `${total} 个事件：${[...seen.entries()].map(([m, n]) => `${m.replace('Network.', '')}×${n}`).join(' ')}`
  })

  await step('CDP 命令错误语义（-32601 可识别）', async () => {
    let code = null
    try {
      await cdp.send('NoSuchDomain.noSuchMethod', {}, sid0)
    } catch (err) {
      code = err.code
    }
    assert(code === -32601, `期望 -32601，实际 ${code}`)
    return 'code = -32601（可用于优雅降级）'
  })

  await step('SOCKS5 代理确实承载了全部流量', async () => {
    assert(socks.stats.connects >= 4, `代理只完成 ${socks.stats.connects} 次 CONNECT`)
    assert(socks.stats.bytesClientToTarget > 1000, `上行字节太少：${socks.stats.bytesClientToTarget}`)
    assert(socks.stats.bytesTargetToClient > 1000, `下行字节太少：${socks.stats.bytesTargetToClient}`)
    assert(socks.stats.errors.length === 0, `代理出现错误：${socks.stats.errors.join('; ')}`)
    return `${socks.stats.connects} 次 CONNECT · ↑${socks.stats.bytesClientToTarget}B ↓${socks.stats.bytesTargetToClient}B`
  })

  await step('清理：关会话/关 target/断 WS', async () => {
    for (const sid of sessionIds) await cdp.send('Target.detachFromTarget', { sessionId: sid }).catch(() => {})
    for (const tid of targetIds) await cdp.send('Target.closeTarget', { targetId: tid }).catch(() => {})
    await cdp.close().catch(() => {})
    cdp.destroy()
    return `${sessionIds.length} sessions / ${targetIds.length} targets`
  })
} catch (err) {
  console.error(`\n致命错误：${err?.stack ?? err}`)
} finally {
  if (!opt.keep) {
    killTree(browserProc?.pid)
    if (socks) await socks.close().catch(() => {})
    if (userDataDir) await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
    if (shotDir) await rm(shotDir, { recursive: true, force: true }).catch(() => {})
  } else {
    console.log(`\n--keep：浏览器(pid=${browserProc?.pid}) 与 profile(${userDataDir}) 保留`)
  }
}

const failed = results.filter((r) => !r.ok)
console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`)
if (failed.length) {
  for (const f of failed) console.log(`  ✗ ${f.label}\n    ${f.err}`)
  process.exitCode = 1
} else {
  console.log('  全部通过 ✅')
}
if (savedShot) console.log(`  截图：${savedShot}${opt.keep ? '' : '（已随临时目录清理）'}`)
