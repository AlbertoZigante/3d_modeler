/**
 * api/requester.js
 *
 * "Latest design wins" request manager for calls that are re-issued on every edit
 * (the BOM today; hardware plan / assembly later). Pure — no DOM, no fetch of its own —
 * so it is tested in node with a fake `call`.
 *
 *   request(payload)   called on EVERY render: cheap + synchronous. Identical payloads
 *                      are a no-op; otherwise the network call is debounced.
 *   flush()            run now (or join the in-flight call for the same payload).
 *                      The promise NEVER rejects: failures land in state.status/error.
 *   seed(payload, r)   adopt a result obtained elsewhere (e.g. nesting returns the BOM too).
 *   invalidate()       drop the cache + applied result key (rules changed): next flush refetches.
 *
 * Guarantees:
 *   - results are cached by payload (small LRU): undo/redo and flip-flopping edits cost no request
 *   - a newer payload ABORTS the superseded in-flight request (signal passed to `call`),
 *     and a late response from it is ignored even if it can't be aborted
 *   - an empty payload never hits the network (`emptyResult` is applied)
 *   - on failure the last good result is KEPT (status 'error'), so exports keep the last data
 *
 * state = { status: 'idle'|'loading'|'ready'|'error', result, appliedKey, error }
 */
export function createLatestRequester({
  call,
  keyOf = (payload) => JSON.stringify(payload),
  isEmpty = (payload) => Array.isArray(payload) && payload.length === 0,
  emptyResult = null,
  debounceMs = 300,
  cacheSize = 16,
  onChange = () => {},
} = {}) {
  if (typeof call !== 'function') throw new TypeError('createLatestRequester: `call` is required');

  const cache = new Map(); // key -> result (insertion order = LRU order)
  let state = { status: 'idle', result: emptyResult, appliedKey: null, error: null };
  let latest = { payload: null, key: null };
  let timer = null;
  let inflight = null; // { key, promise, controller }
  let seq = 0;

  const publish = (patch) => { state = { ...state, ...patch }; onChange(state); };

  function remember(key, result) {
    cache.delete(key);
    cache.set(key, result);
    while (cache.size > cacheSize) cache.delete(cache.keys().next().value);
  }

  function apply(key, result) {
    publish({ status: 'ready', result, appliedKey: key, error: null });
  }

  function request(payload) {
    const key = keyOf(payload);
    if (key === latest.key) return;
    latest = { payload, key };
    clearTimeout(timer);
    timer = setTimeout(flush, debounceMs);
  }

  function flush() {
    clearTimeout(timer);
    timer = null;
    const { payload, key } = latest;
    if (key === null || key === state.appliedKey) return Promise.resolve();
    if (inflight && inflight.key === key) return inflight.promise;

    if (isEmpty(payload)) {
      inflight?.controller.abort();
      inflight = null;
      seq += 1;
      apply(key, emptyResult);
      return Promise.resolve();
    }
    if (cache.has(key)) {
      const hit = cache.get(key);
      remember(key, hit);
      inflight?.controller.abort();
      inflight = null;
      seq += 1;
      apply(key, hit);
      return Promise.resolve();
    }

    inflight?.controller.abort(); // superseded: stop paying for it
    const controller = new AbortController();
    const mySeq = ++seq;
    publish({ status: 'loading', error: null });

    // Executor runs synchronously (the call starts now, not a microtask later); a sync throw becomes a rejection.
    const promise = new Promise((resolve) => resolve(call(payload, { signal: controller.signal })))
      .then((result) => {
        remember(key, result);
        if (mySeq === seq) apply(key, result); // else a newer request superseded this one
      })
      .catch((error) => {
        if (mySeq === seq) publish({ status: 'error', error });
      })
      .finally(() => { if (inflight && inflight.promise === promise) inflight = null; });
    inflight = { key, promise, controller };
    return promise;
  }

  function seed(payload, result) {
    const key = keyOf(payload);
    remember(key, result);
    if (key === latest.key) {
      clearTimeout(timer);
      timer = null;
      inflight?.controller.abort();
      inflight = null;
      seq += 1;
      apply(key, result);
    }
  }

  function invalidate() {
    cache.clear();
    publish({ appliedKey: null });
  }

  function dispose() {
    clearTimeout(timer);
    inflight?.controller.abort();
    inflight = null;
    seq += 1;
  }

  return {
    request,
    flush,
    seed,
    invalidate,
    dispose,
    getState: () => state,
    /** Does the applied result belong to the newest payload? */
    isFresh: () => latest.key !== null && state.appliedKey === latest.key,
    /** Newest payload seen by request() (what an export acts on). */
    peek: () => latest,
  };
}
