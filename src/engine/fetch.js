/**
 * `fetch` — pull a URL into the result store, in **this process**, so the bytes never pass through
 * the agent's context.
 *
 * Why it exists: the useful workflow is "download a file, then inject it into a page"
 * (termcp serves it over `GET /api/sessions/{id}/files/download`, termcdp injects it with
 * `Runtime.evaluate` / `Page.addScriptToEvaluateOnNewDocument`). Every other way of getting the
 * source into the page is worse:
 *   - the page fetching it itself (`fetch` + `eval`, or a `<script src>` tag) dies on any page
 *     whose CSP forbids it — and needs the origin to send CORS headers;
 *   - the agent reading it and pasting it into an `expression` puts the whole file in context.
 * Here the payload lands in the store as an ordinary result: the caller gets a receipt, pages
 * through it with `read` only if it wants to, and the injection step passes the source straight
 * back in — a 300KB bundle costs the agent two ids, not 300KB.
 *
 * Not a general HTTP client: one GET, no cookies, no auth header, no redirect chain beyond what
 * `fetch` does, no streaming to disk. **The process holds no state on disk, so nothing is ever
 * written to a cache** — the store is in memory and dies with the process.
 *
 * The URL check below is a trust boundary, not a policy layer: this process can reach the
 * machine's own network (termcp, an internal host), so a `file:` or `data:` URL — which would
 * turn a fetch into "read any local file" — is refused up front.
 */
import { TermcdpError } from './errors.js'
import { DEFAULT_INLINE_BYTES } from './results.js'

const DEFAULT_MAX_BYTES = 64 * 1024 * 1024
const DEFAULT_TIMEOUT_MS = 30_000

/** Only http(s): `file:`/`data:` would make this a local-file reader, and the browser has no use for them */
function assertFetchable(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw new TermcdpError(`fetch needs a valid absolute URL, got ${JSON.stringify(url)}`, 'invalid')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new TermcdpError(
      `fetch only speaks http/https (got ${parsed.protocol}) — file: and data: are refused because this runs on the host, not in the page`,
      'invalid',
    )
  }
  return parsed
}

/**
 * GET a URL into the result store.
 *
 * Params are **flat** (the engine convention — `paths.js` spreads the verb's `opts` bag, exactly as
 * `targets` / `events` do). A nested `{opts: {…}}` here would be silently ignored on the MCP path,
 * which is how `maxBytes` first failed to apply.
 *
 * @param {import('./registry.js').Registry} reg
 * @param {{url: string, inlineBytes?: number, maxBytes?: number, timeoutMs?: number, headers?: object}} params
 * @returns {Promise<object>} a receipt `{resultId, instance, method, url, bytes, sha256, data?}`
 */
export async function fetchUrl(reg, { url, inlineBytes = DEFAULT_INLINE_BYTES, maxBytes = DEFAULT_MAX_BYTES, timeoutMs = DEFAULT_TIMEOUT_MS, headers } = {}) {
  if (!url) throw new TermcdpError('fetch requires a url: invoke("fetch", "https://…")', 'invalid')
  const parsed = assertFetchable(url)
  const signal = AbortSignal.timeout(Number(timeoutMs) || DEFAULT_TIMEOUT_MS)
  let res
  try {
    res = await fetch(parsed, { redirect: 'follow', signal, ...(headers ? { headers } : {}) })
  } catch (err) {
    // AbortSignal.timeout rejects with a TimeoutError; say which of the two it was
    const why = err?.name === 'TimeoutError' ? `timed out after ${timeoutMs}ms` : err?.message ?? err
    throw new TermcdpError(`fetch failed: ${why} (${parsed.href})`, 'fetch-failed')
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new TermcdpError(
      `fetch failed: HTTP ${res.status} ${res.statusText} (${parsed.href})${body ? `: ${body.slice(0, 200)}` : ''}`,
      'fetch-failed',
    )
  }

  const buf = Buffer.from(await res.arrayBuffer())
  // Bounded, because the whole body lands in memory (the store is in-memory only). Refuse rather
  // than truncate: a truncated script injected into a page fails in a way that reads like a bug
  // in the script.
  if (buf.length > maxBytes) {
    throw new TermcdpError(
      `fetch refused: ${buf.length} bytes exceeds maxBytes ${maxBytes} (raise maxBytes in the verb's opts bag if it is really wanted; the store holds payloads in memory)`,
      'too-large',
    )
  }

  return reg.results.put('fetch', buf, {
    method: 'fetch',
    // The URL rides in the receipt so a caller can tell two downloads apart without re-reading
    url: parsed.href,
    ...(res.headers.get('content-type') ? { contentType: res.headers.get('content-type') } : {}),
    inlineBytes,
  })
}
