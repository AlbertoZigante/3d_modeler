/**
 * engine/hardware.js — HARDWARE / RULE REGISTRY LAYER.
 *
 * This is Phase 3 of the architecture we sketched while building
 * engine/joints.js: `Joint + FeatureJoint -> hardware selection ->
 * fastener/hinge/runner positions`. Geometry (joints.js) answers
 * "where do things meet and how"; this file answers "what hardware
 * goes there, and where exactly do ITS fixings go" — kept separate for
 * the same reason detectJoints and the fastener rules were always
 * meant to be separate (see joints.js's own file header): geometry
 * shouldn't need to know about SKUs, and hardware choices shouldn't
 * need to re-derive geometry.
 *
 * SCOPE AND SOURCING
 * ------------------
 * Hinges and drawer runners are modeled on Blum's actual published
 * catalogue (CLIP top BLUMOTION hinges; TANDEM plus BLUMOTION and
 * LEGRABOX runners) — see the REFERENCES block at the end of this file
 * for exactly which numbers came from where. Carcass panel-to-panel
 * fasteners (for corner_butt/t_butt joints) are NOT a Blum product —
 * Blum is a hinge/runner/lift-system specialist and doesn't publish a
 * confirmat-screw or cam-lock catalogue — so PANEL_CONNECTOR_CATALOG
 * below is explicitly marked as generic/non-Blum rather than
 * misattributed. Where a number isn't a literal Blum spec (e.g. "how
 * many hinges for a 1400mm door"), the doc comment says so and gives
 * it as an industry rule of thumb, not a citation.
 *
 * INPUT CONTRACT
 * --------------
 * Every selector here takes plain numbers/geometry it needs (door
 * height, panel thickness, a FeatureJoint's own p1/p2) — never a raw
 * or resolved panel object — so this file has zero dependency on
 * engine/joints.js's internals beyond the FeatureJoint/Joint SHAPES
 * its callers already have in hand. That keeps this layer testable
 * against plain fixtures, the same way joints.js's own report layer
 * is decoupled from detectJoints itself. buildHardwarePlan below is
 * the one exception — it's the orchestration entry point, so it's the
 * one place in this file that DOES take raw panels and call into
 * joints.js directly (detectJoints, detectFeatureJoints,
 * computeJointExtremities), the same relationship
 * engine/joints.js#buildJointsReport has to detectJoints itself.
 */
import { resolveConstraints } from '../modeller/snap.js';
import { detectJoints, detectFeatureJoints, computeJointExtremities } from './joints.js';

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
// DRAWER RUNNERS — modeled on Blum TANDEM plus BLUMOTION (wood
// drawer side-mount) and LEGRABOX (steel drawer profile)
// ---------------------------------------------------------------
export const RUNNER_CATALOG = [
  {
    id: 'blum-tandem-plus-blumotion-560h',
    brand: 'Blum',
    series: 'TANDEM plus BLUMOTION',
    type: 'wood-drawer-side-mount',
    // Standard TANDEM nominal lengths (mm) — the runner is ordered by
    // NL, not cut to fit. [REF 3]
    nominalLengthsMm: [270, 300, 350, 400, 450, 500, 550, 600, 650],
    // TANDEM's own drawer-side wood-panel range. [REF 3]
    drawerSideThicknessMm: { min: 11, max: 16 },
    // Blum's own spec: inside drawer width = opening width - 42mm —
    // i.e. 21mm clearance per side for the runner itself. [REF 4]
    sideClearanceMm: 21,
    minScrewsPerBracket: 2, // "mount each runner using at least two of the elongated holes" [REF 6]
  },
  {
    id: 'blum-legrabox-c',
    brand: 'Blum',
    series: 'LEGRABOX',
    type: 'steel-profile-side-mount',
    // LEGRABOX C-height nominal lengths (mm), from Blum's own
    // inch/mm table. [REF 7]
    nominalLengthsMm: [270, 350, 400, 450, 500, 550, 600],
    sideClearanceMm: 21, // same opening-width convention as TANDEM
    minScrewsPerBracket: 3, // "minimum 3 screws per bracket" [REF 8]
    fixingScrew: '612TH wood screw', // [REF 7]
  },
];

// Blum publishes sideClearanceMm as an exact spec (42mm opening width
// reduction / 2), so a real built gap should match closely — this
// tolerance only absorbs floating-point noise from geometry math, not
// genuine design differences.
const CLEARANCE_TOLERANCE_MM = 1;

/**
 * Picks a runner model + nominal length for a drawer_slide
 * FeatureJoint pair, from the drawer box's own depth (the slide
 * FeatureJoint's `lengthMm` — see detectFeatureJoints, which derives
 * FeatureJoint's `lengthMm` — see detectFeatureJoints, which derives
 * this straight from the drawer box side panel's own depth extent)
 * and its side-panel thickness.
 *
 * The nominal length picked is the LARGEST catalog length that still
 * fits within the drawer box's actual depth — never longer, since an
 * oversized runner would collide with the cabinet back.
 *
 * Also validates the ACTUAL measured side clearance
 * (`slideJoint.clearanceMm` — see detectFeatureJoints) against the
 * catalog entry's own `sideClearanceMm` spec, within
 * CLEARANCE_TOLERANCE_MM. A drawer box built with the wrong margin
 * (see features/drawer.js#DEFAULT_DRAWER_BOX_WIDTH_MARGIN_MM) has a
 * gap detectJoints already confirmed isn't a physical contact — but
 * "no contact" isn't the same as "the right gap for THIS runner", and
 * without this check a runner would still get recommended for a slot
 * it doesn't actually fit. Falls back to thickness-only matching when
 * `clearanceMm` isn't available (e.g. a hand-built FeatureJoint in a
 * test that skips real geometry) rather than rejecting everything.
 *
 * @param {import('./joints.js').FeatureJoint} slideJoint - kind:'drawer_slide'
 * @param {number} drawerSideThicknessMm
 * @returns {{hardware: object, nominalLengthMm: number} | null}
 */
export function selectRunnerHardware(slideJoint, drawerSideThicknessMm) {
  if (slideJoint.kind !== 'drawer_slide') return null;

  // TANDEM only accepts wood drawer sides in its published thickness
  // range; LEGRABOX is its own steel profile system and isn't
  // constrained by the drawer side's wood thickness the same way, so
  // it's always a fallback candidate.
  const thicknessMatched = RUNNER_CATALOG.filter((r) => {
    if (!r.drawerSideThicknessMm) return true;
    return drawerSideThicknessMm >= r.drawerSideThicknessMm.min && drawerSideThicknessMm <= r.drawerSideThicknessMm.max;
  });
  if (thicknessMatched.length === 0) return null;

  const clearanceMatched = slideJoint.clearanceMm == null
    ? thicknessMatched
    : thicknessMatched.filter((r) => Math.abs(slideJoint.clearanceMm - r.sideClearanceMm) <= CLEARANCE_TOLERANCE_MM);
  if (clearanceMatched.length === 0) return null; // the built gap doesn't match any catalog runner's own clearance spec
  const hardware = clearanceMatched[0];

  const fittingLengths = hardware.nominalLengthsMm.filter((nl) => nl <= slideJoint.lengthMm);
  if (fittingLengths.length === 0) return null; // drawer box too shallow for anything in the catalog
  const nominalLengthMm = Math.max(...fittingLengths);

  return { hardware, nominalLengthMm };
}

// ---------------------------------------------------------------
// PANEL CONNECTORS (corner_butt / t_butt) — GENERIC, NOT BLUM.
// Blum's catalogue doesn't cover carcass-panel fasteners at all; this
// exists so the rule registry has SOMETHING to recommend for the
// joint types detectJoints already classifies, without pretending
// Blum makes confirmat screws or cam locks.
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

function numberItems(items, prefix) {
  return items.map((item, i) => ({ ...item, displayId: `${prefix}${String(i + 1).padStart(3, '0')}` }));
}

/**
 * Ties detectJoints + detectFeatureJoints + this file's own selectors
 * into one pass over a design — the hardware-layer equivalent of
 * engine/joints.js#buildJointsReport: every corner_butt/t_butt Joint
 * gets a panel-connector recommendation, every door_hinge
 * FeatureJoint gets a hinge selection, every drawer_slide FeatureJoint
 * gets a runner selection. Each entry is already cross-referenced
 * against panel name/pieceCode, same convention as buildJointsReport,
 * built from the raw `panels` array directly since — unlike
 * buildJointsReport, which predates FeatureJoint and inherits its
 * precomputed-arrays contract from its original callers (see its own
 * doc comment) — this is a brand-new entry point free to just take
 * `panels` and do the whole pass itself.
 *
 * Anything that doesn't match a catalog entry (a door too thin, a
 * drawer box too shallow, a panel below the connector's minimum
 * thickness) is NOT silently dropped — it's recorded in `unmatched`,
 * the hardware-layer equivalent of findOrphanPanels: a flag worth a
 * person's attention, not a hidden gap.
 *
 * @param {Array} panels - RAW graph (not resolved)
 * @returns {HardwarePlan}
 */
export function buildHardwarePlan(panels) {
  const resolved = resolveConstraints(panels);
  const resolvedById = new Map(resolved.map((r) => [r.id, r]));
  const nameById = new Map(resolved.map((r) => [r.id, r.name || r.id]));
  const pieceCodeById = new Map(panels.map((p) => [p.id, p.pieceCode]));
  const codeOf = (id) => pieceCodeById.get(id) ?? nameById.get(id) ?? id;
  const withNamesAndCodes = (panelAId, panelBId) => ({
    panelA: panelAId,
    panelB: panelBId,
    panelAName: nameById.get(panelAId) ?? '?',
    panelBName: nameById.get(panelBId) ?? '?',
    panelACode: codeOf(panelAId),
    panelBCode: codeOf(panelBId),
  });

  const { joints } = detectJoints(resolved);
  const featureJoints = detectFeatureJoints(panels);

  const hinges = [];
  const runners = [];
  const fasteners = [];
  const unmatched = [];

  featureJoints
    .filter((j) => j.kind === 'door_hinge')
    .forEach((hingeJoint) => {
      const door = resolvedById.get(hingeJoint.panelA);
      const selection = door && selectHingeHardware(hingeJoint, door.thickness);
      if (!selection) {
        unmatched.push({ kind: 'hinge', ...withNamesAndCodes(hingeJoint.panelA, hingeJoint.panelB) });
        return;
      }
      hinges.push({
        kind: 'hinge',
        ...withNamesAndCodes(hingeJoint.panelA, hingeJoint.panelB),
        side: hingeJoint.side,
        hardware: selection.hardware,
        count: selection.count,
        positions: selection.positions,
      });
    });

  featureJoints
    .filter((j) => j.kind === 'drawer_slide')
    .forEach((slideJoint) => {
      const boxPanel = resolvedById.get(slideJoint.panelA);
      const selection = boxPanel && selectRunnerHardware(slideJoint, boxPanel.thickness);
      if (!selection) {
        unmatched.push({ kind: 'runner', ...withNamesAndCodes(slideJoint.panelA, slideJoint.panelB) });
        return;
      }
      runners.push({
        kind: 'runner',
        ...withNamesAndCodes(slideJoint.panelA, slideJoint.panelB),
        side: slideJoint.side,
        hardware: selection.hardware,
        nominalLengthMm: selection.nominalLengthMm,
      });
    });

  joints
    .filter((j) => j.type === 'corner_butt' || j.type === 't_butt')
    .forEach((joint) => {
      const panelA = resolvedById.get(joint.panelA);
      const panelB = resolvedById.get(joint.panelB);
      if (!panelA || !panelB) return;
      const extremities = computeJointExtremities(joint);
      const thinnerMm = Math.min(panelA.thickness, panelB.thickness);
      const selection = selectPanelConnector(joint, extremities, thinnerMm);
      if (!selection) {
        unmatched.push({ kind: 'fastener', jointId: joint.id, jointType: joint.type, ...withNamesAndCodes(joint.panelA, joint.panelB) });
        return;
      }
      fasteners.push({
        kind: 'fastener',
        jointId: joint.id,
        jointType: joint.type,
        ...withNamesAndCodes(joint.panelA, joint.panelB),
        hardware: selection.hardware,
        positions: selection.positions,
      });
    });

  const numberedHinges = numberItems(hinges, 'HG');
  const numberedRunners = numberItems(runners, 'RN');
  const numberedFasteners = numberItems(fasteners, 'FS');

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      hingeCount: numberedHinges.length,
      totalHingeUnits: numberedHinges.reduce((sum, h) => sum + h.count, 0),
      runnerCount: numberedRunners.length,
      fastenerJointCount: numberedFasteners.length,
      totalFastenerCount: numberedFasteners.reduce((sum, f) => sum + f.positions.length, 0),
      unmatchedCount: unmatched.length,
    },
    hinges: numberedHinges,
    runners: numberedRunners,
    fasteners: numberedFasteners,
    unmatched,
  };
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
function summarizePositions(positions) {
  if (positions.length === 1) {
    const p = positions[0];
    return `(${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})`;
  }
  const varyingAxes = ['x', 'y', 'z'].filter((axis) => new Set(positions.map((p) => Math.round(p[axis]))).size > 1);
  if (varyingAxes.length === 1) {
    const axis = varyingAxes[0];
    return `${axis.toUpperCase()}: ${positions.map((p) => Math.round(p[axis])).join(', ')}mm`;
  }
  return positions.map((p) => `(${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})`).join('; ');
}

/**
 * Per-row cell values for exportJointsPdf's THIRD table (Hardware).
 * Unifies hinge/runner/fastener entries — three different shapes from
 * buildHardwarePlan — into one common row, since they share the point
 * of a "what hardware, how many, roughly where" table even though
 * their underlying data differs (a runner has a nominal length, a
 * hinge/fastener has a positions list).
 *
 * @param {object} item - a hinge, runner, or fastener entry from buildHardwarePlan (has `.kind`)
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

/**
 * REFERENCES — where each Blum-specific number above came from.
 * Kept as a plain array (not just comments) so a caller — or a future
 * "show your sources" UI panel — can surface these without parsing
 * doc comments.
 */
export const REFERENCES = [
  { id: 'REF 1', claim: 'CLIP top 110°/125° hinge edge distance (K): 3-6mm', source: 'Cabinet Hinge Boring Dimensions: The Five Numbers', url: 'https://www.sizemarker.com/blog/cabinet-hinge-boring-dimensions' },
  { id: 'REF 2', claim: 'CLIP top 170° hinge edge distance: 3-8mm', source: 'Blum hinge drilling locations (WoodWeb Knowledge Base)', url: 'https://woodweb.com/knowledge_base/Blum_hinge_drilling_locations.html' },
  { id: 'REF 3', claim: 'TANDEM inner-drawer runner: 11-16mm wood drawer-side thickness range; nominal lengths', source: 'Blum catalogue 2022/2023, TANDEM section', url: 'https://publications.blum.com/2022/catalogue/en/450/' },
  { id: 'REF 4', claim: 'TANDEM: inside drawer width = opening width - 42mm', source: 'TANDEM plus BLUMOTION Premium Concealed Runners for Wood Drawers (Blum brochure)', url: 'https://woodworkinstitute.com/wp-content/uploads/2024/07/Blum-Tandem-plus-Blumotion-Brochure.pdf' },
  { id: 'REF 5', claim: '35mm cup diameter / 13mm cup depth; 45mm fixing-hole pattern shared with Hettich', source: 'Cabinet Hinge Boring Dimensions: The Five Numbers', url: 'https://www.sizemarker.com/blog/cabinet-hinge-boring-dimensions' },
  { id: 'REF 6', claim: 'TANDEM: mount each runner using at least two of the elongated holes', source: 'TANDEM plus BLUMOTION 569H/569 installation instructions', url: 'https://s1.img-b.com/build.com/mediabase/specifications/blum/1136097/blum-t65-1600-01-user-guide.pdf' },
  { id: 'REF 7', claim: 'LEGRABOX C-height nominal lengths; 612TH installation wood screw', source: 'Blum LEGRABOX cabinet/drawer profile sets sheet', url: 'https://www.wwhardware.com/media/installation/Blum-legrabox-c-height.pdf' },
  { id: 'REF 8', claim: 'LEGRABOX: minimum 3 screws per bracket', source: 'TANDEM plus BLUMOTION 562F installation instructions', url: 'https://s2.img-b.com/build.com/mediabase/specifications/blum/256205/blum_562f3810b_installation_0.pdf' },
];
