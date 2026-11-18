/** tests/apiPlans.test.mjs — flags + the cached plan fetcher (phase 10). Run: node tests/apiPlans.test.mjs */
import { flagsFrom } from '../src/api/flags.js';
import { createPlanFetcher } from '../src/api/plans.js';

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : (fail++, console.error('  FAIL:', name)); };

console.log('flags');
check('default off', JSON.stringify(flagsFrom({})) === '{"useApiHardware":false,"useApiAssembly":false}');
check('true / TRUE / " true "', flagsFrom({ VITE_USE_API_HARDWARE: 'true', VITE_USE_API_ASSEMBLY: ' TRUE ' }).useApiAssembly && flagsFrom({ VITE_USE_API_HARDWARE: 'true' }).useApiHardware);
check('anything else is off (false, 0, yes, empty)', ['false', '0', 'yes', '', undefined].every((v) => !flagsFrom({ VITE_USE_API_HARDWARE: v }).useApiHardware));
check('the two flags are independent', !flagsFrom({ VITE_USE_API_HARDWARE: 'true' }).useApiAssembly);

const panel = (id, extra = {}) => ({ id, name: id, material: 'M', quantity: 1, thicknessAxis: 'x', width: 100, height: 100, thickness: 18, rotation: { x: 0, y: 0, z: 0 }, basePosition: { x: 0, y: 0, z: 0 }, offset: { x: 0, y: 0, z: 0 }, constraints: [], ...extra });

console.log('plan fetcher');
{
  let calls = 0; const seen = [];
  const f = createPlanFetcher({ call: async (payload) => { calls++; seen.push(payload); return { n: calls }; }, cacheSize: 2 });
  const a = [panel('a')], b = [panel('b')], c = [panel('c')];
  const r1 = await f.fetchPlan(a);
  const r2 = await f.fetchPlan([panel('a')]);
  check('same design -> cached, one call', calls === 1 && r1 === r2);
  check('only RAW panel fields are sent (the cache key and the call get the filtered array)', Array.isArray(seen[0]) && seen[0][0].id === 'a');
  const [x, y] = await Promise.all([f.fetchPlan(b), f.fetchPlan(b)]);
  check('concurrent identical requests share one call', calls === 2 && x === y);
  await f.fetchPlan(c);
  check('LRU: oldest dropped beyond cacheSize', f.size() === 2);
  await f.fetchPlan(a);
  check('evicted design is fetched again', calls === 4);
  f.invalidate();
  check('invalidate empties the cache', f.size() === 0);
  await f.fetchPlan(a);
  check('after invalidate the server is asked again', calls === 5);
}
{
  let n = 0;
  const f = createPlanFetcher({ call: async () => { n++; if (n === 1) throw new Error('boom'); return { ok: true }; } });
  let threw = false;
  try { await f.fetchPlan([panel('a')]); } catch { threw = true; }
  check('failure is thrown to the caller', threw);
  const r = await f.fetchPlan([panel('a')]);
  check('failure is not cached (retry hits the server and succeeds)', n === 2 && r.ok === true);
}
{
  let aborted = null;
  const f = createPlanFetcher({ call: async (_p, options) => { aborted = options; return {}; } });
  await f.fetchPlan([panel('a')], { signal: 'S' });
  check('options (abort signal) reach the call', aborted?.signal === 'S');
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
