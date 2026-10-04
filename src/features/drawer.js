/**
 * features/drawer.js
 *
 * A DRAWER FRONT STACK fills the exact same kind of opening a door
 * does — bounded by 4 already-picked panels (see
 * tools/boundaryRectTool.js + shared/geometry.js#computeBoundaryRectangle),
 * same in/out edgeFit per edge (see shared/frontFit.js#computeFrontFit,
 * which does that actual fitting math and is shared verbatim with
 * features/door.js) — but instead of one panel, it's N equal-height
 * panels stacked bottom-to-top across the opening's own height
 * (axisB), one per drawer.
 *
 * This module builds the N FRONT panels (computeDrawerFrontsPlacement/
 * createDrawerFrontNodes), and — per front — the box that actually
 * turns it into a working drawer: left/right/bottom/back
 * (computeDrawerBoxPlacement/createDrawerBoxNodes below). No top: a
 * drawer box is open on top by construction, same as any real one.
 *
 * PURE MODULE, same rule as features/door.js and features/box.js:
 * nothing here touches the global `panels` array or calls
 * history/render — modeller-main.js applies whatever
 * computeDrawerFrontsPlacement()/computeDrawerBoxPlacement() returns.
 *
 * NOT YET BUILT: resizing one front's own height after creation (the
 * person dragging the boundary between two adjacent fronts). Doing
 * that properly means giving each front a spansBetween-style
 * constraint against its neighbor — the same "constrained field, not
 * a literal one" pattern features/shelf.js's spanToDepth already uses
 * — instead of the plain literal height each front gets today. Flagged
 * here rather than solved speculatively, since nothing yet creates a
 * UI for it. Same limitation applies to the box panels below: they're
 * baked literal geometry, recomputed whole on demand (see
 * computeDrawerBoxPlacement's own comment), not live constraints.
 */
import { createPanelNode, nextId, MIN_PANEL_DIM_MM } from '../modeller/modules.js';
import { computeBoundaryRectangle } from '../shared/geometry.js';
import { computeFrontFit, dimFieldForAxis, ROTATION_FOR_NORMAL_AXIS } from '../shared/frontFit.js';
import { resolveConstraints } from '../modeller/snap.js';
import { findBoxSibling } from './box.js';
import { applyPanelPatch } from './door.js';

export const DEFAULT_DRAWER_EDGE_FIT = { left: 'in', right: 'in', bottom: 'in', top: 'in' };
export const DEFAULT_DRAWER_COUNT = 2;
export const MAX_DRAWER_COUNT = 10; // no structural reason beyond this — just a guard against a fat-fingered huge count producing degenerate slivers (see the panel-too-short check below, which would catch it anyway, but failing fast on the count itself gives a clearer reason)

/**
 * @param {Array} panels - current graph (passed to resolveConstraints)
 * @param {Object} boundaryResult - a successful (ok:true) result from
 *   shared/geometry.js#computeBoundaryRectangle (the 4-panel pick)
 * @param {{left:'in'|'out',right:'in'|'out',bottom:'in'|'out',top:'in'|'out'}} edgeFit
 * @param {{material:string, thicknessMm:number, count:number}} drawerSpec -
 *   count: how many equal-height front panels to subdivide the
 *   opening's own height (axisB) into, bottom-to-top. Width (axisA),
 *   depth position, thickness and material are shared by every front
 *   in the stack.
 * @returns {{ ok: true, groupId: string, normalAxis: string,
 *   axisA: string, axisB: string, aMin: number, aMax: number,
 *   centerN: number, thicknessMm: number, material: string, sign: 1|-1,
 *   edgeFit: Object, boundaryIds: Object,
 *   fronts: [{ bMin: number, bMax: number, heightMm: number }],
 *   panelPatches: [{ id: string, dimField?: string, newMin: number, newMax: number, centerN: number }] }
 *  | { ok: false, reason: 'invalid-boundary-result' | 'not-resolved' | 'degenerate' | 'panel-too-short' | 'invalid-count' }}
 */
export function computeDrawerFrontsPlacement(panels, boundaryResult, edgeFit, drawerSpec) {
  const count = Math.round(drawerSpec?.count);
  if (!Number.isFinite(count) || count < 1 || count > MAX_DRAWER_COUNT) {
    return { ok: false, reason: 'invalid-count' };
  }

  const front = computeFrontFit(panels, boundaryResult, edgeFit, drawerSpec.thicknessMm);
  if (!front.ok) return front;

  const totalHeight = front.bMax - front.bMin;
  const heightEach = totalHeight / count;
  if (heightEach < MIN_PANEL_DIM_MM) return { ok: false, reason: 'panel-too-short' };

  // Equal subdivision, bottom-to-top — fronts[0] sits at bMin (the
  // bottom-most drawer), fronts[count-1] at bMax. See this module's
  // own header comment for why each is a plain literal height today
  // rather than a constraint some future per-drawer resize would need.
  const fronts = Array.from({ length: count }, (_, i) => ({
    bMin: front.bMin + i * heightEach,
    bMax: front.bMin + (i + 1) * heightEach,
    heightMm: heightEach,
  }));

  return {
    ok: true,
    groupId: front.groupId,
    normalAxis: front.normalAxis,
    axisA: front.axisA,
    axisB: front.axisB,
    aMin: front.aMin,
    aMax: front.aMax,
    centerN: front.centerN,
    thicknessMm: drawerSpec.thicknessMm,
    material: drawerSpec.material,
    sign: front.sign,
    edgeFit: front.edgeFit,
    boundaryIds: front.boundaryIds,
    fronts,
    panelPatches: front.panelPatches,
  };
}

/**
 * Builds the N actual new drawer-front panel nodes from a
 * computeDrawerFrontsPlacement() result. Shares the SAME basePosition
 * every other panel in the group already uses (found from `panels`) —
 * offsets are only ever meaningful relative to that one shared anchor
 * (see features/box.js#addBox's own comment on this) — and the SAME
 * drawerStackId, so a later recompute (see computeDrawerRecompute
 * below) can find all N siblings and re-subdivide them together
 * instead of one front drifting out of alignment with the rest.
 */
export function createDrawerFrontNodes(panels, placement, drawerBoxSpec = {}) {
  const basePosition = panels.find((p) => p.groupId === placement.groupId)?.basePosition || { x: 0, y: 0, z: 0 };
  const rotation = ROTATION_FOR_NORMAL_AXIS[placement.normalAxis];
  const widthField = dimFieldForAxis(rotation, placement.axisA);
  const heightField = dimFieldForAxis(rotation, placement.axisB);

  // Stored per front (below, as node.drawerBoxSpec) rather than passed
  // fresh each time — a later recompute
  // (applyDrawerAdjustmentsForGroup) needs to rebuild this exact
  // front's own box with the SAME parameters it was first given,
  // without the caller having to remember and re-supply them.
  const boxSpec = {
    material: drawerBoxSpec.material ?? placement.material,
    thicknessMm: drawerBoxSpec.thicknessMm ?? DEFAULT_DRAWER_BOX_THICKNESS_MM,
    widthMarginMm: drawerBoxSpec.widthMarginMm ?? DEFAULT_DRAWER_BOX_WIDTH_MARGIN_MM,
    depthMarginMm: drawerBoxSpec.depthMarginMm ?? DEFAULT_DRAWER_BOX_DEPTH_MARGIN_MM,
    // computeDrawerBoxPlacement re-clamps these to their own floor
    // itself, so storing an under-floor value here is harmless — but
    // storing the (already-floored) intended value is what lets a
    // later recompute (applyDrawerAdjustmentsForGroup) reproduce THIS
    // drawer's own choice rather than silently reverting to default.
    topMarginMm: drawerBoxSpec.topMarginMm ?? DEFAULT_DRAWER_BOX_TOP_MARGIN_MM,
    bottomMarginMm: drawerBoxSpec.bottomMarginMm ?? DEFAULT_DRAWER_BOX_BOTTOM_MARGIN_MM,
  };

  // nextId() just needs to hand back something unique — reusing it
  // here (rather than inventing a second id scheme) for a value that
  // isn't itself a panel id, only ever compared for equality against
  // its own kind (drawerStackId).
  const stackId = nextId();

  return placement.fronts.map((f, i) => {
    const node = createPanelNode({
      name: placement.fronts.length > 1 ? `Drawer Front ${i + 1}` : 'Drawer Front',
      isDrawerFront: true, // mirrors features/door.js's isDoor — distinguishes a drawer front from a renamed plain panel; gizmos.js's own lockdown/highlight checks should key off this, not the name
      thickness: placement.thicknessMm,
      material: placement.material,
      rotation,
      groupId: placement.groupId,
      isBoxPanel: true,
      // Same reasoning as a door's lockedMoveAxes (see
      // features/door.js#createDoorNode's own comment) — a drawer
      // front's whole size and position are DERIVED from its 4
      // boundary panels + edgeFit + the rest of its stack, never
      // something to drag or type a number into directly.
      lockedMoveAxes: ['x', 'y', 'z'],
    });

    const absoluteCenter = { x: 0, y: 0, z: 0 };
    absoluteCenter[placement.axisA] = (placement.aMin + placement.aMax) / 2;
    absoluteCenter[placement.axisB] = (f.bMin + f.bMax) / 2;
    absoluteCenter[placement.normalAxis] = placement.centerN;

    node[widthField] = placement.aMax - placement.aMin;
    node[heightField] = f.bMax - f.bMin;
    node.basePosition = basePosition;
    // Everything computeDrawerBoxPlacement below needs to build this
    // front's own left/right/bottom/back later, without re-deriving
    // anything from the (by then possibly-changed) boundary panels —
    // same reasoning as a door's own normalAxis/doorSign (see
    // features/door.js#createDoorNode's matching comment).
    node.normalAxis = placement.normalAxis;
    node.axisA = placement.axisA;
    node.axisB = placement.axisB;
    node.sign = placement.sign;
    node.offset = {
      x: absoluteCenter.x - basePosition.x,
      y: absoluteCenter.y - basePosition.y,
      z: absoluteCenter.z - basePosition.z,
    };

    // Needed by computeDrawerRecompute/applyDrawerAdjustmentsForGroup
    // below — same role as a door's edgeFit/boundaryIds.
    node.edgeFit = placement.edgeFit;
    node.boundaryIds = placement.boundaryIds;
    node.drawerStackId = stackId;
    node.drawerIndex = i;
    node.drawerCount = placement.fronts.length;
    node.drawerBoxSpec = boxSpec;

    return node;
  });
}

// Same role as features/door.js#computeDoorOpenTransform — a purely
// VISUAL, ephemeral representation for the inspector's Open/Close
// button (see modeller-main.js#toggleSelectedDrawerOpen), never
// written back into the drawer's own stored geometry. A drawer has no
// hinge to swing about, so "open" means translated straight out along
// its own normal axis instead of rotated.
export const DRAWER_OPEN_FRACTION = 0.75; // "3/4 of its depth" per the ask that prompted this

/**
 * Computes the single world-space offset that opening THIS drawer
 * applies to every one of its own panels at once (the front AND its
 * left/right/bottom/back box — modeller-main.js is the one that
 * actually applies it to all 5, since a drawer, unlike a door, is more
 * than one panel). "Its depth" is read directly off one of the
 * drawer's own already-built side panels (left or right) — the exact
 * same number engine/clearance.js#computeDrawerTravelVolumes already
 * treats as "the runner's own full-extension travel" — rather than a
 * separately-maintained constant, so a deeper drawer box visibly opens
 * further than a shallow one, matching its own actual box.
 *
 * @param {Object} frontRaw - RAW drawer-front node (needs normalAxis/sign/id — see
 *   this module's own header comment on why these must come from the
 *   RAW graph, not a resolved node)
 * @param {Array} panels - RAW graph, to find this front's own box siblings by drawerBoxFrontId
 * @param {Array} resolvedPanels - resolveConstraints(panels) output, to read the box's actual built depth
 * @returns {{ offsetMm: {x:number,y:number,z:number} } | null} null if this front has no box built yet (nothing to open)
 */
export function computeDrawerOpenTransform(frontRaw, panels, resolvedPanels) {
  if (!frontRaw?.isDrawerFront) return null;
  const sideRaw = panels.find((p) => p.isDrawerBoxPanel && p.drawerBoxFrontId === frontRaw.id && (p.drawerBoxRole === 'left' || p.drawerBoxRole === 'right'));
  if (!sideRaw) return null;
  const sideResolved = resolvedPanels.find((r) => r.id === sideRaw.id);
  if (!sideResolved) return null;

  const depthField = dimFieldForAxis(sideResolved.rotation, frontRaw.normalAxis);
  const boxDepthMm = sideResolved[depthField];
  if (!Number.isFinite(boxDepthMm)) return null;

  const offsetMm = { x: 0, y: 0, z: 0 };
  offsetMm[frontRaw.normalAxis] = (frontRaw.sign || 1) * boxDepthMm * DRAWER_OPEN_FRACTION;
  return { offsetMm };
}

/**
 * Re-derives an ENTIRE drawer stack's placement from scratch, using
 * one of its own fronts' stored boundaryIds/edgeFit/thickness/material
 * against the boundary panels' CURRENT (possibly just-changed)
 * geometry, and the stack's own drawerCount — the exact same math
 * computeDrawerFrontsPlacement always does. Needs the WHOLE stack (all
 * `drawerCount` siblings sharing `drawerStackId`), not just the one
 * front passed in, since equal subdivision has to happen across the
 * full opening at once, not one front at a time (unlike a door, which
 * is always exactly one panel).
 *
 * Returns the same shape computeDrawerFrontsPlacement does;
 * `{ ok:false, reason:'boundary-missing' }` if one of the 4 original
 * boundary panels no longer exists, `{ ok:false, reason:'stack-incomplete' }`
 * if fewer than drawerCount siblings are still present (e.g. one was
 * deleted individually) — the caller should just leave the stack at
 * its last-known geometry rather than crash or silently re-flow around
 * a gap.
 */
export function computeDrawerRecompute(panels, anyFrontInStack) {
  if (!anyFrontInStack.boundaryIds) return { ok: false, reason: 'no-boundary-ids' };

  const siblings = panels.filter((p) => p.isDrawerFront && p.drawerStackId === anyFrontInStack.drawerStackId);
  if (siblings.length !== anyFrontInStack.drawerCount) return { ok: false, reason: 'stack-incomplete' };

  const boundaryNodes = Object.values(anyFrontInStack.boundaryIds).map((id) => panels.find((p) => p.id === id));
  if (boundaryNodes.some((n) => !n)) return { ok: false, reason: 'boundary-missing' };

  const boundaryResult = computeBoundaryRectangle(panels, boundaryNodes);
  if (!boundaryResult.ok) return boundaryResult;

  return computeDrawerFrontsPlacement(panels, boundaryResult, anyFrontInStack.edgeFit, {
    material: anyFrontInStack.material,
    thicknessMm: anyFrontInStack.thickness,
    count: anyFrontInStack.drawerCount,
  });
}

/**
 * Re-applies EVERY drawer stack in `groupId` against the CURRENT
 * graph — the drawer-front counterpart of
 * features/door.js#applyDoorAdjustmentsForGroup, meant to run right
 * alongside it after features/box.js#relayoutBox's own patches (see
 * modeller-main.js#applyRelayoutResult) for the exact same reason:
 * relayoutBox has no idea a drawer stack once required some of its
 * boundary panels to be shorter, so without this the very next box
 * edit would silently let the stack interpenetrate them again.
 *
 * Applies each stack's own boundary/clearance patches once per stack
 * (identical across every front in it, since they all share one
 * boundaryResult) rather than once per front, then re-derives each
 * front's own bMin/bMax/geometry from the fresh subdivision.
 *
 * KNOWN LIMITATION: same as applyDoorAdjustmentsForGroup — stacks are
 * processed one at a time, each reading whatever the previous one
 * already wrote; two stacks sharing a boundary panel AND axis isn't
 * resolved to one shared target. Nothing built so far creates that
 * situation.
 */
export function applyDrawerAdjustmentsForGroup(panels, groupId) {
  let next = panels;
  const seenStackIds = new Set();
  const stackFronts = next.filter((p) => p.groupId === groupId && p.isDrawerFront);

  for (const front of stackFronts) {
    if (seenStackIds.has(front.drawerStackId)) continue; // already processed this whole stack via an earlier sibling
    seenStackIds.add(front.drawerStackId);

    const placement = computeDrawerRecompute(next, front);
    if (!placement.ok) continue; // leave the stack exactly as it was rather than erase/break it

    // features/door.js#applyPanelPatch has no drawer-specific logic in
    // it — reused as-is, same reasoning as computeFrontFit's own
    // reuse: a boundary panel or interior shelf doesn't care whether
    // what's now covering it is a door or a drawer front.
    placement.panelPatches.forEach((patch) => {
      next = applyPanelPatch(next, patch, placement.normalAxis);
    });

    const rotation = ROTATION_FOR_NORMAL_AXIS[placement.normalAxis];
    const widthField = dimFieldForAxis(rotation, placement.axisA);
    const heightField = dimFieldForAxis(rotation, placement.axisB);
    const siblings = next.filter((p) => p.drawerStackId === front.drawerStackId);

    next = next.map((p) => {
      const sibling = siblings.find((s) => s.id === p.id);
      if (!sibling) return p;
      const f = placement.fronts[sibling.drawerIndex];
      const absoluteCenter = { x: 0, y: 0, z: 0 };
      absoluteCenter[placement.axisA] = (placement.aMin + placement.aMax) / 2;
      absoluteCenter[placement.axisB] = (f.bMin + f.bMax) / 2;
      absoluteCenter[placement.normalAxis] = placement.centerN;
      return {
        ...p,
        [widthField]: placement.aMax - placement.aMin,
        [heightField]: f.bMax - f.bMin,
        offset: {
          x: absoluteCenter.x - p.basePosition.x,
          y: absoluteCenter.y - p.basePosition.y,
          z: absoluteCenter.z - p.basePosition.z,
        },
      };
    });

    // Now that every front in this stack has its OWN fresh geometry
    // (just written into `next` above), re-derive each one's box
    // (left/right/bottom/back) against it — same "front changed, so
    // whatever depends on it needs a catch-up pass" reasoning as the
    // front recompute itself. Skipped (front left boxless) rather than
    // erasing its existing box outright if it no longer fits — same
    // "leave it as it was rather than break it" rule computeDrawerRecompute
    // above already follows for the fronts themselves.
    siblings.forEach((sibling) => {
      const updatedFront = next.find((p) => p.id === sibling.id);
      if (!updatedFront.drawerBoxSpec) return; // a front created before this feature existed, or one whose box creation failed originally — nothing to recompute
      const boxPlacement = computeDrawerBoxPlacement(next, updatedFront, updatedFront.drawerBoxSpec);
      if (!boxPlacement.ok) return;

      ['left', 'right', 'bottom', 'back'].forEach((role) => {
        const spec = boxPlacement[role];
        next = next.map((p) => (p.drawerBoxFrontId === updatedFront.id && p.drawerBoxRole === role
          ? { ...p, ...spec.dims, offset: { x: spec.center.x - p.basePosition.x, y: spec.center.y - p.basePosition.y, z: spec.center.z - p.basePosition.z } }
          : p));
      });
    });
  }

  return next;
}

export const DEFAULT_DRAWER_BOX_WIDTH_MARGIN_MM = 21; // Blum TANDEM/LEGRABOX spec: inside drawer width = opening width - 42mm, i.e. 21mm clearance per side (see engine/hardware.js's RUNNER_CATALOG + REF 4) — kept in sync with that number on purpose, since a mismatch here would mean the drawer is built without enough room for the runner engine/hardware.js recommends for it
export const DEFAULT_DRAWER_BOX_DEPTH_MARGIN_MM = 20; // clearance so the box doesn't strike the back wall when pushed fully in
export const DEFAULT_DRAWER_BOX_THICKNESS_MM = 12; // drawer boxes conventionally use thinner material than the front/carcass
// Left/right/back's own top and bottom edges are inset this far from the
// FRONT's top and bottom edges, rather than running flush to them (how
// this worked before this pair of margins existed) — rule-of-thumb
// clearance so the box's own carcass doesn't ride right up against the
// front's overlay/reveal at the top and bottom. These are FLOORS, not
// just defaults: computeDrawerBoxPlacement clamps any caller-supplied
// value back up to this minimum, never down — see MIN_DRAWER_BOX_CLEARANCE_MM
// just below for the reason a floor exists at all, rather than letting a
// caller dial the box arbitrarily close to the carcass Top/Bottom panels.
export const DEFAULT_DRAWER_BOX_TOP_MARGIN_MM = 20;
export const DEFAULT_DRAWER_BOX_BOTTOM_MARGIN_MM = 20;
// Even at the floor above, the margins are measured from the FRONT's own
// edges, not from the carcass Top/Bottom panels the drawer actually has
// to clear — the two only coincide exactly when the front's edgeFit is
// 'in' and flush. computeDrawerBoxPlacement re-checks the box's real,
// resolved top/bottom extent against boundaryResult.inner[axisB] (the
// carcass opening's own inner faces) and refuses to build a box that
// leaves less than this much real clearance, rather than trusting the
// margin-from-front arithmetic alone.
export const MIN_DRAWER_BOX_CLEARANCE_MM = 0.5;

/**
 * Computes the left/right/bottom/back panels that turn ONE drawer
 * front into an actual working drawer box — sized from the 'in'
 * (inner) width and depth available BEHIND that front, regardless of
 * whatever edgeFit the front itself was actually given. A front with
 * edgeFit 'out' on an edge visually overlays its boundary panel, but
 * the box mechanism still has to fit entirely INSIDE the cavity those
 * boundary panels' own inner faces define — so width is re-derived
 * fresh here from front.boundaryIds via computeBoundaryRectangle
 * (its .inner, never .outer), not read off the front's own aMin/aMax.
 * Depth has no equivalent boundary-panel pair to read from — it's
 * simply "however far back the cabinet's own Back wall is" — so it's
 * measured from the front's own inner face to features/box.js's
 * findBoxSibling(..., 'Back') instead.
 *
 * FOUR separate margins, per the asks that prompted each:
 *   - widthMarginMm: subtracted from EACH side (left AND right) of the
 *     inner opening width — this is the pair of panels' OUTER-to-OUTER
 *     span, i.e. "how wide the whole box sits inside the opening", not
 *     the usable interior between them.
 *   - depthMarginMm: subtracted ONCE, only at the back (nothing needs
 *     inset at the front — the box's own front opening sits flush
 *     with the drawer front's inner face, touching it exactly).
 *   - topMarginMm / bottomMarginMm: inset the box's own top and bottom
 *     edges THIS FAR from the FRONT's own top and bottom edges — left/
 *     right/back no longer run the front's full height flush to its
 *     edges. Both are FLOORS (see DEFAULT_DRAWER_BOX_TOP_MARGIN_MM's own
 *     comment): a caller-supplied value below the default is clamped
 *     back up to it, never down, so a person adjusting these can only
 *     shrink the box further, never push it closer to the carcass than
 *     the shipped default already sits. Because the margin is measured
 *     from the FRONT, not the carcass, a passing margin doesn't by
 *     itself prove the box clears the carcass Top/Bottom panels — see
 *     the real-clearance check against boundaryResult.inner[axisB]
 *     further down, which is the thing that actually guards that.
 *
 * Left/right run the box's full computed depth; bottom and back then
 * fit INSIDE that (bottom stops depthMarginMm... no — stops
 * `thicknessMm` short of back's own inner face; back sits flush at
 * the sides' far end, recessed inward by its own half-thickness) —
 * see the inline math below for the exact butt-joint layout. No top:
 * a drawer box is open on top by construction. Vertically (axisB),
 * left/right/back now span only the margin-inset height described
 * above, not the front's own full height.
 *
 * SCOPED to normalAxis 'z' only (a front replacing Front/Back) — the
 * only orientation where "the opposing wall to measure depth against"
 * is unambiguous (always Back). A front replacing Left/Right pulls out
 * sideways and has no single unambiguous opposing wall (could be
 * either Left or Right depending on which one WASN'T replaced); a
 * front replacing Top/Bottom has no natural up/down for left/right to
 * even mean anything. Neither is solved speculatively here.
 *
 * @param {Array} panels - current graph
 * @param {Object} frontNode - a single drawer-front node (RAW, from
 *   `panels` — needs boundaryIds/edgeFit/normalAxis/axisA/axisB/sign,
 *   none of which survive resolveConstraints; see
 *   modeller-main.js#renderAll's own drawerFrontFieldsById comment)
 * @param {{material:string, thicknessMm:number, widthMarginMm?:number, depthMarginMm?:number, topMarginMm?:number, bottomMarginMm?:number}} boxSpec
 * @returns {{ ok:true, frontId:string, groupId:string, normalAxis:'z', axisA:string, axisB:string,
 *   material:string, thicknessMm:number,
 *   left:{center:{x,y,z}, dims:{width,height,thickness}},
 *   right:{center:{x,y,z}, dims:{width,height,thickness}},
 *   bottom:{center:{x,y,z}, dims:{width,height,thickness}},
 *   back:{center:{x,y,z}, dims:{width,height,thickness}} }
 *  | { ok:false, reason:'not-a-drawer-front'|'unsupported-normal-axis'|'no-back-wall'|'boundary-missing'|'panel-too-short'|'insufficient-clearance' }}
 */
export function computeDrawerBoxPlacement(panels, frontNode, boxSpec) {
  if (!frontNode?.isDrawerFront) return { ok: false, reason: 'not-a-drawer-front' };
  if (frontNode.normalAxis !== 'z') return { ok: false, reason: 'unsupported-normal-axis' }; // see this function's own doc comment

  const { material, thicknessMm, widthMarginMm = DEFAULT_DRAWER_BOX_WIDTH_MARGIN_MM, depthMarginMm = DEFAULT_DRAWER_BOX_DEPTH_MARGIN_MM } = boxSpec;
  // Floors, not just defaults — see DEFAULT_DRAWER_BOX_TOP_MARGIN_MM's
  // own comment on why a caller can only ever push these UP from here,
  // never down, however the value reaches this function (a future UI
  // field, a stored drawerBoxSpec, a recompute replaying an old spec).
  const topMarginMm = Math.max(DEFAULT_DRAWER_BOX_TOP_MARGIN_MM, boxSpec.topMarginMm ?? DEFAULT_DRAWER_BOX_TOP_MARGIN_MM);
  const bottomMarginMm = Math.max(DEFAULT_DRAWER_BOX_BOTTOM_MARGIN_MM, boxSpec.bottomMarginMm ?? DEFAULT_DRAWER_BOX_BOTTOM_MARGIN_MM);
  const N = frontNode.normalAxis;
  const axisA = frontNode.axisA;
  const axisB = frontNode.axisB;

  const backNode = findBoxSibling(panels, frontNode.groupId, 'Back');
  if (!backNode) return { ok: false, reason: 'no-back-wall' };

  const boundaryNodes = Object.values(frontNode.boundaryIds || {}).map((id) => panels.find((p) => p.id === id));
  if (boundaryNodes.some((n) => !n)) return { ok: false, reason: 'boundary-missing' };
  const boundaryResult = computeBoundaryRectangle(panels, boundaryNodes);
  if (!boundaryResult.ok) return boundaryResult;

  const resolved = resolveConstraints(panels);
  const frontResolved = resolved.find((r) => r.id === frontNode.id);
  const backResolved = resolved.find((r) => r.id === backNode.id);
  if (!frontResolved || !backResolved) return { ok: false, reason: 'not-resolved' };

  const frontRotation = ROTATION_FOR_NORMAL_AXIS[N];
  const frontAxisBField = dimFieldForAxis(frontRotation, axisB);
  const frontAxisBSize = frontResolved[frontAxisBField];
  const frontCenterB = frontResolved.position[axisB];

  // Derived fresh by comparing actual positions rather than trusting
  // frontNode.sign to still mean "which way is away from Back" here —
  // sign was defined relative to the 4 BOUNDARY panels
  // (shared/frontFit.js#computeFrontFit), not Back specifically; they
  // should always agree in practice, but this doesn't depend on that.
  const depthSign = frontResolved.position[N] >= backResolved.position[N] ? 1 : -1;
  const frontInnerFaceN = frontResolved.position[N] - depthSign * (frontResolved.thickness / 2);
  const backInnerFaceN = backResolved.position[N] + depthSign * (backResolved.thickness / 2);
  const availableDepth = Math.abs(frontInnerFaceN - backInnerFaceN);
  const boxDepthMm = availableDepth - depthMarginMm;

  const innerAMin = boundaryResult.inner[axisA].min;
  const innerAMax = boundaryResult.inner[axisA].max;
  const boxWidthMm = (innerAMax - innerAMin) - 2 * widthMarginMm; // outer-to-outer span of left+right, see doc comment above

  // Box's own vertical (axisB) span: inset from the front's top/bottom
  // edges by topMarginMm/bottomMarginMm instead of running flush to
  // them — see this function's own doc comment and
  // DEFAULT_DRAWER_BOX_TOP_MARGIN_MM's comment for why.
  const boxLowB = frontCenterB - frontAxisBSize / 2 + bottomMarginMm;
  const boxHighB = frontCenterB + frontAxisBSize / 2 - topMarginMm;
  const boxAxisBSize = boxHighB - boxLowB;

  if (boxDepthMm < MIN_PANEL_DIM_MM || boxWidthMm < MIN_PANEL_DIM_MM || boxAxisBSize < MIN_PANEL_DIM_MM || (boxWidthMm - 2 * thicknessMm) < MIN_PANEL_DIM_MM || (boxDepthMm - thicknessMm) < MIN_PANEL_DIM_MM || (boxAxisBSize - thicknessMm) < MIN_PANEL_DIM_MM) {
    return { ok: false, reason: 'panel-too-short' };
  }

  // Real-clearance guard: the margins above are measured from the
  // FRONT, but what the box actually has to clear is the CARCASS
  // Top/Bottom panels' own inner faces (boundaryResult.inner[axisB] —
  // same inner rectangle innerAMin/innerAMax above already reads, just
  // the other axis). The two only coincide exactly when the front's
  // edgeFit is 'in' and flush; this re-derives the real gap rather than
  // trusting that coincidence, and refuses to build a box that would
  // leave less than MIN_DRAWER_BOX_CLEARANCE_MM on either end.
  const innerBMin = boundaryResult.inner[axisB].min;
  const innerBMax = boundaryResult.inner[axisB].max;
  const topClearanceMm = innerBMax - boxHighB;
  const bottomClearanceMm = boxLowB - innerBMin;
  if (topClearanceMm < MIN_DRAWER_BOX_CLEARANCE_MM || bottomClearanceMm < MIN_DRAWER_BOX_CLEARANCE_MM) {
    return { ok: false, reason: 'insufficient-clearance' };
  }

  const sideRotation = ROTATION_FOR_NORMAL_AXIS[axisA]; // left/right: thickness along axisA, same convention as box.js's own Left/Right
  const sideDepthField = dimFieldForAxis(sideRotation, N);
  const sideHeightField = dimFieldForAxis(sideRotation, axisB);

  const backRotation = frontRotation; // back: parallel to the front, thickness along N
  const backWidthField = dimFieldForAxis(backRotation, axisA);
  const backHeightField = dimFieldForAxis(backRotation, axisB);

  const bottomRotation = ROTATION_FOR_NORMAL_AXIS[axisB]; // bottom: thickness along axisB, same convention as box.js's own Top/Bottom
  const bottomWidthField = dimFieldForAxis(bottomRotation, axisA);
  const bottomDepthField = dimFieldForAxis(bottomRotation, N);

  // Depth layout, front-to-back: left/right span the FULL boxDepthMm;
  // back then sits flush at their far end, receding inward by its own
  // half-thickness (same "flush at the boundary, inward by half its
  // own thickness" convention box.js's Back/Front already use);
  // bottom fits BETWEEN the front opening and back's own inner face —
  // stopping `thicknessMm` short of the far end so it doesn't
  // interpenetrate back.
  const sideCenterN = frontInnerFaceN - depthSign * (boxDepthMm / 2);
  const sideFarEndN = frontInnerFaceN - depthSign * boxDepthMm;
  const backCenterN = sideFarEndN + depthSign * (thicknessMm / 2);
  const bottomCenterN = frontInnerFaceN - depthSign * ((boxDepthMm - thicknessMm) / 2);

  // Width layout (axisA): symmetric margins either side, so bottom and
  // back always share one common center regardless of margin size.
  const axisACenter = (innerAMin + innerAMax) / 2;
  const leftCenterA = innerAMin + widthMarginMm + thicknessMm / 2;
  const rightCenterA = innerAMax - widthMarginMm - thicknessMm / 2;

  // Height layout (axisB): left/right run the box's own inset height
  // (boxAxisBSize, NOT the front's full height — see topMarginMm/
  // bottomMarginMm above); bottom sits flush at the box's own lower
  // edge; back sits on TOP of bottom (its own height is the box's
  // height minus bottom's thickness), flush with the box's own upper
  // edge — same "no gap, no overlap" butt-joint reasoning as the depth
  // layout above, just measured from boxLowB/boxHighB instead of the
  // front's raw edges.
  const boxCenterB = (boxLowB + boxHighB) / 2;
  const bottomCenterB = boxLowB + thicknessMm / 2;
  const backHeightMm = boxAxisBSize - thicknessMm;
  const backCenterB = boxHighB - backHeightMm / 2;

  function centerFor(nAlongN, aAlongA, bAlongB) {
    const c = { x: 0, y: 0, z: 0 };
    c[N] = nAlongN;
    c[axisA] = aAlongA;
    c[axisB] = bAlongB;
    return c;
  }

  return {
    ok: true,
    frontId: frontNode.id,
    groupId: frontNode.groupId,
    normalAxis: N,
    axisA,
    axisB,
    material,
    thicknessMm,
    left: {
      center: centerFor(sideCenterN, leftCenterA, boxCenterB),
      rotation: sideRotation,
      dims: { [sideDepthField]: boxDepthMm, [sideHeightField]: boxAxisBSize, thickness: thicknessMm },
    },
    right: {
      center: centerFor(sideCenterN, rightCenterA, boxCenterB),
      rotation: sideRotation,
      dims: { [sideDepthField]: boxDepthMm, [sideHeightField]: boxAxisBSize, thickness: thicknessMm },
    },
    bottom: {
      center: centerFor(bottomCenterN, axisACenter, bottomCenterB),
      rotation: bottomRotation,
      dims: { [bottomWidthField]: boxWidthMm - 2 * thicknessMm, [bottomDepthField]: boxDepthMm - thicknessMm, thickness: thicknessMm },
    },
    back: {
      center: centerFor(backCenterN, axisACenter, backCenterB),
      rotation: backRotation,
      dims: { [backWidthField]: boxWidthMm - 2 * thicknessMm, [backHeightField]: backHeightMm, thickness: thicknessMm },
    },
  };
}

/**
 * Builds the 4 actual new panel nodes from a computeDrawerBoxPlacement()
 * result. Same basePosition-sharing rule as
 * createDrawerFrontNodes/createDoorNode — offsets are only ever
 * meaningful relative to that one shared anchor (see
 * features/box.js#addBox's own comment on this), so `panels` is needed
 * here too, purely to find it. Locked the same way the front itself is
 * (lockedMoveAxes, all 3 axes) — their proportions and position are
 * derived by computeDrawerBoxPlacement, not something to drag or
 * resize by hand; applyDrawerAdjustmentsForGroup below keeps them in
 * sync with their front (and, transitively, with the box) going
 * forward via drawerBoxFrontId + drawerBoxRole, the same way a door's
 * boundaryIds let it be found and recomputed later.
 */
export function createDrawerBoxNodes(panels, placement) {
  const basePosition = panels.find((p) => p.groupId === placement.groupId)?.basePosition || { x: 0, y: 0, z: 0 };
  const roles = ['left', 'right', 'bottom', 'back'];
  return roles.map((role) => {
    const spec = placement[role];
    const node = createPanelNode({
      name: `Drawer ${role[0].toUpperCase()}${role.slice(1)}`,
      thickness: placement.thicknessMm,
      material: placement.material,
      rotation: spec.rotation,
      groupId: placement.groupId,
      isBoxPanel: true,
      // Mirrors isDrawerFront — the box's proportions/position are
      // DERIVED (from the front's own boundary panels + Back wall +
      // margins, see computeDrawerBoxPlacement above), never something
      // to drag or type a number into directly, same reasoning as the
      // front itself. Unlike the front, though, these 4 panels don't
      // exist without ONE specific front — drawerBoxFrontId/
      // drawerBoxRole below are what a later recompute
      // (applyDrawerAdjustmentsForGroup) uses to find and update this
      // exact node rather than create a duplicate.
      isDrawerBoxPanel: true,
      lockedMoveAxes: ['x', 'y', 'z'],
      drawerBoxFrontId: placement.frontId,
      drawerBoxRole: role,
      ...spec.dims,
    });
    node.basePosition = basePosition;
    node.offset = {
      x: spec.center.x - basePosition.x,
      y: spec.center.y - basePosition.y,
      z: spec.center.z - basePosition.z,
    };
    return node;
  });
}
