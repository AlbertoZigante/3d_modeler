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
      if (gestureState) gestureState.gizmoHandled = true;
    });
  }

  function isDragging() {
    return transformMove.dragging || transformRotate.dragging || transformScale.dragging;
  }

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
    transformMove.dispose();
    transformRotate.dispose();
    transformScale.dispose();
  }

  return { isDragging, attachTo, detachAll, setMeshEntryLookup, dispose, controls: allControls };
}
