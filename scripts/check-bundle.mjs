/**
 * scripts/check-bundle.mjs — the production bundle must contain NO server-side business logic (migration plan phase 12).
 *
 *   npm run test:bundle        (builds, then scans dist/)
 *
 * Scans every built .js / .html in dist/ for markers of the rules that now live ONLY in the API: runner hardware,
 * assembly sequencing / ergonomics / tools, nesting and BOM. Minification mangles identifiers but never string
 * literals, so the markers are distinctive strings from those modules (NOT translated step wording: i18n/stepStrings.js
 * is presentation and legitimately in the client). Also fails if the source tree regrows a
 * module of the deleted engines. Add a marker here whenever a rule moves server-side.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const DIST = new URL('../dist/', import.meta.url).pathname;
const SRC = new URL('../src/', import.meta.url).pathname;
if (!existsSync(DIST)) { console.error('dist/ not found: run `vite build` first (npm run test:bundle does)'); process.exit(2); }

const MARKERS = [
  // drawer runners (hardware plan, server)
  ['blum-tandem-plus-blumotion', 'runner catalog'], ['blum-legrabox', 'runner catalog'], ['wood-drawer-side-mount', 'runner catalog'],
  ['steel-profile-side-mount', 'runner catalog'], ['nominalLengthsMm', 'runner catalog'], ['sideClearanceMm', 'runner rule'],
  // assembly sequencing, ergonomics, tools (assembly plan, server)
  ['cluster is not fully connected', 'assembly cluster ordering'], ['orderClusterPanels', 'assembly cluster ordering'],
  ['buildAssemblySequence', 'assembly planner'], ['buildAssemblyPlan', 'assembly planner'], ['buildHardwarePlan', 'hardware planner'],
  ['selectRunnerHardware', 'runner selection'], ['ergonomicStepScore', 'ergonomics'], ['annotateStepsWithTools', 'tools'],
  ['two-person', 'ergonomics rule'], ['recommendedSurface', 'ergonomics rule'], ['singleJointCaution', 'ergonomics rule'],
  ['TWO_PERSON_THRESHOLD', 'ergonomics rule'], ['DEFAULT_MATERIAL_DENSITY', 'ergonomics rule'],
  // BOM + nesting engines (server)
  ['nestCutList', 'nesting engine'], ['guillotine', 'nesting engine'], ['maxrects', 'nesting engine'], ['computeBom', 'BOM engine'],
];

const walk = (d) => readdirSync(d).flatMap((f) => { const p = join(d, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const files = walk(DIST).filter((f) => /\.(js|mjs|html)$/.test(f));
const problems = [];
let bytes = 0;
for (const file of files) {
  const text = readFileSync(file, 'utf8');
  bytes += text.length;
  for (const [marker, why] of MARKERS) {
    const i = text.indexOf(marker);
    if (i >= 0) problems.push(`${file.replace(DIST, 'dist/')}: "${marker}" (${why}) …${text.slice(Math.max(0, i - 30), i + 50).replace(/\s+/g, ' ')}…`);
  }
}

// the deleted engines must not come back as source files
const FORBIDDEN_SRC = ['engine/assembly.js', 'engine/ergonomics.js', 'engine/assembly/sequence.js', 'engine/assembly/stages', 'engine/assembly/clusters.js', 'engine/assembly/roles.js', 'engine/pdfExport.js'];
for (const rel of FORBIDDEN_SRC) if (existsSync(join(SRC, rel))) problems.push(`src/${rel} exists again`);
const allowedAssembly = new Set(['manual']);
if (existsSync(join(SRC, 'engine/assembly'))) for (const f of readdirSync(join(SRC, 'engine/assembly'))) if (!allowedAssembly.has(f)) problems.push(`src/engine/assembly/${f}: only manual/ (rendering) belongs here`);

console.log(`scanned ${files.length} files (${(bytes / 1024).toFixed(0)} KB) for ${MARKERS.length} business-logic markers`);
if (problems.length) { console.error('FAIL: business logic leaked into the client:\n  ' + problems.join('\n  ')); process.exit(1); }
console.log('OK: the bundle has no business logic');
