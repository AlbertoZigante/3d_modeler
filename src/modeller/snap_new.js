/**
 * THE CONSTRAINT RESOLVER — Stage 2.
 *
 * Input: the raw `panels` array (literal values + optional
 * `constraints`, possibly `overridden`). Output: an array, same
 * order/ids, where every field is a concrete number — nothing
 * downstream (scene.js, bom.js, toolbar.js) needs to know
 * constraints exist at all. This is the one seam in the whole app
 * where "raw graph" becomes "resolved graph"; every other module
 * only ever sees one side of that seam.
 *
 * Each resolved entry:
 *   {
 *     id, material, quantity, rotation,        // pass-through
 *     width, height, thickness,                // mm, resolved
 *     position: { x, y, z },                   // mm, ABSOLUTE, resolved
 *     lockedFields: { width, height, thickness,
 *                     positionX, positionY, positionZ },  // booleans
 *     warnings: [ 'human-readable message', ... ],
 *   }
 *
 * `lockedFields` is what scene.js uses to hide the corresponding
 * gizmo handle for a field that's under active (non-overridden)
 * constraint — dragging a derived value doesn't mean anything until
 * the user has explicitly broken that link.
 *
 * RESOLUTION ORDER
 * -----------------
 * Constraints reference other nodes, so nodes must be resolved in
 * dependency order (topological sort). A cycle (A depends on B which
 * depends on A) can't be resolved at all — every node in the cycle
 * keeps its literal/fallback value and gets a warning, rather than
 * looping forever or crashing.
 *
 * WHAT'S DELIBERATELY UNSUPPORTED (see modules.js's LOCAL_FACES doc)
 * ---------------------------------------------------------------------
 * A constraint requires the referenced face's WORLD normal (local
 * normal rotated by that node's actual rotation) to land on the
 * constrained axis within a small tolerance. If a target panel is at
 * some arbitrary non-90°-aligned angle, that check fails and the
 * constraint is skipped with a clear warning — angled/mitred joinery
 * is a future stage, not silently-wrong geometry now.
 *
 * INFERRING WHICH FIELD A spansBetween RELATION SETS
 * -----------------------------------------------------
 * The relations UI no longer asks "which field does this set" for a
 * spansBetween relation — panels are mostly a 2D shape (thickness is
 * a small, fixed, BOM-driven value, not something you'd normally span
 * between two other panels). `inferSpanField()` figures out the axis
 * from the chosen From/To faces themselves (both must imply the SAME
 * axis, or it's rejected), then figures out which of the target
 * panel's own width/height/thickness fields lines up with that axis
 * given ITS current rotation — the same alignment math the resolver
 * already uses, just run in the "what field would satisfy this"
 * direction instead of "does this field's face align" direction.
 */

import {
  LOCAL_FACES,
  FACE_TO_DIM_FIELD,
  FIELD_TO_AXIS,
  MIN_PANEL_DIM_MM,
  getAlignedAxis,
  DIM_FIELD_PROBE_FACE,
  computeWorldHalfExtents,
} from './modules.js';

const EMPTY_LOCKS = { width: false, height: false, thickness: false, positionX: false, positionY: false, positionZ: false };
const AXIS_TO_POSITION_FIELD = { x: 'positionX', y: 'positionY', z: 'positionZ' };

function emptyResolved(node) {
  const base = node.basePosition || { x: 0, y: 0, z: 0 };
  const offset = node.offset || { x: 0, y: 0, z: 0 };

  const lockedFields = { ...EMPTY_LOCKS };
  // Some panels (e.g. the box preset's derived faces — see
  // modeller-main.js's addBox) declare up front which move-gizmo
  // axes should always stay locked, REGARDLESS of whether that exact
  // axis happens to carry its own explicit position constraint below.
  // This matters because a width/height spansBetween constraint
  // already implicitly RECENTERS the node on its own axis on every
  // resolve (see applySpansBetween's `hasOwnPositionConstraint`
  // check) even when nothing ever flips that axis's lockedFields —
  // without this, the move gizmo would show a "draggable" handle for
  // an axis whose value silently snaps back to its derived center on
  // the very next render, or — for an axis with no constraint touching
  // it at all (e.g. left/right's own Y/Z) — one that drags freely but
  // visually breaks the assembly's alignment with nothing to stop it.
  (node.lockedMoveAxes || []).forEach((axis) => {
    const field = AXIS_TO_POSITION_FIELD[axis];
    if (field) lockedFields[field] = true;
  });

  return {
    id: node.id,
    name: node.name,
    material: node.material,
    quantity: node.quantity,
    rotation: node.rotation || { x: 0, y: 0, z: 0 },
    thicknessAxis: node.thicknessAxis, // pass through — see modules.js createPanelNode/classifyFacesByThickness
    groupId: node.groupId || null,
    resizeProxy: node.resizeProxy || null, // pass through — see modeller-main.js's addBox and gizmos.js's resize-proxy redirect
    // Cut-list metadata — pure passthrough, never touched by
    // resolution (see modules.js's createPanelNode for what these
    // mean); engine/bom.js reads them off the RESOLVED node the same
    // way it reads width/height/material.
    grainDirection: node.grainDirection || null,
    edgeBanding: node.edgeBanding || { top: false, bottom: false, left: false, right: false },
    edgeBandingMaterial: node.edgeBandingMaterial || null,
    hidden: !!node.hidden,
    width: node.width,
    height: node.height,
    thickness: node.thickness,
    basePosition: base, // pass through unchanged — scene.js reads this directly, never recomputes it
    position: {
      x: base.x + (offset.x || 0),
      y: base.y + (offset.y || 0),
      z: base.z + (offset.z || 0),
    },
    lockedFields,
    warnings: [],
  };
}

// Topological sort over "which nodes does this node's constraints
// reference". Nodes involved in a cycle are returned separately so
// the caller can flag them instead of resolving them.
function topoSort(panels) {
  const byId = new Map(panels.map((p) => [p.id, p]));
  const deps = new Map(panels.map((p) => [p.id, new Set()]));
  panels.forEach((p) => {
    (p.constraints || []).forEach((c) => {
      if (c.overridden) return;
      if (c.from?.node && byId.has(c.from.node)) deps.get(p.id).add(c.from.node);
      if (c.to?.node && byId.has(c.to.node)) deps.get(p.id).add(c.to.node);
    });
  });

  const order = [];
  const state = new Map(); // 0=unvisited,1=visiting,2=done
  const cyclic = new Set();

  function visit(id, stack) {
    const s = state.get(id) || 0;
    if (s === 2) return;
    if (s === 1) {
      const startIdx = stack.indexOf(id);
      stack.slice(startIdx).forEach((cid) => cyclic.add(cid));
      return;
    }
    state.set(id, 1);
    stack.push(id);
    for (const depId of deps.get(id) || []) visit(depId, stack);
    stack.pop();
    state.set(id, 2);
    order.push(id);
  }

  panels.forEach((p) => visit(p.id, []));
  return { order, cyclic };
}

// DIM_FIELD_PROBE_FACE and computeWorldHalfExtents now live in
// modules.js (imported above) — used both to find "which axis does
// field X line up with" (axisForDimensionField, below
// applySpansBetween) and "which field lines up with axis Y"
// (inferSpanField, right below).

/**
 * Given a target node and the From/To face references a user picked
 * for a new spansBetween relation, works out which field (width /
 * height / thickness) on the TARGET node should be governed by it —
 * removing the need for the relations UI to ask directly.
 * Returns { field, axis } on success, or { error: 'message' }.
 */
export function inferSpanField(targetNode, fromFaceRef, toFaceRef, byId) {
  const fromNode = byId.get(fromFaceRef.node);
  const toNode = byId.get(toFaceRef.node);
  if (!fromNode) return { error: `"From" panel "${fromFaceRef.node}" not found.` };
  if (!toNode) return { error: `"To" panel "${toFaceRef.node}" not found.` };

  const fromAligned = getAlignedAxis(fromNode.rotation, fromFaceRef.face);
  const toAligned = getAlignedAxis(toNode.rotation, toFaceRef.face);
  if (!fromAligned) {
    return { error: `"${fromFaceRef.face}" face of the "From" panel isn't aligned with any main axis at its current rotation.` };
  }
  if (!toAligned) {
    return { error: `"${toFaceRef.face}" face of the "To" panel isn't aligned with any main axis at its current rotation.` };
  }
  if (fromAligned.axis !== toAligned.axis) {
    return {
      error: `The "From" and "To" faces point along different axes (${fromAligned.axis.toUpperCase()} vs ` +
        `${toAligned.axis.toUpperCase()}) — pick two faces that face each other along the same axis.`,
    };
  }

  const axis = fromAligned.axis;
  for (const [field, probeFace] of Object.entries(DIM_FIELD_PROBE_FACE)) {
    const aligned = getAlignedAxis(targetNode.rotation, probeFace);
    if (aligned && aligned.axis === axis) {
      if (field === 'thickness') {
        return {
          error:
            'That axis lines up with this panel\'s THICKNESS, which is fixed by its Material ' +
            '(inspector) and can\'t be set via a relation — pick a different pair of faces.',
        };
      }
      return { field, axis };
    }
  }
  return { error: `This panel has no dimension that lines up with the ${axis.toUpperCase()} axis at its current rotation.` };
}

// World-space position (mm, along axisKey) of a referenced face — OR,
// if faceRef has no `.node` and instead carries a literal `.mm`, that
// fixed constant directly. This literal form exists specifically for
// the collinear tool's resize-fallback in modeller-main.js: it lets a
// spansBetween constraint anchor one endpoint to "wherever this
// panel's opposite face already was" as a captured SNAPSHOT — a
// value, not a live reference — which is what makes it possible at
// all (the alternative, a live reference to the panel's OWN
// not-yet-resolved face, is a self-referential dependency; topoSort
// above would just flag it circular).
function resolveFacePointMm(faceRef, axisKey, resolvedById, byId) {
  if (faceRef.node == null && typeof faceRef.mm === 'number') {
    return faceRef.mm;
  }
  const targetNode = byId.get(faceRef.node);
  const targetResolved = resolvedById.get(faceRef.node);
  if (!targetNode || !targetResolved) {
    throw new Error(`references missing panel "${faceRef.node}"`);
  }
  if (!LOCAL_FACES[faceRef.face]) {
    throw new Error(`unknown face "${faceRef.face}"`);
  }
  const aligned = getAlignedAxis(targetResolved.rotation, faceRef.face);
  if (!aligned || aligned.axis !== axisKey) {
    throw new Error(
      `"${faceRef.face}" face of ${faceRef.node} isn't aligned with the ${axisKey.toUpperCase()} axis at its ` +
      `current rotation — angled/non-axis-aligned relations aren't supported yet`
    );
  }
  const dimField = FACE_TO_DIM_FIELD[faceRef.face];
  const halfExtentMm = targetResolved[dimField] / 2;
  const centerMm = targetResolved.position[axisKey];
  const offsetMm = faceRef.offset || 0;
  return centerMm + aligned.sign * (halfExtentMm + offsetMm);
}

// axisForDimensionField reuses DIM_FIELD_PROBE_FACE (defined above,
// near inferSpanField) to find "which world axis does THIS node's
// own width/height/thickness actually line up with right now" — this
// can NOT be a static field->axis table (unlike position fields),
// because it depends on the node's current rotation: an unrotated
// panel's width lines up with world X, but the new default panel
// (rotated 90° about Y, to lie in the YZ plane) has its width lining
// up with world Z instead. Getting this wrong doesn't crash — it
// silently checks alignment against the wrong axis and rejects a
// perfectly valid relation with a confusing error, which is how this
// was actually caught: by running the new default-panel case, not by
// inspection.
function axisForDimensionField(node, field) {
  const probeFace = DIM_FIELD_PROBE_FACE[field];
  if (!probeFace) return null;
  const aligned = getAlignedAxis(node.rotation, probeFace);
  return aligned ? aligned.axis : null;
}

function applySpansBetween(node, constraint, resolvedById, byId, r) {
  if (constraint.field === 'thickness') {
    r.warnings.push('thickness is fixed by Material now — a spansBetween constraint on it is ignored');
    return;
  }
  const axisKey = axisForDimensionField(node, constraint.field);
  if (!axisKey) {
    throw new Error(
      `this panel's own "${constraint.field}" doesn't line up with any main axis at its current rotation`
    );
  }
  const fromMm = resolveFacePointMm(constraint.from, axisKey, resolvedById, byId);
  const toMm = resolveFacePointMm(constraint.to, axisKey, resolvedById, byId);
  const span = Math.max(MIN_PANEL_DIM_MM, Math.abs(toMm - fromMm));
  r[constraint.field] = span;
  r.lockedFields[constraint.field] = true;
  // A dimension constraint also centers the node on that axis unless
  // that exact axis already has its own explicit position constraint.
  const positionField = axisKey === 'x' ? 'positionX' : axisKey === 'y' ? 'positionY' : 'positionZ';
  const hasOwnPositionConstraint = (node.constraints || []).some(
    (c) => !c.overridden && c.field === positionField
  );
  if (!hasOwnPositionConstraint) {
    r.position[axisKey] = (fromMm + toMm) / 2;
  }
}

function applyAttachedTo(node, constraint, resolvedById, byId, r) {
  const axisKey = FIELD_TO_AXIS[constraint.field];
  if (!constraint.myFace || !LOCAL_FACES[constraint.myFace]) {
    throw new Error(`missing or unknown "myFace" for attachedTo constraint`);
  }
  const targetMm = resolveFacePointMm(constraint.from, axisKey, resolvedById, byId);
  const myAligned = getAlignedAxis(r.rotation, constraint.myFace);
  if (!myAligned || myAligned.axis !== axisKey) {
    throw new Error(
      `this panel's own "${constraint.myFace}" face isn't aligned with the ${axisKey.toUpperCase()} axis ` +
      `at its current rotation — angled/non-axis-aligned relations aren't supported yet`
    );
  }
  const dimField = FACE_TO_DIM_FIELD[constraint.myFace];
  const myHalfExtentMm = r[dimField] / 2;
  r.position[axisKey] = targetMm - myAligned.sign * myHalfExtentMm;
  r.lockedFields[constraint.field] = true;
}

export function resolveConstraints(panels) {
  const byId = new Map(panels.map((p) => [p.id, p]));
  const resolvedById = new Map();

  panels.forEach((node) => {
    resolvedById.set(node.id, emptyResolved(node));
  });

  const { order, cyclic } = topoSort(panels);

  order.forEach((id) => {
    const node = byId.get(id);
    const r = resolvedById.get(id);

    if (cyclic.has(id)) {
      r.warnings.push('part of a circular relation (A depends on B which depends on A) — using its last literal values');
      return;
    }

    // Dimension constraints (spansBetween) must be applied before
    // position constraints (attachedTo) on the SAME node — attachedTo
    // reads r[dimField] (via myFace) to compute position, so if a
    // spansBetween on that same field runs AFTER it, position ends up
    // computed from a STALE dimension. This never surfaced from the
    // box preset's own constraints (its attachedTo always keys off
    // `thickness`, which no spansBetween ever touches), but the
    // collinear tool's resize-fallback (see modeller-main.js's
    // applyCollinear) is a real case where a spansBetween and an
    // attachedTo on the same node both matter, in exactly this
    // dependency direction — caught by simulating it against this
    // resolver directly, not by inspection.
    const orderedConstraints = [...(node.constraints || [])].sort(
      (a, b) => (a.type === 'attachedTo' ? 1 : 0) - (b.type === 'attachedTo' ? 1 : 0)
    );
    orderedConstraints.forEach((constraint) => {
      if (constraint.overridden) return;
      try {
        if (constraint.type === 'spansBetween') {
          applySpansBetween(node, constraint, resolvedById, byId, r);
        } else if (constraint.type === 'attachedTo') {
          applyAttachedTo(node, constraint, resolvedById, byId, r);
        } else {
          r.warnings.push(`unknown constraint type "${constraint.type}"`);
        }
      } catch (err) {
        r.warnings.push(err.message);
      }
    });
  });

  // return in the same order as the input, not topo order
  return panels.map((p) => resolvedById.get(p.id));
}
