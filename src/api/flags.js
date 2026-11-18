/**
 * api/flags.js — which parts of the business logic run on the server (migration plan phases 5-12).
 *
 *   VITE_USE_API_HARDWARE=true   hardware plan (joint report PDF / JSON) from POST /v1/hardware-plan
 *   VITE_USE_API_ASSEMBLY=true   assembly manual from POST /v1/assembly (structured steps, rendered in the site language)
 *
 * Default OFF: the client-side JS keeps working exactly as before (rollback = flip the flag back). The flags and the
 * JS they guard are deleted in phase 12, once the server path has run stably.
 */
const truthy = (v) => String(v ?? '').trim().toLowerCase() === 'true';

/** Pure (tested): flags from a Vite-style env object. */
export function flagsFrom(env = {}) {
  return { useApiHardware: truthy(env.VITE_USE_API_HARDWARE), useApiAssembly: truthy(env.VITE_USE_API_ASSEMBLY) };
}

// `globalThis.__MODELLER_ENV__`: test seam for node (no Vite there)
const env = import.meta.env ?? globalThis.__MODELLER_ENV__ ?? {};
export const { useApiHardware, useApiAssembly } = flagsFrom(env);
