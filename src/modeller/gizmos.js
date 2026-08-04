/**
 * Move gizmo (TransformControls), plus a hand-rolled RESIZE using
 * visible dot handles at each face center — extracted out of scene.js
 * so that file's reconciler isn't also managing gizmo event wiring.
 *
 * NO ROTATION GIZMO: orientation is fixed at creation time (the
 * Vertical/Horizontal buttons in the panel list bake `rotation` in
 * directly — see modeller-main.js's addVerticalPanel/
 * addHorizontalPanel) and is never user-adjustable afterwards, in
 * either view. There is deliberately no rotate handle here.
 *
 * STAGE 2 ADDITION: `attachTo(mesh, lockedFields)` can hide specific
 * axis handles on the move gizmo (and the matching pair of resize
 * dots) when the corresponding field is under active constraint —
 * dragging a derived value doesn't mean anything until the user has
 * explicitly broken that link in the inspector.
 *
 * SHIFT-TO-CONSTRAIN: holding Shift while dragging the move gizmo
 * locks the drag to whichever single axis (X, Y, or Z) has moved the
 * most since the drag started, snapping the other two back to their
 * value at drag-start. This matters most when dragging one of the
 * small plane handles (which normally move two axes freely at once)
 * — with Shift held it behaves like a single-axis arrow instead.
 *
 * RESIZE: six dot handles exist (one per face) but only the four on
 * width/height faces (right/left/top/bottom) are ever interactive —
 * the front/back pair (thickness) is permanently hidden, since
 * thickness can only change by selecting a different Material in the
 * inspector (see modeller-main.js's updateSelectedField), never by
 * dragging. Matches the visual language of the app's other draggable
 * handles (same accent color as 2D's edge handles). Dragging a dot is
 * ASYMMETRIC: only the dragged face moves; the OPPOSITE face's world
 * position stays exactly fixed, same convention as 2D's edge-drag in
 * view2d.js. That means resizing this way changes the panel's
 * position (its `offset`), not just its dimension — see the shift
 * math in handleFacePointerMove/Up below, and see modeller-main.js's
 * onDimensionChange handler for how that shift gets ACCUMULATED onto
 * the node's existing offset rather than replacing it.
 */
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { MM_TO_UNIT, MIN_PANEL_DIM_MM, LOCAL_FACES, FACE_TO_DIM_FIELD } from './modules.js';

const RESIZE_HANDLE_COLOR = 0xd97742; // same accent 2D's edge/rotate handles used — "this is draggable"
const HANDLE_RADIUS_UNITS = 0.022;

export function createGizmos(camera, canvas, scene, { onTransformChange, onDimensionChange, gestureState } = {}) {
  const transformMove = new TransformControls(camera, canvas);
  transformMove.setMode('translate');
  transformMove.setSize(0.9);
  scene.add(transformMove.getHelper());

  const allControls = [transformMove];

  for (const tc of allControls) {
    tc.addEventListener('mouseDown', () => {
      if (gestureState) gestureState.interactionHandled = true;
    });
  }

  function isDragging() {
    return transformMove.dragging || !!faceDrag;
  }

  // ---- Shift-to-constrain-to-one-axis (move gizmo only) ----
  let shiftKeyDown = false;
  function handleKeyDown(e) { if (e.key === 'Shift') shiftKeyDown = true; }
  function handleKeyUp(e) { if (e.key === 'Shift') shiftKeyDown = false; }
  window.addEventListener('keydown', handleKeyDown);
  window.addEventListener('keyup', handleKeyUp);

  let moveDragStart = null; // { x, y, z } world position at the start of a move-gizmo drag

  transformMove.addEventListener('mouseDown', () => {
    if (transformMove.object) moveDragStart = { ...transformMove.object.position };
  });
  transformMove.addEventListener('mouseUp', () => {
    moveDragStart = null;
  });
  transformMove.addEventListener('objectChange', () => {
    const mesh = transformMove.object;
    if (!mesh || !moveDragStart || !shiftKeyDown) return;
    const dx = mesh.position.x - moveDragStart.x;
    const dy = mesh.position.y - moveDragStart.y;
    const dz = mesh.position.z - moveDragStart.z;
    const absX = Math.abs(dx), absY = Math.abs(dy), absZ = Math.abs(dz);
    const dominant = absX >= absY && absX >= absZ ? 'x' : absY >= absZ ? 'y' : 'z';
    if (dominant !== 'x') mesh.position.x = moveDragStart.x;
    if (dominant !== 'y') mesh.position.y = moveDragStart.y;
    if (dominant !== 'z') mesh.position.z = moveDragStart.z;
  });

  function reportTransform(mesh) {
    if (!onTransformChange) return;
    onTransformChange(mesh.userData.nodeId, {
      offsetDelta: { x: mesh.position.x, y: mesh.position.y, z: mesh.position.z }, // caller converts vs. its own base
      rotation: {
        x: THREE.MathUtils.radToDeg(mesh.rotation.x),
        y: THREE.MathUtils.radToDeg(mesh.rotation.y),
        z: THREE.MathUtils.radToDeg(mesh.rotation.z),
      },
    });
  }

  transformMove.addEventListener('objectChange', () => {
    if (transformMove.object) reportTransform(transformMove.object);
    if (transformMove.object) positionResizeHandles(transformMove.object);
  });

  // ---- resize (visible dot handles, one per face) ----
  let getMeshEntry = null; // injected by scene.js: (mesh) => { lastDims } | undefined
  const raycaster = new THREE.Raycaster();
  let faceDrag = null; // { mesh, nodeId, axisKey, sign, field, dimsStartMm: {w,h,t}, worldNormal, axisOrigin, startParam, lastParam, dragStartMeshPos }

  const resizeHandleGroup = new THREE.Group();
  resizeHandleGroup.visible = false;
  scene.add(resizeHandleGroup);

  const FACE_NAMES = ['right', 'left', 'top', 'bottom', 'front', 'back'];
  const handleGeometry = new THREE.SphereGeometry(HANDLE_RADIUS_UNITS, 12, 12);
  const resizeHandles = {}; // faceName -> mesh
  FACE_NAMES.forEach((faceName) => {
    const dot = new THREE.Mesh(handleGeometry, new THREE.MeshBasicMaterial({ color: RESIZE_HANDLE_COLOR, depthTest: false }));
    dot.renderOrder = 10;
    dot.userData.faceName = faceName;
    resizeHandleGroup.add(dot);
    resizeHandles[faceName] = dot;
  });

  // Positions the six dot handles at the CURRENTLY ATTACHED mesh's
  // face centers, in world space — called from attachTo() every
  // reconcile pass (keeps them glued through ordinary dimension/
  // position updates), and again on every resize pointermove (keeps
  // the dragged dot visually riding the live-resizing face).
  function positionResizeHandles(mesh) {
    const p = mesh.geometry.parameters; // BoxGeometry(width, height, depth)
    const halfW = p.width / 2, halfH = p.height / 2, halfT = p.depth / 2;
    const lockedFields = mesh.userData.lockedFields || {};

    resizeHandleGroup.position.copy(mesh.position);
    resizeHandleGroup.quaternion.copy(mesh.quaternion);

    resizeHandles.right.position.set(halfW, 0, 0);
    resizeHandles.left.position.set(-halfW, 0, 0);
    resizeHandles.top.position.set(0, halfH, 0);
    resizeHandles.bottom.position.set(0, -halfH, 0);
    resizeHandles.front.position.set(0, 0, halfT);
    resizeHandles.back.position.set(0, 0, -halfT);

    resizeHandles.right.visible = !lockedFields.width;
    resizeHandles.left.visible = !lockedFields.width;
    resizeHandles.top.visible = !lockedFields.height;
    resizeHandles.bottom.visible = !lockedFields.height;
    // Thickness is never drag-resizable, constraint or not — it's
    // only ever changed by selecting a different Material in the
    // inspector (see modeller-main.js's updateSelectedField).
    resizeHandles.front.visible = false;
    resizeHandles.back.visible = false;
  }

  function visibleResizeHandleList() {
    return FACE_NAMES.map((n) => resizeHandles[n]).filter((m) => m.visible);
  }

  // Returns the signed distance, along a given world-space axis line
  // (axisOrigin + t*axisDir), to the point on that line closest to
  // the camera ray through the current mouse position — the standard
  // closest-point-between-two-3D-lines solution. This is exact for a
  // PERSPECTIVE camera at any distance: the old approach (project a
  // reference point once, reuse that fixed NDC depth to unproject
  // pixel deltas for the rest of the drag) drifts more and more as
  // the dragged point's true depth-from-camera changes — which it
  // does here, since resizing also shifts the mesh's position. Using
  // the ray/line intersection instead means there's no "stale depth"
  // to drift from in the first place.
  function axisDragParameter(e, axisOrigin, axisDir) {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    const rayOrigin = raycaster.ray.origin;
    const rayDir = raycaster.ray.direction; // THREE keeps this normalized

    const w0 = new THREE.Vector3().subVectors(axisOrigin, rayOrigin);
    const a = rayDir.dot(rayDir);
    const b = rayDir.dot(axisDir);
    const c = axisDir.dot(axisDir);
    const d = rayDir.dot(w0);
    const eDot = axisDir.dot(w0);
    const denom = a * c - b * b;

    if (Math.abs(denom) < 1e-6) return faceDrag ? faceDrag.lastParam : 0; // camera looking straight down the drag axis — degenerate, hold position rather than producing a wild value
    return -(a * eDot - b * d) / denom; // signed world-unit distance along axisDir from axisOrigin
  }

  function handleFacePointerDown(e) {
    const mesh = transformMove.object; // "the selected mesh" — move/resize share it
    if (!mesh || !getMeshEntry || !resizeHandleGroup.visible) return;

    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObjects(visibleResizeHandleList(), false);
    if (hits.length === 0) return; // missed every dot — normal orbit/select flow continues

    const faceName = hits[0].object.userData.faceName;
    const local = LOCAL_FACES[faceName]; // e.g. { x: 1, y: 0, z: 0 } for 'right'
    const axisKey = local.x !== 0 ? 'x' : local.y !== 0 ? 'y' : 'z';
    const sign = (local.x || local.y || local.z) > 0 ? 1 : -1;
    const field = FACE_TO_DIM_FIELD[faceName];

    const entry = getMeshEntry(mesh);
    if (!entry) return;

    const worldNormal = new THREE.Vector3(local.x, local.y, local.z).transformDirection(mesh.matrixWorld);
    const axisOrigin = hits[0].point.clone();

    if (gestureState) gestureState.interactionHandled = true;
    faceDrag = {
      mesh,
      nodeId: mesh.userData.nodeId,
      axisKey,
      sign,
      field,
      dimsStartMm: {
        w: entry.lastDims.w / MM_TO_UNIT,
        h: entry.lastDims.h / MM_TO_UNIT,
        t: entry.lastDims.t / MM_TO_UNIT,
      },
      worldNormal,
      axisOrigin,
      startParam: axisDragParameter(e, axisOrigin, worldNormal),
      lastParam: 0,
      dragStartMeshPos: mesh.position.clone(),
    };
  }

  function computeAsymmetricResize(e) {
    const currentParam = axisDragParameter(e, faceDrag.axisOrigin, faceDrag.worldNormal);
    faceDrag.lastParam = currentParam;
    const scalarMm = (currentParam - faceDrag.startParam) / MM_TO_UNIT;

    const dimKey = { x: 'w', y: 'h', z: 't' }[faceDrag.axisKey];
    const startMm = faceDrag.dimsStartMm[dimKey];
    // ASYMMETRIC: the dragged face moves by exactly scalarMm (1:1 with
    // the cursor) — the opposite face must then stay fixed, so the
    // panel's CENTER has to shift by half of the growth, in the same
    // direction the dragged face moved.
    const newMm = Math.max(MIN_PANEL_DIM_MM, startMm + scalarMm);
    const growthMm = newMm - startMm;
    const shiftMm = growthMm / 2; // along worldNormal — see file header math

    return { newMm, startMm, shiftMm };
  }

  function handleFacePointerMove(e) {
    if (!faceDrag) return;
    const { newMm, startMm, shiftMm } = computeAsymmetricResize(e);

    faceDrag.mesh.scale[faceDrag.axisKey] = newMm / startMm; // live visual feedback only
    faceDrag.mesh.position
      .copy(faceDrag.dragStartMeshPos)
      .addScaledVector(faceDrag.worldNormal, shiftMm * MM_TO_UNIT);

    positionResizeHandles(faceDrag.mesh); // keep the dot glued to the live-resizing face
  }

  function handleFacePointerUp(e) {
    if (!faceDrag) return;
    const { newMm, startMm, shiftMm } = computeAsymmetricResize(e);
    const finalMm = Math.max(MIN_PANEL_DIM_MM, newMm);

    const dims = {
      width: faceDrag.dimsStartMm.w,
      height: faceDrag.dimsStartMm.h,
      thickness: faceDrag.dimsStartMm.t,
    };
    dims[faceDrag.field] = finalMm;

    // worldNormal is a unit vector, so worldNormal * (mm) is already a
    // valid mm-space offset delta — no MM_TO_UNIT conversion needed
    // here (that conversion is only for the transient THREE-units
    // preview above).
    const offsetDeltaMm = {
      x: faceDrag.worldNormal.x * shiftMm,
      y: faceDrag.worldNormal.y * shiftMm,
      z: faceDrag.worldNormal.z * shiftMm,
    };

    faceDrag.mesh.scale.set(1, 1, 1); // bake into geometry on next reconcile, never leave scale lingering
    faceDrag.mesh.position.copy(faceDrag.dragStartMeshPos); // reconcile() will set the true final position

    // Clear faceDrag BEFORE calling onDimensionChange — see the
    // matching comment in view2d.js's handlePointerUp for why: it
    // synchronously triggers reconcile(), which checks isDragging()
    // to decide whether to skip repositioning this exact mesh.
    const nodeId = faceDrag.nodeId;
    faceDrag = null;

    onDimensionChange?.(nodeId, dims, offsetDeltaMm);
  }

  canvas.addEventListener('pointerdown', handleFacePointerDown);
  window.addEventListener('pointermove', handleFacePointerMove);
  window.addEventListener('pointerup', handleFacePointerUp);

  function attachTo(mesh, lockedFields = {}) {
    if (transformMove.object !== mesh) transformMove.attach(mesh);

    transformMove.showX = !lockedFields.positionX;
    transformMove.showY = !lockedFields.positionY;
    transformMove.showZ = !lockedFields.positionZ;

    resizeHandleGroup.visible = true;
    positionResizeHandles(mesh);
  }

  function detachAll() {
    transformMove.detach();
    resizeHandleGroup.visible = false;
  }

  function setMeshEntryLookup(fn) {
    getMeshEntry = fn;
  }

  function dispose() {
    window.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('keyup', handleKeyUp);
    canvas.removeEventListener('pointerdown', handleFacePointerDown);
    window.removeEventListener('pointermove', handleFacePointerMove);
    window.removeEventListener('pointerup', handleFacePointerUp);
    detachAll();
    scene.remove(transformMove.getHelper());
    transformMove.dispose();
    scene.remove(resizeHandleGroup);
    handleGeometry.dispose();
    FACE_NAMES.forEach((n) => resizeHandles[n].material.dispose());
  }

  return { isDragging, attachTo, detachAll, setMeshEntryLookup, dispose, controls: allControls };
}
