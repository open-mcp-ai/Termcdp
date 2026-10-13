/**
 * CDP object / stream helpers.
 *
 * **Nothing here touches disk.** Every CDP payload lives in the result store (receipt + id,
 * see `engine/results.js`), in memory only. So only three protocol concerns remain:
 *
 *  - `sha256`: digest for the receipt (used by the result store)
 *  - `readStream`: drain a CDP stream handle into a single Buffer — the right way to move large
 *    content without blowing up the WebSocket with base64. Get a `stream` handle from
 *    `Page.printToPDF {transferMode:'ReturnAsStream'}` / `Fetch.takeResponseBodyAsStream`,
 *    then pull it in chunks with `IO.read(handle, size)` and close with `IO.close`.
 *  - `chunkToBuffer`: an `IO.read` result → Buffer (mind `base64Encoded`)
 */
import { createHash } from 'node:crypto'

export const sha256 = (buf) => createHash('sha256').update(buf).digest('hex')

/** Turn an `IO.read` result into a Buffer (mind `base64Encoded`) */
function chunkToBuffer({ data, base64Encoded }) {
  if (data == null) return Buffer.alloc(0)
  return base64Encoded ? Buffer.from(data, 'base64') : Buffer.from(data, 'utf8')
}

/**
 * Drain a CDP stream handle into a single Buffer.
 * @param {{ send: Function }} conn something with `send(method, params)` (CdpConnection or Session)
 * @param {string} handle IO.StreamHandle
 */
export async function readStream(conn, handle, { maxBytes = 64 * 1024 * 1024, chunkSize = 1024 * 1024 } = {}) {
  const chunks = []
  let total = 0
  let truncated = false
  try {
    for (;;) {
      const res = await conn.send('IO.read', { handle, size: chunkSize })
      const buf = chunkToBuffer(res)
      if (buf.length) {
        chunks.push(buf)
        total += buf.length
      }
      if (res.eof) break
      if (total >= maxBytes) {
        truncated = true
        break
      }
    }
  } finally {
    await conn.send('IO.close', { handle }).catch(() => {})
  }
  return { buffer: Buffer.concat(chunks, total), truncated }
}
