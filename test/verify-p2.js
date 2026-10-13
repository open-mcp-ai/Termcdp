#!/usr/bin/env node
/**
 * P2 验收：引擎（多实例注册表 + 结果仓）
 *
 * 单进程模型：没有 daemon、没有 socket。这里用真实的 `LocalClient`（进程内）
 * 对着**两个真实浏览器**（一个直连、一个经 SOCKS5）做聚合。
 * 「真实子进程入口」这条覆盖在 P3 里（`termcdp mcp` 走真实 stdio）—— 现在只有那一个入口。
 *
 *   node test/verify-p2.js
 */
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, readdir, rm } from 'node:fs/promises'
import process from 'node:process'

const HOME = await mkdtemp(path.join(os.tmpdir(), 'termcdp-p2-home-'))
process.env.TERMCDP_HOME = HOME

const { LocalClient } = await import('../src/engine/local-client.js')
const { launchBrowser, createRunner, assert, readReceipt, sleep } = await import('./harness.js')
const { startSocks5Server } = await import('./socks5-server.js')

const PORT_A = 9341
const PORT_B = 9342

const runner = createRunner()
const { step } = runner

let client = null
let browserA = null
let browserB = null
let socks = null
let targetA = null
let targetB = null
let sessionA = null
let sessionB = null

/** 绑定到本进程客户端的调用函数（收据 + read 这一套辅助都按 (method, params) 取调用方） */
const callClient = (method, params) => client.call(method, params)

console.log(`\n=== termcdp P2 验收（单进程模型）===\nTERMCDP_HOME=${HOME}\n`)

try {
  await step('启动两个 headless 浏览器 + 一个 SOCKS5 代理 + 进程内引擎', async () => {
    browserA = await launchBrowser({ port: PORT_A })
    browserB = await launchBrowser({ port: PORT_B })
    socks = await startSocks5Server({ port: 0 })
    client = await LocalClient.open({ actor: 'p2' })
    assert(client.hello.mode === 'standalone', `应为单进程模式：${client.hello.mode}`)
    assert(client.hello.socket === undefined, '不该再有任何 socket 概念')
    return `A:${PORT_A} B:${PORT_B} socks:${socks.port} mode=${client.hello.mode}`
  })

  await step('instances add：直连 + 经 SOCKS5 各一个', async () => {
    await client.call('instances', { action: 'add', name: 'direct-a', spec: `127.0.0.1:${PORT_A}` })
    await client.call('instances', { action: 'add', name: 'socks-b', spec: `socks5://127.0.0.1:${socks.port}?cdp=127.0.0.1:${PORT_B}` })
    const { instances } = await client.call('instances', { action: 'list' })
    assert(instances.length === 2, `实例数不对：${instances.length}`)
    assert(
      instances.every((i) => i.status === 'ready'),
      `有实例未就绪：${JSON.stringify(instances.map((i) => [i.name, i.status, i.error]))}`,
    )
    assert(instances.find((i) => i.name === 'socks-b').via !== null, 'socks-b 应记录经代理')
    return instances.map((i) => `${i.name}[${i.status}]${i.via ? ` via ${i.via}` : ''}`).join('  ')
  })

  await step('无状态：新连接从空开始，上个连接的实例不会渗进来', async () => {
    const fresh = await LocalClient.open({ actor: 'fresh' })
    try {
      const list = await fresh.call('instances', { action: 'list' })
      assert(list.instances.length === 0, `新连接应从空开始：${JSON.stringify(list)}`)
      // 就算这边的浏览器还活着，新连接也不知道它们 —— 要它自己 add
      const tg = await fresh.call('targets', {})
      assert(tg.targets.length === 0, `空连接不该聚合到任何 target：${tg.targets.length}`)
      return `第二个 LocalClient 打开时实例数=${list.instances.length}（这边两个浏览器都还活着，它一个也不知道）`
    } finally {
      await fresh.close().catch(() => {})
    }
  })

  await step('targets：跨实例聚合（省略 instance）', async () => {
    const { targets } = await client.call('targets', {})
    const byInstance = new Set(targets.map((t) => t.instance))
    assert(byInstance.has('direct-a') && byInstance.has('socks-b'), `聚合未覆盖两个实例：${[...byInstance]}`)
    return `${targets.length} 个 target，来自 ${byInstance.size} 个实例`
  })

  await step('各建一个 target 并 attach，拿到两个 sessionId', async () => {
    // 新契约：call 只回收据，targetId 在载荷里 —— 先 read 再取
    const mk = async (instance) => {
      const receipt = await callClient('call', { instance, method: 'Target.createTarget', params: { url: 'about:blank' } })
      assert(receipt.resultId, `createTarget 应回收据：${JSON.stringify(receipt)?.slice(0, 200)}`)
      const payload = await readReceipt(callClient, receipt)
      assert(payload.targetId, `createTarget 未返回 targetId：${JSON.stringify(payload)?.slice(0, 200)}`)
      return payload.targetId
    }
    targetA = await mk('direct-a')
    targetB = await mk('socks-b')
    sessionA = (await client.call('attach', { instance: 'direct-a', targetId: targetA })).sessionId
    sessionB = (await client.call('attach', { instance: 'socks-b', targetId: targetB })).sessionId
    assert(sessionA && sessionB && sessionA !== sessionB, `sessionId 异常：${sessionA} / ${sessionB}`)
    const again = await client.call('attach', { instance: 'direct-a', targetId: targetA })
    assert(again.sessionId === sessionA, 'attach 应幂等')
    return `A=${sessionA.slice(0, 6)}… B=${sessionB.slice(0, 6)}…`
  })

  await step('call：两个实例各自求值（路由不串台）', async () => {
    const ra = await callClient('call', {
      instance: 'direct-a',
      sessionId: sessionA,
      method: 'Runtime.evaluate',
      params: { expression: '"A" + (1+1)', returnByValue: true },
    })
    const rb = await callClient('call', {
      instance: 'socks-b',
      sessionId: sessionB,
      method: 'Runtime.evaluate',
      params: { expression: '"B" + (2+2)', returnByValue: true },
    })
    // 载荷不进上下文：两条都只回收据，正文各自按 resultId read 回来。
    // 注意 read 回来的**就是** send() 的返回值本身，所以这里是 `payload.result.value`（不是 payload.result.result.value）
    assert(ra.resultId && rb.resultId, `call 应回收据：${JSON.stringify([ra, rb])?.slice(0, 200)}`)
    const pa = await readReceipt(callClient, ra)
    const pb = await readReceipt(callClient, rb)
    assert(pa.result.value === 'A2', `A 结果异常：${JSON.stringify(pa.result)}`)
    assert(pb.result.value === 'B4', `B 结果异常：${JSON.stringify(pb.result)}`)
    return `A=${pa.result.value} B=${pb.result.value}（经代理那个也对）`
  })

  await step('batch：一次往返跨实例扇出导航', async () => {
    const out = await callClient('batch', {
      calls: [
        { instance: 'direct-a', sessionId: sessionA, method: 'Page.navigate', params: { url: 'data:text/html,<title>AAA</title>' } },
        { instance: 'socks-b', sessionId: sessionB, method: 'Page.navigate', params: { url: 'data:text/html,<title>BBB</title>' } },
      ],
    })
    assert(out.summary.ok === 2, `扇出失败：${JSON.stringify(out.results)}`)
    assert(out.results.every((r) => r.resultId), `batch 每项都应带收据：${JSON.stringify(out.results)?.slice(0, 300)}`)
    await sleep(300)
    const t = await callClient('batch', {
      calls: [
        { instance: 'direct-a', sessionId: sessionA, method: 'Runtime.evaluate', params: { expression: 'document.title', returnByValue: true } },
        { instance: 'socks-b', sessionId: sessionB, method: 'Runtime.evaluate', params: { expression: 'document.title', returnByValue: true } },
      ],
      mode: 'sequential',
    })
    // 每项的正文各自 read（顺序由 index 保证，与入参一致）
    const titles = []
    for (const item of t.results) {
      assert(item.ok && item.resultId, `batch 项异常：${JSON.stringify(item)}`)
      titles[item.index] = (await readReceipt(callClient, item)).result.value
    }
    assert(JSON.stringify(titles) === JSON.stringify(['AAA', 'BBB']), `标题错位：${JSON.stringify(titles)}`)
    return `顺序与入参一致：[${titles.join(', ')}]`
  })

  await step('events：全局单调序号 + 跨实例过滤 + since 续读', async () => {
    const all = await client.call('events', { since: 0, limit: 2000 })
    assert(all.events.length > 0, '没有事件')
    const ns = all.events.map((e) => e.n)
    assert(ns.every((v, i) => i === 0 || v > ns[i - 1]), '事件序号非单调')
    // 新契约：事件参数不再随事件返回，每条只带收据；正文按 resultId read
    assert(all.events.every((e) => e.resultId), `每条事件都应带 resultId：${JSON.stringify(all.events[0])}`)
    assert(all.events.every((e) => e.params === undefined), '事件不该再直接带 params（正文改走收据 + read）')
    const first = all.events[0]
    const params = await readReceipt(callClient, first)
    assert(params && typeof params === 'object', `事件 params 应是 JSON 对象：${JSON.stringify(params)?.slice(0, 200)}`)
    // read 回来的 JSON 就是这条事件原来的 params；小事件的 data 随收据就是完整的
    const wire = JSON.stringify(params)
    assert('data' in first, `默认 inlineBytes（512B）下这条小事件应内联完整的 data：${JSON.stringify(first).slice(0, 200)}`)
    assert(first.data === wire, '内联的 data 应与该事件 params 的 JSON 逐字一致（要么完整、要么没有）')
    assert(first.bytes === Buffer.byteLength(wire), `收据 bytes 应等于该事件 params 的字节数：${first.bytes} vs ${Buffer.byteLength(wire)}`)
    const onlyA = await client.call('events', { since: 0, limit: 2000, instance: 'direct-a' })
    assert(onlyA.events.every((e) => e.instance === 'direct-a'), 'instance 过滤失效')
    const mark = all.latest
    await client.call('call', { instance: 'socks-b', sessionId: sessionB, method: 'Page.reload' })
    await sleep(200)
    const delta = await client.call('events', { since: mark, limit: 500 })
    assert(delta.events.length > 0 && delta.events.every((e) => e.n > mark), 'since 续读异常')
    return `共 ${all.latest} 条；A 的 ${onlyA.events.length} 条；mark=${mark} 后新增 ${delta.events.length} 条（正文均可 read）`
  })

  await step('protocol：从实机拿签名（不硬编码）', async () => {
    const domains = await client.call('protocol', { instance: 'direct-a' })
    assert(domains.domains.length > 40, `域数过少：${domains.domains.length}`)
    const fetch = await client.call('protocol', { instance: 'direct-a', domain: 'Fetch' })
    const names = fetch.commands.map((c) => c.name)
    assert(names.includes('enable') && names.includes('continueRequest') && names.includes('fulfillRequest'), `Fetch 域签名异常：${names}`)
    assert(fetch.commands.find((c) => c.name === 'continueRequest').parameters.some((p) => p.name === 'requestId' && !p.optional), '参数必填信息缺失')
    return `${domains.domains.length} 个域；Fetch 有 ${fetch.commands.length} 条命令 / ${fetch.events.length} 个事件`
  })

  await step('大对象：只回收据，正文用 read 取回；截图 base64 不进上下文', async () => {
    // 先把视口放大：空白页的 PNG 只有几百字节，落在 4KB preview 窗口内就测不出「截断」这件事
    const resized = await callClient('call', {
      instance: 'direct-a',
      sessionId: sessionA,
      method: 'Emulation.setDeviceMetricsOverride',
      params: { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false },
    })
    assert(resized.resultId, `setDeviceMetricsOverride 应回收据：${JSON.stringify(resized)?.slice(0, 200)}`)
    const shot = await callClient('call', {
      instance: 'direct-a',
      sessionId: sessionA,
      method: 'Page.captureScreenshot',
      params: { format: 'png' },
    })
    // ① 只回收据，不进内容
    assert(shot.resultId, `截图应回收据：${JSON.stringify(shot)?.slice(0, 200)}`)
    assert(shot.bytes > 1000, `截图收据应如实报出字节数：${shot.bytes}`)
    assert(shot.result === undefined, '收据里不该再夹带载荷')
    assert(!JSON.stringify(shot).includes('$externalized'), '旧的 $externalized 协议不该再出现')
    // ② 超过 inlineBytes 的载荷：data 一个字节都不带（不是截断的前缀）
    assert(shot.bytes > 4096, `这张截图应大过默认 inlineBytes 才能验证「不内联」：${shot.bytes}`)
    assert(shot.data === undefined, `超过 inlineBytes 时不应内联任何字节：${JSON.stringify(shot).slice(0, 200)}`)
    assert(shot.truncatedPreview === undefined, '不该再有 truncatedPreview 这个截断 flag')
    // ③ read 取回完整 JSON（data 是 base64，长度与收据 bytes 一致）
    const full = await readReceipt(callClient, shot)
    assert(typeof full.data === 'string', `截图载荷应有 data 字段：${Object.keys(full).join(',')}`)
    assert(JSON.stringify(full).length === shot.bytes, `read 回来的正文长度应与收据 bytes 一致：${JSON.stringify(full).length} vs ${shot.bytes}`)
    const decoded = Buffer.from(full.data, 'base64')
    assert(decoded[0] === 0x89 && decoded[1] === 0x50, '解出来不是 PNG')
    const jsonSize = JSON.stringify(shot).length
    // 收据只有几个标量字段；base64 一旦进上下文这里会直接涨到几万字节
    assert(jsonSize < 700, `收据 ${jsonSize} 字节过大，说明正文（base64）没被剥离`)
    // 正文绝不能出现在收据里（data 不内联时，一个字节都不该有）
    assert(!JSON.stringify(shot).includes(full.data.slice(-200)), '收据里不该出现载荷正文')
    // ⑤ 抬高 inlineBytes 后，同一类大载荷也可以选择内联（调用方说了算）
    const inlined = await callClient('call', {
      instance: 'direct-a',
      sessionId: sessionA,
      method: 'Page.captureScreenshot',
      params: { format: 'png' },
      inlineBytes: 8 * 1024 * 1024,
    })
    assert(typeof inlined.data === 'string' && inlined.data.length === inlined.bytes,
      `显式抬高 inlineBytes 后应内联完整正文：bytes=${inlined.bytes}`)
    // 收尾：把视口改回去，免得影响后面的用例
    await callClient('call', {
      instance: 'direct-a',
      sessionId: sessionA,
      method: 'Emulation.clearDeviceMetricsOverride',
    }).catch(() => {})
    return `${shot.bytes} 字节 PNG → 默认不内联（收据仅 ${jsonSize} 字节）；抬高 inlineBytes 后内联 ${inlined.bytes} 字节`
  })

  await step('错误语义：未知实例 / 未知方法 / 未知会话', async () => {
    try {
      await client.call('call', { instance: 'nope', method: 'Browser.getVersion' })
      throw new Error('期望报错但没有')
    } catch (err) {
      assert(err.code === 'unknown-instance', `错误码不符：${err.code}（${err.message}）`)
    }
    try {
      await client.call('no.such.rpc')
      throw new Error('未知 RPC 应该报错')
    } catch (err) {
      assert(err.code === 'unknown-method', `未知方法错误码异常：${err.code}`)
      assert(err.message.includes('available:'), '错误信息应列出可用方法（自描述）')
    }
    try {
      await client.call('detach', { instance: 'direct-a', sessionId: 'DEADBEEF' })
      throw new Error('未知会话应该报错')
    } catch (err) {
      assert(err.code === 'unknown-session', `未知会话错误码异常：${err.code}`)
    }
    return '3 类错误都给出了可读原因与稳定错误码'
  })

  await step('status：本次进程的概览', async () => {
    const st = await client.call('status')
    assert(st.mode === 'standalone' && st.instances.length === 2, `status 异常：${JSON.stringify(st).slice(0, 300)}`)
    assert(st.audit === undefined, 'status 不该再带 audit 字段')
    return `mode=${st.mode} 实例 ${st.instances.length} · 会话 ${st.sessions} · 事件 n=${st.eventLog.seq} · 结果仓 ${st.results.count} 条`
  })

  await step('无状态不变量：home 目录里什么都没有（不落盘）', async () => {
    const files = await readdir(HOME)
    assert(files.length === 0, `进程不该往 home 写任何东西，实际：${files.join(', ')}`)
    const tg = await client.call('targets', {})
    const byInstance = new Set(tg.targets.map((t) => t.instance))
    assert(byInstance.has('direct-a') && byInstance.has('socks-b'), `聚合不到两个实例：${[...byInstance]}`)
    return `聚合 ${tg.targets.length} 个 target（两个实例）；${HOME} 内空（没有 config / audit / exports）`
  })

  await step('清理', async () => {
    await client.close()
    return 'done'
  })
} catch (err) {
  console.error(`\n致命错误：${err?.stack ?? err}`)
} finally {
  await client?.close().catch(() => {})
  await browserA?.kill().catch(() => {})
  await browserB?.kill().catch(() => {})
  if (socks) await socks.close().catch(() => {})
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
}

runner.summary()
