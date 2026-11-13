/**
 * scripts/golden/legacy-oracle.mjs
 *
 * Runs the ORIGINAL JS BOM + nesting engine (scripts/golden/legacy/, copied from
 * commit f297265^, before they moved to the API) on every frozen design and writes
 *
 *   fixtures/golden/<design>/legacyBom.json      { rows, materialSummary }          == POST /v1/bom
 *   fixtures/golden/<design>/legacyNesting.json  { bom, results, summary }          == POST /v1/nesting
 *
 * Input panels = the VISIBLE resolved panels (what modeller-main.js sends), catalog =
 * fixtures/golden/catalog.json (exported from the API by api/scripts/dump_golden.py).
 * These files are the independent reference the Python BOM/nesting are compared with.
 *
 *   node scripts/golden/legacy-oracle.mjs [--in <dir>] [--out <dir>] [--catalog <file>]
 *     --in   where designs' resolved.json are read from (default fixtures/golden)
 */
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { toJsonExact } from './normalize.mjs';
import { computeBom, computeMaterialSummary, setCatalog } from './legacy/bom.js';
import { nestCutList, summarizeNestingResult } from './legacy/nesting.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : undefined; };
const goldenDir = join(root, 'fixtures/golden');
const inDir = resolve(opt('--in') ?? goldenDir);
const outDir = resolve(opt('--out') ?? goldenDir);
const catalogPath = resolve(opt('--catalog') ?? join(goldenDir, 'catalog.json'));

// Same normalisation as modules.js normalizeApiMaterial: kerfMm omitted unless a valid number.
const catalog = JSON.parse(readFileSync(catalogPath, 'utf8')).map(({ kerfMm, ...rest }) =>
  (Number.isFinite(kerfMm) && kerfMm >= 0 ? { ...rest, kerfMm } : rest));
setCatalog(catalog);

const designs = readdirSync(inDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort();
for (const name of designs) {
  const resolved = JSON.parse(readFileSync(join(inDir, name, 'resolved.json'), 'utf8'));
  const visible = Array.isArray(resolved) ? resolved.filter((p) => !p.hidden) : [];
  const bom = { rows: computeBom(visible), materialSummary: computeMaterialSummary(visible) };
  const results = nestCutList(bom.rows, catalog, {});
  const nesting = { bom, results, summary: summarizeNestingResult(results, catalog) };
  const dir = join(outDir, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'legacyBom.json'), toJsonExact(bom));
  writeFileSync(join(dir, 'legacyNesting.json'), toJsonExact(nesting));
  console.log(`ok  ${name.padEnd(24)} bomRows=${bom.rows.length} sheets=${nesting.summary.totals.sheetsUsed}`);
}
console.log(`\n${designs.length} design(s) -> ${outDir}`);
