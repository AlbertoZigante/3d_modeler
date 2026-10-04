/**
 * engine/clearance.js
 *
 * SPATIAL-VALIDITY LAYER, PHASE 2 (see engine/validator.js's own file
 * header for phase 1 — collisions, panel-size, design-limit, and the
 * original per-axis min-gap sweep). Where validator.js answers "does
 * a panel occupy space it shouldn't", this file answers a narrower,
 * harder question: "does a panel — or another piece of hardware —
 * sit somewhere a JOINT or a moving part needs to stay clear, even
 * though nothing is actually touching or overlapping in the AABB
 * sense validator.js already checks?"
 *
 * THE CORE IDEA: RESERVED VOLUMES
 * --------------------------------
 * Every check here reduces to the same shape: compute a set of
 * axis-aligned boxes ("reserved volumes") that some joint, hinge,
 * drawer runner, or handle needs kept clear, tag each with the
 * panel(s) that OWN it (so a panel never gets flagged for blocking its
 * own hardware), then sweep those volumes against (a) every other
 * panel's own AABB and (b) every OTHER reserved volume. Both sweeps
 * reuse shared/geometry.js#boxesOverlap — the exact same 3-axis AABB
 * test engine/joints.js uses for real panel-panel collisions — so
 * there's one geometric primitive for "do these two boxes occupy the
 * same space" in the whole codebase, not a family of near-duplicates.
 *
 * WHY THIS DOESN'T GO THROUGH engine/hardware.js#buildHardwarePlan
 * -------------------------------------------------------------------
 * buildHardwarePlan is the deliberately LAZY, expensive path (see its
 * own call sites in modeller-main.js, both outside renderAll) — full
 * hinge/runner/fastener resolution for the BOM/export panels. This
 * file needed something engine/validator.js could run on EVERY
 * renderAll instead, so it calls the same underlying pure selectors
 * buildHardwarePlan calls (selectHingeHardware, selectRunnerHardware,
 * selectPanelConnector, placeFastenersAlongSeam) directly, per joint/
 * FeatureJoint, the same "cheap, per-item, no full-plan orchestration"
 * pattern engine/joints.js#detectFeatureJoints already established.
 *
 * WHAT'S A HONEST APPROXIMATION HERE (flagged inline, not hidden)
 * ------------------------------------------------------------------
 * - Door swing: this modeller only supports axis-aligned (90°-
 *   multiple) rotations (see modules.js's LOCAL_FACES header note),
 *   so there's no machinery for an intermediate-angle AABB. The swing
 *   volume is the union of the closed and 90°-open boxes (see
 *   features/door.js#computeDoorOpenTransform) — conservative, not a
 *   true swept arc, but never UNDER-covers the quarter-circle.
 * - Fastener driver-access direction: which of the two joined panels
 *   the screw actually goes THROUGH isn't modeled anywhere yet (see
 *   engine/ergonomics.js's own header, which flags the identical open
 *   problem for its orientation scoring) — so the access corridor
 *   straddles BOTH directions along the joint's contact axis rather
 *   than guessing a side.
 * - Drawer pull-out distance: assumed full-extension (travel = the
 *   runner's own seam length), matching the TANDEM/LEGRABOX runners
 *   engine/hardware.js#RUNNER_CATALOG already models — a partial-
 *   extension runner would travel less.
 * - Hinge cup position: placed at the door's own centerline along its
 *   hinge edge (from detectFeatureJoints's p1/p2), not the true
 *   slightly-inset boring point — close enough for a keep-out volume,
 *   not precise enough for actual boring-machine setup.
 * All distances not sourced from engine/hardware.js's own catalogs are
 * plain rules of thumb, named as such below — same convention as that
 * file's own DRIVER_CLEARANCE-style constants.
 */
import { resolveConstraints } from '../modeller/snap.js';
import { detectJoints, detectFeatureJoints, computeJointExtremities } from './joints.js';
import { selectHingeHardware, selectPanelConnector } from './hardware.js';
import { computeWorldAABB, boxesOverlap, localOffsetToWorld, worldHalfExtentsForLocalDims, rotationsMatch, MIN_WALL_GAP_MM } from '../shared/geometry.js';
import { computeDoorOpenTransform } from '../features/door.js';
import { computeHandlePlacement } from '../shared/handle.js';

// ---------------------------------------------------------------
// TUNABLE CONSTANTS — every one not already sourced from
// engine/hardware.js's own catalogs is a rule of thumb, not a spec.
// ---------------------------------------------------------------
export const DRIVER_CLEARANCE_MARGIN_MM = 60; // beyond the fastener's own length: cordless driver body + bit clearance
export const DRIVER_FOOTPRINT_HALF_MM = 20; // lateral half-width of the access corridor around a fastener's own axis
export const MIN_FIXING_SPACING_MM = 25; // min center-to-center distance between two DIFFERENT hardware items' fixings before hole tear-out risk
export const MIN_BORING_WALL_MM = 2; // material that must remain behind a hinge cup boring for it not to punch through
// Generalizes shared/geometry.js#MIN_WALL_GAP_MM (originally box-wall/
// same-axis-slab only) to ANY two facing parallel panels — same
// number, since there's no reason a divider and a door should be held
// to a different minimum than a wall and a shelf. Does NOT replace
// checkMinGap, which is still the right, cheaper check for the
// specific box-relayout case it guards.
export const PARALLEL_PANEL_MIN_GAP_MM = MIN_WALL_GAP_MM;
// Below this gap, two parallel panels are a real touch/near-touch
// joint (engine/joints.js's own nearContactToleranceMm), not a
// spacing violation — mirrored here rather than imported since
// joints.js doesn't export its DEFAULT_OPTIONS.
const NEAR_CONTACT_TOLERANCE_MM = 3;
const MIN_FOOTPRINT_OVERLAP_MM = 5; // ignore a corner graze — mirrors joints.js's own minContactLengthMm
// A panel butted flush against a reserved volume's own boundary (0mm
// overlap) is the NORMAL state — e.g. a door's closed AABB always
// touches its own hinge-side wall — not an intrusion. Real violations
// need at least this much genuine penetration before they're reported,
// same reasoning as engine/joints.js's own contactEpsilonMm.
const MIN_INTRUSION_MM = 0.5;

function displayName(panel) {
  return panel?.name || panel?.id || '?';
}

function pointBox(center, half) {
  return {
    x: [center.x - half.x, center.x + half.x],
    y: [center.y - half.y, center.y + half.y],
    z: [center.z - half.z, center.z + half.z],
  };
}

function unionBox(a, b) {
  const box = {};
  ['x', 'y', 'z'].forEach((axis) => {
    box[axis] = [Math.min(a[axis][0], b[axis][0]), Math.max(a[axis][1], b[axis][1])];
  });
  return box;
}

function boxCenter(box) {
  return {
    x: (box.x[0] + box.x[1]) / 2,
    y: (box.y[0] + box.y[1]) / 2,
    z: (box.z[0] + box.z[1]) / 2,
  };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
}

// Positive => the two intervals overlap by this many mm — same
// definition as joints.js's own private axisOverlap, needed again
// here for findParallelPanelGapViolations, which isn't a reserved-
// volume check at all (no owner, no hardware) so it doesn't go
// through the volumes pipeline below.
function axisOverlapLen(a, b) {
  return Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
}

/**
 * @typedef {Object} ReservedVolume
 * @property {string} id - unique per volume instance
 * @property {string} sourceId - the joint/FeatureJoint id this volume came from (multiple positions along one seam/hinge share a sourceId)
 * @property {'fastenerAccess'|'hingeBoring'|'doorSwing'|'drawerTravel'|'handleClearance'} kind
 * @property {string[]} ownerIds - panel ids this volume BELONGS to; never flagged against these
 * @property {{x:[number,number],y:[number,number],z:[number,number]}} box
 * @property {string} reason - human-readable, for violation messages
 */

// ---------------------------------------------------------------
// VOLUME SOURCES — one function per kind, each independently testable
// against plain fixtures (mirrors engine/hardware.js's own per-
// selector decomposition).
// ---------------------------------------------------------------

// Driver-access corridor at each corner_butt/t_butt joint's fastener
// position — see file header on why this straddles both directions
// along contactAxis instead of picking a side.
function computeFastenerVolumes(resolvedById, joints) {
  const volumes = [];
  joints.forEach((joint) => {
    if (joint.type !== 'corner_butt' && joint.type !== 't_butt') return;
    const a = resolvedById.get(joint.panelA);
    const b = resolvedById.get(joint.panelB);
    if (!a || !b) return;
    const panelThicknessMm = Math.min(a.thickness, b.thickness);
    const connector = selectPanelConnector(joint, computeJointExtremities(joint), panelThicknessMm);
    if (!connector) return;

    connector.positions.forEach((pos, i) => {
      const half = { x: DRIVER_FOOTPRINT_HALF_MM, y: DRIVER_FOOTPRINT_HALF_MM, z: DRIVER_FOOTPRINT_HALF_MM };
      half[joint.contactAxis] = connector.hardware.lengthMm / 2 + DRIVER_CLEARANCE_MARGIN_MM;
      volumes.push({
        id: `${joint.id}:fastener:${i}`,
        sourceId: joint.id,
        kind: 'fastenerAccess',
        ownerIds: [joint.panelA, joint.panelB],
        box: pointBox(pos, half),
        reason: `driver access for the ${connector.hardware.kind.replace('_', ' ')} joining ${displayName(a)} and ${displayName(b)}`,
      });
    });
  });
  return volumes;
}

// Hinge cup boring, one volume per hinge along a door's hinge edge.
function computeHingeVolumes(panels, resolvedById) {
  const volumes = [];
  detectFeatureJoints(panels)
    .filter((fj) => fj.kind === 'door_hinge')
    .forEach((hj) => {
      const door = resolvedById.get(hj.panelA);
      if (!door) return;
      const selection = selectHingeHardware(hj, door.thickness);
      if (!selection) return;
      const { hardware, positions } = selection;
      // `positions` sit exactly ON the hinge line (see joints.js's own
      // p1/p2 construction) — the theoretical hinge axis, not the cup
      // center. Blum's own "K" dimension (edgeDistanceMm) is door-edge
      // to CUP-EDGE, not cup center, so the true center offset inward
      // from that line is edgeDistanceMm + half the cup diameter.
      // Without this, the cup volume straddles the hinge line itself
      // and spuriously overlaps the boundary wall the door is hinged
      // to (see file header — same "not modeled precisely, but keep-
      // out-volume-good-enough" tier as the depth-axis centering below).
      const horizontalAxis = ['x', 'y', 'z'].find((axis) => axis !== hj.axis && axis !== 'y');
      const edgeDistanceMm = (hardware.edgeDistanceMm && hardware.edgeDistanceMm.default) || 5;
      const inwardOffsetMm = edgeDistanceMm + hardware.cupDiameterMm / 2;
      const inwardSign = door.position[horizontalAxis] >= positions[0][horizontalAxis] ? 1 : -1;
      positions.forEach((pos, i) => {
        const center = { ...pos, [horizontalAxis]: pos[horizontalAxis] + inwardSign * inwardOffsetMm };
        const half = { x: hardware.cupDiameterMm / 2, y: hardware.cupDiameterMm / 2, z: hardware.cupDiameterMm / 2 };
        half[hj.axis] = hardware.cupDepthMm / 2;
        volumes.push({
          id: `${hj.id}:cup:${i}`,
          sourceId: hj.id,
          kind: 'hingeBoring',
          ownerIds: [hj.panelA],
          box: pointBox(center, half),
          reason: `${hardware.series} cup boring on ${displayName(door)}`,
        });
      });
    });
  return volumes;
}

// Door swing envelope — see file header for the "union of closed +
// 90°-open" approximation.
function computeDoorSwingVolumes(panels, resolvedById) {
  const volumes = [];
  panels
    .filter((p) => p.isDoor)
    .forEach((doorRaw) => {
      const resolved = resolvedById.get(doorRaw.id);
      if (!resolved) return;
      const doorForTransform = { ...resolved, isDoor: true, hinge: doorRaw.hinge, normalAxis: doorRaw.normalAxis, doorSign: doorRaw.doorSign };
      const openTransform = computeDoorOpenTransform(doorForTransform);
      if (!openTransform) return; // lid-style door (normalAxis 'y') — no vertical hinge edge, see computeDoorOpenTransform's own guard
      const closedBox = computeWorldAABB(resolved);
      const openBox = computeWorldAABB({ ...resolved, position: openTransform.position, rotation: openTransform.rotation });
      // The hinge-side boundary panel is an OWNER too: the open door's
      // own thickness footprint necessarily sits right at the hinge
      // line, against the panel the hinge is mounted to — that's the
      // hinge doing its job, not an intrusion. (Any OTHER panel the
      // swing crosses is still a real violation.)
      const hingePanelId = doorRaw.boundaryIds && doorRaw.boundaryIds[doorRaw.hinge];
      volumes.push({
        id: `${doorRaw.id}:swing`,
        sourceId: `${doorRaw.id}:hinge`,
        kind: 'doorSwing',
        ownerIds: hingePanelId ? [doorRaw.id, hingePanelId] : [doorRaw.id],
        box: unionBox(closedBox, openBox),
        reason: `${displayName(resolved)}'s door swing`,
      });
    });
  return volumes;
}

// Drawer pull-out travel — a single box per drawer front, extended
// from its closed position outward along normalAxis. See file header
// on the full-extension assumption.
function computeDrawerTravelVolumes(panels, resolvedById) {
  const volumes = [];
  const slidesByFront = new Map();
  detectFeatureJoints(panels)
    .filter((fj) => fj.kind === 'drawer_slide')
    .forEach((fj) => {
      const boxPanelRaw = panels.find((p) => p.id === fj.panelA);
      if (!boxPanelRaw) return;
      const frontId = boxPanelRaw.drawerBoxFrontId;
      if (!slidesByFront.has(frontId)) slidesByFront.set(frontId, []);
      slidesByFront.get(frontId).push(fj);
    });

  slidesByFront.forEach((slides, frontId) => {
    const front = resolvedById.get(frontId);
    const frontRaw = panels.find((p) => p.id === frontId);
    if (!front || !frontRaw) return;
    const axis = frontRaw.normalAxis;
    const sign = frontRaw.sign || 1;
    const travelMm = Math.max(...slides.map((s) => s.lengthMm));
    const closedBox = computeWorldAABB(front);
    const openBox = { ...closedBox, [axis]: [closedBox[axis][0] + sign * travelMm, closedBox[axis][1] + sign * travelMm] };
    // Every panel belonging to this drawer's own box (side/bottom/back
    // — not just the two side panels the slide FeatureJoints are
    // keyed on) moves together with the front, so all of them are
    // OWNERS of this travel volume, not intruders into it.
    const boxPanelIds = panels.filter((p) => p.isDrawerBoxPanel && p.drawerBoxFrontId === frontId).map((p) => p.id);
    volumes.push({
      id: `${frontId}:travel`,
      sourceId: `${frontId}:travel`,
      kind: 'drawerTravel',
      ownerIds: [frontId, ...boxPanelIds],
      box: unionBox(closedBox, openBox),
      reason: `${displayName(front)}'s full pull-out travel`,
    });
  });
  return volumes;
}

// Handle standoff — reuses shared/handle.js's own placement instead of
// re-deriving it, so this can never disagree with what's actually
// rendered (see modeller/scene.js's own call to the same function).
function computeHandleVolumes(panels, resolvedById) {
  const volumes = [];
  const fieldsById = new Map();
  panels.filter((p) => p.isDoor).forEach((p) => fieldsById.set(p.id, { isDoor: true, hinge: p.hinge, doorSign: p.doorSign }));
  panels.filter((p) => p.isDrawerFront).forEach((p) => fieldsById.set(p.id, { isDrawerFront: true, sign: p.sign }));

  fieldsById.forEach((fields, id) => {
    const resolved = resolvedById.get(id);
    if (!resolved) return;
    const placement = computeHandlePlacement({ ...resolved, ...fields });
    if (!placement) return;
    const worldOffset = localOffsetToWorld(resolved.rotation, placement.localOffset);
    const center = {
      x: resolved.position.x + worldOffset.x,
      y: resolved.position.y + worldOffset.y,
      z: resolved.position.z + worldOffset.z,
    };
    const localHalf = placement.axis === 'x'
      ? { x: placement.dims.length / 2, y: placement.dims.crossSection / 2, z: placement.dims.protrusion / 2 }
      : { x: placement.dims.crossSection / 2, y: placement.dims.length / 2, z: placement.dims.protrusion / 2 };
    const half = worldHalfExtentsForLocalDims(resolved.rotation, localHalf);
    volumes.push({
      id: `${id}:handle`,
      sourceId: `${id}:handle`,
      kind: 'handleClearance',
      ownerIds: [id],
      box: pointBox(center, half),
      reason: `${displayName(resolved)}'s handle`,
    });
  });
  return volumes;
}

/**
 * Orchestrator: every reserved volume in the current design, from
 * every source above. Pure, resolves the graph itself (same
 * self-sufficiency as detectFeatureJoints) so callers just pass the
 * RAW graph.
 *
 * @param {Array} panels - raw graph
 * @returns {ReservedVolume[]}
 */
export function computeReservedVolumes(panels) {
  const resolved = resolveConstraints(panels);
  const resolvedById = new Map(resolved.map((r) => [r.id, r]));
  const { joints } = detectJoints(resolved);

  return [
    ...computeFastenerVolumes(resolvedById, joints),
    ...computeHingeVolumes(panels, resolvedById),
    ...computeDoorSwingVolumes(panels, resolvedById),
    ...computeDrawerTravelVolumes(panels, resolvedById),
    ...computeHandleVolumes(panels, resolvedById),
  ];
}

// ---------------------------------------------------------------
// VIOLATION SWEEPS — same {type, key, panelIds, message} shape as
// engine/validator.js's own Violation, so modeller-main.js's existing
// toast/dedup path (checkJointWarnings) and ui/warnings.js need no new
// plumbing beyond a message per new `type`.
// ---------------------------------------------------------------

// Any panel (other than the volume's own owners) sitting inside a
// reserved volume — covers "no panel placed where a door/drawer/
// hinge/handle needs to move or be driven".
export function findVolumePanelViolations(resolvedPanels, volumes) {
  const visible = resolvedPanels.filter((p) => !p.hidden);
  const violations = [];
  volumes.forEach((v) => {
    visible.forEach((panel) => {
      if (v.ownerIds.includes(panel.id)) return;
      if (boxesOverlap(v.box, computeWorldAABB(panel), MIN_INTRUSION_MM)) {
        violations.push({
          type: v.kind,
          key: `${v.kind}:${v.id}:${panel.id}`,
          panelIds: [...v.ownerIds, panel.id],
          message: `${displayName(panel)} sits inside the clearance ${v.reason} needs.`,
        });
      }
    });
  });
  return violations;
}

// Two reserved volumes overlapping each other — e.g. a hinge's swing
// arc against a neighboring handle's grip zone, or two hinges/handles
// too close together. Skips pairs that already share an owner (same
// panel's own hardware isn't a conflict with itself).
export function findVolumeVolumeViolations(volumes) {
  const violations = [];
  for (let i = 0; i < volumes.length; i++) {
    for (let j = i + 1; j < volumes.length; j++) {
      const a = volumes[i];
      const b = volumes[j];
      if (a.ownerIds.some((id) => b.ownerIds.includes(id))) continue;
      if (boxesOverlap(a.box, b.box, MIN_INTRUSION_MM)) {
        violations.push({
          type: 'clearanceConflict',
          key: `clearanceConflict:${[a.id, b.id].sort().join('|')}`,
          panelIds: [...new Set([...a.ownerIds, ...b.ownerIds])],
          message: `${a.reason} conflicts with ${b.reason}.`,
        });
      }
    }
  }
  return violations;
}

// Generalizes checkMinGap beyond box-wall/shelf axis-slabs to ANY two
// facing parallel panels (doors, dividers, drawer fronts...) — see
// PARALLEL_PANEL_MIN_GAP_MM's own comment.
export function findParallelPanelGapViolations(resolvedPanels, minGapMm = PARALLEL_PANEL_MIN_GAP_MM) {
  const visible = resolvedPanels.filter((p) => !p.hidden);
  const violations = [];
  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      const a = visible[i];
      const b = visible[j];
      if (!rotationsMatch(a.rotation, b.rotation)) continue;
      const boxA = computeWorldAABB(a);
      const boxB = computeWorldAABB(b);
      let best = null;
      ['x', 'y', 'z'].forEach((axis) => {
        const gap = -axisOverlapLen(boxA[axis], boxB[axis]);
        if (gap <= NEAR_CONTACT_TOLERANCE_MM || gap >= minGapMm) return;
        const others = ['x', 'y', 'z'].filter((ax) => ax !== axis);
        const facing = others.every((ax) => axisOverlapLen(boxA[ax], boxB[ax]) >= MIN_FOOTPRINT_OVERLAP_MM);
        if (!facing) return;
        if (!best || gap < best.gap) best = { gap };
      });
      if (best) {
        violations.push({
          type: 'parallelPanelGap',
          key: `parallelPanelGap:${[a.id, b.id].sort().join('|')}`,
          panelIds: [a.id, b.id],
          message: `${displayName(a)} and ${displayName(b)} are only ${best.gap.toFixed(0)}mm apart — closer than the ${minGapMm}mm minimum.`,
        });
      }
    }
  }
  return violations;
}

// Two DIFFERENT hardware items' fixing points landing too close
// together on a shared panel — e.g. a confirmat screw and a hinge cup
// a few mm apart. Skips pairs from the SAME source (a joint's own
// several fasteners, or one hinge's own single cup) and pairs that
// don't actually share a panel.
export function findFixingProximityViolations(volumes, minSpacingMm = MIN_FIXING_SPACING_MM) {
  const fixings = volumes
    .filter((v) => v.kind === 'fastenerAccess' || v.kind === 'hingeBoring')
    .map((v) => ({ ...v, center: boxCenter(v.box) }));

  const violations = [];
  for (let i = 0; i < fixings.length; i++) {
    for (let j = i + 1; j < fixings.length; j++) {
      const a = fixings[i];
      const b = fixings[j];
      if (a.sourceId === b.sourceId) continue;
      if (!a.ownerIds.some((id) => b.ownerIds.includes(id))) continue;
      const d = distance(a.center, b.center);
      if (d < minSpacingMm) {
        violations.push({
          type: 'fixingProximity',
          key: `fixingProximity:${[a.id, b.id].sort().join('|')}`,
          panelIds: [...new Set([...a.ownerIds, ...b.ownerIds])],
          message: `${a.reason} and ${b.reason} are only ${d.toFixed(0)}mm apart — too close for both fixings.`,
        });
      }
    }
  }
  return violations;
}

// A hinge cup deep enough to punch through (or leave a fragile skin
// on) a thin door.
export function findBoringDepthViolations(panels) {
  const resolved = resolveConstraints(panels);
  const resolvedById = new Map(resolved.map((r) => [r.id, r]));
  const violations = [];

  detectFeatureJoints(panels)
    .filter((fj) => fj.kind === 'door_hinge')
    .forEach((hj) => {
      const door = resolvedById.get(hj.panelA);
      if (!door) return;
      const selection = selectHingeHardware(hj, door.thickness);
      if (!selection) return;
      const remainingMm = door.thickness - selection.hardware.cupDepthMm;
      if (remainingMm < MIN_BORING_WALL_MM) {
        violations.push({
          type: 'boringDepth',
          key: `boringDepth:${hj.id}`,
          panelIds: [hj.panelA],
          message: `${displayName(door)} is ${door.thickness.toFixed(0)}mm thick — the ${selection.hardware.series} cup (${selection.hardware.cupDepthMm}mm deep) would leave under ${MIN_BORING_WALL_MM}mm of material behind it.`,
        });
      }
    });

  return violations;
}

/**
 * Single entry point — folds every check in this file into one array,
 * same shape engine/validator.js#validateDesign already returns, so
 * that file just spreads this in alongside its own.
 *
 * @param {Array} panels - raw graph
 * @param {Array} resolvedPanels - resolveConstraints(panels) output — passed in rather than
 *   recomputed since callers (validator.js) already have it this render.
 * @returns {import('./validator.js').Violation[]}
 */
export function findClearanceViolations(panels, resolvedPanels) {
  const volumes = computeReservedVolumes(panels);
  return [
    ...findVolumePanelViolations(resolvedPanels, volumes),
    ...findVolumeVolumeViolations(volumes),
    ...findParallelPanelGapViolations(resolvedPanels),
    ...findFixingProximityViolations(volumes),
    ...findBoringDepthViolations(panels),
  ];
}
