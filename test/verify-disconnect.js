#!/usr/bin/env node
/**
 * 回归测试：disconnect / remove 的语义（修掉的两个 bug）
 *
 * Bug A：`instances disconnect` 之后
 *   · 状态被"连接丢失"处理器覆盖成 dead + 错误信息（看起来像崩溃）
 *   · 懒连接路径（call/attach/targets/protocol）会静默把它连回来 → disconnect 形同虚设
 *   · 代码上还会额外武装一个自动重连定时器
 * Bug B：`instances remove` 会吐一条瞬时 dead 事件（给一个已被删掉的实例）
 *
 *   node test/verify-disconnect.js
 */
import os from 'node:os'
import path from 'node:path'
import { mkdtemp, rm } from 'node:fs/promises'
import process from 'node:process'

const HOME = await mkdtemp(path.join(os.tmpdir(), 'termcdp-disc-'))
process.env.TERMCDP_HOME = HOME

const { LocalClient } = await import('../src/engine/local-client.js')
const { launchBrowser, createRunner, assert, readReceipt, sleep } = await import('./harness.js')

const runner = createRunner()
const { step } = runner
const PORT = 9361

let client = null
let browser = null

/** 绑定到本进程客户端的调用函数（收据 + read 这套辅助按 (method, params) 取调用方） */
const callClient = (method, params) => client.call(method, params)

console.log(`\n=== disconnect / remove 语义回归 ===\nTERMCDP_HOME=${HOME}\n`)

try {
  await step('准备：一个浏览器 + 一个实例，并订阅实例状态事件', async () => {
    browser = await launchBrowser({ port: PORT })
    client = await LocalClient.open({ actor: 'disc' })
    await client.call('instances', { action: 'add', name: 'a', spec: `127.0.0.1:${PORT}` })
    const st = (await client.call('instances', { action: 'list' })).instances[0]
    assert(st.status === 'ready' && st.manuallyDisconnected === false, `初始状态异常：${JSON.stringify(st)}`)
    return `a → 127.0.0.1:${PORT} ready`
  })

  const seen = []
  client.on('instance', (inst) => seen.push({ name: inst.name, status: inst.status, error: inst.error ?? null, at: Date.now() }))

  await step('disconnect 之后状态是 idle（不是 dead），且无错误', async () => {
    seen.length = 0
    const r = await client.call('instances', { action: 'disconnect', name: 'a' })
    assert(r.status === 'idle', `disconnect 应返回 idle，实际 ${r.status}`)
    assert(r.manuallyDisconnected === true, 'describe 应标记 manuallyDisconnected=true')
    const st = (await client.call('instances', { action: 'list' })).instances[0]
    assert(st.status === 'idle', `list 里状态应为 idle，实际 ${st.status}`)
    assert(st.error === null, `不该有错误信息，实际 ${st.error}`)
    assert(st.manuallyDisconnected === true, 'list 里也该带 manuallyDisconnected')
    assert(!seen.some((e) => e.status === 'dead'), `不该出现 dead 事件：${JSON.stringify(seen)}`)
    return `status=idle / error=null / manuallyDisconnected=true；期间事件：${seen.map((e) => e.status).join('→') || '（无）'}`
  })

  await step('断开是"粘"的：等 1.6 秒（超过 1s 自动重连窗口）仍是 idle', async () => {
    await sleep(1600)
    const st = (await client.call('instances', { action: 'list' })).instances[0]
    assert(st.status === 'idle' && st.connected === false, `不该自己连回来：${JSON.stringify(st)}`)
    assert(!seen.some((e) => e.status === 'connecting' || e.status === 'ready'), `不该出现重连事件：${JSON.stringify(seen)}`)
    return '1.6s 后仍 idle，无 connecting/ready 事件'
  })

  await step('懒连接路径明确报错（instance-disconnected），而不是静默重连', async () => {
    const cases = [
      ['call', { instance: 'a', method: 'Browser.getVersion' }],
      ['targets', { instance: 'a' }],
      ['sessions', { instance: 'a' }],
      ['protocol', { instance: 'a' }],
    ]
    for (const [method, params] of cases) {
      try {
        await client.call(method, params)
        throw new Error(`${method} 应该报错`)
      } catch (err) {
        assert(err.code === 'instance-disconnected', `${method} 错误码应为 instance-disconnected，实际 ${err.code}（${err.message}）`)
      }
    }
    const st = (await client.call('instances', { action: 'list' })).instances[0]
    assert(st.status === 'idle', `报错后仍应保持 idle，实际 ${st.status}`)
    return 'call / targets / sessions / protocol 四条都回 instance-disconnected'
  })

  await step('显式 instances connect 之后恢复可用（intentional 被清除）', async () => {
    const r = await client.call('instances', { action: 'connect', name: 'a' })
    assert(r.instance.status === 'ready', `connect 后应为 ready，实际 ${r.instance.status}`)
    assert(r.instance.manuallyDisconnected === false, 'connect 应清除 manuallyDisconnected')
    const v = await callClient('call', { instance: 'a', method: 'Browser.getVersion' })
    // 新契约：call 只回收据，product 在载荷里 —— 先 read 再断言
    assert(v.resultId, `连接后 call 应回收据：${JSON.stringify(v)?.slice(0, 200)}`)
    const payload = await readReceipt(callClient, v)
    assert(payload.product, `连接后 call 应可用：${JSON.stringify(payload)?.slice(0, 200)}`)
    return `ready 且 call 可用（${payload.product}）`
  })

  await step('remove 不再吐 dead 事件', async () => {
    seen.length = 0
    const r = await client.call('instances', { action: 'remove', name: 'a' })
    assert(r.removed === 'a', 'remove 返回值异常')
    await sleep(300)
    const dead = seen.filter((e) => e.status === 'dead')
    assert(dead.length === 0, `remove 过程中不该出现 dead 事件：${JSON.stringify(seen)}`)
    const list = (await client.call('instances', { action: 'list' })).instances
    assert(list.length === 0, `remove 后列表应为空，实际 ${JSON.stringify(list)}`)
    return `remove 期间事件：${seen.map((e) => e.status).join('→') || '（无）'}；列表已空`
  })

  await step('对照：浏览器真的断掉（意外断开）仍然会被标成 dead 并尝试重连', async () => {
    await client.call('instances', { action: 'add', name: 'b', spec: `127.0.0.1:${PORT}` })
    seen.length = 0
    // 模拟意外断开：直接销毁底层连接（不是走 disconnect）
    const st = client.registry.instances.get('b')
    st.browser.connection.destroy()
    await sleep(400)
    assert(seen.some((e) => e.status === 'dead'), `意外断开应产生 dead：${JSON.stringify(seen)}`)
    return `意外断开 → ${seen.map((e) => e.status).join('→')}（这条路径保持不变）`
  })
} catch (err) {
  console.error(`\n致命错误：${err?.stack ?? err}`)
} finally {
  await client?.close().catch(() => {})
  await browser?.kill().catch(() => {})
  await rm(HOME, { recursive: true, force: true }).catch(() => {})
}

runner.summary()
