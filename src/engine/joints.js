/**
 * engine/joints.js — PHYSICAL JOINT DETECTION.
 *
 * This is the geometry layer of the connections architecture: it
 * answers "where do these resolved panels actually touch, and what
 * kind of contact is it", and nothing else. It never decides what
 * hardware a joint needs (that's a future engine/fasteners.js reading
 * a construction profile) and it never decides whether two touching
 * panels are MEANT to be joined (that's tools/attachTool.js's explicit
 * user-confirmation flow, or a feature's own declareJoint() call at
 * creation time). See the joints design notes for the full rationale;
 * the short version:
 *
 *   geometric contact  !=  physical connection
 *
 * A panel's `attachedTo`/`spansBetween` CONSTRAINTS (snap.js) mean
 * "keep this geometric relationship true" — they say nothing about
 * whether the panels are screwed together. This file sits entirely
 * downstream of constraint resolution and never touches constraints
 * itself.
 *
 * TWO ENTRY POINTS, ONE SHARED CORE
 * ----------------------------------
 * detectJoints(resolvedPanels) — batch scan. Pure function: resolved
 *   panels in, Joint[] + Collision[] out. No feature/UI awareness, no
 *   mutation, nothing stored. This is what a future "scan the whole
 *   design" action would call, and what the phase-by-phase test suite
 *   (tests/joints.test.mjs) validates directly against real
 *   addBox()/addShelf() output.
 *
 * classifyJoint(panels, nodeAId, faceA, nodeBId, faceB) — single-pair
 *   check for tools/attachTool.js's manual flow: the user has already
 *   picked two specific faces, so this resolves the graph itself, then
 *   asks "do THESE two faces actually touch, and what would that
 *   joint be" instead of scanning everything. Returns { type, params }
 *   or null (attachTool.js shows "not a recognizable joint" on null).
 *
 * declareJoint(nodeAId, faceA, nodeBId, faceB, type, params) — pure
 *   builder for the RELATION object attachTool.js (and, later, box/
 *   shelf/drawer/door at creation time) attaches to a node's own
 *   `relations` array. Deliberately a SEPARATE array from `constraints`
 *   — see the file-header note above. Building the object here (not
 *   inline in the tool) keeps every declared joint, manual or
 *   automated, structurally identical.
 *
 * Both entry points share the same per-axis contact test
 * (evaluateAxisContact) so "does an automatic scan find this joint"
 * and "does confirming these two exact faces find this joint" can
 * never quietly disagree with each other.
 *
 * JOINT TAXONOMY
 * --------------
 * Every panel here is an axis-aligned box (general angled joinery is
 * unsupported by the resolver itself — see modules.js's LOCAL_FACES
 * doc), so a joint reduces to: two AABBs adjacent along ONE axis (the
 * "contact axis" / normal), with their footprint overlapping on the
 * other two. What differs between joint TYPES is which of the two
 * panels' THICKNESS axis (see modules.js#classifyFacesByThickness —
 * "flat" there is this file's "broad face") lines up with that
 * contact axis:
 *
 *   face_to_face   both panels' thickness axis == contact axis.
 *                  Broad face against broad face. Rare in single-box
 *                  furniture; common for doubled panels or a shared
 *                  divider between two box modules.
 *
 *   corner_butt    exactly one panel's thickness axis == contact axis
 *   t_butt         (the "flat"/broad panel); the other panel meets it
 *                  edge-first. Same underlying contact shape — these
 *                  two differ only in WHERE on the flat panel's own
 *                  footprint the contact sits: at its boundary
 *                  (corner_butt — e.g. Bottom meeting Left at the
 *                  box's own corner) or mid-span, away from every edge
 *                  of the flat panel (t_butt — e.g. a shelf meeting
 *                  Left partway up). See classifyButtGeometry below
 *                  for exactly how that's decided; fastener spacing
 *                  rules will eventually care about this distinction
 *                  (a t-joint wants symmetric spacing along the span
 *                  AND clearance from the flat panel's own edges; a
 *                  corner only needs the edge offset).
 *
 *   edge_to_edge   NEITHER panel's thickness axis == contact axis —
 *                  two edge (non-broad) faces meeting with no broad
 *                  face touching either one. Not produced by plain
 *                  box/shelf construction; will start appearing once
 *                  face frames/trim exist. Detected but deliberately
 *                  left with status:'unhandled' — there's no real
 *                  construction to test sub-classification against
 *                  yet (see tests/joints.test.mjs Phase 5 note).
 *
 *   near_contact   panels within nearContactToleranceMm of each other
 *                  along the contact axis but not actually touching.
 *                  Reported as its own type rather than sub-classified
 *                  — mainly useful right now for catching constraint
 *                  bugs (an off-by-thickness / wrong-axis spansBetween)
 *                  during testing; later becomes a real "intentional
 *                  reveal gap" signal.
 *
 * True 3D interpenetration (a genuine modelling bug: panels
 * overlapping in space, not touching at a boundary) is NOT a joint —
 * see the collision check in detectJoints. Conflating the two would
 * feed garbage into every downstream fastener rule.
 *
 * WHAT'S OUT OF SCOPE HERE, ON PURPOSE
 * -------------------------------------
 * - True lap/notch/cross joints (interpenetrating material removal)
 *   aren't representable in the current panel model — nothing to
 *   detect until that's a real geometry feature.
 * - A pair overlapping on exactly one axis by more than
 *   contactEpsilonMm, but not on all three (so it's not a full
 *   collision either), is neither a joint nor a reported collision —
 *   it's simply skipped. This is a real gap (a two-axis-only overlap
 *   generally shouldn't happen from legitimate constraint-driven
 *   geometry) but a deliberately narrow first pass; revisit if the
 *   test suite ever produces one from real box/shelf/door/drawer
 *   output.
 */
import { computeWorldHalfExtents, getAlignedAxis, LOCAL_FACES } from '../modeller/modules.js';
import { facingFace } from '../shared/geometry.js';
import { resolveConstraints } from '../modeller/snap.js';
import { dimFieldForAxis } from '../shared/frontFit.js';

export const JOINT_TYPES = ['face_to_face', 'corner_butt', 't_butt', 'edge_to_edge', 'near_contact'];
export const FEATURE_JOINT_KINDS = ['door_hinge', 'drawer_slide'];

const AXES = ['x', 'y', 'z'];
const OTHER_AXES = { x: ['y', 'z'], y: ['x', 'z'], z: ['x', 'y'] };

// All distances in mm. Deliberately generous but not sloppy — the
// resolver produces exact numbers (see snap.js's own header comment),
// so "touching" here means "computed as touching", not "looks close
// in the viewport". See the file-header taxonomy note for what each
// one gates.
const DEFAULT_OPTIONS = {
  contactEpsilonMm: 0.05, // within this of zero gap counts as a true, flush touch
  nearContactToleranceMm: 3, // beyond touching but still worth flagging as near_contact
  minContactLengthMm: 5, // ignore a footprint overlap this small — a corner graze, not a real contact face
  boundaryToleranceMm: 0.5, // used only by classifyButtGeometry, below
  collisionMinMm: 1, // real overlap on EVERY axis beyond this = interpenetration, not a joint
};

/**
 * @typedef {Object} Joint
 * @property {string} id
 * @property {string} panelA
 * @property {string} panelB
 * @property {string} faceA - local face of panelA pointing at panelB (see modules.js LOCAL_FACES)
 * @property {string} faceB - local face of panelB pointing at panelA
 * @property {'face_to_face'|'corner_butt'|'t_butt'|'edge_to_edge'|'near_contact'} type
 * @property {'classified'|'unhandled'} status
 * @property {'x'|'y'|'z'} contactAxis
 * @property {number} contactPosition - world coordinate along contactAxis where the contact sits (see evaluateAxisContact)
 * @property {Object} overlap - contact footprint rectangle on the two non-contact axes, e.g. { y: [min,max], z: [min,max] }
 * @property {number} gap - 0 for a true touch, >0 mm for near_contact
 * @property {boolean} sameGroup - both panels share a groupId (informational only — see Phase 6 note in tests/joints.test.mjs re: cross-group policy, not decided here)
 */

/**
 * @typedef {Object} Collision
 * @property {string} panelA
 * @property {string} panelB
 * @property {{x:number,y:number,z:number}} overlapMm - real overlap length on every axis
 */

// A resolved node's own world AABB, expressed as [min,max] per axis.
// computeWorldHalfExtents already accounts for rotation (a Vertical
// panel's `width` runs along world Z, not X, etc.) — this file never
// re-derives that, it's the one source of truth (modules.js).
function computeAABB(resolved) {
  const half = computeWorldHalfExtents(resolved);
  const box = {};
  AXES.forEach((axis) => {
    box[axis] = [resolved.position[axis] - half[axis], resolved.position[axis] + half[axis]];
  });
  return box;
}

// Positive => the two intervals overlap by this many mm.
// Zero => they touch exactly, edge to edge.
// Negative => they're separated by |value| mm.
function axisOverlap(a, b) {
  return Math.min(a[1], b[1]) - Math.max(a[0], b[0]);
}

/**
 * Decides corner_butt vs t_butt for an edge_to_face contact (see the
 * file-header taxonomy note). `flatBox` is the AABB of whichever
 * panel's thickness axis equals the contact axis (the broad-face
 * owner); `overlapRect` is the contact footprint on the two remaining
 * axes.
 *
 * The rule: for each footprint axis, if the contact spans that axis's
 * FULL length on the flat panel, that axis carries no information
 * (both a corner joint and a t-joint commonly run the full depth of a
 * cabinet, say — that alone doesn't distinguish them). Only an axis
 * where the contact is a PARTIAL slice of the flat panel is
 * diagnostic: if that slice touches one of the flat panel's own
 * boundary edges, this is a corner; if it sits away from both edges,
 * it's a mid-span T. If every footprint axis fully spans the flat
 * panel (edge case: the two panels' footprints coincide exactly on
 * both remaining axes), there's no mid-span evidence at all, so this
 * defaults to corner_butt.
 */
function classifyButtGeometry(overlapRect, flatBox, footprintAxes, tolerance) {
  let sawPartialAxis = false;
  for (const axis of footprintAxes) {
    const flatLen = flatBox[axis][1] - flatBox[axis][0];
    const [oMin, oMax] = overlapRect[axis];
    const overlapLen = oMax - oMin;
    const spansFullFlatPanel = Math.abs(overlapLen - flatLen) <= tolerance;
    if (spansFullFlatPanel) continue; // doesn't discriminate — see doc comment above

    sawPartialAxis = true;
    const touchesMin = Math.abs(oMin - flatBox[axis][0]) <= tolerance;
    const touchesMax = Math.abs(oMax - flatBox[axis][1]) <= tolerance;
    if (touchesMin || touchesMax) return 'corner_butt';
  }
  return sawPartialAxis ? 't_butt' : 'corner_butt';
}

/**
 * The shared per-axis contact test both entry points below use.
 * `axis` is the candidate contact NORMAL — the axis along which the
 * two panels are adjacent, not the axis their footprint overlaps on.
 * Returns null if this axis isn't a plausible contact plane between
 * these two boxes at all (too far apart, or footprint overlap too
 * small to count as a real contact face rather than a corner graze —
 * see minContactLengthMm). Otherwise returns everything detectJoints/
 * classifyJoint need EXCEPT the face names and panel ids, which their
 * callers already have context for.
 */
function evaluateAxisContact(resolvedA, resolvedB, boxA, boxB, axis, opts) {
  const gap = -axisOverlap(boxA[axis], boxB[axis]);
  if (gap < -opts.contactEpsilonMm || gap > opts.nearContactToleranceMm) return null;

  const footprintAxes = OTHER_AXES[axis];
  const overlapRect = {};
  for (const a of footprintAxes) {
    const overlapLen = axisOverlap(boxA[a], boxB[a]);
    if (overlapLen < opts.minContactLengthMm) return null; // grazes at a corner/edge only
    overlapRect[a] = [Math.max(boxA[a][0], boxB[a][0]), Math.min(boxA[a][1], boxB[a][1])];
  }

  const isTouching = gap <= opts.contactEpsilonMm;
  let type;
  let status = 'classified';

  if (!isTouching) {
    type = 'near_contact';
  } else {
    const flatA = resolvedA.thicknessAxis === axis;
    const flatB = resolvedB.thicknessAxis === axis;
    if (flatA && flatB) {
      type = 'face_to_face';
    } else if (flatA || flatB) {
      const flatBox = flatA ? boxA : boxB;
      type = classifyButtGeometry(overlapRect, flatBox, footprintAxes, opts.boundaryToleranceMm);
    } else {
      type = 'edge_to_edge';
      status = 'unhandled'; // see file-header taxonomy note
    }
  }

  // World coordinate along `axis` where the contact actually sits —
  // the midpoint between the two panels' nearest faces on this axis.
  // For a true touch this IS the shared boundary plane (both faces
  // sit at essentially the same value, so their midpoint is that
  // value); for a near_contact it's the midpoint of the small gap
  // between them, which is the only sensible single number to report
  // for "where" a not-quite-touching pair sits.
  const contactPosition = (Math.max(boxA[axis][0], boxB[axis][0]) + Math.min(boxA[axis][1], boxB[axis][1])) / 2;

  return { type, status, overlap: overlapRect, gap: Math.max(gap, 0), contactPosition, footprintAxes };
}

/**
 * Batch scan: every pair of resolved panels, every candidate contact
 * axis, keeping the tightest valid one per pair (two panels can only
 * legitimately share ONE flush contact plane — the other two axes are
 * where that plane's footprint lives, never a second competing
 * normal). Pure function — no mutation, nothing stored, safe to call
 * on every resolve the same way bom.js's computeBom() is.
 *
 * @param {Array} resolvedPanels - output of snap.js#resolveConstraints
 * @param {Partial<typeof DEFAULT_OPTIONS>} [options]
 * @returns {{ joints: Joint[], collisions: Collision[] }}
 */
export function detectJoints(resolvedPanels, options = {}) {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const visible = resolvedPanels.filter((p) => !p.hidden); // a hidden wall (e.g. addBox's default-hidden Front) has no physical presence to joint against
  const boxes = new Map(visible.map((p) => [p.id, computeAABB(p)]));

  const joints = [];
  const collisions = [];

  for (let i = 0; i < visible.length; i++) {
    for (let j = i + 1; j < visible.length; j++) {
      const A = visible[i];
      const B = visible[j];
      const boxA = boxes.get(A.id);
      const boxB = boxes.get(B.id);

      const overlaps = {};
      AXES.forEach((axis) => { overlaps[axis] = axisOverlap(boxA[axis], boxB[axis]); });

      // Real 3D interpenetration: positive overlap on every axis at
      // once. A modelling error, not a joint — see file-header note on
      // why this is routed to a separate channel instead of Joint[].
      if (AXES.every((axis) => overlaps[axis] >= opts.collisionMinMm)) {
        collisions.push({
          panelA: A.id,
          panelB: B.id,
          overlapMm: { x: overlaps.x, y: overlaps.y, z: overlaps.z },
        });
        continue;
      }

      let best = null;
      for (const axis of AXES) {
        const result = evaluateAxisContact(A, B, boxA, boxB, axis, opts);
        if (!result) continue;
        if (!best || result.gap < best.result.gap) best = { axis, result };
      }
      if (!best) continue;

      const { axis, result } = best;
      joints.push({
        id: `${A.id}:${B.id}:${axis}`,
        panelA: A.id,
        panelB: B.id,
        faceA: facingFace(A, axis, B),
        faceB: facingFace(B, axis, A),
        type: result.type,
        status: result.status,
        contactAxis: axis,
        contactPosition: result.contactPosition,
        overlap: result.overlap,
        gap: result.gap,
        sameGroup: !!A.groupId && A.groupId === B.groupId,
      });
    }
  }

  return { joints, collisions };
}

/**
 * Single-pair check for tools/attachTool.js's manual flow: the user
 * has already picked one face on each of two panels. This resolves
 * the graph itself (attachTool.js only has the raw `panels` array),
 * then verifies the picked faces are actually the ones facing each
 * other (rejecting, say, "right" picked on both panels, which can't
 * be a real facing pair) before running the exact same contact test
 * detectJoints uses. Returning null on any failure — wrong axis,
 * faces don't actually face each other, or no real contact — is what
 * drives attachTool.js's "not a recognizable joint, try a different
 * pair" message.
 *
 * @param {Array} panels - raw graph (unresolved) — this resolves it internally
 * @param {string} nodeAId
 * @param {string} faceA - one of modules.js's LOCAL_FACES names, as picked on panel A
 * @param {string} nodeBId
 * @param {string} faceB - as picked on panel B
 * @param {Partial<typeof DEFAULT_OPTIONS>} [options]
 * @returns {{ type: string, params: Object } | null}
 */
export function classifyJoint(panels, nodeAId, faceA, nodeBId, faceB, options = {}) {
  if (!LOCAL_FACES[faceA] || !LOCAL_FACES[faceB]) return null;
  const opts = { ...DEFAULT_OPTIONS, ...options };

  const resolved = resolveConstraints(panels);
  const A = resolved.find((r) => r.id === nodeAId);
  const B = resolved.find((r) => r.id === nodeBId);
  if (!A || !B || A.hidden || B.hidden) return null;

  const alignedA = getAlignedAxis(A.rotation, faceA);
  const alignedB = getAlignedAxis(B.rotation, faceB);
  if (!alignedA || !alignedB || alignedA.axis !== alignedB.axis) return null;
  const axis = alignedA.axis;

  // The picked faces must be the ones actually facing each other, not
  // just any two faces that happen to share an axis (e.g. both panels'
  // "right" face) — otherwise a mis-click would get recorded as a
  // joint on the wrong physical face.
  if (facingFace(A, axis, B) !== faceA || facingFace(B, axis, A) !== faceB) return null;

  const boxA = computeAABB(A);
  const boxB = computeAABB(B);
  const result = evaluateAxisContact(A, B, boxA, boxB, axis, opts);
  if (!result) return null;

  return {
    type: result.type,
    params: {
      contactAxis: axis,
      contactPosition: result.contactPosition,
      overlap: result.overlap,
      gap: result.gap,
      status: result.status,
    },
  };
}

/**
 * Pure builder for the relation object tools/attachTool.js attaches to
 * panelA's `relations` array on confirm. Deliberately just assembles
 * data — no lookup, no validation (classifyJoint already did that),
 * no id-generation side effects beyond nextId() itself, which is
 * side-effect-free bookkeeping identical to how constraints get their
 * ids (see modules.js#nextConstraintId). Kept separate from
 * `constraints` — see this file's header note on why a joint isn't a
 * constraint.
 *
 * @param {string} nodeAId
 * @param {string} faceA
 * @param {string} nodeBId
 * @param {string} faceB
 * @param {string} type - one of JOINT_TYPES
 * @param {Object} params - the `params` object classifyJoint returned
 * @returns {Object} relation
 */
export function declareJoint(nodeAId, faceA, nodeBId, faceB, type, params) {
  return {
    id: nextJointId(),
    kind: 'joint', // future-proofs the `relations` array for a non-joint relation type later, the same way `constraints` distinguishes spansBetween/attachedTo
    jointType: type,
    from: { node: nodeAId, face: faceA },
    to: { node: nodeBId, face: faceB },
    params: { ...params },
    // Mirrors the design doc's Connection.locked: a future geometry-
    // change validity pass can flip this to flag a joint whose panels
    // no longer actually touch, rather than silently deleting a
    // user-confirmed connection.
    locked: false,
  };
}

let jointIdCounter = 1;
function nextJointId() {
  return `j${jointIdCounter++}`;
}

// ---------------------------------------------------------------
// FEATURE JOINTS — door hinges and drawer slides. These are NOT
// AABB-contact joints and deliberately don't go through detectJoints
// above at all: a hinge side and a drawer-slide pairing are
// CONSTRUCTION INTENT the feature itself already declared at creation
// time (door.hinge + door.boundaryIds; a drawer box panel's
// drawerBoxFrontId/drawerBoxRole + its front's own boundaryIds) — not
// something to (re)discover from geometry. This is exactly the
// "geometric contact != physical connection" distinction this file's
// own header leads with, showing up in its most literal form: a
// drawer box's left/right panels typically DON'T even touch their
// carcass boundary panels (there's a real clearance gap for the slide
// hardware — see features/drawer.js's widthMarginMm), so
// detectJoints's own contact test would correctly find nothing there
// at all. A door's hinge edge, by contrast, usually IS geometrically
// close to its boundary panel — but relying on that (near_contact,
// say) would be fragile against whatever reveal gap a given edgeFit
// happens to produce, where the stored `hinge` field is exact and
// unambiguous regardless.
//
// Because of that, a FeatureJoint has its own, smaller schema — no
// contactAxis/overlap/gap (there's no AABB contact to describe), just
// which two panels are mechanically associated, which side, and the
// 3D line (two endpoints + length) a hinge or a slide mechanism would
// actually run along. That line is real, useful geometry (a hinge
// needs positions along it; a slide's length matters for choosing
// hardware) even though it isn't derived from AABB contact.
//
// IMPORTANT: unlike detectJoints, this reads FEATURE FLAGS (isDoor,
// hinge, boundaryIds, drawerBoxFrontId, drawerBoxRole, normalAxis)
// from the RAW `panels` array, not from resolved output — the same
// "resolveConstraints doesn't reliably carry an arbitrary custom
// field through" reasoning buildJointsReport's own doc comment gives
// for pieceCode applies equally here. Resolved data is used ONLY for
// what it's actually for: position, rotation, and dimensions.
//
// @param {Array} panels - RAW graph (not resolved) — this resolves
//   internally for geometry, same pattern as classifyJoint above
// @returns {FeatureJoint[]}
/**
 * @typedef {Object} FeatureJoint
 * @property {string} id
 * @property {'door_hinge'|'drawer_slide'} kind
 * @property {string} panelA - the door, or the drawer box's left/right panel
 * @property {string} panelB - the carcass/boundary panel it's mechanically associated with
 * @property {'left'|'right'} side
 * @property {'x'|'y'|'z'} axis - the front's normalAxis (informational)
 * @property {{x:number,y:number,z:number}} p1
 * @property {{x:number,y:number,z:number}} p2
 * @property {number} lengthMm
 * @property {number} [clearanceMm] - drawer_slide only: the actual measured gap between the box side and its carcass boundary panel, along the width axis (perpendicular to the slide's own run) — see detectFeatureJoints's own doc comment on why this exists
 */
export function detectFeatureJoints(panels) {
  const resolved = resolveConstraints(panels);
  const resolvedById = new Map(resolved.map((r) => [r.id, r]));
  const featureJoints = [];

  // --- Doors: hinge side -> the boundary panel on that side ---------
  panels
    .filter((p) => p.isDoor && p.boundaryIds && p.hinge && p.normalAxis && p.normalAxis !== 'y') // normalAxis 'y' (a lid-style door) has no vertical hinge edge — mirrors computeDoorOpenTransform's own guard
    .forEach((doorRaw) => {
      const door = resolvedById.get(doorRaw.id);
      const hingePanelId = doorRaw.boundaryIds[doorRaw.hinge];
      if (!door || !hingePanelId || !resolvedById.has(hingePanelId)) return;

      // Mirrors features/door.js#computeDoorOpenTransform's own
      // derivation of which world axis the door swings across.
      const horizontalAxis = AXES.find((a) => a !== doorRaw.normalAxis && a !== 'y');
      const widthField = dimFieldForAxis(doorRaw.rotation, horizontalAxis);
      const heightField = dimFieldForAxis(doorRaw.rotation, 'y');
      const halfWidth = door[widthField] / 2;
      const halfHeight = door[heightField] / 2;
      const hingeCoord = doorRaw.hinge === 'right'
        ? door.position[horizontalAxis] + halfWidth
        : door.position[horizontalAxis] - halfWidth;

      const p1 = { ...door.position, y: door.position.y - halfHeight };
      const p2 = { ...door.position, y: door.position.y + halfHeight };
      p1[horizontalAxis] = hingeCoord;
      p2[horizontalAxis] = hingeCoord;

      featureJoints.push({
        id: `${doorRaw.id}:hinge`,
        kind: 'door_hinge',
        panelA: doorRaw.id,
        panelB: hingePanelId,
        side: doorRaw.hinge,
        axis: doorRaw.normalAxis,
        p1,
        p2,
        lengthMm: Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z),
      });
    });

  // --- Drawers: each box side panel -> the boundary panel it slides against
  panels
    .filter((p) => p.isDrawerFront && p.boundaryIds)
    .forEach((frontRaw) => {
      ['left', 'right'].forEach((side) => {
        const boundaryPanelId = frontRaw.boundaryIds[side];
        const boxPanelRaw = panels.find((p) => p.isDrawerBoxPanel && p.drawerBoxFrontId === frontRaw.id && p.drawerBoxRole === side);
        const boxPanel = boxPanelRaw && resolvedById.get(boxPanelRaw.id);
        const boundaryPanel = resolvedById.get(boundaryPanelId);
        if (!boundaryPanelId || !boxPanel || !boundaryPanel) return;

        // The slide's own run length = the box side panel's own depth
        // extent along the front's normalAxis.
        const depthField = dimFieldForAxis(boxPanelRaw.rotation, frontRaw.normalAxis);
        const halfDepth = boxPanel[depthField] / 2;
        const p1 = { ...boxPanel.position };
        const p2 = { ...boxPanel.position };
        p1[frontRaw.normalAxis] = boxPanel.position[frontRaw.normalAxis] - halfDepth;
        p2[frontRaw.normalAxis] = boxPanel.position[frontRaw.normalAxis] + halfDepth;

        // The ACTUAL measured gap between the box side's outer face and
        // the carcass side's inner face, along the width axis (NOT the
        // normalAxis above, which only measures the slide's own run
        // length/depth). This is the number a runner's own
        // sideClearanceMm spec has to match — see
        // engine/hardware.js#selectRunnerHardware, which validates
        // against it rather than trusting the geometry blindly. Without
        // this, a design built with the wrong margin (see
        // features/drawer.js's own DEFAULT_DRAWER_BOX_WIDTH_MARGIN_MM
        // history) would still get a runner "recommended" that doesn't
        // physically fit the gap actually built.
        const widthAxis = AXES.find((a) => a !== frontRaw.normalAxis && a !== 'y');
        const boxHalf = computeWorldHalfExtents(boxPanel);
        const boundaryHalf = computeWorldHalfExtents(boundaryPanel);
        const boxFacingEdge = side === 'left'
          ? boxPanel.position[widthAxis] - boxHalf[widthAxis]
          : boxPanel.position[widthAxis] + boxHalf[widthAxis];
        const boundaryFacingEdge = side === 'left'
          ? boundaryPanel.position[widthAxis] + boundaryHalf[widthAxis]
          : boundaryPanel.position[widthAxis] - boundaryHalf[widthAxis];
        const clearanceMm = Math.abs(boxFacingEdge - boundaryFacingEdge);

        featureJoints.push({
          id: `${boxPanelRaw.id}:${boundaryPanelId}:slide`,
          kind: 'drawer_slide',
          panelA: boxPanelRaw.id,
          panelB: boundaryPanelId,
          side,
          axis: frontRaw.normalAxis,
          p1,
          p2,
          lengthMm: Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z),
          clearanceMm,
        });
      });
    });

  return featureJoints;
}

// ---------------------------------------------------------------
// DEBUG/VERIFICATION REPORT — turns a detectJoints() result into a
// human-checkable summary for engine/pdfExport.js#exportJointsPdf
// (text) and the JSON export (structured) — the toolbar's "Print
// Joints" / "Export Joints JSON" buttons, next to Print History. None
// of this is part of the geometry contract above — nothing else in
// the app depends on this exact wording or shape — so it's kept
// separate and free to change without touching detectJoints/
// classifyJoint/declareJoint. buildJointsReport() below is the single
// source of truth both the PDF and JSON export read from, so the two
// formats can never drift into disagreeing with each other.
// ---------------------------------------------------------------

function formatOverlap(overlap) {
  return Object.entries(overlap)
    .map(([axis, [min, max]]) => `${axis}:[${min.toFixed(1)}, ${max.toFixed(1)}]`)
    .join(' ');
}

/**
 * Reduces a joint's 2D contact footprint (see the `overlap` field —
 * ranges on the two non-contact axes) down to a single 3D LINE
 * SEGMENT: the two "extremities" of the seam and its length, the way
 * you'd describe a physical joint on a cut sheet ("runs from (x1,y1,z1)
 * to (x2,y2,z2), 350mm"). A real contact footprint is a rectangle, not
 * a line, so this picks the LONGER of the two footprint axes as the
 * seam's direction (e.g. a shelf-to-side joint's seam runs along the
 * cabinet's depth) and holds the shorter axis fixed at the footprint's
 * own midpoint (that shorter axis is usually just a panel's thickness,
 * not a meaningful "run" direction) — see the corner_butt/t_butt note
 * above this file's classifyButtGeometry for the same "which axis
 * actually varies" reasoning. The contact axis itself is fixed at
 * `contactPosition` for both points, since that's the plane the two
 * panels actually meet on.
 *
 * @param {Joint} j
 * @returns {{p1:{x:number,y:number,z:number}, p2:{x:number,y:number,z:number}, lengthMm:number}}
 */
export function computeJointExtremities(j) {
  const [axisA, axisB] = Object.keys(j.overlap);
  const lenA = j.overlap[axisA][1] - j.overlap[axisA][0];
  const lenB = j.overlap[axisB][1] - j.overlap[axisB][0];
  const lengthAxis = lenA >= lenB ? axisA : axisB;
  const fixedAxis = lengthAxis === axisA ? axisB : axisA;
  const fixedValue = (j.overlap[fixedAxis][0] + j.overlap[fixedAxis][1]) / 2;

  const buildPoint = (lengthValue) => {
    const coords = { x: 0, y: 0, z: 0 };
    coords[j.contactAxis] = j.contactPosition;
    coords[fixedAxis] = fixedValue;
    coords[lengthAxis] = lengthValue;
    return coords;
  };

  const p1 = buildPoint(j.overlap[lengthAxis][0]);
  const p2 = buildPoint(j.overlap[lengthAxis][1]);
  const lengthMm = Math.hypot(p2.x - p1.x, p2.y - p1.y, p2.z - p1.z);

  return { p1, p2, lengthMm };
}

/**
 * Two-letter joint-type code used to build each joint's short display
 * id (see assignDisplayIds) — e.g. CB001, the way panels already get
 * a short pieceCode like BA0001 (see modules.js#nextPieceCode) instead
 * of their internal node id.
 */
const JOINT_TYPE_CODE = {
  face_to_face: 'FF',
  corner_butt: 'CB',
  t_butt: 'TB',
  edge_to_edge: 'EE',
  near_contact: 'NC',
};

/** Same idea as JOINT_TYPE_CODE, for FeatureJoint.kind instead of Joint.type. */
const FEATURE_JOINT_TYPE_CODE = {
  door_hinge: 'DH',
  drawer_slide: 'DS',
};

/**
 * Assigns each item a short, human-friendly display id — two letters
 * from `codeMap` plus a zero-padded per-code instance number, e.g. the
 * third corner_butt joint encountered becomes CB003. Purely a DISPLAY
 * concern: unlike a Joint's own `id` (a stable `panelA:panelB:axis`
 * key — see detectJoints) or a FeatureJoint's (`panelA:panelB:kind` —
 * see detectFeatureJoints), this numbering only makes sense within one
 * report — both detectors recompute fresh on every call (nothing is
 * persisted — see this file's header note on why), so "CB003" means
 * "the third corner_butt joint in THIS report", not a stable identity
 * across two different reports/designs.
 *
 * @param {Array<{id:string}>} items - in the order they should be numbered
 * @param {Record<string,string>} codeMap
 * @param {(item:object)=>string} [typeOf] - defaults to reading `.type`; pass `(j)=>j.kind` for FeatureJoint
 * @returns {Map<string,string>} item.id -> display id
 */
function assignDisplayIds(items, codeMap, typeOf = (item) => item.type) {
  const counters = {};
  const displayIdById = new Map();
  items.forEach((item) => {
    const code = codeMap[typeOf(item)] ?? 'XX';
    counters[code] = (counters[code] ?? 0) + 1;
    displayIdById.set(item.id, `${code}${String(counters[code]).padStart(3, '0')}`);
  });
  return displayIdById;
}

/**
 * Joint counts by type — e.g. { corner_butt: 8, t_butt: 2,
 * face_to_face: 0, edge_to_edge: 0, near_contact: 0 }. Always includes
 * every entry in JOINT_TYPES, even at zero, so a report reader can see
 * "0 near_contact" rather than that type simply being absent.
 */
function summarizeJointTypes(joints) {
  const counts = Object.fromEntries(JOINT_TYPES.map((t) => [t, 0]));
  joints.forEach((j) => { counts[j.type] = (counts[j.type] ?? 0) + 1; });
  return counts;
}

/**
 * Visible panels that appear in NO joint at all. In any real design
 * this is almost always a constraint bug (a floating, unattached
 * panel) rather than an intentional design — a legitimately freestanding
 * panel is rare enough that it's worth a look every time this is
 * non-empty.
 *
 * @param {Array} resolvedPanels
 * @param {Joint[]} joints
 * @returns {{id:string, name:string}[]}
 */
export function findOrphanPanels(resolvedPanels, joints) {
  const touched = new Set();
  joints.forEach((j) => { touched.add(j.panelA); touched.add(j.panelB); });
  return resolvedPanels
    .filter((p) => !p.hidden && !touched.has(p.id))
    .map((p) => ({ id: p.id, name: p.name || p.id }));
}

/**
 * Joints between two panels that belong to two DIFFERENT groups —
 * e.g. two separately-built box modules pushed together until they
 * touch. Deliberately NOT the same test as a Joint's own `sameGroup`
 * field: `sameGroup` is false whenever either panel has no groupId at
 * all (a standalone panel outside any box), which would wrongly flag
 * every touching pair of ungrouped panels as "cross-group". This only
 * counts it when BOTH panels genuinely belong to a group and those
 * groups differ — the case actually worth a person's attention, since
 * it usually means two independent pieces of furniture are now
 * touching (intentionally, or because one got dragged into the other).
 *
 * @param {Array} resolvedPanels
 * @param {Joint[]} joints
 * @returns {Joint[]}
 */
export function findCrossGroupJoints(resolvedPanels, joints) {
  const groupById = new Map(resolvedPanels.map((p) => [p.id, p.groupId]));
  return joints.filter((j) => {
    const groupA = groupById.get(j.panelA);
    const groupB = groupById.get(j.panelB);
    return !!groupA && !!groupB && groupA !== groupB;
  });
}

/**
 * Single source of truth for both the PDF and JSON joint reports —
 * everything either export format needs, already cross-referenced
 * against panel names/codes so callers never have to look ids up
 * twice.
 *
 * `pieceCodeById` is optional and SEPARATE from `resolvedPanels` on
 * purpose: resolveConstraints() does not reliably carry a custom field
 * like pieceCode through for constrained nodes (see
 * modeller-main.js#renderAll's own identical pieceCodeById map, built
 * from the RAW `panels` array for exactly this reason) — so a caller
 * with access to the raw graph should pass `panels.map(p=>[p.id,
 * p.pieceCode])` here rather than relying on resolvedPanels having it.
 * Falls back to the panel's name (then its id) when no code is given,
 * which is exactly what every existing test fixture in this file's own
 * test suite gets, since those build raw createPanelNode() fixtures
 * without wiring up a full cut-list pass.
 *
 * `featureJoints` (door hinges, drawer slides — see detectFeatureJoints)
 * is a separate, pre-computed array rather than something this
 * function derives itself, for the same reason `joints`/`collisions`
 * are: detectFeatureJoints needs the RAW `panels` array (feature flags
 * aren't reliable on resolved output either — see detectFeatureJoints's
 * own doc comment), which this function deliberately doesn't take, to
 * keep its own contract limited to "format what I'm given" rather than
 * "go fetch more state". Defaults to [] so every existing caller/test
 * that predates feature joints keeps working unchanged.
 *
 * @param {Array} resolvedPanels - same array passed to detectJoints
 * @param {Joint[]} joints
 * @param {Collision[]} collisions
 * @param {FeatureJoint[]} [featureJoints]
 * @param {{pieceCodeById?: Map<string,string>}} [options]
 */
export function buildJointsReport(resolvedPanels, joints, collisions, featureJoints = [], { pieceCodeById = new Map() } = {}) {
  const nameById = new Map(resolvedPanels.map((p) => [p.id, p.name || p.id]));
  const codeOf = (id) => pieceCodeById.get(id) ?? nameById.get(id) ?? id;
  const withNames = (j) => ({
    ...j,
    panelAName: nameById.get(j.panelA) ?? '?',
    panelBName: nameById.get(j.panelB) ?? '?',
    panelACode: codeOf(j.panelA),
    panelBCode: codeOf(j.panelB),
  });

  const displayIdById = assignDisplayIds(joints, JOINT_TYPE_CODE);
  const withDisplayId = (j) => ({ ...j, displayId: displayIdById.get(j.id) });

  const featureDisplayIdById = assignDisplayIds(featureJoints, FEATURE_JOINT_TYPE_CODE, (j) => j.kind);
  const withFeatureDisplayId = (j) => ({ ...j, displayId: featureDisplayIdById.get(j.id) });

  const crossGroupJoints = findCrossGroupJoints(resolvedPanels, joints);
  const crossGroupIds = new Set(crossGroupJoints.map((j) => j.id));

  return {
    generatedAt: new Date().toISOString(),
    summary: {
      panelCount: resolvedPanels.filter((p) => !p.hidden).length,
      jointCount: joints.length,
      byType: summarizeJointTypes(joints),
      collisionCount: collisions.length,
      crossGroupCount: crossGroupJoints.length,
      featureJointCount: featureJoints.length,
      doorHingeCount: featureJoints.filter((j) => j.kind === 'door_hinge').length,
      drawerSlideCount: featureJoints.filter((j) => j.kind === 'drawer_slide').length,
    },
    orphanPanels: findOrphanPanels(resolvedPanels, joints),
    crossGroupJoints: crossGroupJoints.map((j) => withDisplayId(withNames(j))),
    joints: joints.map((j) => ({ ...withDisplayId(withNames(j)), crossGroup: crossGroupIds.has(j.id) })),
    collisions: collisions.map(withNames),
    featureJoints: featureJoints.map((j) => withFeatureDisplayId(withNames(j))),
  };
}

/**
 * Per-row cell values for exportJointsPdf's joints TABLE (see
 * JOINTS_TABLE_COLUMNS in pdfExport.js). Kept here, not in
 * pdfExport.js, so it's covered by this file's own test suite like
 * every other reader of a Joint's fields — pdfExport.js only owns
 * column widths/layout, not what goes in a cell. Expects a joint
 * that's already been through buildJointsReport (so it carries
 * displayId/panelACode/panelBCode), not a raw detectJoints() Joint.
 *
 * Point/length values are rounded to whole mm — matching how a
 * physical cut/assembly measurement would actually be read off a
 * tape, not a false-precision decimal.
 *
 * @param {ReturnType<typeof buildJointsReport>['joints'][number]} j
 * @returns {{id:string, type:string, panelA:string, panelB:string, axis:string, faces:string, gap:string, point1:string, point2:string, length:string}}
 */
export function formatJointTableRow(j) {
  const { p1, p2, lengthMm } = computeJointExtremities(j);
  const formatPoint = (p) => `(${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})`;
  return {
    id: j.displayId ?? j.id,
    type: j.type,
    panelA: j.panelACode ?? j.panelA,
    panelB: j.panelBCode ?? j.panelB,
    axis: j.contactAxis.toUpperCase(),
    faces: `${j.faceA}/${j.faceB}`,
    gap: j.gap.toFixed(1),
    point1: formatPoint(p1),
    point2: formatPoint(p2),
    length: `${Math.round(lengthMm)}mm`,
  };
}

/**
 * Per-row cell values for exportJointsPdf's SECOND table (door hinges
 * / drawer slides) — a FeatureJoint has no contactAxis/faces/gap (see
 * detectFeatureJoints's own doc comment on why these aren't AABB-
 * contact joints), so this is deliberately a separate, smaller
 * formatter rather than forcing FeatureJoint through
 * formatJointTableRow's Joint-shaped columns.
 *
 * @param {ReturnType<typeof buildJointsReport>['featureJoints'][number]} j
 * @returns {{id:string, kind:string, panelA:string, panelB:string, side:string, point1:string, point2:string, length:string}}
 */
export function formatFeatureJointTableRow(j) {
  const formatPoint = (p) => `(${Math.round(p.x)}, ${Math.round(p.y)}, ${Math.round(p.z)})`;
  return {
    id: j.displayId ?? j.id,
    kind: j.kind,
    panelA: j.panelACode ?? j.panelA,
    panelB: j.panelBCode ?? j.panelB,
    side: j.side,
    point1: formatPoint(j.p1),
    point2: formatPoint(j.p2),
    length: `${Math.round(j.lengthMm)}mm`,
  };
}

/**
 * Just the "=== SUMMARY ===" block — factored out so
 * engine/pdfExport.js#exportJointsPdf can print it above a real table
 * instead of the plain per-joint text lines formatJointsReportLines
 * produces (see formatJointTableRow above for the table's own
 * per-row formatting).
 *
 * @param {ReturnType<typeof buildJointsReport>} report
 * @returns {string[]}
 */
export function formatSummaryLines(report) {
  const lines = [
    '=== SUMMARY ===',
    `${report.summary.panelCount} visible panel(s), ${report.summary.jointCount} joint(s), ${report.summary.collisionCount} collision(s)`,
    Object.entries(report.summary.byType).map(([type, count]) => `${count} ${type}`).join(', '),
  ];
  if (report.summary.featureJointCount > 0) {
    lines.push(`${report.summary.doorHingeCount} door_hinge, ${report.summary.drawerSlideCount} drawer_slide`);
  }
  return lines;
}

/**
 * Just the "=== NEEDS ATTENTION ===" block (collisions, near_contact,
 * orphan panels, cross-group joints) — returns [] when there's
 * nothing to flag, so callers can skip the section entirely rather
 * than print an empty header.
 *
 * @param {ReturnType<typeof buildJointsReport>} report
 * @returns {string[]}
 */
export function formatAttentionLines(report) {
  const nearContact = report.joints.filter((j) => j.type === 'near_contact');
  const hasAttentionItems = report.collisions.length > 0 || nearContact.length > 0
    || report.orphanPanels.length > 0 || report.crossGroupJoints.length > 0;
  if (!hasAttentionItems) return [];

  const lines = ['=== NEEDS ATTENTION ==='];

  if (report.collisions.length > 0) {
    lines.push(`${report.collisions.length} COLLISION(S) — real interpenetration, NOT a joint:`);
    report.collisions.forEach((c) => {
      lines.push(
        `[collision]  ${c.panelAName} (${c.panelA}) <-> ${c.panelBName} (${c.panelB})  —  ` +
        `overlap x:${c.overlapMm.x.toFixed(1)} y:${c.overlapMm.y.toFixed(1)} z:${c.overlapMm.z.toFixed(1)} mm`
      );
    });
  }
  if (nearContact.length > 0) {
    lines.push(`${nearContact.length} NEAR-CONTACT joint(s) — close but not touching:`);
    nearContact.forEach((j) => {
      lines.push(
        `[near_contact]  ${j.panelAName} (${j.panelA}) <-> ${j.panelBName} (${j.panelB})  —  ` +
        `axis ${j.contactAxis.toUpperCase()}, gap ${j.gap.toFixed(1)}mm`
      );
    });
  }
  if (report.orphanPanels.length > 0) {
    lines.push(`${report.orphanPanels.length} ORPHAN PANEL(S) — no joint detected at all (likely a constraint bug):`);
    report.orphanPanels.forEach((p) => lines.push(`[orphan]  ${p.name} (${p.id})`));
  }
  if (report.crossGroupJoints.length > 0) {
    lines.push(`${report.crossGroupJoints.length} CROSS-GROUP joint(s) — touching panels from two different groups:`);
    report.crossGroupJoints.forEach((j) => {
      lines.push(`[cross-group]  ${j.panelAName} (${j.panelA}) <-> ${j.panelBName} (${j.panelB})  —  type ${j.type}`);
    });
  }
  return lines;
}

/**
 * Text-report version for exportJointsPdf's OLDER plain-text mode /
 * any other console/log consumer. Leads with a summary and the
 * "attention" section above, then the full per-joint dump in prose
 * form. exportJointsPdf itself no longer uses this for the per-joint
 * portion (see JOINTS_TABLE_COLUMNS in pdfExport.js — that renders an
 * actual table now), but this stays as the plain-text equivalent for
 * anywhere a real table isn't available (e.g. piping the report to a
 * text log).
 *
 * @param {Array} resolvedPanels
 * @param {Joint[]} joints
 * @param {Collision[]} collisions
 * @returns {string[]}
 */
/**
 * @param {Array} resolvedPanels
 * @param {Joint[]} joints
 * @param {Collision[]} collisions
 * @param {FeatureJoint[]} [featureJoints]
 * @returns {string[]}
 */
export function formatJointsReportLines(resolvedPanels, joints, collisions, featureJoints = []) {
  const report = buildJointsReport(resolvedPanels, joints, collisions, featureJoints);
  const lines = [...formatSummaryLines(report)];

  const attention = formatAttentionLines(report);
  if (attention.length > 0) lines.push('', ...attention);

  lines.push('', '=== ALL JOINTS ===');
  if (joints.length === 0) {
    lines.push('No joints detected.');
  } else {
    report.joints.forEach((j) => {
      const flags = [
        j.status === 'unhandled' ? 'unhandled' : null,
        j.crossGroup ? 'cross-group' : null,
      ].filter(Boolean);
      lines.push(
        `[${j.type}${flags.length ? ', ' + flags.join(', ') : ''}]  ` +
        `${j.panelAName} (${j.panelA}) <-> ${j.panelBName} (${j.panelB})  —  ` +
        `axis ${j.contactAxis.toUpperCase()}, faces ${j.faceA}/${j.faceB}, ` +
        `gap ${j.gap.toFixed(1)}mm, overlap ${formatOverlap(j.overlap)}`
      );
    });
  }

  if (report.featureJoints.length > 0) {
    lines.push('', '=== DOOR HINGES / DRAWER SLIDES ===');
    report.featureJoints.forEach((j) => {
      lines.push(
        `[${j.kind}]  ${j.panelAName} (${j.panelA}) <-> ${j.panelBName} (${j.panelB})  —  ` +
        `side ${j.side}, axis ${j.axis.toUpperCase()}, length ${Math.round(j.lengthMm)}mm`
      );
    });
  }

  return lines;
}

