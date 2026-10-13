#!/usr/bin/env node
/**
 * P1 验收：CDP 核心（经 SOCKS5）
 *
 *  - autoAttach(flatten)：新开 tab 自动建会话
 *  - 显式 attach + 期望状态登记（enable 域 / Emulation）
 *  - 事件日志：单调序号 + 按 sessionId/前缀过滤 + since 精确续读
 *  - 流式大对象：printToPDF 走 ReturnAsStream + IO.read（内存里读完，验 %%EOF 不被截断）；截图解出 PNG 验魔数
 *  - CDP 层**不落盘**（载荷统一进结果仓，见 src/engine/results.js）
 *  - 并发闸：20 条 evaluate 并发不串号
 *  - **断线重连 + 状态重放**：会话重建后 enable 的域与 Emulation 是否真的生效（用 window.innerWidth 验证）
 *
 *   node test/verify-p1.js
 */
import process from 'node:process'

import { parseEndpoint } from '../src/transport/endpoint.js'
import { Browser } from '../src/cdp/browser.js'
import { startSocks5Server } from './socks5-server.js'
import { launchBrowser, createRunner, assert, withTimeout } from './harness.js'

const runner = createRunner()
const { step } = runner

const CDP_PORT = Number(process.env.TERMCDP_TEST_PORT ?? 9334)

let browserProc = null
let socks = null
/** @type {Browser|null} */
let browser = null
let targetId = null
let autoTargetId = null

console.log('\n=== termcdp P1 验收 ===\n')

try {
  await step('启动 headless 浏览器 + SOCKS5 代理', async () => {
    browserProc = await launchBrowser({ port: CDP_PORT })
    socks = await startSocks5Server({ port: 0 })
    return `${browserProc.version.Browser} · socks5 :${socks.port}`
  })

  const ep = parseEndpoint(`p1=socks5://127.0.0.1:${socks.port}?cdp=127.0.0.1:${CDP_PORT}`)

  await step('Browser.connect（经 SOCKS5）+ 初始 target 列表', async () => {
    browser = await Browser.connect(ep, { eventCapacity: 3000 })
    const targets = browser.listTargets()
    assert(targets.length >= 1, `target 列表为空`)
    assert(browser.product.includes('Edg') || browser.product.includes('Chrome'), `product 异常：${browser.product}`)
    return `${browser.product} · ${targets.length} 个 target`
  })

  await step('autoAttach(flatten)：新开 tab 自动建会话', async () => {
    await browser.setAutoAttach({ autoAttach: true, waitForDebuggerOnStart: false })
    // setAutoAttach 会把**已存在**的 target 也自动接上；这里只要"下一个新出现的会话"
    const known = new Set(browser.byTarget.keys())
    const waitSession = browser.waitForSession((s) => !known.has(s.targetId), 10_000)
    const created = await browser.createTarget({ url: 'about:blank' })
    const session = await waitSession
    assert(session.targetId === created, `自动会话 targetId 不符：${session.targetId} vs ${created}`)
    assert(!session.closed, '自动会话不应是已关闭状态')
    autoTargetId = created
    return `session=${session.sessionId.slice(0, 6)}… target=${created.slice(0, 8)}…`
  })

  let session = null

  await step('显式 attach + 开域（登记期望状态）', async () => {
    targetId = await browser.createTarget({ url: 'about:blank' })
    session = await browser.attach(targetId)
    await session.enable('Page', 'Runtime')
    const d = session.describe()
    assert(d.enabledDomains.includes('Page') && d.enabledDomains.includes('Runtime'), `域登记异常：${d.enabledDomains}`)
    const again = await browser.attach(targetId)
    assert(again.sessionId === session.sessionId, 'attach 应幂等')
    return `session=${session.sessionId.slice(0, 6)}… domains=[${d.enabledDomains.join(',')}]`
  })

  await step('导航（等 lifecycle 事件，不 sleep）+ 读标题', async () => {
    await session.navigate('data:text/html,<title>p1</title><h1>ok</h1>', { waitUntil: 'load' })
    const title = await session.evaluate('document.title')
    assert(title === 'p1', `标题异常：${title}`)
    return `document.title = ${title}`
  })

  await step('事件日志：单调序号 + sessionId 过滤', async () => {
    const all = browser.eventsSince(0, { limit: 20 })
    const ns = all.map((e) => e.n)
    assert(ns.every((v, i) => i === 0 || v > ns[i - 1]), `序号非单调：${ns.join(',')}`)
    const mine = browser.eventsSince(0, { sessionId: session.sessionId })
    assert(mine.every((e) => e.sessionId === session.sessionId), 'sessionId 过滤失效')
    assert(mine.length > 0, '本会话没有事件（Page.enable 后应至少有 lifecycle）')
    return `共 ${browser.events.stats().seq} 条事件，其中本会话 ${mine.length} 条`
  })

  await step('since 精确续读（增量不重不漏）', async () => {
    const mark = browser.events.latest
    await session.navigate('data:text/html,<title>p1b</title>', { waitUntil: 'load' })
    const delta = browser.eventsSince(mark)
    assert(delta.length > 0, '续读没有拿到新事件')
    assert(
      delta.every((e) => e.n > mark),
      '续读混入了旧事件',
    )
    const again = browser.eventsSince(browser.events.latest)
    assert(again.length === 0, `再从最新续读应为空，实际 ${again.length} 条`)
    return `mark=${mark} → 新增 ${delta.length} 条 → 再读 0 条`
  })

  await step('按方法前缀过滤（Network./Page.）', async () => {
    const page = browser.eventsSince(0, { prefix: 'Page.' })
    const net = browser.eventsSince(0, { prefix: 'Network.' })
    assert(page.length > 0, 'Page.* 过滤为空')
    assert(page.every((e) => e.method.startsWith('Page.')), '前缀过滤失效')
    return `Page.*=${page.length} Network.*=${net.length}`
  })

  await step('流式大对象：printToPDF（ReturnAsStream + IO.read），内存里读完不落盘', async () => {
    const res = await session.send('Page.printToPDF', { transferMode: 'ReturnAsStream' })
    assert(res.stream, `printToPDF 没给 stream：${JSON.stringify(Object.keys(res ?? {}))}`)
    const read = await session.readStreamHandle(res.stream)
    // 真正要验的是"流读完没被截断"：PDF 必须以 %%EOF 收尾（空页 PDF 只有 ~860 字节，不能用大小判断）
    assert(read.buffer.length > 0, '流读回来是空的')
    assert(!read.truncated, '流被 maxBytes 截断')
    assert(read.buffer.subarray(-16).toString('latin1').includes('%%EOF'), 'PDF 未以 %%EOF 收尾（流可能被截断）')
    return `${read.buffer.length} 字节 pdf · 以 %%EOF 收尾 · 全程内存（CDP 层不落盘）`
  })

  await step('截图：解出 PNG（内存里校验魔数，不回 base64）', async () => {
    const buf = await session.screenshotBuffer()
    assert(buf.length > 100, `截图太小：${buf.length}`)
    assert(buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47, '魔数不是 PNG')
    return `${buf.length} 字节 png · 魔数校验通过 · 不落盘`
  })

  await step('并发闸：20 条 evaluate 并发不串号', async () => {
    const values = await Promise.all(
      Array.from({ length: 20 }, (_, i) => session.evaluate(`${i} * 7 + 1`)),
    )
    const expected = Array.from({ length: 20 }, (_, i) => i * 7 + 1)
    assert(JSON.stringify(values) === JSON.stringify(expected), `结果错位：${JSON.stringify(values)}`)
    return `20/20 正确，最大并发=${browser.connection.maxInflight}`
  })

  await step('登记 Emulation 期望状态（重放前置条件）', async () => {
    await session.setEmulation('setDeviceMetricsOverride', {
      width: 800,
      height: 600,
      deviceScaleFactor: 1,
      mobile: false,
    })
    const w = await session.evaluate('window.innerWidth')
    assert(w === 800, `仿真未生效：innerWidth=${w}`)
    return `innerWidth = ${w}`
  })

  await step('断线重连 + 状态重放（enable 域 + Emulation 真的重新生效）', async () => {
    const disconnected = withTimeout(
      new Promise((resolve) => browser.once('disconnected', resolve)),
      5000,
      '没有收到 disconnected 事件',
    )
    browser.connection.destroy()
    await disconnected
    const report = await browser.reconnect()
    assert(report.reattached.includes(targetId), `未重新 attach：${JSON.stringify(report)}`)
    const newSession = browser.sessions.get(browser.byTarget.get(targetId))
    assert(newSession, '重连后找不到会话')
    const d = newSession.describe()
    assert(d.enabledDomains.includes('Runtime'), `域未重放：${d.enabledDomains}`)
    // 关键：Emulation 不是"登记了"就算，要真的生效
    const w = await newSession.evaluate('window.innerWidth')
    assert(w === 800, `Emulation 未真正重放：innerWidth=${w}`)
    session = newSession
    return `重连 ${browser.reconnects} 次 · 域=[${d.enabledDomains.join(',')}] · innerWidth=${w}（真生效）`
  })

  await step('重连后继续可用（导航 + 事件续读）', async () => {
    await session.navigate('data:text/html,<title>after-reconnect</title>', { waitUntil: 'load' })
    const title = await session.evaluate('document.title')
    assert(title === 'after-reconnect', `标题异常：${title}`)
    return `document.title = ${title}`
  })

  await step('Browser.describe() 汇总（给 UI/审计用）', async () => {
    const d = browser.describe()
    assert(d.sessions >= 1 && d.targets >= 1, `describe 异常：${JSON.stringify(d)}`)
    return `targets=${d.targets} sessions=${d.sessions} events=${d.eventLog.seq} 重连=${d.reconnects}`
  })

  await step('清理：关 target + 断连接', async () => {
    if (autoTargetId) await browser.closeTarget(autoTargetId).catch(() => {})
    if (targetId) await browser.closeTarget(targetId).catch(() => {})
    await browser.close()
    return 'done'
  })
} catch (err) {
  console.error(`\n致命错误：${err?.stack ?? err}`)
} finally {
  try {
    browser?.connection?.destroy()
  } catch {
    /* ignore */
  }
  await browserProc?.kill().catch(() => {})
  if (socks) await socks.close().catch(() => {})
}

runner.summary()
