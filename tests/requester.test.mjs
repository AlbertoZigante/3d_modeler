/**
 * tests/requester.test.mjs — src/api/requester.js (debounce / cache / abort / stale / errors)
 * Run with: node tests/requester.test.mjs
 */
import { createLatestRequester } from '../src/api/requester.js';

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : (fail++, console.error('  FAIL:', name)); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const panels = (n) => Array.from({ length: n }, (_, i) => ({ id: `p${i}` }));

/** call() fake: records calls, lets each test decide when/how a call settles. */
function fakeCall() {
  const calls = [];
  const call = (payload, { signal }) => new Promise((resolve, reject) => {
    const c = { payload, signal, resolve: (v) => resolve(v), reject: (e) => reject(e) };
    signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    calls.push(c);
  });
  return { call, calls };
}
const make = (opts = {}) => {
  const f = fakeCall();
  const changes = [];
  const r = createLatestRequester({ call: f.call, debounceMs: 15, emptyResult: { rows: [] }, onChange: (s) => changes.push(s.status), ...opts });
  return { ...f, r, changes };
};

console.log('debounce: a burst of edits makes ONE call, with the last payload');
{
  const { r, calls } = make();
  r.request(panels(1)); r.request(panels(2)); r.request(panels(3));
  check('nothing called synchronously', calls.length === 0);
  await sleep(40);
  check('exactly one call', calls.length === 1);
  check('with the newest payload', calls[0].payload.length === 3);
  calls[0].resolve({ rows: ['x'] });
  await sleep(5);
  check('state ready with the result', r.getState().status === 'ready' && r.getState().result.rows[0] === 'x');
  check('isFresh', r.isFresh());
}

console.log('identical payload is a no-op; flush() is idempotent once applied');
{
  const { r, calls } = make();
  r.request(panels(2)); await sleep(30); calls[0].resolve({ rows: [1] }); await sleep(5);
  r.request(panels(2)); await sleep(30);
  check('same payload -> no second call', calls.length === 1);
  await r.flush();
  check('flush of an applied payload -> no call', calls.length === 1);
}

console.log('cache: going back to an earlier design costs no request');
{
  const { r, calls } = make();
  r.request(panels(1)); await sleep(30); calls[0].resolve({ rows: ['A'] }); await sleep(5);
  r.request(panels(2)); await sleep(30); calls[1].resolve({ rows: ['B'] }); await sleep(5);
  r.request(panels(1)); await sleep(30);
  check('third edit served from cache', calls.length === 2);
  check('result is the cached one', r.getState().result.rows[0] === 'A' && r.isFresh());
}

console.log('LRU: oldest entries are evicted beyond cacheSize');
{
  const { r, calls } = make({ cacheSize: 2 });
  for (const n of [1, 2, 3]) { r.request(panels(n)); await sleep(30); calls.at(-1).resolve({ rows: [n] }); await sleep(5); }
  r.request(panels(1)); await sleep(30);
  check('design 1 was evicted -> refetched', calls.length === 4);
  calls.at(-1).resolve({ rows: [1] }); await sleep(5);
}

console.log('stale: a superseded request is aborted and its late answer ignored');
{
  const { r, calls } = make();
  r.request(panels(1)); await sleep(30);
  r.request(panels(2)); await sleep(30);
  check('two calls issued', calls.length === 2);
  check('first one was aborted', calls[0].signal.aborted === true);
  calls[1].resolve({ rows: ['new'] }); await sleep(5);
  calls[0].resolve({ rows: ['OLD'] }); await sleep(5); // late, even though aborted
  check('state keeps the newest result', r.getState().result.rows[0] === 'new');
  check('applied key is the newest payload', r.isFresh());
}

console.log('flush() joins the in-flight call for the same payload');
{
  const { r, calls } = make();
  r.request(panels(2)); await sleep(30);
  const a = r.flush(), b = r.flush();
  check('no extra call', calls.length === 1);
  calls[0].resolve({ rows: ['ok'] });
  await Promise.all([a, b]);
  check('both resolved with state ready', r.getState().status === 'ready');
}

console.log('empty design: no network, emptyResult applied');
{
  const { r, calls } = make();
  r.request([]); await sleep(30);
  check('no call', calls.length === 0);
  check('ready with emptyResult', r.getState().status === 'ready' && r.getState().result.rows.length === 0);
}

console.log('errors: status error, last good result kept, flush() retries, flush never rejects');
{
  const { r, calls, changes } = make();
  r.request(panels(1)); await sleep(30); calls[0].resolve({ rows: ['good'] }); await sleep(5);
  r.request(panels(2)); await sleep(30);
  calls[1].reject(new Error('boom')); await sleep(5);
  check('status error', r.getState().status === 'error' && r.getState().error.message === 'boom');
  check('last good result kept', r.getState().result.rows[0] === 'good');
  check('not fresh', !r.isFresh());
  const retry = r.flush();
  check('flush retries (new call)', calls.length === 3);
  calls[2].resolve({ rows: ['fixed'] });
  let threw = false; try { await retry; } catch { threw = true; }
  check('flush promise did not reject', !threw);
  check('recovered', r.getState().status === 'ready' && r.getState().result.rows[0] === 'fixed');
  check('status sequence includes loading -> error -> loading -> ready', ['loading', 'error', 'loading', 'ready'].every((s) => changes.includes(s)));
}

console.log('a failure of a superseded request does not mark the newest as failed');
{
  const { r, calls } = make();
  r.request(panels(1)); await sleep(30);
  r.request(panels(2)); await sleep(30); // aborts #1 -> its promise rejects with AbortError
  await sleep(5);
  check('still loading (not error)', r.getState().status === 'loading');
  calls[1].resolve({ rows: ['two'] }); await sleep(5);
  check('ready', r.getState().status === 'ready');
}

console.log('invalidate(): rules changed -> cache dropped, same payload refetched');
{
  const { r, calls } = make();
  r.request(panels(2)); await sleep(30); calls[0].resolve({ rows: ['v1'] }); await sleep(5);
  r.invalidate();
  check('no longer fresh', !r.isFresh());
  const p = r.flush();
  check('refetches the same payload', calls.length === 2);
  calls[1].resolve({ rows: ['v2'] }); await p;
  check('new result applied', r.getState().result.rows[0] === 'v2');
}

console.log('seed(): adopt a result obtained elsewhere (nesting returns the BOM too)');
{
  const { r, calls } = make();
  r.request(panels(3)); // pending debounce
  r.seed(panels(3), { rows: ['seeded'] });
  check('applied immediately', r.isFresh() && r.getState().result.rows[0] === 'seeded');
  await sleep(30);
  check('debounced call never fires (already fresh)', calls.length === 0);
  r.request(panels(4)); r.seed(panels(3), { rows: ['x'] });
  check('seeding an OLD payload does not replace the newest state', r.getState().result.rows[0] === 'seeded');
  r.dispose();
}

console.log('dispose(): cancels timers and in-flight work');
{
  const { r, calls } = make();
  r.request(panels(1)); await sleep(30);
  r.dispose();
  check('in-flight aborted', calls[0].signal.aborted === true);
  r.request(panels(2)); r.dispose(); await sleep(30);
  check('pending debounce cancelled', calls.length === 1);
}

console.log(`\n${pass}/${pass + fail} checks passed.`);
process.exit(fail ? 1 : 0);
