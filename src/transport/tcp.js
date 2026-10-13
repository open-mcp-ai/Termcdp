/** Bare TCP dial with a connect timeout — the base layer every transport here builds on. */
import net from 'node:net'

export function connectTcp(host, port, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host, port })
    const timer = setTimeout(() => {
      socket.destroy()
      reject(new Error(`TCP connect timed out: ${host}:${port} (${timeoutMs}ms)`))
    }, timeoutMs)
    timer.unref?.()
    socket.once('connect', () => {
      clearTimeout(timer)
      socket.setNoDelay(true)
      resolve(socket)
    })
    socket.once('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`TCP connect failed ${host}:${port}: ${err.message}`))
    })
  })
}
