/**
 * SeqLog — a bounded ring buffer where every record carries a monotonically increasing number.
 *
 * Why: CDP has **no event replay** — once pushed, an event is gone. Consumers pull in batches,
 * so a process must keep a window of history itself, and each record needs a sequence number
 * that stays stable across truncation: the client says "give me n > 1234" and resumes exactly,
 * without relying on any byte offset.
 */
export class SeqLog {
  /**
   * @param {{ capacity?: number, compactAt?: number }} [opts]
   */
  constructor({ capacity = 5000, compactAt = 2000 } = {}) {
    this.capacity = capacity
    this.compactAt = compactAt
    /** @type {Array<object>} */
    this.items = []
    /** Total records produced (= the latest sequence number) */
    this.seq = 0
    /** Records dropped for exceeding the capacity */
    this.dropped = 0
  }

  get size() {
    return this.items.length
  }

  /** The latest sequence number (what the consumer passes as `since` next time) */
  get latest() {
    return this.seq
  }

  /**
   * @param {object} record shallow-copied and stamped with `n`
   * @returns {object} the stamped record
   */
  push(record) {
    const rec = { n: ++this.seq, ...record }
    this.items.push(rec)
    if (this.items.length > this.capacity + this.compactAt) {
      const drop = this.items.length - this.capacity
      this.items.splice(0, drop)
      this.dropped += drop
    }
    return rec
  }

  /**
   * Records with a sequence number greater than `since`.
   * @param {number} since
   * @param {{ sessionId?: string, method?: string, prefix?: string, instance?: string, limit?: number, order?: 'asc'|'desc' }} [opts]
   */
  since(since = 0, opts = {}) {
    const { sessionId, method, prefix, instance, limit, order = 'asc' } = opts
    const out = []
    for (let i = this.items.length - 1; i >= 0; i--) {
      const rec = this.items[i]
      if (rec.n <= since) break
      if (sessionId && rec.sessionId !== sessionId) continue
      if (instance && rec.instance !== instance) continue
      if (method && rec.method !== method) continue
      if (prefix && !String(rec.method ?? '').startsWith(prefix)) continue
      out.push(rec)
    }
    out.reverse()
    if (order === 'desc') out.reverse()
    if (limit && out.length > limit) {
      return order === 'desc' ? out.slice(0, limit) : out.slice(out.length - limit)
    }
    return out
  }

  stats() {
    return { seq: this.seq, size: this.items.length, capacity: this.capacity, dropped: this.dropped }
  }
}
