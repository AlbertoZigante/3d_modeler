/**
 * The view layer + THE RECONCILER. Owns the Three.js scene, renderer,
 * lights, and composes three interaction modules: orbitControls.js +
 * gizmos.js (the 3D experience) and view2d.js (the 2D front-elevation
 * experience with PowerPoint-style direct manipulation). Exactly one
 * of these interaction layers is alive at a time — switching modes
 * disposes the old one and creates the other, rather than both
 * fighting over the same pointer events.
 *
 * `reconcile()` takes the RESOLVED panels array (from snap.js) and
 * is completely mode-agnostic: it sets mesh position/rotation/
 * geometry/material the same way regardless of which camera is
 * currently rendering the scene. BOM, relations, the box preset, and
 * locked-field logic all work identically in both views because none
 * of that ever depended on a specific camera or interaction style —
 * only WHICH camera renders, and WHICH layer listens for drags,
 * changes between 2D and 3D.
 */

import * as THREE from 'three';
import { MM_TO_UNIT, FACE_ORDER } from './modules.js';
import { createOrbitControls } from './orbitControls.js';
import { createGizmos } from './gizmos.js';
import { create2DControls } from './view2d.js';
import { createAxesGizmo } from './axesGizmo.js';

export function createModellerScene(
  canvas,
  main,
  { onSelect, onTransformChange, onDimensionChange, onFacePick, axesCanvas } = {}
) {
  // ---- renderer / scene / lights — warm, light palette ----
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0xf6ede0); // warm cream

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xf6ede0, 8, 24);

  const ambient = new THREE.AmbientLight(0xfff4e2, 0.75);
  scene.add(ambient);

  const dirLight = new THREE.DirectionalLight(0xfff1d6, 0.85);
  dirLight.position.set(5, 8, 5);
  dirLight.castShadow = true;
  dirLight.shadow.camera.near = 0.1;
  dirLight.shadow.camera.far = 50;
  dirLight.shadow.camera.left = dirLight.shadow.camera.bottom = -6;
  dirLight.shadow.camera.right = dirLight.shadow.camera.top = 6;
  dirLight.shadow.mapSize.set(2048, 2048);
  scene.add(dirLight);

  const fillLight = new THREE.DirectionalLight(0xffe6c2, 0.3);
  fillLight.position.set(-4, 3, -4);
  scene.add(fillLight);

  const grid = new THREE.GridHelper(20, 20, 0xcdbfa5, 0xe6dac6);
  grid.position.y = -0.5;
  scene.add(grid);

  const groundGeo = new THREE.PlaneGeometry(40, 40);
  const groundMat = new THREE.ShadowMaterial({ opacity: 0.15 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = -0.5;
  ground.receiveShadow = true;
  scene.add(ground);

  // ---- two cameras, one scene ----
  const camera3d = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
  camera3d.position.set(3, 2.5, 4);

  const ORTHO_HALF_HEIGHT = 2;
  const camera2d = new THREE.OrthographicCamera(-2, 2, ORTHO_HALF_HEIGHT, -ORTHO_HALF_HEIGHT, 0.1, 100);
  camera2d.position.set(0, 0, 10);
  camera2d.lookAt(0, 0, 0);

  let viewMode = '3d';
  let activeCamera = camera3d;

  // ---- shared conversion: absolute mesh transform -> offset delta ----
  // Both gizmos (3D) and view2d (2D) report an absolute world
  // position after a drag; this is the one place that converts it
  // back into `offset` (a delta from the auto-layout/constraint base)
  // before handing it to the external onTransformChange callback —
  // written once, used by both interaction layers.
  const autoBaseById = new Map();
  function reportTransformToExternal(nodeId, transform) {
    if (!onTransformChange) return;
    const base = autoBaseById.get(nodeId) || { x: 0, y: 0, z: 0 };
    onTransformChange(nodeId, {
      offset: {
        x: (transform.offsetDelta.x - base.x) / MM_TO_UNIT,
        y: (transform.offsetDelta.y - base.y) / MM_TO_UNIT,
        z: (transform.offsetDelta.z - base.z) / MM_TO_UNIT,
      },
      rotation: transform.rotation,
    });
  }

  // ---- THE RECONCILER's data (shared across whichever mode is active) ----
  const meshRegistry = new Map(); // id -> { mesh, edges, lastDims }
  let lastResolvedPanels = [];
  let lastSelectedId = null;
  let lastFacePicks = null;

  function meshList() {
    return Array.from(meshRegistry.values()).map((entry) => entry.mesh);
  }

  // ---- 3D interaction layer ----
  const gestureState = { interactionHandled: false };

  // FACE PICKING (item 11): while `facePickMode` is 'from' or 'to',
  // the next click is interpreted as picking a FACE (not selecting a
  // panel) — see reconcile() below for how the picked face gets
  // colored, and handleClickSelect3D for how a face is identified
  // from the raycast hit.
  let facePickMode = null;

  function setFacePickMode(mode) {
    facePickMode = mode; // 'from' | 'to' | null — used by handleClickSelect3D
    canvas.style.cursor = mode ? 'crosshair' : 'grab';
    // delegate to the 2D layer when active — it has its own internal
    // facePickMode state that governs handlePointerDown branching
    if (view2d && view2d.setFacePickMode) view2d.setFacePickMode(mode);
  }

  function faceNameFromHit(hit) {
    if (!hit.face) return null;
    return FACE_ORDER[hit.face.materialIndex] ?? null;
  }

  function handleClickSelect3D(e) {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    const raycaster = new THREE.Raycaster();
    raycaster.setFromCamera(ndc, camera3d);
    const hits = raycaster.intersectObjects(meshList(), false);

    if (facePickMode) {
      const mode = facePickMode;
      facePickMode = null; // exit picking mode on any click, hit or miss
      canvas.style.cursor = 'grab';
      if (hits.length > 0) {
        const faceName = faceNameFromHit(hits[0]);
        if (faceName && onFacePick) {
          onFacePick(mode, hits[0].object.userData.nodeId, faceName);
        }
      }
      return;
    }

    onSelect?.(hits.length > 0 ? hits[0].object.userData.nodeId : null);
  }

  let orbit = null;
  let gizmos = null;
  let view2d = null;

  function activate3D() {
    gestureState.interactionHandled = false;
    orbit = createOrbitControls(canvas, camera3d, {
      isBlocked: () => gizmos.isDragging(),
      onClick: handleClickSelect3D,
      gestureState,
    });
    gizmos = createGizmos(camera3d, canvas, scene, {
      gestureState,
      onDimensionChange,
      onTransformChange: reportTransformToExternal,
    });
    gizmos.setMeshEntryLookup((mesh) => meshRegistry.get(mesh.userData.nodeId));
  }

  function activate2D() {
    view2d = create2DControls(canvas, camera2d, scene, meshRegistry, {
      onSelect,
      onTransformChange: reportTransformToExternal,
      onFacePick, // item 12 — face picking in the 2D view
    });
  }

  function deactivateCurrent() {
    if (orbit) { orbit.dispose(); orbit = null; }
    if (gizmos) { gizmos.dispose(); gizmos = null; }
    if (view2d) { view2d.dispose(); view2d = null; }
  }

  activate3D(); // default on load

  function setViewMode(mode) {
    if (mode === viewMode) return;
    deactivateCurrent();
    viewMode = mode;
    activeCamera = mode === '2d' ? camera2d : camera3d;
    if (mode === '2d') activate2D();
    else activate3D();
    onResize(); // camera projections depend on the active camera
    reconcile(lastResolvedPanels, lastSelectedId, lastFacePicks); // re-apply immediately, don't wait for the next external render
  }

  function reconcile(resolvedPanels, selectedId, facePicks = null) {
    lastResolvedPanels = resolvedPanels;
    lastSelectedId = selectedId;
    lastFacePicks = facePicks;

    const liveIds = new Set(resolvedPanels.map((p) => p.id));

    for (const [id, entry] of meshRegistry.entries()) {
      if (!liveIds.has(id)) {
        if (gizmos) {
          for (const tc of gizmos.controls) {
            if (tc.object === entry.mesh) tc.detach();
          }
        }
        scene.remove(entry.mesh);
        entry.mesh.geometry.dispose();
        entry.mesh.material.forEach((m) => m.dispose());
        entry.edges.geometry.dispose();
        meshRegistry.delete(id);
      }
    }

    resolvedPanels.forEach((node) => {
      const w = node.width * MM_TO_UNIT;
      const h = node.height * MM_TO_UNIT;
      const t = node.thickness * MM_TO_UNIT;

      let entry = meshRegistry.get(node.id);
      const isSelected = node.id === selectedId;

      if (!entry) {
        const materials = FACE_ORDER.map(() => new THREE.MeshStandardMaterial({
          color: 0xdcbd8c,
          roughness: 0.75,
          metalness: 0.04,
        }));
        const geometry = new THREE.BoxGeometry(w, h, t);
        const mesh = new THREE.Mesh(geometry, materials);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.nodeId = node.id;

        const edges = new THREE.LineSegments(
          new THREE.EdgesGeometry(geometry),
          new THREE.LineBasicMaterial({ color: 0x8b6540 })
        );
        mesh.add(edges);

        scene.add(mesh);
        entry = { mesh, edges, lastDims: { w, h, t } };
        meshRegistry.set(node.id, entry);
      } else if (
        entry.lastDims.w !== w ||
        entry.lastDims.h !== h ||
        entry.lastDims.t !== t
      ) {
        entry.mesh.geometry.dispose();
        entry.mesh.geometry = new THREE.BoxGeometry(w, h, t);
        entry.edges.geometry.dispose();
        entry.edges.geometry = new THREE.EdgesGeometry(entry.mesh.geometry);
        entry.lastDims = { w, h, t };
      }

      // 2D drag needs to know, per axis, whether it's allowed to move
      // this panel — same lockedFields the 3D gizmo already reads.
      entry.mesh.userData.lockedFields = node.lockedFields || {};

      const posUnits = {
        x: node.position.x * MM_TO_UNIT,
        y: node.position.y * MM_TO_UNIT,
        z: node.position.z * MM_TO_UNIT,
      };
      autoBaseById.set(node.id, posUnits);

      const isBeingDragged =
        (gizmos && gizmos.controls.some((tc) => tc.object === entry.mesh && tc.dragging)) ||
        (view2d && view2d.isDragging() && view2d.draggedMeshRef() === entry.mesh);

      if (!isBeingDragged) {
        entry.mesh.position.set(posUnits.x, posUnits.y, posUnits.z);

        const rot = node.rotation || { x: 0, y: 0, z: 0 };
        entry.mesh.rotation.set(
          THREE.MathUtils.degToRad(rot.x),
          THREE.MathUtils.degToRad(rot.y),
          THREE.MathUtils.degToRad(rot.z)
        );

        entry.mesh.scale.set(1, 1, 1); // scale is only ever transient (see gizmos.js)
      }

      const baseColor = isSelected ? 0xe0904a : 0xdcbd8c;
      entry.mesh.material.forEach((m) => m.color.set(baseColor));
      entry.edges.material.color.set(isSelected ? 0x8a4a1a : 0x8b6540);

      // FACE PICKING (item 11): tint a specific face green ("from")
      // or red ("to") when this node's mesh has a picked face —
      // applied AFTER the base color above so it always wins.
      if (facePicks?.from?.node === node.id) {
        const idx = FACE_ORDER.indexOf(facePicks.from.face);
        if (idx >= 0) entry.mesh.material[idx].color.set(0x2f8a4f); // green
      }
      if (facePicks?.to?.node === node.id) {
        const idx = FACE_ORDER.indexOf(facePicks.to.face);
        if (idx >= 0) entry.mesh.material[idx].color.set(0xc0392b); // red
      }
    });

    const selectedEntry = meshRegistry.get(selectedId);
    if (gizmos) {
      if (selectedEntry) {
        const node = resolvedPanels.find((p) => p.id === selectedId);
        gizmos.attachTo(selectedEntry.mesh, node?.lockedFields || {});
      } else {
        gizmos.detachAll();
      }
    }
    if (view2d) {
      view2d.setSelectedMesh(selectedEntry ? selectedEntry.mesh : null);
    }
  }

  // ---- resize + render loop ----
  // Observes the canvas's own container (not just window resize),
  // since dragging a sidebar's width changes this element's size
  // without ever firing a window resize event.
  const viewportEl = canvas.parentElement || main;
  function onResize() {
    const w = viewportEl.clientWidth;
    const h = viewportEl.clientHeight;
    renderer.setSize(w, h, false);

    camera3d.aspect = w / h;
    camera3d.updateProjectionMatrix();

    const aspect = w / h;
    camera2d.left = -ORTHO_HALF_HEIGHT * aspect;
    camera2d.right = ORTHO_HALF_HEIGHT * aspect;
    camera2d.top = ORTHO_HALF_HEIGHT;
    camera2d.bottom = -ORTHO_HALF_HEIGHT;
    camera2d.updateProjectionMatrix();
  }
  window.addEventListener('resize', onResize);
  const resizeObserver = new ResizeObserver(onResize);
  resizeObserver.observe(viewportEl);
  onResize();

  const axesGizmo = axesCanvas ? createAxesGizmo(axesCanvas) : null;

  let animationFrameId = null;
  function animate() {
    animationFrameId = requestAnimationFrame(animate);
    renderer.render(scene, activeCamera);
    if (axesGizmo) axesGizmo.render(activeCamera);
  }
  animate();

  function dispose() {
    cancelAnimationFrame(animationFrameId);
    window.removeEventListener('resize', onResize);
    resizeObserver.disconnect();
    deactivateCurrent();
    if (axesGizmo) axesGizmo.dispose();

    for (const entry of meshRegistry.values()) {
      entry.mesh.geometry.dispose();
      entry.mesh.material.forEach((m) => m.dispose());
      entry.edges.geometry.dispose();
    }
    meshRegistry.clear();

    renderer.dispose();
  }

  return { reconcile, dispose, setViewMode, setFacePickMode };
}
