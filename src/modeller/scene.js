/**
 * The view layer. Owns the Three.js scene, camera, renderer,
 * lights, camera controls, and the transform gizmos — and
 * nothing else. It never originates graph data; it only reads
 * the `panels` array handed to it via reconcile() and keeps the
 * scene in sync, and reports user manipulation back up through
 * callbacks (onSelect, onTransformChange, onDimensionChange).
 *
 * THE RECONCILER
 * ---------------
 * `reconcile(panels, selectedId)` diffs the incoming panels array
 * against a live id -> mesh registry: creates meshes for new
 * nodes, disposes meshes for removed nodes, rebuilds geometry
 * only when dimensions actually changed, positions each mesh at
 * (auto-layout position + node.offset), and keeps all three
 * gizmos attached to whichever mesh is selected — or detached
 * entirely when nothing is selected.
 *
 * THREE GIZMOS, ALL AT ONCE
 * --------------------------
 * Move (translate arrows), rotate (rings), and resize (scale
 * handles) are three independent TransformControls instances all
 * attached to the selected mesh simultaneously — pick whichever
 * handle you want directly, no mode toggle. All are pointer-event
 * based, so dragging works the same with a trackpad's click-drag
 * as with a mouse.
 *
 * Resize is implemented via 'scale' mode rather than literal
 * edge-dragging (Three.js has no built-in box-edge-drag handle),
 * but it reads and feels the same: grab a handle near a face,
 * drag out/in, the panel gets bigger/smaller along that axis. The
 * scale factor is only ever transient — on drag end it's baked
 * into real width/height/thickness (mm) in the graph and the
 * mesh's scale is reset to 1, so geometry (not a lingering scale
 * transform) is always the source of truth for panel size.
 *
 * CLICK ON EMPTY SPACE = DESELECT
 * ---------------------------------
 * A plain click that hits no panel mesh clears selection, which
 * detaches all three gizmos and (via main.js) clears the
 * inspector. A click that lands on a gizmo handle itself must NOT
 * be treated as "empty space" even though gizmo geometry isn't in
 * the panel raycast — `gizmoHandled` tracks that per-gesture.
 */

import * as THREE from 'three';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { MM_TO_UNIT, computeAutoLayoutPositions } from './modules.js';

const MIN_DIM_MM = 10; // guard against zero/negative geometry from an aggressive scale drag

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

  // ---- manual orbit controls (pointer events: mouse, trackpad, touch) ----
  const spherical = { theta: 0.6, phi: 1.0, radius: 5.5 };
  const target = new THREE.Vector3(0, 0, 0);

  function applyCamera() {
    camera.position.x = target.x + spherical.radius * Math.sin(spherical.phi) * Math.sin(spherical.theta);
    camera.position.y = target.y + spherical.radius * Math.cos(spherical.phi);
    camera.position.z = target.z + spherical.radius * Math.sin(spherical.phi) * Math.cos(spherical.theta);
    camera.lookAt(target);
  }
  applyCamera();

  const pointer = { down: false, button: -1, x: 0, y: 0, moved: false };

  // True only while the pointer gesture currently in progress started
  // on one of the gizmo handles. Reset at the start of every new
  // pointerdown, set by the gizmos' own 'mouseDown' events, and read
  // at pointerup — this is more reliable than checking `.dragging`
  // at pointerup time, since the gizmo's own listeners may already
  // have cleared that flag by then depending on listener order.
  let gizmoHandled = false;

  function anyGizmoDragging() {
    return transformMove.dragging || transformRotate.dragging || transformScale.dragging;
  }

  canvas.addEventListener('pointerdown', (e) => {
    gizmoHandled = false;
    pointer.down = true;
    pointer.button = e.button;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.moved = false;
    canvas.style.cursor = e.button === 0 ? 'grabbing' : 'move';
  });

  window.addEventListener('pointerup', (e) => {
    if (pointer.down && !pointer.moved && pointer.button === 0 && !gizmoHandled) {
      handleClickSelect(e);
    }
    pointer.down = false;
    canvas.style.cursor = 'grab';
  });

  window.addEventListener('pointermove', (e) => {
    if (!pointer.down) return;
    const dx = e.clientX - pointer.x;
    const dy = e.clientY - pointer.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) pointer.moved = true;
    pointer.x = e.clientX;
    pointer.y = e.clientY;

    // While a gizmo is being dragged, it owns the pointer — camera
    // orbit/pan must not fight it for the same drag.
    if (anyGizmoDragging()) return;

    if (pointer.button === 0) {
      spherical.theta -= dx * 0.007;
      spherical.phi = Math.max(0.05, Math.min(Math.PI - 0.05, spherical.phi - dy * 0.007));
    }
    if (pointer.button === 2) {
      const panSpeed = spherical.radius * 0.001;
      const right = new THREE.Vector3();
      const up = new THREE.Vector3();
      right.crossVectors(camera.getWorldDirection(new THREE.Vector3()), camera.up).normalize();
      up.copy(camera.up).normalize();
      target.addScaledVector(right, -dx * panSpeed);
      target.addScaledVector(up, dy * panSpeed);
    }
    applyCamera();
  });

  // Trackpad two-finger scroll (or mouse wheel) still zooms.
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    spherical.radius = Math.max(1, Math.min(30, spherical.radius + e.deltaY * 0.01));
    applyCamera();
  }, { passive: false });

  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.style.cursor = 'grab';

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
    if (hits.length > 0) {
      onSelect(hits[0].object.userData.nodeId);
    } else {
      onSelect(null); // clicked empty space — deselect
    }
  }

  // ---- MOVE + ROTATE + RESIZE GIZMOS (all visible at once) ----
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

  for (const tc of [transformMove, transformRotate, transformScale]) {
    tc.addEventListener('mouseDown', () => {
      gizmoHandled = true;
    });
  }

  // per-node id -> auto-layout base position (units), refreshed each
  // reconcile pass. Needed to convert an absolute drag result back
  // into an offset-from-home delta.
  const autoBaseById = new Map();

  function reportTransform(mesh) {
    if (!onTransformChange) return;
    const nodeId = mesh.userData.nodeId;
    const base = autoBaseById.get(nodeId) || { x: 0, y: 0, z: 0 };
    onTransformChange(nodeId, {
      offset: {
        x: (mesh.position.x - base.x) / MM_TO_UNIT,
        y: (mesh.position.y - base.y) / MM_TO_UNIT,
        z: (mesh.position.z - base.z) / MM_TO_UNIT,
      },
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

  transformScale.addEventListener('mouseDown', () => {
    const mesh = transformScale.object;
    if (!mesh) return;
    const entry = meshRegistry.get(mesh.userData.nodeId);
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
    const newWidth = Math.max(MIN_DIM_MM, Math.abs(scaleDragStartDims.w * mesh.scale.x));
    const newHeight = Math.max(MIN_DIM_MM, Math.abs(scaleDragStartDims.h * mesh.scale.y));
    const newThickness = Math.max(MIN_DIM_MM, Math.abs(scaleDragStartDims.t * mesh.scale.z));

    // Bake the drag into real dimensions; geometry (rebuilt by the
    // next reconcile pass) becomes the source of truth for size, not
    // a lingering scale transform.
    mesh.scale.set(1, 1, 1);
    onDimensionChange(nodeId, { width: newWidth, height: newHeight, thickness: newThickness });
    scaleDragStartDims = null;
  });

  // ---- THE RECONCILER ----
  const meshRegistry = new Map(); // id -> { mesh, edges, lastDims }

  function reconcile(panels, selectedId) {
    const liveIds = new Set(panels.map((p) => p.id));

    for (const [id, entry] of meshRegistry.entries()) {
      if (!liveIds.has(id)) {
        for (const tc of [transformMove, transformRotate, transformScale]) {
          if (tc.object === entry.mesh) tc.detach();
        }
        scene.remove(entry.mesh);
        entry.mesh.geometry.dispose();
        entry.mesh.material.dispose();
        entry.edges.geometry.dispose();
        meshRegistry.delete(id);
      }
    }

    // auto-layout placeholder for the base position — replaced once
    // Stage 2 relations give panels real spatial constraints
    const autoPositions = computeAutoLayoutPositions(panels);

    panels.forEach((node) => {
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

      const base = autoPositions.get(node.id);
      autoBaseById.set(node.id, base);

      const isBeingDragged =
        (transformMove.object === entry.mesh && transformMove.dragging) ||
        (transformRotate.object === entry.mesh && transformRotate.dragging) ||
        (transformScale.object === entry.mesh && transformScale.dragging);

      // Don't stomp the mesh transform while the user is actively
      // dragging it — it's already the source of truth mid-drag.
      if (!isBeingDragged) {
        const off = node.offset || { x: 0, y: 0, z: 0 };
        entry.mesh.position.set(
          base.x + off.x * MM_TO_UNIT,
          base.y + off.y * MM_TO_UNIT,
          base.z + off.z * MM_TO_UNIT
        );

        const rot = node.rotation || { x: 0, y: 0, z: 0 };
        entry.mesh.rotation.set(
          THREE.MathUtils.degToRad(rot.x),
          THREE.MathUtils.degToRad(rot.y),
          THREE.MathUtils.degToRad(rot.z)
        );

        entry.mesh.scale.set(1, 1, 1); // scale is only ever transient (see resize handlers above)
      }

      entry.mesh.material.color.set(isSelected ? 0xe0904a : 0xdcbd8c);
      entry.edges.material.color.set(isSelected ? 0x8a4a1a : 0x8b6540);
    });

    // keep all three gizmos attached to whichever mesh is selected —
    // or fully detached (hidden) when nothing is selected
    const selectedEntry = meshRegistry.get(selectedId);
    if (selectedEntry) {
      if (transformMove.object !== selectedEntry.mesh) transformMove.attach(selectedEntry.mesh);
      if (transformRotate.object !== selectedEntry.mesh) transformRotate.attach(selectedEntry.mesh);
      if (transformScale.object !== selectedEntry.mesh) transformScale.attach(selectedEntry.mesh);
    } else {
      transformMove.detach();
      transformRotate.detach();
      transformScale.detach();
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

  function animate() {
    requestAnimationFrame(animate);
    renderer.render(scene, camera);
  }
  animate();

  return { reconcile };
}
