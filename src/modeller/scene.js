/**
 * The view layer + THE RECONCILER. Owns the Three.js scene, camera,
 * renderer, lights, and composes the two extracted modules —
 * orbitControls.js (camera) and gizmos.js (move/rotate/resize
 * handles) — rather than managing that wiring itself. This file's
 * job is: keep the scene in sync with RESOLVED panel data, and
 * report user manipulation back up through callbacks.
 *
 * STAGE 2: `reconcile()` now takes the RESOLVED panels array (from
 * snap.js's resolveConstraints — concrete width/height/thickness/
 * position/lockedFields for every node), not the raw graph. This
 * file no longer calls computeAutoLayoutPositions itself — the
 * resolver already folds that fallback in. Locked fields hide their
 * corresponding gizmo handle (see gizmos.js) so dragging a derived
 * value isn't possible until the user explicitly breaks that link.
 *
 * CLICK ON EMPTY SPACE = DESELECT
 * ---------------------------------
 * A plain click that hits no panel mesh clears selection (detaches
 * all three gizmos, clears the inspector via main.js). A click that
 * lands on a gizmo handle must NOT be read as "empty space" even
 * though gizmo geometry isn't in the panel raycast — a shared
 * `gestureState.gizmoHandled` flag (set by gizmos.js, read by
 * orbitControls.js) tracks that per-gesture, regardless of which
 * module's own event listeners happen to fire first.
 */

import * as THREE from 'three';
import { MM_TO_UNIT } from './modules.js';
import { createOrbitControls } from './orbitControls.js';
import { createGizmos } from './gizmos.js';

export function createModellerScene(
  canvas,
  main,
  { onSelect, onTransformChange, onDimensionChange } = {}
) {
  // ---- renderer / scene / camera — warm, light palette ----
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.setClearColor(0xf6ede0); // warm cream

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(0xf6ede0, 8, 24);

  const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
  camera.position.set(3, 2.5, 4);

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

  // ---- shared per-gesture state between orbitControls and gizmos ----
  // True only while the pointer gesture in progress started on a
  // gizmo handle. See file header for why this beats checking
  // `.dragging` at pointerup time.
  const gestureState = { gizmoHandled: false };

  // ---- click-to-select / click-empty-to-deselect via raycast ----
  const raycaster = new THREE.Raycaster();

  function handleClickSelect(e) {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    const meshes = Array.from(meshRegistry.values()).map((entry) => entry.mesh);
    const hits = raycaster.intersectObjects(meshes, false);
    if (!onSelect) return;
    onSelect(hits.length > 0 ? hits[0].object.userData.nodeId : null);
  }

  // orbitControls registered BEFORE gizmos, deliberately: canvas
  // 'pointerdown' listeners fire in registration order, and
  // orbitControls resets gestureState.gizmoHandled = false at the
  // very start of every gesture, before gizmos.js's own listeners
  // (added when TransformControls is constructed, below) get a
  // chance to set it back to true for a genuine gizmo hit.
  const orbit = createOrbitControls(canvas, camera, {
    isBlocked: () => gizmos.isDragging(),
    onClick: handleClickSelect,
    gestureState,
  });

  const gizmos = createGizmos(camera, canvas, scene, {
    gestureState,
    onDimensionChange,
    onTransformChange: (nodeId, transform) => {
      const entry = Array.from(meshRegistry.entries()).find(([id]) => id === nodeId);
      const base = autoBaseById.get(nodeId) || { x: 0, y: 0, z: 0 };
      if (!onTransformChange) return;
      onTransformChange(nodeId, {
        offset: {
          x: (transform.offsetDelta.x - base.x) / MM_TO_UNIT,
          y: (transform.offsetDelta.y - base.y) / MM_TO_UNIT,
          z: (transform.offsetDelta.z - base.z) / MM_TO_UNIT,
        },
        rotation: transform.rotation,
      });
    },
  });
  gizmos.setMeshEntryLookup((mesh) => meshRegistry.get(mesh.userData.nodeId));

  // ---- THE RECONCILER ----
  const meshRegistry = new Map(); // id -> { mesh, edges, lastDims }
  const autoBaseById = new Map(); // id -> resolved position (units) as of the last reconcile — used to convert a gizmo drag's absolute result back into an offset delta

  function reconcile(resolvedPanels, selectedId) {
    const liveIds = new Set(resolvedPanels.map((p) => p.id));

    for (const [id, entry] of meshRegistry.entries()) {
      if (!liveIds.has(id)) {
        for (const tc of gizmos.controls) {
          if (tc.object === entry.mesh) tc.detach();
        }
        scene.remove(entry.mesh);
        entry.mesh.geometry.dispose();
        entry.mesh.material.dispose();
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
        const material = new THREE.MeshStandardMaterial({
          color: 0xdcbd8c,
          roughness: 0.75,
          metalness: 0.04,
        });
        const geometry = new THREE.BoxGeometry(w, h, t);
        const mesh = new THREE.Mesh(geometry, material);
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

      const posUnits = {
        x: node.position.x * MM_TO_UNIT,
        y: node.position.y * MM_TO_UNIT,
        z: node.position.z * MM_TO_UNIT,
      };
      autoBaseById.set(node.id, posUnits);

      const isBeingDragged = gizmos.controls.some((tc) => tc.object === entry.mesh && tc.dragging);

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

      entry.mesh.material.color.set(isSelected ? 0xe0904a : 0xdcbd8c);
      entry.edges.material.color.set(isSelected ? 0x8a4a1a : 0x8b6540);
    });

    const selectedEntry = meshRegistry.get(selectedId);
    if (selectedEntry) {
      const node = resolvedPanels.find((p) => p.id === selectedId);
      gizmos.attachTo(selectedEntry.mesh, node?.lockedFields || {});
    } else {
      gizmos.detachAll();
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
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  window.addEventListener('resize', onResize);
  const resizeObserver = new ResizeObserver(onResize);
  resizeObserver.observe(viewportEl);
  onResize();

  let animationFrameId = null;
  function animate() {
    animationFrameId = requestAnimationFrame(animate);
    renderer.render(scene, camera);
  }
  animate();

  function dispose() {
    cancelAnimationFrame(animationFrameId);
    window.removeEventListener('resize', onResize);
    resizeObserver.disconnect();
    orbit.dispose();
    gizmos.dispose();

    for (const entry of meshRegistry.values()) {
      entry.mesh.geometry.dispose();
      entry.mesh.material.dispose();
      entry.edges.geometry.dispose();
    }
    meshRegistry.clear();

    renderer.dispose();
  }

  return { reconcile, dispose };
}
