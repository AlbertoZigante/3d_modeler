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
