/**
 * tests/apiErrors.test.mjs — src/api/errors.js
 *   - every error code the API contract documents is handled (not "unknown")
 *   - every user-facing message has fr + it translations in the i18n catalog
 *   - mapping rules (retryable / silent / unknown codes)
 * Run with: node tests/apiErrors.test.mjs
 */
import { readFileSync } from 'node:fs';
import { API_ERROR_MESSAGES, STALE_NOTE, describeApiError } from '../src/api/errors.js';
import { ApiError } from '../src/api/http.js';
import { CATALOG } from '../src/i18n/catalog.js';

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : (fail++, console.error('  FAIL:', name)); };

const spec = JSON.parse(readFileSync(new URL('../src/api/openapi.json', import.meta.url), 'utf8'));

console.log('every code documented in the API contract is handled');
{
  const documented = new Set();
  const scan = (responses = {}) => Object.values(responses).forEach((r) => {
    for (const m of String(r.description ?? '').matchAll(/code=([a-z_]+)/g)) documented.add(m[1]);
  });
  Object.values(spec.paths).forEach((methods) => Object.values(methods).forEach((op) => scan(op.responses)));
  check('the contract documents error codes', documented.size >= 5);
  for (const code of documented) check(`contract code "${code}" is mapped`, describeApiError({ code }).code === code);
  ['busy', 'nesting_timeout', 'validation_error', 'invalid_api_key', 'unauthorized', 'invalid_token', 'token_expired', 'rate_limited', 'payload_too_large'].forEach((c) => check(`"${c}" is documented`, documented.has(c)));
}

console.log('every user-facing message is translated (fr + it)');
{
  const rows = new Map(CATALOG.map((r) => [r[0].replace(/\s+/g, ' ').trim(), r]));
  for (const text of [...Object.values(API_ERROR_MESSAGES), STALE_NOTE]) {
    const row = rows.get(text);
    check(`catalog row exists: "${text.slice(0, 50)}…"`, !!row);
    check(`  fr + it filled: "${text.slice(0, 40)}…"`, !!row && !!row[1] && !!row[2] && row[1] !== text);
  }
}

console.log('mapping rules');
{
  check('ApiError with a known code', describeApiError(new ApiError('x', { code: 'busy', status: 503 })).message === API_ERROR_MESSAGES.busy);
  check('busy / unreachable / timeout / rate_limited / internal_error are retryable', ['busy', 'unreachable', 'timeout', 'rate_limited', 'internal_error'].every((c) => describeApiError({ code: c }).retryable));
  check('sign-in problems say so (needsSignIn) and are not retryable', ['invalid_api_key', 'unauthorized', 'invalid_token', 'token_expired'].every((c) => describeApiError({ code: c }).needsSignIn && !describeApiError({ code: c }).retryable));
  check('retryAfterS is passed through for the UI', describeApiError(new ApiError('x', { code: 'rate_limited', status: 429, retryAfterS: 12 })).retryAfterS === 12 && describeApiError({ code: 'busy' }).retryAfterS === undefined);
  check('other codes do not claim needsSignIn', !describeApiError({ code: 'busy' }).needsSignIn && !describeApiError({ code: 'validation_error' }).needsSignIn);
  check('nesting_timeout is NOT retryable (same input would time out again)', !describeApiError({ code: 'nesting_timeout' }).retryable);
  check('validation / auth / config errors are not retryable', ['validation_error', 'invalid_api_key', 'not_configured', 'payload_too_large'].every((c) => !describeApiError({ code: c }).retryable));
  check('only "aborted" is silent', describeApiError({ code: 'aborted' }).silent && !describeApiError({ code: 'busy' }).silent);
  check('HTTP error without a code -> unknown, retryable', describeApiError(new ApiError('x', { status: 502 })).code === 'unknown' && describeApiError({ status: 502 }).retryable);
  check('non-ApiError (TypeError) -> unknown', describeApiError(new TypeError('boom')).code === 'unknown');
  check('null / undefined are safe', describeApiError(null).code === 'unknown' && describeApiError(undefined).code === 'unknown');
  check('prototype keys are not treated as codes', describeApiError({ code: 'constructor' }).code === 'unknown' && describeApiError({ code: 'toString' }).code === 'unknown');
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exit(fail ? 1 : 0);
