/**
 * scripts/golden/resolve-runner.mjs — runs the REAL modeller resolver (src/modeller/snap.js) on a batch.
 *
 * stdin : JSON array of raw panel graphs  [ [node, node, ...], [node, ...], ... ]
 * stdout: JSON array, one entry per graph: { ok: [resolved...] } or { error: "message" }
 *
 * Used by the API repo's differential fuzz test (api/tests/test_resolve_differential.py): the same random
 * constraint graphs go through this and through the Python port, and every number / warning must match.
 *   node scripts/golden/resolve-runner.mjs < graphs.json
 */
import { readFileSync } from 'node:fs';

const { resolveConstraints } = await import('../../src/modeller/snap.js');
const graphs = JSON.parse(readFileSync(0, 'utf8'));
const out = graphs.map((panels) => {
  try { return { ok: resolveConstraints(panels) }; } catch (e) { return { error: String(e.message) }; }
});
process.stdout.write(JSON.stringify(out));
