/**
 * tests/contract.test.mjs
 *
 * The modeller side of the API contract (src/api/openapi.json, copied from the
 * api repo by `npm run api:types`):
 *   - toRawPayload's whitelist == RawPanelNode's properties (no drift either way)
 *   - every frozen golden RAW node survives toRawPayload with ZERO fields lost
 *   - required fields are always present, nothing outside the contract is sent
 *   - bounds from the contract are respected by the real fixtures
 *
 * Run with: node tests/contract.test.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { assert, assertEqual, section, report } from './helpers.mjs';
import { toRawPayload, RAW_PANEL_FIELDS, toPayload } from '../src/api/payload.js';

const spec = JSON.parse(readFileSync(new URL('../src/api/openapi.json', import.meta.url), 'utf8'));
const schemas = spec.components.schemas;
const rawSchema = schemas.RawPanelNode;
const goldenDir = new URL('../fixtures/golden/', import.meta.url);
const designs = readdirSync(goldenDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
const rawOf = (d) => JSON.parse(readFileSync(new URL(`${d}/raw.json`, goldenDir), 'utf8'));

section('whitelist == contract', () => {
  const contract = Object.keys(rawSchema.properties).sort();
  const mine = [...RAW_PANEL_FIELDS].sort();
  assertEqual(JSON.stringify(mine), JSON.stringify(contract), 'RAW_PANEL_FIELDS equals RawPanelNode.properties');
  assertEqual(new Set(RAW_PANEL_FIELDS).size, RAW_PANEL_FIELDS.length, 'no duplicate field in the whitelist');
});

section('golden RAW nodes through toRawPayload', () => {
  const required = rawSchema.required ?? [];
  const max = {
    width: rawSchema.properties.width.exclusiveMinimum !== undefined ? rawSchema.properties.width.maximum : Infinity,
    thickness: rawSchema.properties.thickness.maximum,
  };
  let nodes = 0;
  designs.forEach((d) => {
    const raw = rawOf(d);
    const sent = toRawPayload(raw);
    assertEqual(sent.length, raw.length, `${d}: one payload node per panel`);
    raw.forEach((node, i) => {
      nodes++;
      const lost = Object.keys(node).filter((k) => node[k] !== undefined && !(k in sent[i]));
      assertEqual(lost.length, 0, `${d}/${node.id}: no field lost (${lost.join(',')})`);
      required.forEach((k) => assert(k in sent[i], `${d}/${node.id}: required field "${k}" present`));
      assert(node.width <= max.width && node.thickness <= max.thickness, `${d}/${node.id}: within contract bounds`);
    });
    assert(raw.length <= 500, `${d}: within the 500-panel limit`);
  });
  assert(nodes >= 150, `checked ${nodes} golden nodes across ${designs.length} designs`);
});

section('nothing outside the contract leaves the browser', () => {
  const node = { id: 'a', name: 'A', material: 'm', width: 1, height: 1, thickness: 1,
    relations: [{ kind: 'joint' }], resolvedPosition: { x: 1 }, joints: [{ id: 'evil' }], __ui: { selected: true } };
  const [sent] = toRawPayload([node]);
  assertEqual(Object.keys(sent).sort().join(), 'height,id,material,name,thickness,width', 'only whitelisted, defined fields');
  assertEqual(toRawPayload([]).length, 0, 'empty design -> empty payload');
});

section('BOM payload (resolved) unchanged', () => {
  const [p] = toPayload([{ id: 'a', name: 'A', width: 1, height: 2, thickness: 3, material: 'm' }]);
  assertEqual(Object.keys(p).length, 16, 'toPayload still sends its 16 BOM fields');
});

section('contract shape', () => {
  ['/v1/version', '/v1/joints', '/v1/hardware-plan', '/v1/assembly', '/v1/bom', '/v1/nesting'].forEach((p) =>
    assert(p in spec.paths, `contract exposes ${p}`));
  assert(!('HTTPValidationError' in schemas), 'documented 422 is the {code, detail} envelope, not FastAPI default');
  assert('ErrorBody' in schemas, 'ErrorBody is part of the contract');
});

report();
