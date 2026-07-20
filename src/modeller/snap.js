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

import * as THREE from 'three';
import {
  MM_TO_UNIT,
  LOCAL_FACES,
  FACE_TO_DIM_FIELD,
  FIELD_TO_AXIS,
  MIN_PANEL_DIM_MM,
  computeAutoLayoutPositions,
} from './modules.js';

const EMPTY_LOCKS = { width: false, height: false, thickness: false, positionX: false, positionY: false, positionZ: false };
const AXIS_VECTORS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

function emptyResolved(node, autoPos) {
  return {
    id: node.id,
    name: node.name,
    material: node.material,
    quantity: node.quantity,
    rotation: node.rotation || { x: 0, y: 0, z: 0 },
    width: node.width,
    height: node.height,
    thickness: node.thickness,
    position: {
      x: (autoPos.x + (node.offset?.x || 0) * MM_TO_UNIT) / MM_TO_UNIT,
      y: (autoPos.y + (node.offset?.y || 0) * MM_TO_UNIT) / MM_TO_UNIT,
      z: (autoPos.z + (node.offset?.z || 0) * MM_TO_UNIT) / MM_TO_UNIT,
    },
    lockedFields: { ...EMPTY_LOCKS },
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

/**
 * Which single world axis (if any) a local face lands on, given a
 * node's rotation — the one shared alignment check every constraint
 * (and now the field-inference helper below) is built on.
 * Returns { axis: 'x'|'y'|'z', sign: 1|-1 } or null if the face isn't
 * aligned with any single axis within tolerance.
 */
export function getAlignedAxis(rotationDeg, faceName) {
  const local = LOCAL_FACES[faceName];
  if (!local) return null;
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(rotationDeg?.x || 0),
    THREE.MathUtils.degToRad(rotationDeg?.y || 0),
    THREE.MathUtils.degToRad(rotationDeg?.z || 0)
  );
  const worldNormal = new THREE.Vector3(local.x, local.y, local.z).applyEuler(euler);
  for (const axis of ['x', 'y', 'z']) {
    const alignment = worldNormal.dot(AXIS_VECTORS[axis]);
    if (Math.abs(Math.abs(alignment) - 1) <= 0.02) {
      return { axis, sign: alignment >= 0 ? 1 : -1 };
    }
  }
  return null;
}

// Representative face for each dimension field — used both to find
// "which axis does field X line up with" (axisForDimensionField,
// below applySpansBetween) and "which field lines up with axis Y"
// (inferSpanField, right below) — one shared table so both
// directions of this lookup can never quietly drift apart.
const DIM_FIELD_PROBE_FACE = { width: 'right', height: 'top', thickness: 'front' };

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
    if (aligned && aligned.axis === axis) return { field, axis };
  }
  return { error: `This panel has no dimension that lines up with the ${axis.toUpperCase()} axis at its current rotation.` };
}

// World-space position (mm, along axisKey) of a referenced face.
function resolveFacePointMm(faceRef, axisKey, resolvedById, byId) {
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
  const autoPositions = computeAutoLayoutPositions(panels);
  const resolvedById = new Map();

  panels.forEach((node) => {
    resolvedById.set(node.id, emptyResolved(node, autoPositions.get(node.id)));
  });

  const { order, cyclic } = topoSort(panels);

  order.forEach((id) => {
    const node = byId.get(id);
    const r = resolvedById.get(id);

    if (cyclic.has(id)) {
      r.warnings.push('part of a circular relation (A depends on B which depends on A) — using its last literal values');
      return;
    }

    (node.constraints || []).forEach((constraint) => {
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
