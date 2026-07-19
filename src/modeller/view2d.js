/**
 * 2D (front elevation) view: an orthographic camera looking down -Z,
 * plus PowerPoint-style direct manipulation — drag a selected panel's
 * body to translate it, drag its rotate handle to spin it — instead
 * of the 3D gizmos.
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
 * Only X/Y position and Z-axis rotation are ever touched here — the
 * same one plane a 2D front view can meaningfully manipulate. Width/
 * height/thickness stay editable via the inspector, same as always;
 * corner-drag resize in this view is a natural follow-up, not
 * included in this pass (deliberately, to keep scope contained).
 */
import * as THREE from 'three';
import { MM_TO_UNIT } from './modules.js';

const HANDLE_GAP_UNITS = 0.25; // distance above the panel's top edge

export function create2DControls(
  canvas,
  camera,
  scene,
  meshRegistry,
  { onSelect, onTransformChange, getSelectedId } = {}
) {
  const raycaster = new THREE.Raycaster();
  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

  // ---- rotate-handle visual (a small circle + connecting line) ----
  const handleGroup = new THREE.Group();
  const handleDot = new THREE.Mesh(
    new THREE.CircleGeometry(0.06, 20),
    new THREE.MeshBasicMaterial({ color: 0xd97742 })
  );
  const handleLineGeo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 1, 0),
  ]);
  const handleLine = new THREE.Line(handleLineGeo, new THREE.LineBasicMaterial({ color: 0xd97742 }));
  handleGroup.add(handleLine, handleDot);
  handleGroup.visible = false;
  scene.add(handleGroup);

  let currentMesh = null; // the mesh the handle currently follows

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
    // width/height in WORLD units, from the mesh's own geometry
    // parameters — reconcile() always rebuilds BoxGeometry(w,h,t), so
    // this is exact, not an approximation from a transformed bbox.
    const params = mesh.geometry.parameters;
    return { halfW: params.width / 2, halfH: params.height / 2 };
  }

  function positionHandle(mesh) {
    const { halfH } = meshHalfExtents(mesh);
    handleGroup.position.set(mesh.position.x, mesh.position.y + halfH, mesh.position.z + 0.01);
    handleGroup.rotation.z = mesh.rotation.z;
    handleLine.scale.set(1, HANDLE_GAP_UNITS, 1);
    handleDot.position.set(0, HANDLE_GAP_UNITS, 0);
  }

  // ---- pointer / drag state ----
  let mode = null; // null | 'translate' | 'rotate'
  let draggedMesh = null;
  let dragStartWorld = null;
  let dragStartMeshPos = null;
  let dragStartAngleOffset = 0;
  const gestureState = { moved: false, downX: 0, downY: 0 };

  function meshList() {
    return Array.from(meshRegistry.values()).map((entry) => entry.mesh);
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

    // rotate handle takes priority if a panel is already selected
    if (handleGroup.visible) {
      const handleHits = hitTest(e, [handleDot]);
      if (handleHits.length > 0) {
        mode = 'rotate';
        draggedMesh = currentMesh;
        const world = screenToWorld(e);
        const angle = Math.atan2(world.y - draggedMesh.position.y, world.x - draggedMesh.position.x);
        dragStartAngleOffset = angle - draggedMesh.rotation.z;
        return;
      }
    }

    const hits = hitTest(e, meshList());
    if (hits.length > 0) {
      mode = 'translate';
      draggedMesh = hits[0].object;
      dragStartWorld = screenToWorld(e);
      dragStartMeshPos = draggedMesh.position.clone();
    } else {
      mode = null;
      draggedMesh = null;
    }
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
    } else if (mode === 'rotate' && draggedMesh) {
      const world = screenToWorld(e);
      const angle = Math.atan2(world.y - draggedMesh.position.y, world.x - draggedMesh.position.x);
      draggedMesh.rotation.z = angle - dragStartAngleOffset;
      if (draggedMesh === currentMesh) positionHandle(draggedMesh);
      reportTransform(draggedMesh);
    }
  }

  function handlePointerUp(e) {
    if (!gestureState.moved && mode !== 'rotate') {
      // plain click (no drag): select whatever's under the pointer,
      // or deselect if empty space
      const hits = hitTest(e, meshList());
      onSelect?.(hits.length > 0 ? hits[0].object.userData.nodeId : null);
    }
    mode = null;
    draggedMesh = null;
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
    const handleHit = handleGroup.visible ? hitTest(e, [handleDot]) : [];
    if (hits.length === 0 && handleHit.length === 0) {
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
  // selected mesh (or null) so the handle follows selection/edits
  function setSelectedMesh(mesh) {
    currentMesh = mesh;
    handleGroup.visible = !!mesh;
    if (mesh) positionHandle(mesh);
  }

  function dispose() {
    canvas.removeEventListener('pointerdown', handlePointerDown);
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    canvas.removeEventListener('pointerdown', handlePanPointerDown);
    window.removeEventListener('pointermove', handlePanPointerMove);
    window.removeEventListener('pointerup', handlePanPointerUp);
    canvas.removeEventListener('wheel', handleWheel);
    scene.remove(handleGroup);
    handleDot.geometry.dispose();
    handleDot.material.dispose();
    handleLineGeo.dispose();
  }

  return { isDragging, setSelectedMesh, draggedMeshRef: () => draggedMesh, dispose };
}
