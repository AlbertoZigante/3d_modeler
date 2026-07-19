/**
 * All three transform gizmos (move / rotate / resize), extracted out
 * of scene.js so that file's reconciler isn't also managing gizmo
 * event wiring. Move + rotate + scale are attached to the selected
 * mesh SIMULTANEOUSLY (no mode toggle) — see scene.js's file header
 * for why.
 *
 * STAGE 2 ADDITION: `attachTo(mesh, lockedFields)` can hide specific
 * axis handles on the move/scale gizmos when the corresponding field
 * is under active constraint (lockedFields.width -> hide the X scale
 * handle, lockedFields.positionZ -> hide the Z move handle, etc.) —
 * dragging a derived value doesn't mean anything until the user has
 * explicitly broken that link in the inspector. Rotation is never
 * constrained in this design, so the rotate gizmo is always fully
 * enabled.
 *
 * SHIFT-TO-CONSTRAIN: holding Shift while dragging the move gizmo
 * locks the drag to whichever single axis (X, Y, or Z) has moved the
 * most since the drag started, snapping the other two back to their
 * value at drag-start. This matters most when dragging one of the
 * small plane handles (which normally move two axes freely at once)
 * — with Shift held it behaves like a single-axis arrow instead.
 */
import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { MM_TO_UNIT } from './modules.js';

export function createGizmos(camera, canvas, scene, { onTransformChange, onDimensionChange, gestureState } = {}) {
  const transformMove = new TransformControls(camera, canvas);
  transformMove.setMode('translate');
  transformMove.setSize(0.9);
  scene.add(transformMove.getHelper());

  const transformRotate = new TransformControls(camera, canvas);
  transformRotate.setMode('rotate');
  transformRotate.setSize(0.75);
  scene.add(transformRotate.getHelper());

  const transformScale = new TransformControls(camera, canvas);
  transformScale.setMode('scale');
  transformScale.setSize(0.6);
  scene.add(transformScale.getHelper());

  const allControls = [transformMove, transformRotate, transformScale];

  for (const tc of allControls) {
    tc.addEventListener('mouseDown', () => {
      if (gestureState) gestureState.interactionHandled = true;
    });
  }

  function isDragging() {
    return transformMove.dragging || transformRotate.dragging || transformScale.dragging;
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
  });
  transformRotate.addEventListener('objectChange', () => {
    if (transformRotate.object) reportTransform(transformRotate.object);
  });

  // ---- resize (scale-drag -> baked mm dimensions on release) ----
  let scaleDragStartDims = null; // { w, h, t } in mm, captured at drag start
  let getMeshEntry = null; // injected by scene.js: (mesh) => { lastDims } | undefined

  transformScale.addEventListener('mouseDown', () => {
    const mesh = transformScale.object;
    if (!mesh || !getMeshEntry) return;
    const entry = getMeshEntry(mesh);
    if (!entry) return;
    scaleDragStartDims = {
      w: entry.lastDims.w / MM_TO_UNIT,
      h: entry.lastDims.h / MM_TO_UNIT,
      t: entry.lastDims.t / MM_TO_UNIT,
    };
  });

  transformScale.addEventListener('mouseUp', () => {
    const mesh = transformScale.object;
    if (!mesh || !scaleDragStartDims || !onDimensionChange) {
      scaleDragStartDims = null;
      return;
    }
    const nodeId = mesh.userData.nodeId;
    const newWidth = scaleDragStartDims.w * mesh.scale.x;
    const newHeight = scaleDragStartDims.h * mesh.scale.y;
    const newThickness = scaleDragStartDims.t * mesh.scale.z;
    mesh.scale.set(1, 1, 1); // bake into geometry on next reconcile, never leave scale lingering
    onDimensionChange(nodeId, { width: newWidth, height: newHeight, thickness: newThickness });
    scaleDragStartDims = null;
  });

  function attachTo(mesh, lockedFields = {}) {
    if (transformMove.object !== mesh) transformMove.attach(mesh);
    if (transformRotate.object !== mesh) transformRotate.attach(mesh);
    if (transformScale.object !== mesh) transformScale.attach(mesh);

    transformMove.showX = !lockedFields.positionX;
    transformMove.showY = !lockedFields.positionY;
    transformMove.showZ = !lockedFields.positionZ;

    transformScale.showX = !lockedFields.width;
    transformScale.showY = !lockedFields.height;
    transformScale.showZ = !lockedFields.thickness;
  }

  function detachAll() {
    transformMove.detach();
    transformRotate.detach();
    transformScale.detach();
  }

  function setMeshEntryLookup(fn) {
    getMeshEntry = fn;
  }

  function dispose() {
    window.removeEventListener('keydown', handleKeyDown);
    window.removeEventListener('keyup', handleKeyUp);
    detachAll();
    scene.remove(transformMove.getHelper());
    scene.remove(transformRotate.getHelper());
    scene.remove(transformScale.getHelper());
    transformMove.dispose();
    transformRotate.dispose();
    transformScale.dispose();
  }

  return { isDragging, attachTo, detachAll, setMeshEntryLookup, dispose, controls: allControls };
}
