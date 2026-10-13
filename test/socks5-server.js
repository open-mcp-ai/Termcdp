/**
 * 极简 SOCKS5 服务器 —— 只用于测试/开发（验证我们的 SOCKS5 客户端与经代理的 CDP 全链路）。
 *
 * 支持：无认证、RFC1929 用户名/口令、CONNECT、IPv4/IPv6/域名目标、双向字节计数（作为"流量确实过了代理"的证据）。
 */
import net from 'node:net'
import { BufferedSocket } from '../src/util/buffered-socket.js'

function readAddress(reader, atyp) {
  if (atyp === 0x01) return reader.read(4).then((b) => [...b].join('.'))
  if (atyp === 0x04) {
    return reader.read(16).then((b) => {
      const groups = []
      for (let i = 0; i < 16; i += 2) groups.push(b.readUInt16BE(i).toString(16))
      return groups.join(':')
    })
  }
  if (atyp === 0x03) {
    return reader.read(1).then(([len]) => reader.read(len).then((b) => b.toString('utf8')))
  }
  throw new Error(`不支持的 ATYP：0x${atyp.toString(16)}`)
}

export function startSocks5Server({ host = '127.0.0.1', port = 0, auth = null, onLog } = {}) {
  const stats = { connections: 0, connects: 0, bytesClientToTarget: 0, bytesTargetToClient: 0, errors: [] }
  const sockets = new Set()

  const server = net.createServer((client) => {
    stats.connections++
    sockets.add(client)
    client.on('error', () => {})
    handle(client).catch((err) => {
      stats.errors.push(err.message)
      onLog?.(`[socks5] 处理失败：${err.message}`)
      client.destroy()
    })
  })

  async function handle(client) {
    const reader = new BufferedSocket(client)
    const greeting = await reader.read(2)
    if (greeting[0] !== 0x05) throw new Error(`非 SOCKS5 请求（版本 0x${greeting[0].toString(16)}）`)
    const methods = await reader.read(greeting[1])
    let chosen = 0x00
    if (auth) {
      if (!methods.includes(0x02)) {
        client.write(Buffer.from([0x05, 0xff]))
        throw new Error('客户端未提供用户名/口令认证方式')
      }
      chosen = 0x02
    }
    client.write(Buffer.from([0x05, chosen]))

    if (chosen === 0x02) {
      const [ver, ulen] = await reader.read(2)
      if (ver !== 0x01) throw new Error(`用户名/口令认证版本异常：0x${ver.toString(16)}`)
      const user = (await reader.read(ulen)).toString('utf8')
      const [plen] = await reader.read(1)
      const pass = (await reader.read(plen)).toString('utf8')
      const ok = user === auth.user && pass === auth.pass
      client.write(Buffer.from([0x01, ok ? 0x00 : 0x01]))
      if (!ok) throw new Error(`认证失败：${user}`)
    }

    const head = await reader.read(4)
    const [, cmd, , atyp] = head
    if (cmd !== 0x01) {
      client.write(Buffer.from([0x05, 0x07, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
      throw new Error(`只支持 CONNECT（收到 cmd=0x${cmd.toString(16)}）`)
    }
    const targetHost = await readAddress(reader, atyp)
    const targetPort = (await reader.read(2)).readUInt16BE(0)
    onLog?.(`[socks5] CONNECT ${targetHost}:${targetPort}`)

    const upstream = await new Promise((resolve, reject) => {
      const up = net.connect({ host: targetHost, port: targetPort })
      up.once('connect', () => resolve(up))
      up.once('error', (err) => reject(new Error(`无法连到 ${targetHost}:${targetPort}：${err.message}`)))
    })
    sockets.add(upstream)
    stats.connects++

    client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]))
    const { socket, rest } = reader.detach()
    if (rest.length) {
      stats.bytesClientToTarget += rest.length
      upstream.write(rest)
    }

    // 手写双向转发（带背压 + 字节计数；比 pipe() 多一层可观测性）
    socket.on('data', (chunk) => {
      stats.bytesClientToTarget += chunk.length
      if (!upstream.write(chunk)) socket.pause()
    })
    upstream.on('drain', () => socket.resume())
    upstream.on('data', (chunk) => {
      stats.bytesTargetToClient += chunk.length
      if (!socket.write(chunk)) upstream.pause()
    })
    socket.on('drain', () => upstream.resume())
    socket.on('error', () => upstream.destroy())
    upstream.on('error', () => socket.destroy())
    socket.on('close', () => upstream.destroy())
    upstream.on('close', () => socket.destroy())
  }

  return new Promise((resolve) => {
    server.listen(port, host, () => {
      resolve({
        port: server.address().port,
        stats,
        close: () =>
          new Promise((done) => {
            for (const s of sockets) s.destroy()
            server.close(() => done())
          }),
      })
    })
  })
}
