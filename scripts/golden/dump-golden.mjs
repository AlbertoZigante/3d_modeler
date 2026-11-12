/**
 * scripts/golden/dump-golden.mjs
 *
 * Freezes the CURRENT JS behaviour of the stages being migrated to the API
 * (joints, feature joints, hardware plan, assembly sequence/plan) as golden
 * files, one folder per design:
 *
 *   fixtures/golden/<design>/raw.json            input: raw panel graph
 *   fixtures/golden/<design>/resolved.json       input: resolveConstraints(raw)
 *   fixtures/golden/<design>/joints.json         detectJoints(resolved)
 *   fixtures/golden/<design>/featureJoints.json  detectFeatureJoints(raw)
 *   fixtures/golden/<design>/hardware.json       buildHardwarePlan(raw)
 *   fixtures/golden/<design>/sequence.json       buildAssemblySequence(raw)
 *   fixtures/golden/<design>/assembly.json       buildAssemblyPlan(raw)  (tools + ergonomics)
 *   fixtures/golden/manifest.json                design list + stage list + counts
 *
 * Usage:
 *   node scripts/golden/dump-golden.mjs [--out <dir>] [--only <design>]
 *
 * Each design is built in its own child process (id/pieceCode counters are
 * module-level, so a fresh process = stable ids regardless of fixture order).
 */
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toJson } from './normalize.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const args = process.argv.slice(2);
const opt = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const outDir = resolve(opt('--out') ?? join(root, 'fixtures/golden'));
const one = opt('--one');
const only = opt('--only');

export const STAGES = ['raw', 'resolved', 'joints', 'featureJoints', 'hardware', 'sequence', 'assembly'];

// ------------------------------------------------------------------ child: build one design
if (one) {
  const { ensureMaterialCatalog } = await import('../../tests/helpers.mjs');
  await ensureMaterialCatalog();
  const { DESIGNS } = await import('./builders.mjs');
  const { resolveConstraints } = await import('../../src/modeller/snap.js');
  const { detectJoints, detectFeatureJoints } = await import('../../src/engine/joints.js');
  const { buildHardwarePlan } = await import('../../src/engine/hardware.js');
  const { buildAssemblySequence } = await import('../../src/engine/assembly.js');
  const { buildAssemblyPlan } = await import('../../src/engine/ergonomics.js');

  const raw = DESIGNS[one]();
  // A stage that throws is itself behaviour worth freezing.
  const run = (fn) => { try { return fn(); } catch (e) { return { __error: String(e.message) }; } };
  const resolved = run(() => resolveConstraints(raw));
  const stages = {
    raw,
    resolved,
    joints: run(() => detectJoints(resolved)),
    featureJoints: run(() => detectFeatureJoints(raw)),
    hardware: run(() => buildHardwarePlan(raw)),
    sequence: run(() => buildAssemblySequence(raw)),
    assembly: run(() => buildAssemblyPlan(raw)),
  };
  const dir = join(outDir, one);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  for (const name of STAGES) writeFileSync(join(dir, `${name}.json`), toJson(stages[name]));
  process.exit(0);
}

// ------------------------------------------------------------------ parent: orchestrate
const { DESIGN_NAMES } = await import('./builders.mjs');
const names = only ? [only] : DESIGN_NAMES;
mkdirSync(outDir, { recursive: true });

const summary = {};
for (const name of names) {
  const res = spawnSync(process.execPath, [fileURLToPath(import.meta.url), '--one', name, '--out', outDir], { encoding: 'utf8' });
  if (res.status !== 0) {
    console.error(`FAILED ${name}\n${res.stderr || res.stdout}`);
    process.exit(1);
  }
  const { readFileSync } = await import('node:fs');
  const read = (stage) => JSON.parse(readFileSync(join(outDir, name, `${stage}.json`), 'utf8'));
  const j = read('joints'), h = read('hardware'), a = read('assembly');
  summary[name] = {
    panels: Array.isArray(read('raw')) ? read('raw').length : 0,
    joints: j.joints?.length ?? 'error',
    collisions: j.collisions?.length ?? 'error',
    hardwareItems: h.summary ? h.summary.hingeCount + h.summary.runnerCount + h.summary.fastenerJointCount : 'error',
    steps: a.steps?.length ?? 'error',
  };
  console.log(`ok  ${name.padEnd(24)} ${JSON.stringify(summary[name])}`);
}

if (!only) {
  writeFileSync(join(outDir, 'manifest.json'), toJson({ designs: names, stages: STAGES, summary }));
}
console.log(`\n${names.length} design(s) -> ${outDir}`);
