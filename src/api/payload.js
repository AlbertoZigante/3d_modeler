/**
 * api/payload.js — pure (no DOM, no fetch): shapes RESOLVED panels into the
 * request body the API expects (schema: api repo, app/schemas/bom.py Panel).
 */
// Only the fields the server's BOM needs — resolved nodes carry far more.
export function toPayload(panels) {
  return panels.map((p) => ({
    id: p.id,
    name: p.name,
    pieceCode: p.pieceCode,
    width: p.width,
    height: p.height,
    thickness: p.thickness,
    material: p.material,
    bandedEdges: p.bandedEdges || [],
    groupId: p.groupId ?? null,
    boxGroupId: p.boxGroupId ?? null,
    isDoor: !!p.isDoor,
    isPlinthPanel: !!p.isPlinthPanel,
    isLeg: !!p.isLeg,
    isBoxPanel: !!p.isBoxPanel,
    isDrawerFront: !!p.isDrawerFront,
    isDrawerBoxPanel: !!p.isDrawerBoxPanel,
  }));
}

/**
 * Fields of the RAW panel graph the API accepts (schema: api repo,
 * app/schemas/panels.py RawPanelNode — mirrored in src/api/openapi.json).
 * An explicit whitelist on purpose: nothing else leaves the browser (no
 * `relations`/declared joints, no resolved positions, no UI state), and
 * tests/contract.test.mjs fails if this list drifts from the contract.
 */
export const RAW_PANEL_FIELDS = [
  'id', 'name', 'type', 'pieceCode', 'material', 'width', 'height', 'thickness', 'quantity',
  'thicknessAxis', 'rotation', 'basePosition', 'offset', 'hidden', 'bandedEdges', 'groupId', 'boxGroupId',
  'constraints', 'ownership', 'ownershipReason', 'displayColor', 'lockedFields', 'lockedMoveAxes',
  'lockedResizeAxes', 'isBoxPanel', 'isBoxWall', 'isDoor', 'isLeg', 'isPlinthPanel', 'isPlinthRib',
  'isDrawerFront', 'isDrawerBoxPanel', 'hinge', 'normalAxis', 'doorSign', 'doorOpen', 'drawerStackId',
  'drawerCount', 'drawerIndex', 'drawerHeights', 'drawerLayoutMode', 'drawerBoxFrontId', 'drawerBoxRole',
  'drawerBoxSpec', 'axisA', 'axisB', 'sign', 'plinthRole', 'plinthEdgeFit', 'legRole', 'boundaryIds', 'edgeFit',
];

/**
 * RAW nodes -> request body of POST /v1/joints | /v1/hardware-plan | /v1/assembly.
 * Pure. Only whitelisted fields, and only those that are set (undefined is dropped).
 */
export function toRawPayload(rawPanels) {
  return rawPanels.map((node) => {
    const out = {};
    for (const key of RAW_PANEL_FIELDS) if (node[key] !== undefined) out[key] = node[key];
    return out;
  });
}
