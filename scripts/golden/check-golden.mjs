/**
 * scripts/golden/check-golden.mjs
 *
 * Regenerates the golden files into a temp folder and diffs them against
 * fixtures/golden. Exit 1 on any difference.
 *   - Right after dump: proves the dump is DETERMINISTIC.
 *   - Later: a regression test for any change to the JS engine.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const goldenDir = join(root, 'fixtures/golden');
const tmp = mkdtempSync(join(tmpdir(), 'golden-'));

const res = spawnSync(process.execPath, [join(here, 'dump-golden.mjs'), '--out', tmp], { encoding: 'utf8' });
if (res.status !== 0) { console.error(res.stderr || res.stdout); process.exit(1); }

// Legacy bom/nesting oracle, regenerated from the freshly dumped resolved panels + the committed catalog.
const oracle = spawnSync(process.execPath,
  [join(here, 'legacy-oracle.mjs'), '--in', tmp, '--out', tmp, '--catalog', join(goldenDir, 'catalog.json')], { encoding: 'utf8' });
if (oracle.status !== 0) { console.error(oracle.stderr || oracle.stdout); process.exit(1); }

const list = (dir) => readdirSync(dir).flatMap((f) => {
  const p = join(dir, f);
  return statSync(p).isDirectory() ? list(p).map((x) => join(f, x)) : [f];
});

// catalog.json is an INPUT (exported from the API), not generated here.
const expected = new Set(list(goldenDir).filter((f) => f !== 'catalog.json'));
const actual = new Set(list(tmp));
const problems = [];
for (const f of expected) {
  if (!actual.has(f)) problems.push(`missing in regenerated output: ${f}`);
  else if (readFileSync(join(goldenDir, f), 'utf8') !== readFileSync(join(tmp, f), 'utf8')) problems.push(`differs: ${f}`);
}
for (const f of actual) if (!expected.has(f)) problems.push(`not in committed goldens: ${f}`);

rmSync(tmp, { recursive: true, force: true });
if (problems.length) {
  console.error(`GOLDEN CHECK FAILED (${problems.length})\n` + problems.slice(0, 40).map((p) => `  ${p}`).join('\n'));
  process.exit(1);
}
console.log(`GOLDEN CHECK OK — ${expected.size} files identical`);
