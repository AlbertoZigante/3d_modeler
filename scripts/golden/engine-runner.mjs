/**
 * scripts/golden/engine-runner.mjs — runs the REAL modeller resolver + joint detection on a batch.
 *
 * stdin : JSON array of raw panel graphs  [ [node, ...], ... ]
 * stdout: JSON array, one entry per graph:
 *           { ok: { resolved, joints: { joints, collisions }, featureJoints } }  or  { error: "message" }
 *
 * Used by the API repo's differential fuzz tests (api/tests/test_joints_differential.py): the same random
 * graphs go through this and through the Python port; every number, flag and text must match.
 */
import { readFileSync } from 'node:fs';

const { resolveConstraints } = await import('../../src/modeller/snap.js');
const { detectJoints, detectFeatureJoints } = await import('../../src/engine/joints.js');
const { buildHardwarePlan } = await import('../../src/engine/hardware.js');
const { buildAssemblySequence } = await import('../../src/engine/assembly.js');
const { buildAssemblyPlan } = await import('../../src/engine/ergonomics.js');
const graphs = JSON.parse(readFileSync(0, 'utf8'));
const out = graphs.map((panels) => {
  try {
    const resolved = resolveConstraints(panels);
    const { generatedAt, ...hardware } = buildHardwarePlan(panels);
    return { ok: { resolved, joints: detectJoints(resolved), featureJoints: detectFeatureJoints(panels), hardware,
      sequence: buildAssemblySequence(panels), assembly: buildAssemblyPlan(panels) } };
  } catch (e) {
    return { error: String(e.message) };
  }
});
process.stdout.write(JSON.stringify(out));
