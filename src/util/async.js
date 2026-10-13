/** Small async helpers (zero dependencies). */

/** Race a promise against a timeout; rejects with `message` when it expires. */
export function withTimeout(promise, ms, message) {
  let timer
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message ?? `timed out (${ms}ms)`)), ms)
    timer.unref?.()
  })
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer))
}
