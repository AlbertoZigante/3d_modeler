/**
 * 2D (front elevation) view: an orthographic camera looking down -Z,
 * plus PowerPoint-style direct manipulation — drag a selected panel's
 * body to translate it, drag one of its four edge handles to resize
 * it — instead of the 3D gizmos.
 *
 * ARCHITECTURE: this does NOT duplicate the reconciler, mesh
 * registry, or selection logic. It's handed the SAME Three.js scene
 * and mesh registry scene.js already owns, and only swaps which
 * camera is active and which interaction layer is listening to
 * pointer events. Every panel is still the same mesh; BOM, relations,
 * the box preset, and locked-field logic are completely unaffected
 * by which view is on screen, because none of that ever depended on
 * a specific camera or interaction style.
 *
 * "Front" means looking down -Z: a vertical panel shows its true
 * width×height silhouette. A box preset's left/right side panels
 * (rotated 90° about Y to form the box's sides) will appear as thin
 * edge-on slivers here — that's physically correct (a cabinet side
 * really does look like a thin line from the front), not a bug.
 *
 * NO ROTATION: orientation is fixed at creation time (the Vertical/
 * Horizontal buttons in the panel list bake `rotation` in directly —
 * see modeller-main.js) and is never user-adjustable afterwards, in
 * either view — see gizmos.js for the same decision on the 3D side.
 * There is deliberately no rotate handle here.
 *
 * RESIZE IS AXIS-RESTRICTED BY ORIENTATION: only a field that
 * currently lines up with world X or Y is 2D-edge-draggable at all —
 * a Vertical panel's width lines up with Z (not draggable here, only
 * its height/Y is); a Horizontal panel's height lines up with Z (only
 * its width/X is); a Parallel panel (identity rotation) has BOTH
 * width->X and height->Y, so it gets all four handles. This is
 * computed directly from rotation via getAlignedAxis (imported from
 * modules.js) rather than a hardcoded Vertical/Horizontal check, so
 * it's correct for any current or future orientation, not just two.
 * Thickness is never 2D-edge-draggable regardless of orientation,
 * since a front-on view has no way to grab a face lying along its own
 * view axis — that field stays inspector-only (or, in 3D, a face-drag
 * if it happens to line up with X/Y/Z there — see gizmos.js).
 *
 * RESIZE is ASYMMETRIC — dragging an edge out by X moves only that
 * edge; the opposite edge's world position stays exactly fixed. That
 * means a resize here also shifts the panel's `offset` (its center
 * moves by half the growth, toward the dragged edge) — see
 * computeResizeResult() below, and modeller-main.js's
 * onDimensionChange handler for how that shift gets accumulated onto
 * the node's existing offset rather than replacing it.
 */
import * as THREE from 'three';
import { MM_TO_UNIT, MIN_PANEL_DIM_MM, getAlignedAxis } from './modules.js';

const RESIZE_HANDLE_COLOR = 0xd97742; // "this is draggable" accent

// Which field (if any) currently lines up with a given WORLD axis, for
// a panel's FIXED rotation (never changes after creation — no rotate
// UI exists anywhere in the app). Used to decide which edge handles
// are meaningful to show at all, for whatever orientation this
// specific panel happens to have.
function fieldAlignedToAxis(mesh, worldAxis) {
  const rotationDeg = {
    x: THREE.MathUtils.radToDeg(mesh.rotation.x),
    y: THREE.MathUtils.radToDeg(mesh.rotation.y),
    z: THREE.MathUtils.radToDeg(mesh.rotation.z),
  };
  if (getAlignedAxis(rotationDeg, 'right')?.axis === worldAxis) return 'width';
  if (getAlignedAxis(rotationDeg, 'top')?.axis === worldAxis) return 'height';
  return null; // thickness lines up with this axis instead — not 2D-editable
}

export function create2DControls(
  canvas,
  camera,
  scene,
  meshRegistry,
  { onSelect, onTransformChange, onDimensionChange, onGroupDragStart, onGroupTransformChange, isFacePickMode, onFacePick, getSelectedId } = {}
) {
  const raycaster = new THREE.Raycaster();
  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

  // ---- resize-handle visuals: left/right (width) + top/bottom (height) ----
  // Children of one group so they inherit the panel's rotation for free.
  const edgeHandleGroup = new THREE.Group();
  const edgeHandles = {};
  ['left', 'right'].forEach((key) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.05, 0.16),
      new THREE.MeshBasicMaterial({ color: RESIZE_HANDLE_COLOR, depthTest: false })
    );
    mesh.renderOrder = 10;
    edgeHandleGroup.add(mesh);
    edgeHandles[key] = mesh;
  });
  ['top', 'bottom'].forEach((key) => {
    const mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.16, 0.05),
      new THREE.MeshBasicMaterial({ color: RESIZE_HANDLE_COLOR, depthTest: false })
    );
    mesh.renderOrder = 10;
    edgeHandleGroup.add(mesh);
    edgeHandles[key] = mesh;
  });
  edgeHandleGroup.visible = false;
  scene.add(edgeHandleGroup);

  const EDGE_TO_FIELD = { left: 'width', right: 'width', top: 'height', bottom: 'height' };

  let currentMesh = null; // the mesh the handles currently follow
  let groupMembers = null; // array of meshes when a WHOLE group (not a drilled-into member) is selected

  function screenToWorld(e) {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    const point = new THREE.Vector3();
    raycaster.ray.intersectPlane(dragPlane, point);
    return point;
  }

  function meshHalfExtents(mesh) {
    // width/height/thickness in WORLD units. Static geometry
    // parameters alone aren't enough — during a live resize drag,
    // mesh.scale is what's actually moving the visual edge (geometry
    // itself isn't rebuilt until the drag ends), so it has to be
    // factored in or the handle would visibly lag behind the real
    // edge position while dragging.
    const params = mesh.geometry.parameters;
    return {
      halfW: (params.width / 2) * mesh.scale.x,
      halfH: (params.height / 2) * mesh.scale.y,
      depth: params.depth * mesh.scale.z,
    };
  }

  function positionHandle(mesh) {
    const { halfW, halfH } = meshHalfExtents(mesh);
    const lockedFields = mesh.userData.lockedFields || {};
    const xEditable = fieldAlignedToAxis(mesh, 'x') === 'width';
    const yEditable = fieldAlignedToAxis(mesh, 'y') === 'height';

    edgeHandleGroup.position.set(mesh.position.x, mesh.position.y, mesh.position.z + 0.01);
    edgeHandleGroup.rotation.z = mesh.rotation.z; // panels can still have a FIXED rotation set at creation
    edgeHandles.left.position.set(-halfW, 0, 0);
    edgeHandles.right.position.set(halfW, 0, 0);
    edgeHandles.top.position.set(0, halfH, 0);
    edgeHandles.bottom.position.set(0, -halfH, 0);

    // Two gates on each handle: (1) hidden if its dimension is
    // currently derived from a constraint — dragging it would mean
    // nothing until that link is explicitly broken in the inspector;
    // (2) hidden if that field doesn't currently line up with the
    // axis this handle controls — e.g. left/right only make sense
    // when width lines up with world X. A Parallel panel has both
    // width->X and height->Y, so it gets all four; Vertical/
    // Horizontal panels only ever get one axis's pair.
    edgeHandles.left.visible = !lockedFields.width && xEditable;
    edgeHandles.right.visible = !lockedFields.width && xEditable;
    edgeHandles.top.visible = !lockedFields.height && yEditable;
    edgeHandles.bottom.visible = !lockedFields.height && yEditable;
  }

  // ---- pointer / drag state ----
  let mode = null; // null | 'translate' | 'group-translate' | 'resize'
  let draggedMesh = null;
  let dragStartWorld = null;
  let dragStartMeshPos = null;
  let resizeEdgeKey = null;
  let resizeStartMm = null; // { width, height, thickness } at drag start
  let groupDragStart = null; // { nodeIds, startWorld, startPositions: Map<mesh, Vector3> } — set only during 'group-translate'
  const gestureState = { moved: false, downX: 0, downY: 0 };

  function meshList() {
    return Array.from(meshRegistry.values()).map((entry) => entry.mesh);
  }

  function visibleEdgeHandleList() {
    return Object.values(edgeHandles).filter((m) => m.visible);
  }

  // Collinear face-pick mode (2D): no drag handles exist here — a
  // click is mapped straight to whichever of the panel's 4 screen
  // edges (left/right/top/bottom) is CLOSEST to the click point in
  // the panel's own local frame, normalized by that edge's own half-
  // extent so it works regardless of the panel's aspect ratio.
  // Thickness (front/back) is never reachable this way, since a
  // front-elevation view has no edge lying along its own view axis —
  // naturally satisfies "never touch thickness" for the 2D path.
  function nearestEdgeFaceName(mesh, worldPoint) {
    const { halfW, halfH } = meshHalfExtents(mesh);
    const rot = mesh.rotation.z;
    const cosInv = Math.cos(-rot), sinInv = Math.sin(-rot);
    const dx = worldPoint.x - mesh.position.x;
    const dy = worldPoint.y - mesh.position.y;
    const lx = dx * cosInv - dy * sinInv;
    const ly = dx * sinInv + dy * cosInv;
    const nx = halfW > 0 ? Math.abs(lx) / halfW : 0;
    const ny = halfH > 0 ? Math.abs(ly) / halfH : 0;
    if (nx >= ny) return lx >= 0 ? 'right' : 'left';
    return ly >= 0 ? 'top' : 'bottom';
  }

  function hitTest(e, objects) {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    return raycaster.intersectObjects(objects, false);
  }

  function handlePointerDown(e) {
    gestureState.moved = false;
    gestureState.downX = e.clientX;
    gestureState.downY = e.clientY;

    if (isFacePickMode?.()) return; // suspend all normal drag-start logic — the pick itself happens on pointerup, click-only

    // edge (resize) handles take priority, same "must already be
    // selected" gate as before
    if (edgeHandleGroup.visible) {
      const edgeHits = hitTest(e, visibleEdgeHandleList());
      if (edgeHits.length > 0) {
        const hitMesh = edgeHits[0].object;
        resizeEdgeKey = Object.keys(edgeHandles).find((key) => edgeHandles[key] === hitMesh);
        mode = 'resize';
        draggedMesh = currentMesh;
        const { halfW, halfH, depth } = meshHalfExtents(draggedMesh);
        resizeStartMm = {
          width: (halfW * 2) / MM_TO_UNIT,
          height: (halfH * 2) / MM_TO_UNIT,
          thickness: depth / MM_TO_UNIT,
        };
        dragStartWorld = screenToWorld(e);
        dragStartMeshPos = draggedMesh.position.clone();
        return;
      }
    }

    const hits = hitTest(e, meshList());
    if (hits.length > 0) {
      const hitMesh = hits[0].object;
      if (groupMembers && groupMembers.includes(hitMesh)) {
        // The whole group is currently selected (not drilled into one
        // member) — drag every member rigidly as a single unit instead
        // of just the one panel under the cursor.
        mode = 'group-translate';
        groupDragStart = {
          nodeIds: groupMembers.map((m) => m.userData.nodeId),
          startWorld: screenToWorld(e),
          startPositions: new Map(groupMembers.map((m) => [m, m.position.clone()])),
        };
        onGroupDragStart?.(groupDragStart.nodeIds);
      } else {
        mode = 'translate';
        draggedMesh = hitMesh;
        dragStartWorld = screenToWorld(e);
        dragStartMeshPos = draggedMesh.position.clone();
      }
    } else {
      mode = null;
      draggedMesh = null;
    }
  }

  // Shared by pointermove (live preview) and pointerup (final commit)
  // so the two can never disagree. ASYMMETRIC: the dragged edge moves
  // 1:1 with the cursor; the opposite edge must then stay fixed, so
  // the panel's center shifts by half the growth, along the same
  // local axis, in the same outward direction — mirrors gizmos.js's
  // 3D face-drag math exactly, just rotated by rotation.z instead of
  // a full 3D quaternion.
  function computeResizeResult(e) {
    const world = screenToWorld(e);
    const rot = draggedMesh.rotation.z;
    const cosInv = Math.cos(-rot), sinInv = Math.sin(-rot);
    const dx0 = world.x - dragStartMeshPos.x, dy0 = world.y - dragStartMeshPos.y;
    const lx = dx0 * cosInv - dy0 * sinInv;
    const ly = dx0 * sinInv + dy0 * cosInv;

    const isWidthEdge = resizeEdgeKey === 'left' || resizeEdgeKey === 'right';
    const outwardSign = resizeEdgeKey === 'right' || resizeEdgeKey === 'top' ? 1 : -1;
    const local = isWidthEdge ? lx : ly;
    const scalarMm = (outwardSign * local) / MM_TO_UNIT;

    const field = EDGE_TO_FIELD[resizeEdgeKey];
    const startMm = resizeStartMm[field];
    const newMm = Math.max(MIN_PANEL_DIM_MM, startMm + scalarMm);
    const growthMm = newMm - startMm;
    const shiftMm = (growthMm / 2) * outwardSign; // along the LOCAL outward axis

    const localShiftX = isWidthEdge ? shiftMm : 0;
    const localShiftY = isWidthEdge ? 0 : shiftMm;
    const cosFwd = Math.cos(rot), sinFwd = Math.sin(rot);
    const worldShiftXmm = localShiftX * cosFwd - localShiftY * sinFwd;
    const worldShiftYmm = localShiftX * sinFwd + localShiftY * cosFwd;

    return { isWidthEdge, field, startMm, newMm, worldShiftXmm, worldShiftYmm };
  }

  function handlePointerMove(e) {
    const dx = e.clientX - gestureState.downX;
    const dy = e.clientY - gestureState.downY;
    if (Math.abs(dx) + Math.abs(dy) > 3) gestureState.moved = true;

    if (mode === 'translate' && draggedMesh) {
      const world = screenToWorld(e);
      let dxWorld = world.x - dragStartWorld.x;
      let dyWorld = world.y - dragStartWorld.y;
      if (e.shiftKey) {
        // constrain to whichever single axis (X or Y) has moved more
        if (Math.abs(dxWorld) >= Math.abs(dyWorld)) dyWorld = 0;
        else dxWorld = 0;
      }
      const lock = draggedMesh.userData.lockedFields || {};
      draggedMesh.position.x = lock.positionX ? dragStartMeshPos.x : dragStartMeshPos.x + dxWorld;
      draggedMesh.position.y = lock.positionY ? dragStartMeshPos.y : dragStartMeshPos.y + dyWorld;
      if (draggedMesh === currentMesh) positionHandle(draggedMesh);
      reportTransform(draggedMesh);
    } else if (mode === 'group-translate' && groupDragStart) {
      const world = screenToWorld(e);
      let dxWorld = world.x - groupDragStart.startWorld.x;
      let dyWorld = world.y - groupDragStart.startWorld.y;
      if (e.shiftKey) {
        if (Math.abs(dxWorld) >= Math.abs(dyWorld)) dyWorld = 0;
        else dxWorld = 0;
      }
      const deltaMm = { x: dxWorld / MM_TO_UNIT, y: dyWorld / MM_TO_UNIT, z: 0 };
      // The caller may return a CORRECTED delta (e.g. clamped to the
      // scene's design limits) — if so, use that for the live mesh
      // positions instead of the raw drag delta, same reasoning as
      // gizmos.js's 3D group-drag branch.
      const corrected = onGroupTransformChange?.(groupDragStart.nodeIds, deltaMm);
      const finalDeltaMm = corrected || deltaMm;
      groupDragStart.startPositions.forEach((startPos, mesh) => {
        mesh.position.x = startPos.x + finalDeltaMm.x * MM_TO_UNIT;
        mesh.position.y = startPos.y + finalDeltaMm.y * MM_TO_UNIT;
      });
    } else if (mode === 'resize' && draggedMesh) {
      const { isWidthEdge, startMm, newMm, worldShiftXmm, worldShiftYmm } = computeResizeResult(e);

      draggedMesh.scale[isWidthEdge ? 'x' : 'y'] = newMm / startMm; // live visual feedback only
      draggedMesh.position.x = dragStartMeshPos.x + worldShiftXmm * MM_TO_UNIT;
      draggedMesh.position.y = dragStartMeshPos.y + worldShiftYmm * MM_TO_UNIT;
      positionHandle(draggedMesh); // keep handles glued to the (visually) resizing panel
    }
  }

  function handlePointerUp(e) {
    if (isFacePickMode?.()) {
      if (!gestureState.moved) {
        const hits = hitTest(e, meshList());
        if (hits.length > 0) {
          const mesh = hits[0].object;
          const faceName = nearestEdgeFaceName(mesh, screenToWorld(e));
          onFacePick?.(mesh.userData.nodeId, faceName);
        }
      }
      return; // pick mode suspends select/resize/translate entirely
    }

    if (!gestureState.moved && mode !== 'resize') {
      // plain click (no drag): select whatever's under the pointer,
      // or deselect if empty space
      const hits = hitTest(e, meshList());
      onSelect?.(hits.length > 0 ? hits[0].object.userData.nodeId : null, e.ctrlKey || e.metaKey);
    }

    if (mode === 'resize' && draggedMesh) {
      const { field, newMm, worldShiftXmm, worldShiftYmm } = computeResizeResult(e);

      const dims = { ...resizeStartMm };
      dims[field] = newMm;

      // worldShiftXmm/Ymm are already in mm — no MM_TO_UNIT conversion
      // needed here (that conversion is only for the transient THREE-
      // units preview in handlePointerMove).
      const offsetDeltaMm = { x: worldShiftXmm, y: worldShiftYmm, z: 0 };
      const nodeId = draggedMesh.userData.nodeId;

      draggedMesh.scale.set(1, 1, 1); // bake into geometry on next reconcile
      draggedMesh.position.copy(dragStartMeshPos); // reconcile() will set the true final position

      // Clear drag state BEFORE calling onDimensionChange: it
      // synchronously triggers a full renderAll()/reconcile(), and
      // reconcile() checks isDragging()/draggedMeshRef() to decide
      // whether to skip repositioning THIS mesh (on the assumption a
      // drag is still live and driving it). If mode/draggedMesh were
      // still 'resize'/this mesh during that render, reconcile would
      // wrongly skip it and leave the mesh at the transform we just
      // reset it to above — which is exactly the "only becomes
      // asymmetric after deselecting" bug: the correct asymmetric
      // result was already in the graph, it just never got drawn
      // until some later, unrelated render finally saw isDragging()
      // as false.
      mode = null;
      draggedMesh = null;
      resizeEdgeKey = null;
      resizeStartMm = null;

      onDimensionChange?.(nodeId, dims, offsetDeltaMm);
      return;
    }

    // group-translate needs no special commit step, same reasoning as
    // plain 'translate': onGroupTransformChange already patched the
    // graph live on every pointermove, and the meshes are already at
    // their final visual position — nothing further to reconcile.
    mode = null;
    draggedMesh = null;
    resizeEdgeKey = null;
    resizeStartMm = null;
    groupDragStart = null;
  }

  function reportTransform(mesh) {
    if (!onTransformChange) return;
    onTransformChange(mesh.userData.nodeId, {
      offsetDelta: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z },
      rotation: {
        x: THREE.MathUtils.radToDeg(mesh.rotation.x),
        y: THREE.MathUtils.radToDeg(mesh.rotation.y),
        z: THREE.MathUtils.radToDeg(mesh.rotation.z),
      },
    });
  }

  canvas.addEventListener('pointerdown', handlePointerDown);
  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', handlePointerUp);

  // ---- pan (drag empty space) + zoom (adjust ortho frustum) ----
  let panning = false;
  let panStartWorld = null;

  function handlePanPointerDown(e) {
    if (mode) return; // a panel/handle drag already claimed this gesture
    const hits = hitTest(e, meshList());
    const edgeHit = edgeHandleGroup.visible ? hitTest(e, visibleEdgeHandleList()) : [];
    if (hits.length === 0 && edgeHit.length === 0) {
      panning = true;
      panStartWorld = screenToWorld(e);
    }
  }
  function handlePanPointerMove(e) {
    if (!panning) return;
    const world = screenToWorld(e);
    camera.position.x -= world.x - panStartWorld.x;
    camera.position.y -= world.y - panStartWorld.y;
    camera.updateProjectionMatrix();
  }
  function handlePanPointerUp() {
    panning = false;
  }
  canvas.addEventListener('pointerdown', handlePanPointerDown);
  window.addEventListener('pointermove', handlePanPointerMove);
  window.addEventListener('pointerup', handlePanPointerUp);

  function handleWheel(e) {
    e.preventDefault();
    const zoomFactor = Math.exp(e.deltaY * 0.001);
    camera.zoom = Math.max(0.2, Math.min(6, camera.zoom * zoomFactor));
    camera.updateProjectionMatrix();
  }
  canvas.addEventListener('wheel', handleWheel, { passive: false });

  function isDragging() {
    return mode !== null;
  }

  // called by scene.js's reconcile() every pass with the currently
  // selected mesh (or null) so the handles follow selection/edits.
  // Mutually exclusive with setSelectedGroup below — drilling into a
  // specific member always clears any whole-group drag eligibility.
  function setSelectedMesh(mesh) {
    currentMesh = mesh;
    groupMembers = null;
    edgeHandleGroup.visible = !!mesh; //
    if (mesh) positionHandle(mesh);
  }

  // Called instead of setSelectedMesh when a GROUP is selected as a
  // whole (not drilled into one member) — no resize handles (resizing
  // a whole group isn't supported), but clicking-and-dragging any
  // member's body now moves the whole group rigidly (see
  // handlePointerDown above).
  function setSelectedGroup(memberMeshes) {
    groupMembers = memberMeshes && memberMeshes.length > 0 ? memberMeshes : null;
    currentMesh = null;
    edgeHandleGroup.visible = false;
  }

  // Used by scene.js's reconcile() to skip forcibly repositioning a
  // mesh currently being live-driven by an in-progress group drag.
  function isGroupMember(mesh) {
    return !!(groupDragStart && groupDragStart.startPositions.has(mesh));
  }

  function dispose() {
    canvas.removeEventListener('pointerdown', handlePointerDown);
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    canvas.removeEventListener('pointerdown', handlePanPointerDown);
    window.removeEventListener('pointermove', handlePanPointerMove);
    window.removeEventListener('pointerup', handlePanPointerUp);
    canvas.removeEventListener('wheel', handleWheel);
    scene.remove(edgeHandleGroup);
    Object.values(edgeHandles).forEach((m) => {
      m.geometry.dispose();
      m.material.dispose();
    });
  }

  return { isDragging, setSelectedMesh, setSelectedGroup, isGroupMember, draggedMeshRef: () => draggedMesh, dispose };
}
