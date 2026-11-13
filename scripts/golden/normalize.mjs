/**
 * Deterministic JSON: sorted keys, numbers rounded to 3 decimals, -0 -> 0,
 * Set -> sorted array, Map -> object, volatile fields dropped.
 */
const VOLATILE = new Set(['generatedAt']);
const r3 = (n) => (Number.isFinite(n) ? (Math.round(n * 1000) / 1000 || 0) : String(n));

export function normalize(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return r3(value);
  if (typeof value !== 'object') return value;
  if (value instanceof Set) return [...value].map(normalize).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  if (value instanceof Map) return normalize(Object.fromEntries(value));
  if (Array.isArray(value)) return value.map(normalize);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (VOLATILE.has(key) || typeof value[key] === 'function') continue;
    out[key] = normalize(value[key]);
  }
  return out;
}

export const toJson = (value) => JSON.stringify(normalize(value), null, 2) + '\n';

/**
 * Same as normalize/toJson but keeps 9 decimals instead of 3. Used for the legacy
 * bom/nesting oracle, whose numbers (areas in m², costs) are compared with a 1e-6
 * tolerance by the API tests — 3-decimal rounding would be too coarse for that.
 */
const r9 = (n) => (Number.isFinite(n) ? (Math.round(n * 1e9) / 1e9 || 0) : String(n));
export function normalizeExact(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') return r9(value);
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(normalizeExact);
  const out = {};
  for (const key of Object.keys(value).sort()) {
    if (VOLATILE.has(key) || typeof value[key] === 'function') continue;
    out[key] = normalizeExact(value[key]);
  }
  return out;
}
export const toJsonExact = (value) => JSON.stringify(normalizeExact(value), null, 2) + '\n';
