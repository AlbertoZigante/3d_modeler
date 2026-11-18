/**
 * scripts/golden/hardware-runner.mjs — runs the REAL hardware selectors on a batch of plain inputs.
 *
 * stdin : JSON array of calls  [ { fn, args }, ... ]  with fn in
 *           selectHingeHardware(hingeJoint, doorThicknessMm) | selectRunnerHardware(slideJoint, sideThicknessMm)
 *           selectPanelConnector(joint, extremities, panelThicknessMm) | placeFastenersAlongSeam(seam, edgeOffsetMm, maxSpacingMm)
 * stdout: JSON array of results (null where the selector returns null)
 *
 * Used by the API repo's api/tests/test_hardware_differential.py to hit every catalog boundary in both languages.
 */
import { readFileSync } from 'node:fs';
import * as hw from '../../src/engine/hardware.js';

const calls = JSON.parse(readFileSync(0, 'utf8'));
const out = calls.map(({ fn, args }) => {
  try {
    return { ok: hw[fn](...args) ?? null };
  } catch (e) {
    return { error: String(e.message) };
  }
});
process.stdout.write(JSON.stringify(out));
