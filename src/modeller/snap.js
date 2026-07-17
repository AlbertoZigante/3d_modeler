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

function emptyResolved(node, autoPos) {
  return {
    id: node.id,
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
      // found a cycle — mark everyone currently on the stack from
      // the repeat point onward as cyclic
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

function worldNormalAndAlignment(rotationDeg, faceName, axisKey) {
  const local = LOCAL_FACES[faceName];
  if (!local) return null;
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(rotationDeg.x || 0),
    THREE.MathUtils.degToRad(rotationDeg.y || 0),
    THREE.MathUtils.degToRad(rotationDeg.z || 0)
  );
  const worldNormal = new THREE.Vector3(local.x, local.y, local.z).applyEuler(euler);
  const axisVec = axisKey === 'x' ? new THREE.Vector3(1, 0, 0)
    : axisKey === 'y' ? new THREE.Vector3(0, 1, 0)
    : new THREE.Vector3(0, 0, 1);
  const alignment = worldNormal.dot(axisVec);
  return alignment; // ~+1 or ~-1 if aligned with this axis; otherwise not usable
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
  const alignment = worldNormalAndAlignment(targetResolved.rotation, faceRef.face, axisKey);
  if (alignment == null || Math.abs(Math.abs(alignment) - 1) > 0.02) {
    throw new Error(
      `"${faceRef.face}" face of ${faceRef.node} isn't aligned with the ${axisKey.toUpperCase()} axis at its ` +
      `current rotation — angled/non-axis-aligned relations aren't supported yet`
    );
  }
  const sign = alignment >= 0 ? 1 : -1;
  const dimField = FACE_TO_DIM_FIELD[faceRef.face];
  const halfExtentMm = targetResolved[dimField] / 2;
  const centerMm = targetResolved.position[axisKey];
  const offsetMm = faceRef.offset || 0;
  return centerMm + sign * (halfExtentMm + offsetMm);
}

function applySpansBetween(node, constraint, resolvedById, byId, r) {
  const axisKey = FIELD_TO_AXIS[constraint.field];
  const fromMm = resolveFacePointMm(constraint.from, axisKey, resolvedById, byId);
  const toMm = resolveFacePointMm(constraint.to, axisKey, resolvedById, byId);
  const span = Math.max(MIN_PANEL_DIM_MM, Math.abs(toMm - fromMm));
  r[constraint.field] = span;
  r.lockedFields[constraint.field] = true;
  // A dimension constraint also centers the node on that axis unless
  // that exact axis already has its own explicit position constraint
  // — simple, predictable default ("shelf fits between and is
  // centered on its two supports") without fighting a more specific
  // attachedTo constraint on the same axis.
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
  const myAlignment = worldNormalAndAlignment(r.rotation, constraint.myFace, axisKey);
  if (myAlignment == null || Math.abs(Math.abs(myAlignment) - 1) > 0.02) {
    throw new Error(
      `this panel's own "${constraint.myFace}" face isn't aligned with the ${axisKey.toUpperCase()} axis ` +
      `at its current rotation — angled/non-axis-aligned relations aren't supported yet`
    );
  }
  const mySign = myAlignment >= 0 ? 1 : -1;
  const dimField = FACE_TO_DIM_FIELD[constraint.myFace];
  const myHalfExtentMm = r[dimField] / 2;
  r.position[axisKey] = targetMm - mySign * myHalfExtentMm;
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
