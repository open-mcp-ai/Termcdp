/**
 * Result store — **receipts + ids**.
 *
 * Every CDP payload (command result, event params) lands here and only here; the caller gets back
 * a receipt `{resultId, instance, sessionId?, method?, at, bytes, sha256, data?}`, and reads the
 * full body by id, in slices, when it actually wants it.
 *
 * **Inlining (data): complete or nothing.** `data` appears only when the whole payload fits inside
 * the `inlineBytes` the caller passed in; above that, not one byte is inlined — go `read` it.
 * Deliberately no truncated prefix: truncated JSON cannot be parsed, truncated strings are useless,
 * and it would force every caller to also check a `truncatedPreview` flag. Made binary this way,
 * `data` present means it is the whole thing, `data` absent means go read.
 *
 * Why "everything gets an id" rather than "only big objects go to a file":
 *  - Deciding what counts as big needs a whitelist or a threshold — that is policy, and it drifts
 *    and leaks. A 46KB `DOM.getDocument {depth:-1}` and a 300KB string from `Runtime.evaluate` both
 *    slip through into context, while a 411-byte blank screenshot gets a file whose pointer costs
 *    more than the data.
 *  - With a uniform "everything has an id": the shape is always the same (callers parse one way),
 *    there is no whitelist to maintain, and how much to read is decided entirely by the reading side
 *    (it manages its own offset).
 *
 * The id shape is `<instance>/<seq>`:
 *  - `instance`: one process can hold several CDP ports at once and they must be distinguishable
 *  - `seq`: monotonic within the process → a total order, usable for "the last N results"
 *
 * Storage is **in memory** only (bounded, FIFO eviction) — nothing in this process is ever written
 * to disk. That means login state and credentials never reach disk either, and there is no quota
 * rotation to manage. The process is stateless: when it exits, everything is gone, and the model
 * re-adds its instances on the next connection.
 *
 * This file has two layers:
 *  1. `ResultStore` — the store itself (put / slice / list / stats); it only stores.
 *  2. The two **read-side** functions below (`readResult` / `listResults`) — the command-layer
 *     semantics: param validation and error codes.
 *
 * Why the read side lives here instead of on the registry:
 *  it depends on exactly one thing — the store — and has nothing to do with instance lifecycle.
 *  These functions take `store` (= `registry.results`) rather than the registry precisely to keep
 *  that dependency explicit, and to make the store assertable on its own.
 */
import { sha256 } from '../cdp/objects.js'
import { TermcdpError } from './errors.js'

/** Default inline limit for command results: ≤ this and the whole data comes back with the receipt (enough for `Runtime.enable` → `{}` or `Page.navigate` → frameId) */
export const DEFAULT_INLINE_BYTES = 4096
/** The default inline limit for events is smaller: events are read in batches (default 50), so a large one would eat tens of KB of context */
export const DEFAULT_EVENT_INLINE_BYTES = 512
const DEFAULT_STORE_BYTES = 256 * 1024 * 1024

export class ResultStore {
  constructor({ maxBytes = DEFAULT_STORE_BYTES } = {}) {
    this.maxBytes = maxBytes
    /** @type {Map<string, object>} resultId → record (holds the raw bytes) */
    this.map = new Map()
    /** Insertion order (= ascending seq), used for eviction */
    this.order = []
    this.totalBytes = 0
    this.seq = 0
    this.putCount = 0
    this.evictedCount = 0
    /** Highest seq already evicted per instance — lets us report "reclaimed" separately from "never existed" */
    this.evictedTo = new Map()
  }

  /**
   * Store one payload.
   * @param {string} instance instance name
   * @param {Buffer|string} bytes the payload (command result = JSON.stringify(result); event = its params)
   * @param {{ method?: string, sessionId?: string|null, kind?: 'result'|'event', inlineBytes?: number }} meta
   */
  put(instance, bytes, meta = {}) {
    const { inlineBytes = 0, ...rest } = meta
    const seq = ++this.seq
    const resultId = `${instance}/${seq}`
    const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes), 'utf8')
    const rec = {
      resultId,
      instance,
      seq,
      buf,
      bytes: buf.length,
      sha256: sha256(buf),
      at: Date.now(),
      kind: 'result',
      ...rest,
    }
    this.map.set(resultId, rec)
    this.order.push(resultId)
    this.totalBytes += buf.length
    this.putCount++
    this.#evict()
    return this.#receiptOf(rec, inlineBytes)
  }

  /** Build a receipt (no raw bytes): metadata is always present; `data` only when the whole thing fits `inlineBytes` */
  #receiptOf(rec, inlineBytes) {
    const out = {
      resultId: rec.resultId,
      instance: rec.instance,
      ...(rec.sessionId ? { sessionId: rec.sessionId } : {}),
      ...(rec.method ? { method: rec.method } : {}),
      ...(rec.kind === 'event' ? { kind: 'event' } : {}),
      at: rec.at,
      bytes: rec.bytes,
      sha256: rec.sha256,
    }
    // Complete or nothing: if it fits, inline the whole thing; if not, not one byte (no truncation, no flag to check)
    if (inlineBytes > 0 && rec.bytes <= inlineBytes) out.data = rec.buf.toString('utf8')
    return out
  }

  /**
   * Regenerate a receipt by resultId (read side: the event log / the `results` index).
   * @param {{ inlineBytes?: number, missingOk?: boolean }} [opts] `missingOk` = return null instead of throwing when the payload was evicted
   */
  receipt(resultId, { inlineBytes = 0, missingOk = false } = {}) {
    const rec = this.map.get(resultId)
    if (!rec) {
      if (missingOk) return null
      throw this.#missingError(resultId)
    }
    return this.#receiptOf(rec, inlineBytes)
  }

  #evict() {
    // Always keep at least one entry: even a single payload larger than the budget must not evict itself
    while (this.totalBytes > this.maxBytes && this.order.length > 1) {
      const id = this.order.shift()
      const rec = this.map.get(id)
      if (!rec) continue
      this.map.delete(id)
      this.totalBytes -= rec.bytes
      this.evictedCount++
      const prev = this.evictedTo.get(rec.instance) ?? 0
      if (rec.seq > prev) this.evictedTo.set(rec.instance, rec.seq)
    }
  }

  #require(resultId) {
    const rec = this.map.get(resultId)
    if (rec) return rec
    throw this.#missingError(resultId)
  }

  /** A miss reports an error that distinguishes "evicted" from "never existed" */
  #missingError(resultId) {
    const m = /^(.*)\/(\d+)$/.exec(String(resultId ?? ''))
    if (m) {
      const evictedTo = this.evictedTo.get(m[1]) ?? 0
      if (Number(m[2]) <= evictedTo) {
        return new TermcdpError(
          `result ${resultId} has been evicted (result-store budget ${this.maxBytes} bytes, FIFO eviction)`,
          'result-evicted',
        )
      }
    }
    return new TermcdpError(
      `unknown resultId: ${resultId} (shaped like win10/42; read cdp://results for the recent ones)`,
      'unknown-result',
    )
  }

  /** Sliced read: the reading side manages its own offset cursor */
  slice(resultId, offset = 0, maxBytes = 64 * 1024) {
    const rec = this.#require(resultId)
    const from = Math.max(0, Math.min(Number(offset) || 0, rec.bytes))
    const len = Math.max(0, Math.min(Number(maxBytes) || 64 * 1024, rec.bytes - from))
    const chunk = rec.buf.subarray(from, from + len)
    return {
      resultId,
      offset: from,
      nextOffset: from + chunk.length,
      eof: from + chunk.length >= rec.bytes,
      totalBytes: rec.bytes,
      data: chunk.toString('utf8'),
    }
  }

  /** Index of recent results (metadata receipts only, no data — the index is for recovering an id) */
  list({ since = 0, limit = 50, instance } = {}) {
    const out = []
    for (const id of this.order) {
      const rec = this.map.get(id)
      if (!rec) continue
      if (rec.seq <= since) continue
      if (instance && rec.instance !== instance) continue
      out.push(this.#receiptOf(rec, 0))
    }
    return { results: out.slice(-Math.max(1, limit)), latest: this.seq, store: this.stats() }
  }

  stats() {
    return {
      count: this.map.size,
      bytes: this.totalBytes,
      maxBytes: this.maxBytes,
      seq: this.seq,
      evicted: this.evictedCount,
    }
  }
}

// ---------- Read side (the caller manages the cursor) ----------

/** Page through a payload by resultId */
export function readResult(store, { resultId, offset = 0, maxBytes } = {}) {
  if (!resultId) throw new TermcdpError('read requires resultId', 'invalid')
  return store.slice(resultId, offset, maxBytes)
}

/**
 * Result index: which results came through recently (receipts only, no bodies).
 * The method is not named `results()` — that would collide with `this.results` (the store itself),
 * the way `this.events` already does on the registry.
 */
export function listResults(store, { since = 0, limit = 50, instance } = {}) {
  return store.list({ since, limit, instance })
}
