/** 测试公共设施：浏览器探测/启动、CDP 就绪等待、进程树清理、步骤运行器。 */
import { spawn, execFileSync } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export function detectBrowser(explicit) {
  if (explicit) return explicit
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

export async function waitForCdp(port, timeoutMs = 20_000) {
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
    await new Promise((r) => setTimeout(r, 200))
  }
  throw new Error(`浏览器 CDP 未就绪（:${port}）：${lastErr?.message ?? 'unknown'}`)
}

export function killTree(pid) {
  if (!pid) return
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

export async function launchBrowser({ port = 9333, browser, extraArgs = [] } = {}) {
  const browserPath = detectBrowser(browser ?? process.env.TERMCDP_BROWSER)
  if (!browserPath) throw new Error('未找到浏览器，请设置 TERMCDP_BROWSER=/path/to/chrome')
  const userDataDir = await mkdtemp(path.join(os.tmpdir(), 'termcdp-test-'))
  const proc = spawn(
    browserPath,
    [
      '--headless=new',
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${userDataDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-crash-reporter',
      '--disable-breakpad',
      '--disable-extensions',
      '--disable-sync',
      '--disable-background-networking',
      ...extraArgs,
      'about:blank',
    ],
    { stdio: 'ignore' },
  )
  const version = await waitForCdp(port)
  return {
    path: browserPath,
    proc,
    userDataDir,
    version,
    async kill() {
      killTree(proc.pid)
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {})
    },
  }
}

export function createRunner() {
  const results = []
  let n = 0
  return {
    results,
    async step(name, fn) {
      n++
      const label = `${String(n).padStart(2, '0')}. ${name}`
      const t0 = Date.now()
      try {
        const info = await fn()
        results.push({ label, ok: true })
        console.log(`PASS  ${label}${info ? `  — ${info}` : ''}  (${Date.now() - t0}ms)`)
        return true
      } catch (err) {
        results.push({ label, ok: false, err: err?.message ?? String(err) })
        console.log(`FAIL  ${label}  — ${err?.message ?? err}  (${Date.now() - t0}ms)`)
        return false
      }
    },
    summary() {
      const failed = results.filter((r) => !r.ok)
      console.log(`\n=== 结果：${results.length - failed.length}/${results.length} 通过 ===`)
      if (failed.length) {
        for (const f of failed) console.log(`  ✗ ${f.label}\n    ${f.err}`)
        process.exitCode = 1
      } else {
        console.log('  全部通过 ✅')
      }
      return failed.length === 0
    },
  }
}

export function assert(cond, msg) {
  if (!cond) throw new Error(msg)
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

/**
 * 测试辅助：把「收据」读成完整对象。
 * 新契约下 call/batch/events 只回收据，正文要 read 按 resultId 分片取回。
 * 一次 read 上限默认 8MB（收据里的正文都是 JSON 文本，测试用例远小于这个量）。
 * @param {(method: string, params?: object) => Promise<any>} call 已绑定到某个客户端/子进程的调用函数
 * @param {{resultId: string}} receipt 收据（call/batch 每项/events 每条都长这样）
 * @param {{maxBytes?: number}} [opts]
 * @returns {Promise<any>} 收据背后载荷的 JSON 对象
 */
export async function readReceipt(call, receipt, { maxBytes = 8 * 1024 * 1024 } = {}) {
  assert(receipt?.resultId, `收据缺少 resultId：${JSON.stringify(receipt)?.slice(0, 200)}`)
  const out = await call('read', { resultId: receipt.resultId, maxBytes })
  assert(out.eof, `正文未读完：${receipt.resultId}（读到 ${out.nextOffset}/${out.totalBytes} 字节，超过 maxBytes=${maxBytes}）`)
  return JSON.parse(out.data)
}

export function withTimeout(promise, ms, message) {
  let timer
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message ?? `超时 ${ms}ms`)), ms)
      timer.unref?.()
    }),
  ]).finally(() => clearTimeout(timer))
}
