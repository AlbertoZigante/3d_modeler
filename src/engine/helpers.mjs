/**
 * tests/helpers.mjs
 *
 * Shared bootstrap for the assertion-based .mjs test files in this
 * folder, run directly with `node tests/<file>.mjs` (no test runner /
 * bundler — same "empirical ground truth from the real resolver"
 * approach used for the rest of this project's geometry code).
 *
 * Node has no bundler-provided `import.meta.env.BASE_URL`, and
 * loadMaterialCatalog()'s fetch() call can't reach a local file: URL
 * under plain Node — that's fine and expected here, NOT a bug to work
 * around: modules.js's loadMaterialCatalog() already has a documented
 * fallback (a single 18mm melamine material) for exactly this kind of
 * failure, and one material is all these geometry tests need. This
 * helper just calls it once and swallows the expected console.error
 * so test output stays readable.
 */
import { loadMaterialCatalog } from '../src/modeller/modules.js';

let ready = null;

export function ensureMaterialCatalog() {
  if (!ready) {
    ready = (async () => {
      const originalError = console.error;
      console.error = () => {}; // expected fallback path, see file header
      try {
        await loadMaterialCatalog('file:///dev/null');
      } finally {
        console.error = originalError;
      }
    })();
  }
  return ready;
}

let failures = 0;
let checks = 0;

export function assert(condition, message) {
  checks++;
  if (!condition) {
    failures++;
    console.error(`  FAIL: ${message}`);
  }
}

export function assertEqual(actual, expected, message) {
  assert(actual === expected, `${message} (expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)})`);
}

export function section(name, fn) {
  console.log(`\n${name}`);
  return fn();
}

export function report() {
  console.log(`\n${checks - failures}/${checks} checks passed.`);
  if (failures > 0) {
    console.error(`${failures} FAILURE(S)`);
    process.exitCode = 1;
  }
}
