/**
 * The one error type with a code.
 *
 * Lives in its own module to keep the result store and the registry from importing each other
 * circularly (`results.js` throws it, `registry.js` uses the result store).
 */
export class TermcdpError extends Error {
  constructor(message, code = 'error') {
    super(message)
    this.name = 'TermcdpError'
    this.code = code
  }
}
