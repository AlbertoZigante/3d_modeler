/**
 * engine/hardware.js — the LIVE-VALIDATION subset of the hardware rules (since phase 12).
 *
 * The hardware PLAN (which hinge / runner / fastener goes where, numbered and cross-referenced) and everything
 * downstream of it (assembly steps, tools, ergonomics) are computed by the API (POST /v1/hardware-plan, /v1/assembly;
 * api/app/rules/hardware.py). What stays here is only what the editor needs to answer instantly, offline, while the
 * person drags panels — engine/clearance.js's "does the hardware fit?" check — plus the table-row formatting of the
 * server's hardware entries for the PDFs:
 *
 *   HINGE_CATALOG / selectHingeHardware           hinge model + count + positions for a door_hinge feature joint
 *   PANEL_CONNECTOR_CATALOG / selectPanelConnector  confirmat screws along a corner_butt / t_butt seam
 *   formatHardwareTableRow                        one table row for any hardware entry (hinge, runner, fastener)
 *
 * These are a deliberate DUPLICATE of api/app/rules/hardware.py (same numbers); a change there must be mirrored here
 * until live validation itself moves server-side. Sourcing notes (Blum catalogue numbers vs rules of thumb) are in
 * api/app/rules/hardware.py (REFERENCES) and docs/HARDWARE.md.
 */
import { getUnit, MM_PER_INCH } from '../units/index.js';

// ---------------------------------------------------------------
// HINGES — modeled on Blum CLIP top BLUMOTION (concealed, 35mm cup)
// ---------------------------------------------------------------
export const HINGE_CATALOG = [
  {
    id: 'blum-clip-top-blumotion-110',
    brand: 'Blum',
    series: 'CLIP top BLUMOTION',
    openingDeg: 110,
    cupDiameterMm: 35,
    cupDepthMm: 13,
    // "K" dimension: door-edge to cup-edge, NOT cup centre. Blum
    // publishes 3-6mm for its 110°/125° hinges. [REF 1]
    edgeDistanceMm: { min: 3, max: 6, default: 5 },
    screwPatternMm: 45, // fixing-hole spacing straddling the cup — Blum/Hettich share this pattern [REF 5]
    minDoorThicknessMm: 16,
    maxDoorThicknessMm: 24,
  },
  {
    id: 'blum-clip-top-blumotion-170',
    brand: 'Blum',
    series: 'CLIP top BLUMOTION',
    openingDeg: 170,
    cupDiameterMm: 35,
    cupDepthMm: 13,
    // Wide-angle 170° hinge gets a larger published range, 3-8mm. [REF 2]
    edgeDistanceMm: { min: 3, max: 8, default: 5 },
    screwPatternMm: 45,
    minDoorThicknessMm: 16,
    maxDoorThicknessMm: 24,
  },
];

/**
 * How many hinges a door needs, by height. This is NOT a Blum-
 * published number — Blum's planning software (and most hardware
 * guides) use a rule of thumb like this one, but treat it as a
 * sensible default to override via a construction profile later, not
 * a spec to cite.
 */
function hingeCountForHeight(heightMm) {
  if (heightMm <= 900) return 2;
  if (heightMm <= 1600) return 3;
  if (heightMm <= 2200) return 4;
  return 5;
}

/**
 * Positions N hinges along a hinge line (see detectFeatureJoints's
 * `p1`/`p2` on a door_hinge FeatureJoint), inset from both ends. The
 * inset follows the same "edge distance, not centre distance" logic
 * Blum's own boring charts use for the cup itself — here applied to
 * the OUTER hinges along the door's height instead: roughly 1/10 of
 * the door height, clamped to a sane minimum/maximum so a very short
 * or very tall door doesn't get a hinge jammed at the corner or
 * absurdly far from it. Remaining hinges (if any) space evenly between
 * the two end hinges.
 */
function placeAlongLine(p1, p2, count, insetMm) {
  const lengthMm = Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z);
  const lerp = (t) => ({
    x: p1.x + (p2.x - p1.x) * t,
    y: p1.y + (p2.y - p1.y) * t,
    z: p1.z + (p2.z - p1.z) * t,
  });
  if (count <= 1) return [lerp(0.5)];

  const insetT = Math.min(insetMm / lengthMm, 0.5 - 1e-6);
  const positions = [];
  for (let i = 0; i < count; i++) {
    const t = insetT + ((1 - 2 * insetT) * i) / (count - 1);
    positions.push(lerp(t));
  }
  return positions;
}

/**
 * Selects a hinge model and computes where each one goes, from a
 * door_hinge FeatureJoint (see engine/joints.js#detectFeatureJoints)
 * and the door's own thickness.
 *
 * @param {import('./joints.js').FeatureJoint} hingeJoint - kind:'door_hinge'
 * @param {number} doorThicknessMm
 * @returns {{hardware: object, count: number, positions: {x:number,y:number,z:number}[]} | null}
 */
export function selectHingeHardware(hingeJoint, doorThicknessMm) {
  if (hingeJoint.kind !== 'door_hinge') return null;
  const hardware = HINGE_CATALOG.find(
    (h) => doorThicknessMm >= h.minDoorThicknessMm && doorThicknessMm <= h.maxDoorThicknessMm
  );
  if (!hardware) return null; // door too thin/thick for anything in the catalog — flag rather than guess

  const count = hingeCountForHeight(hingeJoint.lengthMm);
  // Door-height inset: ~10% of height, clamped to [80mm, 160mm] — keeps
  // a short door's hinges from crowding the very corner and a tall
  // door's from drifting implausibly far from its ends.
  const insetMm = Math.min(Math.max(hingeJoint.lengthMm * 0.1, 80), 160);
  const positions = placeAlongLine(hingeJoint.p1, hingeJoint.p2, count, insetMm);

  return { hardware, count, positions };
}

// ---------------------------------------------------------------
// PANEL CONNECTORS — generic confirmat screws (NOT a Blum product)
// ---------------------------------------------------------------
export const PANEL_CONNECTOR_CATALOG = [
  {
    id: 'generic-confirmat-7x50',
    brand: null, // deliberately not Blum — see file header
    kind: 'confirmat_screw',
    diameterMm: 7,
    lengthMm: 50,
    minPanelThicknessMm: 16,
    pilotHoleDiameterMm: 4.5,
    clearanceHoleDiameterMm: 7,
    edgeOffsetMm: 50,
    maxSpacingMm: 150,
  },
];

/**
 * Distributes fasteners along a joint's own seam (see
 * engine/joints.js#computeJointExtremities — the same two-endpoints-
 * plus-length reduction used for the joints table), evenly spaced at
 * or under `maxSpacingMm`, inset `edgeOffsetMm` from each end. This is
 * the "joint zone" placement strategy from the original architecture
 * discussion — min edge distance + max spacing -> N fasteners —
 * finally with real seam geometry to run against instead of just a
 * joint type.
 *
 * @param {{p1:{x,y,z}, p2:{x,y,z}, lengthMm:number}} extremities
 * @param {number} edgeOffsetMm
 * @param {number} maxSpacingMm
 * @returns {{x:number,y:number,z:number}[]}
 */
export function placeFastenersAlongSeam({ p1, p2, lengthMm }, edgeOffsetMm, maxSpacingMm) {
  const usableMm = lengthMm - 2 * edgeOffsetMm;
  if (usableMm <= 0) return [{ x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2, z: (p1.z + p2.z) / 2 }]; // seam too short for edge offsets on both ends — single centered fastener

  const gaps = Math.max(1, Math.ceil(usableMm / maxSpacingMm));
  const count = gaps + 1;
  const positions = [];
  for (let i = 0; i < count; i++) {
    const distanceMm = edgeOffsetMm + (usableMm * i) / gaps;
    const t = distanceMm / lengthMm;
    positions.push({
      x: p1.x + (p2.x - p1.x) * t,
      y: p1.y + (p2.y - p1.y) * t,
      z: p1.z + (p2.z - p1.z) * t,
    });
  }
  return positions;
}

/**
 * Recommends a panel connector + fastener positions for a corner_butt
 * or t_butt Joint. Returns null for any other joint type — face_to_face
 * is a glue/clamp joint with no discrete fastener positions to place,
 * edge_to_edge is still `status:'unhandled'` upstream (see joints.js),
 * and near_contact isn't a real joint at all.
 *
 * @param {import('./joints.js').Joint} joint
 * @param {ReturnType<typeof import('./joints.js').computeJointExtremities>} extremities
 * @param {number} panelThicknessMm - the thinner of the two panels at this joint
 * @returns {{hardware: object, positions: {x,y,z}[]} | null}
 */
export function selectPanelConnector(joint, extremities, panelThicknessMm) {
  if (joint.type !== 'corner_butt' && joint.type !== 't_butt') return null;
  const hardware = PANEL_CONNECTOR_CATALOG.find((c) => panelThicknessMm >= c.minPanelThicknessMm);
  if (!hardware) return null;

  const positions = placeFastenersAlongSeam(extremities, hardware.edgeOffsetMm, hardware.maxSpacingMm);
  return { hardware, positions };
}


/**
 * Compacts a list of positions for display: if all but one axis is
 * constant across the whole list (true for every hinge set — all
 * share the same X/Z, only Y varies — and for every fastener seam,
 * where only the seam's own length axis varies), shows just that
 * axis's values instead of a full (x,y,z) triple per point. Falls
 * back to full triples for the rare case (a single point, or points
 * that vary on more than one axis) where that compaction doesn't
 * apply.
 *
 * @param {{x:number,y:number,z:number}[]} positions
 * @returns {string}
 */
// Display only: whole mm, or inches (2 decimals) when the person chose inches.
const pt = (v) => (getUnit() === 'in' ? String(Number((v / MM_PER_INCH).toFixed(2))) : String(Math.round(v)));

function summarizePositions(positions) {
  if (positions.length === 1) {
    const p = positions[0];
    return `(${pt(p.x)}, ${pt(p.y)}, ${pt(p.z)})`;
  }
  const varyingAxes = ['x', 'y', 'z'].filter((axis) => new Set(positions.map((p) => Math.round(p[axis]))).size > 1);
  if (varyingAxes.length === 1) {
    const axis = varyingAxes[0];
    return `${axis.toUpperCase()}: ${positions.map((p) => pt(p[axis])).join(', ')}${getUnit() === 'in' ? ' in' : 'mm'}`;
  }
  return positions.map((p) => `(${pt(p.x)}, ${pt(p.y)}, ${pt(p.z)})`).join('; ');
}

/**
 * Per-row cell values for exportJointsPdf's THIRD table (Hardware).
 * Unifies hinge/runner/fastener entries — three different shapes from
 * the API's hardware plan — into one common row, since they share the point
 * of a "what hardware, how many, roughly where" table even though
 * their underlying data differs (a runner has a nominal length, a
 * hinge/fastener has a positions list).
 *
 * @param {object} item - a hinge, runner, or fastener entry from the API's hardware plan (has `.kind`)
 * @returns {{id:string, kind:string, panelA:string, panelB:string, hardware:string, qty:string, detail:string}}
 */
export function formatHardwareTableRow(item) {
  const brand = item.hardware.brand ?? 'Generic';
  const label = item.hardware.series ?? item.hardware.kind;
  let qty;
  let detail;
  if (item.kind === 'hinge') {
    qty = item.count;
    detail = summarizePositions(item.positions);
  } else if (item.kind === 'runner') {
    qty = 1;
    detail = `NL ${item.nominalLengthMm}mm`;
  } else {
    qty = item.positions.length;
    detail = summarizePositions(item.positions);
  }
  return {
    id: item.displayId,
    kind: item.kind,
    panelA: item.panelACode,
    panelB: item.panelBCode,
    hardware: `${brand} ${label}`,
    qty: String(qty),
    detail,
  };
}
