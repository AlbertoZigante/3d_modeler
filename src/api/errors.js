/**
 * api/errors.js — what an ApiError means for the person using the app.
 *
 * Codes come from two places (see api/http.js):
 *   the API (documented in openapi.json): invalid_api_key, unauthorized, invalid_token, token_expired,
 *     rate_limited, validation_error, payload_too_large, busy, nesting_timeout, not_implemented, internal_error
 *   the client transport: unreachable, timeout, aborted, not_configured
 *
 * Messages are ENGLISH SOURCE TEXT: the i18n layer (src/i18n/catalog.js) translates them when they are
 * rendered (toast / banner), so every string here MUST have a catalog row — tests/apiErrors.test.mjs
 * enforces that, and that every code the contract documents is handled here.
 */

export const API_ERROR_MESSAGES = {
  invalid_api_key: 'Invalid or missing API key',
  unauthorized: 'Please sign in to use this feature.',
  invalid_token: 'Your session is not valid — please sign in again.',
  token_expired: 'Your session has expired — please sign in again.',
  rate_limited: 'Too many requests — wait a moment and try again.',
  internal_error: 'The server had a problem — please try again.',
  validation_error: 'The design could not be processed (invalid data).',
  payload_too_large: 'The design is too large to process.',
  busy: 'The server is busy — try again in a few seconds.',
  nesting_timeout: 'Nesting took too long — try a smaller design.',
  not_implemented: 'This feature is not available on the server yet.',
  unreachable: 'Backend unavailable — cut list and nesting need the API.',
  timeout: 'The server took too long to answer.',
  aborted: 'Request cancelled.',
  not_configured: 'Backend not configured (VITE_API_URL is empty)',
  unknown: 'Backend error — please try again.',
};

/** Retrying the SAME action can help (transient), as opposed to needing a change of design/config. */
const RETRYABLE = new Set(['busy', 'rate_limited', 'internal_error', 'unreachable', 'timeout', 'unknown']);

/** Sign-in problems: the person must (re)authenticate — retrying the same call cannot help. */
export const AUTH_CODES = new Set(['invalid_api_key', 'unauthorized', 'invalid_token', 'token_expired']);

/** Shown under the message while the cut list cannot refresh. */
export const STALE_NOTE = 'The cut list is out of date. It refreshes automatically on your next edit, or when you open the cut list.';

/**
 * @param {unknown} err  usually an ApiError (code/status), but anything thrown is accepted
 * @returns {{ code: string, message: string, retryable: boolean, needsSignIn: boolean, retryAfterS?: number, silent: boolean }}
 *   silent = the request was cancelled on purpose (superseded): nothing to tell the person.
 */
export function describeApiError(err) {
  const raw = err?.code;
  const code = Object.hasOwn(API_ERROR_MESSAGES, raw) ? raw : 'unknown';
  return {
    code,
    message: API_ERROR_MESSAGES[code],
    retryable: RETRYABLE.has(code),
    needsSignIn: AUTH_CODES.has(code),
    retryAfterS: Number.isFinite(err?.retryAfterS) ? err.retryAfterS : undefined,
    silent: code === 'aborted',
  };
}
