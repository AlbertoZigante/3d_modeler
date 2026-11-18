/**
 * api/plans.js — hardware plan and assembly plan from the API, for the user-triggered exports (joint report,
 * assembly manual). Pure apart from the injected `call`s, so it is tested in node with fakes.
 *
 * What it adds over a bare fetch: the answer for an unchanged design is cached (the person prints the manual,
 * tweaks nothing, prints again), the same in-flight request is shared by concurrent clicks, and everything is
 * dropped when the server's rules version changes (src/api/http.js tracks it) because old answers are then wrong.
 * Failures are NOT cached and are thrown as ApiError — the caller reports them, editing keeps working.
 */
import { toRawPayload } from './payload.js';

export function createPlanFetcher({ call, cacheSize = 4 }) {
  const cache = new Map(); // key -> result (insertion order = LRU)
  const inflight = new Map(); // key -> promise

  async function fetchPlan(rawPanels, options = {}) {
    const payload = toRawPayload(rawPanels);
    const key = JSON.stringify(payload);
    if (cache.has(key)) {
      const hit = cache.get(key);
      cache.delete(key);
      cache.set(key, hit);
      return hit;
    }
    if (inflight.has(key)) return inflight.get(key);
    const promise = (async () => {
      try {
        const result = await call(payload, options);
        cache.set(key, result);
        while (cache.size > cacheSize) cache.delete(cache.keys().next().value);
        return result;
      } finally {
        inflight.delete(key);
      }
    })();
    inflight.set(key, promise);
    return promise;
  }

  return { fetchPlan, invalidate: () => cache.clear(), size: () => cache.size };
}
