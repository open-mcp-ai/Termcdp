#!/usr/bin/env node
/**
 * 一条命令跑完全部验收：`node test/run-all.js`
 *
 * 每个套件都自带靶机（起 headless 浏览器 + 自建 SOCKS5 服务器，跑完清理），
 * 所以这里只负责串起来、抽取每个套件的结论行、并把**整体退出码**传出去（CI 可用）。
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import process from 'node:process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SUITES = [
  ['p0', '传输层：SOCKS5(含认证) + 手写 WS + flatten 多路复用'],
  ['p1', 'CDP 核心：autoAttach / 事件日志 / 重连+状态重放 / 流式大对象'],
  ['p2', '引擎：两个真实浏览器(直连+经SOCKS5) 聚合 / 审计 / 真实 CLI 一次性调用'],
  ['p3', 'MCP（真实子进程 stdio）+ 入口收敛：只剩 mcp'],
  ['fetch', 'fetch 动词：URL 拉进 result store → 注入页面（字节不过 agent context）'],
  ['mcp-client', '集成：官方 @modelcontextprotocol/sdk 客户端真连一次（dev 依赖，未安装则跳过）'],
  ['disconnect', '断开/删除语义：disconnect 是粘的、remove 无噪声、意外断开仍标 dead'],
]

console.log('=== termcdp 全量验收 ===\n')
let allOk = true
const rows = []

for (const [name, desc] of SUITES) {
  const started = Date.now()
  const res = spawnSync(process.execPath, [path.join(HERE, `verify-${name}.js`)], { encoding: 'utf8' })
  const out = `${res.stdout ?? ''}\n${res.stderr ?? ''}`
  const verdict = out
    .split(/\r?\n/)
    .filter((l) => /结果：|FAIL|✗/.test(l))
    .map((l) => l.trim())
    .join(' | ')
  const ok = res.status === 0
  allOk = allOk && ok
  rows.push({ name, ok, ms: Date.now() - started, verdict: verdict || '(无结论行)' })
  console.log(`${ok ? 'PASS' : 'FAIL'}  verify-${name}  ${verdict || '(无结论行)'}  (${((Date.now() - started) / 1000).toFixed(1)}s)`)
  if (!ok) {
    const tail = out.split(/\r?\n/).filter((l) => /FAIL|✗|错误/.test(l)).slice(0, 12)
    for (const line of tail) console.log(`      ${line.trim()}`)
  }
}

console.log('\n================ 汇总 ================')
for (const r of rows) console.log(`${r.ok ? '✅' : '❌'}  ${r.name}  ${(r.ms / 1000).toFixed(1)}s  ${r.verdict}`)
console.log(allOk ? '\n全部通过 ✅' : '\n有失败 ❌')
process.exit(allOk ? 0 : 1)
