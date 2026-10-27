import { toPayload } from '../src/api/payload.js';

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : (fail++, console.error('FAIL', name)); };

const node = {
  id: 'p1', name: 'Left', pieceCode: 'B1-L', width: 400, height: 700, thickness: 18,
  material: 'Melamine White 18mm', groupId: 'g1', isBoxPanel: true,
  position: { x: 1, y: 2, z: 3 }, rotation: { x: 0, y: 0, z: 0 }, constraints: [{ big: 'junk' }],
};
const [out] = toPayload([node]);

check('keeps geometry/material', out.width === 400 && out.height === 700 && out.thickness === 18 && out.material === node.material);
check('keeps identity', out.id === 'p1' && out.pieceCode === 'B1-L' && out.name === 'Left');
check('drops graph-only fields', !('position' in out) && !('constraints' in out) && !('rotation' in out));
check('defaults missing flags to false', out.isDoor === false && out.isLeg === false && out.isDrawerFront === false);
check('defaults bandedEdges to []', Array.isArray(out.bandedEdges) && out.bandedEdges.length === 0);
check('null (not undefined) for missing groups', out.boxGroupId === null && out.groupId === 'g1');
check('is JSON-serializable', JSON.parse(JSON.stringify(out)).id === 'p1');

console.log(`${pass}/${pass + fail} checks passed.`);
process.exit(fail ? 1 : 0);
