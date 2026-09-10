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
import { MM_TO_UNIT, LOCAL_FACES, FACE_TO_DIM_FIELD } from './modules.js';
import { computeHandlePlacement } from '../shared/handle.js';
import { createOrbitControls } from './orbitControls.js';
import { createGizmos } from './gizmos.js';
import { create2DControls } from './view2d.js';
import { createViewCube } from './viewCube.js';

const CONST_Face_Panel_Color_Highlight = 0xff8a1e; // orange, same as the collinear tool's highlight color
const CONST_Face_Panel_Color_Highlight_Opacity = 0.5; // slightly more transparent than the collinear tool's highlight (0.55) so it doesn't visually compete with that tool's own highlight when both are active

export function createModellerScene(
  canvas,
  main,
  {
    onSelect,
    onTransformChange,
    onDimensionChange,
    onGroupDragStart,
    onGroupTransformChange,
    axesCanvas,
    pipCanvas,
    onPipModeClick,
  } = {}
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

  const grid = new THREE.GridHelper(250, 1000, 0xcdbfa5, 0xe6dac6);
  // y=0 — matches where addBox() actually places a box's bottom
  // exterior surface (see its own anchor.y comment), NOT the older
  // FLOOR_MM convention (-0.5 units) this used to sit at. FLOOR_MM
  // itself is unchanged and still governs DESIGN_LIMITS_MM's lower Y
  // bound (how far down a panel is ALLOWED to be dragged) — a
  // separate concern from where this purely-visual reference plane is
  // drawn, so it wasn't touched.
  // grid.position.y = 0;

  function orientGridForView(mode) {
    if (mode === '3d') {
      // XZ plane at Y=0
      grid.rotation.set(0, 0, 0);
      grid.position.set(0, 0, 0);
    } else {
      // XY plane at Z=0
      // GridHelper is normally XZ, so rotate it 90° around X.
      grid.rotation.set(Math.PI / 2, 0, 0);
      grid.position.set(0, 0, -5);
    }
  }

  scene.add(grid);

  const groundGeo = new THREE.PlaneGeometry(40, 40);
  const groundMat = new THREE.ShadowMaterial({ opacity: 0.15 });
  const ground = new THREE.Mesh(groundGeo, groundMat);
  ground.rotation.x = -Math.PI / 2;
  ground.position.y = 0; // see the grid's own comment just above
  ground.receiveShadow = true;
  scene.add(ground);

  // ---- single-FACE highlight (not a whole-panel tint) — used while
  // picking a face/edge for the collinear tool (see modeller-main.js's
  // handleFacePick), so what's confirmed as "picked" is exactly the
  // one face/edge the person clicked, not the entire panel it belongs
  // to. A single reusable plane, repositioned/reoriented/rescaled to
  // sit flush against whichever face is currently targeted, and
  // hidden otherwise.
  //
  // Every face's orientation is built from an EXPLICIT right/up/normal
  // basis (not a generic "rotate default normal to face normal"
  // shortcut) — that shortcut leaves an unconstrained "roll" around
  // the target axis, which would size/orient the highlight using the
  // WRONG pair of the panel's two in-plane dimensions for a
  // non-square face. Each basis must be right-handed (right×up =
  // normal) for THREE.Matrix4.makeBasis + setFromRotationMatrix to
  // produce a valid rotation at all — verified against a brute-force
  // corner-position ground truth for all 6 faces before shipping this
  // (see the standalone test run while building this), not assumed.
  const FACE_HIGHLIGHT_BASIS = {
    right:  { right: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, 1, 0), normal: new THREE.Vector3(1, 0, 0) },
    left:   { right: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0), normal: new THREE.Vector3(-1, 0, 0) },
    top:    { right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 0, -1), normal: new THREE.Vector3(0, 1, 0) },
    bottom: { right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 0, 1), normal: new THREE.Vector3(0, -1, 0) },
    front:  { right: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0), normal: new THREE.Vector3(0, 0, 1) },
    back:   { right: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 1, 0), normal: new THREE.Vector3(0, 0, -1) },
  };
  // Which of the node's OWN width/height/thickness fields lies along
  // each face's right/up/normal direction — 'right'/'left' span
  // (thickness, height); 'top'/'bottom' span (width, thickness);
  // 'front'/'back' span (width, height) — with the normal axis always
  // being the ONE field FACE_TO_DIM_FIELD already gives directly.
  const FACE_PLANE_DIMS = {
    right: ['thickness', 'height'], left: ['thickness', 'height'],
    top: ['width', 'thickness'], bottom: ['width', 'thickness'],
    front: ['width', 'height'], back: ['width', 'height'],
  };

  const faceHighlightGeo = new THREE.PlaneGeometry(1, 1);
  const faceHighlightMat = new THREE.MeshBasicMaterial({
    color: CONST_Face_Panel_Color_Highlight, transparent: true, opacity: CONST_Face_Panel_Color_Highlight_Opacity, side: THREE.DoubleSide, depthTest: true,
  });
  const faceHighlightMesh = new THREE.Mesh(faceHighlightGeo, faceHighlightMat);
  faceHighlightMesh.renderOrder = 10; // Slightly offset from the real face to avoid z-fighting. depthTest remains enabled so the highlight is still occluded correctly by geometry in front of it.
  faceHighlightMesh.visible = false;
  scene.add(faceHighlightMesh);

  let faceHighlightTarget = null; // { nodeId, faceName } | null

  // ---- WHOLE-PANEL highlight ----
  // A reusable box that sits exactly over the target panel. It is slightly
  // enlarged to avoid z-fighting with the real panel. The faceName is kept
  // as part of the target so the caller can identify which face caused the
  // highlight, even though the visual result is the entire panel.

  const panelHighlightGeo = new THREE.BoxGeometry(1, 1, 1);
  const panelHighlightMat = new THREE.MeshBasicMaterial({
    color: CONST_Face_Panel_Color_Highlight, transparent: true, opacity: CONST_Face_Panel_Color_Highlight_Opacity, side: THREE.DoubleSide, depthTest: true,
  });

  const panelHighlightMesh = new THREE.Mesh(
    panelHighlightGeo,
    panelHighlightMat
  );

  panelHighlightMesh.renderOrder = 9;
  panelHighlightMesh.visible = false;
  scene.add(panelHighlightMesh);

  let panelHighlightTarget = null; // { nodeId, faceName } | null

  // ---- MULTI-panel highlight SET ----
  // panelHighlightMesh above is a single reusable mesh — fine for
  // shelfTool.js, which only ever has ONE pick "pending" at a time.
  // Tools that accumulate several picks before committing (e.g.
  // boundaryRectTool.js's 4-panel pick) need every already-picked
  // panel to stay highlighted at once, so this keeps a small pool of
  // highlight meshes keyed by nodeId instead of one shared mesh. Same
  // visual language (color/opacity) as panelHighlightMesh — this is
  // "the shelf-tool highlight, just N of them at once" rather than a
  // new visual meaning.
  const highlightSetMeshes = new Map(); // nodeId -> THREE.Mesh
  let highlightSetIds = new Set();

  function setPanelHighlightSet(nodeIds) {
    highlightSetIds = new Set(nodeIds || []);
  }

  function updatePanelHighlightSet(resolvedPanels) {
    for (const [id, mesh] of highlightSetMeshes.entries()) {
      if (!highlightSetIds.has(id)) {
        scene.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
        highlightSetMeshes.delete(id);
      }
    }

    highlightSetIds.forEach((id) => {
      const node = resolvedPanels.find((p) => p.id === id);
      if (!node) return;

      let mesh = highlightSetMeshes.get(id);
      if (!mesh) {
        const geo = new THREE.BoxGeometry(1, 1, 1);
        const mat = new THREE.MeshBasicMaterial({
          color: CONST_Face_Panel_Color_Highlight, transparent: true, opacity: CONST_Face_Panel_Color_Highlight_Opacity, side: THREE.DoubleSide, depthTest: true,
        });
        mesh = new THREE.Mesh(geo, mat);
        mesh.renderOrder = 9;
        scene.add(mesh);
        highlightSetMeshes.set(id, mesh);
      }

      const padding = 0.002;
      mesh.position.set(node.position.x * MM_TO_UNIT, node.position.y * MM_TO_UNIT, node.position.z * MM_TO_UNIT);
      mesh.rotation.set(
        THREE.MathUtils.degToRad(node.rotation?.x || 0),
        THREE.MathUtils.degToRad(node.rotation?.y || 0),
        THREE.MathUtils.degToRad(node.rotation?.z || 0)
      );
      mesh.scale.set(node.width * MM_TO_UNIT + padding, node.height * MM_TO_UNIT + padding, node.thickness * MM_TO_UNIT + padding);
      mesh.visible = true;
    });
  }

  function setFaceHighlight(nodeId, faceName) {
    faceHighlightTarget = nodeId && faceName ? { nodeId, faceName } : null;
    faceHighlightMesh.visible = false; // reconcile() below turns it back on once it finds the matching resolved node — avoids a stale-position flash if the target node doesn't (yet) exist
  }

  function setPanelHighlight(nodeId, faceName) {
    panelHighlightTarget =
      nodeId && faceName
        ? { nodeId, faceName }
        : null;

    panelHighlightMesh.visible = false;
  }
  function updateFaceHighlight(resolvedPanels) {
    if (!faceHighlightTarget) { faceHighlightMesh.visible = false; return; }
    const node = resolvedPanels.find((p) => p.id === faceHighlightTarget.nodeId);
    const basis = FACE_HIGHLIGHT_BASIS[faceHighlightTarget.faceName];
    if (!node || !basis) { faceHighlightMesh.visible = false; return; }

    const nodeQuat = new THREE.Quaternion().setFromEuler(
      new THREE.Euler(
        THREE.MathUtils.degToRad(node.rotation.x),
        THREE.MathUtils.degToRad(node.rotation.y),
        THREE.MathUtils.degToRad(node.rotation.z),
        'XYZ'
      )
    );
    const localBasisQuat = new THREE.Quaternion().setFromRotationMatrix(
      new THREE.Matrix4().makeBasis(basis.right, basis.up, basis.normal)
    );

    const normalDimField = FACE_TO_DIM_FIELD[faceHighlightTarget.faceName];
    const halfExtentMm = node[normalDimField] / 2;
    const HIGHLIGHT_OFFSET = 0.001;
    const worldNormal = basis.normal.clone().applyQuaternion(nodeQuat).normalize();

    const worldOffsetUnits = worldNormal.clone().multiplyScalar(halfExtentMm * MM_TO_UNIT + HIGHLIGHT_OFFSET);
    // const worldOffsetUnits = basis.normal.clone().multiplyScalar(halfExtentMm * MM_TO_UNIT).applyQuaternion(nodeQuat);

    const [rightField, upField] = FACE_PLANE_DIMS[faceHighlightTarget.faceName];

    faceHighlightMesh.position.set(
      node.position.x * MM_TO_UNIT + worldOffsetUnits.x,
      node.position.y * MM_TO_UNIT + worldOffsetUnits.y,
      node.position.z * MM_TO_UNIT + worldOffsetUnits.z
    );
    faceHighlightMesh.quaternion.copy(nodeQuat).multiply(localBasisQuat);
    faceHighlightMesh.scale.set(node[rightField] * MM_TO_UNIT, node[upField] * MM_TO_UNIT, 1);
    faceHighlightMesh.visible = true;
  }

  function updatePanelHighlight(resolvedPanels) {
    if (!panelHighlightTarget) {
      panelHighlightMesh.visible = false;
      return;
    }

    const node = resolvedPanels.find((p) => p.id === panelHighlightTarget.nodeId);

    if (!node) {panelHighlightMesh.visible = false;return;}

    const w = node.width * MM_TO_UNIT;
    const h = node.height * MM_TO_UNIT;
    const t = node.thickness * MM_TO_UNIT;

    // Match the actual panel's world transform.
    panelHighlightMesh.position.set(
      node.position.x * MM_TO_UNIT,
      node.position.y * MM_TO_UNIT,
      node.position.z * MM_TO_UNIT
    );

    panelHighlightMesh.rotation.set(
      THREE.MathUtils.degToRad(node.rotation?.x || 0),
      THREE.MathUtils.degToRad(node.rotation?.y || 0),
      THREE.MathUtils.degToRad(node.rotation?.z || 0)
    );

    // Slightly enlarge the overlay in every direction so it doesn't
    // z-fight with the actual panel surface.
    const padding = 0.002;
    panelHighlightMesh.scale.set(
      w + padding,
      h + padding,
      t + padding
    );
    panelHighlightMesh.visible = true;
  }
  // ---- two cameras, one scene ----
  const camera3d = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
  camera3d.position.set(3, 2.5, 4);

  const ORTHO_HALF_HEIGHT = 2;
  const camera2d = new THREE.OrthographicCamera(-2, 2, ORTHO_HALF_HEIGHT, -ORTHO_HALF_HEIGHT, 0.1, 100);
  camera2d.position.set(0, 0, 10);
  camera2d.lookAt(0, 0, 0);

  // ---- picture-in-picture cameras: always show whichever mode is
  // NOT currently the main view. These are dedicated cameras, not
  // reuses of camera3d/camera2d — camera3d gets orbited by the user
  // and camera2d's aspect is driven by the main viewport's size, so
  // sharing either with the PiP (which has its own, different aspect
  // ratio) would mean re-deriving a shared camera's projection twice
  // per frame. A fixed, independent pair is simpler and can never
  // fight with the main view for a projection matrix.
  const camera3dPip = new THREE.PerspectiveCamera(45, 1, 0.1, 2000);
  camera3dPip.position.set(3.5, 2.5, 3.5); // fixed three-quarter angle, never orbited
  camera3dPip.lookAt(0, 0, 0);

  const camera2dPip = new THREE.OrthographicCamera(-2, 2, ORTHO_HALF_HEIGHT, -ORTHO_HALF_HEIGHT, 0.1, 100);
  camera2dPip.position.set(0, 0, 10);
  camera2dPip.lookAt(0, 0, 0);

  let viewMode = '3d';
  let activeCamera = camera3d;

  function pipCameraForCurrentMode() {
    return viewMode === '2d' ? camera3dPip : camera2dPip;
  }

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
    const proposedOffsetMm = {
      x: (transform.offsetDelta.x - base.x) / MM_TO_UNIT,
      y: (transform.offsetDelta.y - base.y) / MM_TO_UNIT,
      z: (transform.offsetDelta.z - base.z) / MM_TO_UNIT,
    };
    // The handler may return a corrected offset (e.g. clamped to a
    // design limit) — if it does, snap the LIVE mesh to match right
    // away. Nothing else resets mesh.position between frames during
    // a continuous move-drag, so without this the mesh would visibly
    // overshoot the limit until some unrelated later render happened.
    const correctedOffsetMm = onTransformChange(nodeId, { offset: proposedOffsetMm, rotation: transform.rotation });
    if (correctedOffsetMm) {
      const entry = meshRegistry.get(nodeId);
      if (entry) {
        entry.mesh.position.set(
          base.x + correctedOffsetMm.x * MM_TO_UNIT,
          base.y + correctedOffsetMm.y * MM_TO_UNIT,
          base.z + correctedOffsetMm.z * MM_TO_UNIT
        );
      }
    }
  }

  // ---- THE RECONCILER's data (shared across whichever mode is active) ----
  const meshRegistry = new Map(); // id -> { mesh, edges, lastDims }
  let lastResolvedPanels = [];
  let lastSelectedId = null;
  let lastSelectedGroupId = null;
  let lastMultiSelectedIds = null;
  let lastBoxWallIds = null; // Set<nodeId> | null — authoritative box-wall flags, see reconcile() below

  function meshList() {
    return Array.from(meshRegistry.values()).map((entry) => entry.mesh);
  }

  // Matches a BoxGeometry face-intersection's LOCAL normal (from
  // Three.js's own raycast hit, already in the mesh's own unrotated
  // object space) against LOCAL_FACES to recover which named face
  // ('right'/'left'/'top'/'bottom'/'front'/'back') was actually
  // clicked — used by collinear face-picking below.
  function faceNameFromLocalNormal(normal) {
    let best = null;
    let bestDot = -Infinity;
    for (const [name, v] of Object.entries(LOCAL_FACES)) {
      const dot = normal.x * v.x + normal.y * v.y + normal.z * v.z;
      if (dot > bestDot) { bestDot = dot; best = name; }
    }
    return best;
  }

  // ---- collinear face-pick mode: while active, ordinary select/drag
  // is suspended in BOTH views and clicks report (nodeId, faceName)
  // to onFacePick instead — see modeller-main.js's handleFacePick.
  let facePickMode = false;
  let onFacePickCallback = null;
  function setFacePickMode(active, onFacePick) {
    facePickMode = active;
    onFacePickCallback = onFacePick || null;
    if (gizmos) gizmos.detachAll(); // no move/resize handles while picking — see reconcile()'s gate below too
    if (view2d) view2d.setSelectedMesh(null);
    if (!active) {
      setFaceHighlight(null, null); // leaving pick mode always clears any lingering highlight from that session
      setPanelHighlight(null, null);
      setPanelHighlightSet([]);
    }
  }

  // ---- 3D interaction layer ----
  const gestureState = { interactionHandled: false };

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
      if (hits.length > 0 && hits[0].face) {
        const hit = hits[0];

        const faceName = faceNameFromLocalNormal(hit.face.normal);

        // IMPORTANT:
        // hit.point is the actual 3D world-space position where
        // the mouse ray intersected the panel.
        const worldPoint = hit.point.clone();

        onFacePickCallback?.(
          hit.object.userData.nodeId,
          faceName,
          worldPoint
        );
      }

      return; // ordinary selection is suspended entirely while picking
    }

    onSelect?.(
      hits.length > 0 ? hits[0].object.userData.nodeId : null,
      e.ctrlKey || e.metaKey
    );
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
      onGroupDragStart,
      onGroupTransformChange,
    });
    gizmos.setMeshEntryLookup((mesh) => meshRegistry.get(mesh.userData.nodeId));
    gizmos.setNodeEntryLookup((nodeId) => meshRegistry.get(nodeId)); // used by the resize-proxy redirect (box Top/Bottom/Back/Front dragging Left/Right's own field) — see gizmos.js's handleFacePointerDown
  }

  function activate2D() {
    view2d = create2DControls(canvas, camera2d, scene, meshRegistry, {
      onSelect,
      onTransformChange: reportTransformToExternal,
      onDimensionChange,
      onGroupDragStart,
      onGroupTransformChange,
      isFacePickMode: () => facePickMode,

      // 2D now returns the actual world-space click position too.
      onFacePick: (nodeId, faceName, worldPoint) =>
        onFacePickCallback?.(nodeId, faceName, worldPoint),
    });
  }

  function deactivateCurrent() {
    if (orbit) { orbit.dispose(); orbit = null; }
    if (gizmos) { gizmos.dispose(); gizmos = null; }
    if (view2d) { view2d.dispose(); view2d = null; }
  }

  activate3D(); // default on load

  // ---- picture-in-picture renderer (own tiny WebGL context, same
  // shared `scene`) + click-to-swap. The wrapper div (not the canvas)
  // owns the click and hover styling; the canvas has pointer-events
  // disabled in CSS so it never fights the wrapper for the click. ----
  const pipRenderer = pipCanvas
    ? new THREE.WebGLRenderer({ canvas: pipCanvas, antialias: true })
    : null;
  const pipWrapper = pipCanvas ? pipCanvas.parentElement : null;
  const pipLabel = pipWrapper ? pipWrapper.querySelector('.pip-label') : null;
  if (pipRenderer) {
    pipRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    pipRenderer.setClearColor(0xf6ede0);
  }

  function updatePipLabel() {
    if (pipLabel) pipLabel.textContent = viewMode === '2d' ? '3D' : '2D';
  }
  updatePipLabel();

  if (pipWrapper) {
    pipWrapper.addEventListener('click', () => {
      onPipModeClick?.(viewMode === '2d' ? '3d' : '2d');
    });
  }

  function onPipResize() {
    if (!pipRenderer) return;
    const w = pipCanvas.clientWidth;
    const h = pipCanvas.clientHeight;
    if (w === 0 || h === 0) return;
    pipRenderer.setSize(w, h, false);

    camera3dPip.aspect = w / h;
    camera3dPip.updateProjectionMatrix();

    const aspect = w / h;
    camera2dPip.left = -ORTHO_HALF_HEIGHT * aspect;
    camera2dPip.right = ORTHO_HALF_HEIGHT * aspect;
    camera2dPip.top = ORTHO_HALF_HEIGHT;
    camera2dPip.bottom = -ORTHO_HALF_HEIGHT;
    camera2dPip.updateProjectionMatrix();
  }
  onPipResize(); // fixed CSS size — set once, no need to observe

  function setViewMode(mode) {
    if (mode === viewMode) return;
    deactivateCurrent();
    viewMode = mode;
    activeCamera = mode === '2d' ? camera2d : camera3d;
    if (mode === '2d') activate2D();
    else activate3D();
    onResize(); // camera projections depend on the active camera
    updatePipLabel();
    reconcile(lastResolvedPanels, lastSelectedId, lastSelectedGroupId, lastMultiSelectedIds, lastBoxWallIds); // re-apply immediately, don't wait for the next external render
  }

  function reconcile(resolvedPanels, selectedId, selectedGroupId, multiSelectedIds, boxWallIds, selectedBoxWallId) {
    lastResolvedPanels = resolvedPanels;
    lastSelectedId = selectedId;
    lastSelectedGroupId = selectedGroupId;
    lastMultiSelectedIds = multiSelectedIds;
    lastBoxWallIds = boxWallIds;

    updateFaceHighlight(resolvedPanels);
    updatePanelHighlight(resolvedPanels);
    updatePanelHighlightSet(resolvedPanels);

    const liveIds = new Set(resolvedPanels.map((p) => p.id));

    for (const [id, entry] of meshRegistry.entries()) {
      if (!liveIds.has(id)) {
        if (gizmos) {
          for (const tc of gizmos.controls) {
            if (tc.object === entry.mesh) tc.detach();
          }
        }
        scene.remove(entry.mesh); // removes the whole subtree, including entry.handleMesh (a child) — but geometry/material still need explicit disposal below, THREE.js doesn't do that on removal
        entry.mesh.geometry.dispose();
        entry.mesh.material.dispose();
        entry.edges.geometry.dispose();
        if (entry.handleMesh) {
          entry.handleMesh.geometry.dispose();
          entry.handleMesh.material.dispose();
          entry.handleEdges.geometry.dispose();
        }
        meshRegistry.delete(id);
      }
    }

    resolvedPanels.forEach((node) => {
      const w = node.width * MM_TO_UNIT;
      const h = node.height * MM_TO_UNIT;
      const t = node.thickness * MM_TO_UNIT;

      let entry = meshRegistry.get(node.id);
      const isSelected = node.id === selectedId || (selectedGroupId != null && node.groupId === selectedGroupId);
      const isMultiSelected = !isSelected && multiSelectedIds && multiSelectedIds.has(node.id);
      // A selected BOX WALL reuses the shelf-tool's own highlight color
      // (CONST_Face_Panel_Color_Highlight) instead of the ordinary
      // selection orange — same visual language as "this panel is the
      // one currently being pointed at", whether that's via shelf-pick
      // or via plain selection. boxWallIds is the same authoritative
      // set already used elsewhere in this function.
      const isSelectedSpecialPanel = node.id === selectedBoxWallId || node.id === selectedId;

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

      // 2D drag needs to know, per axis, whether it's allowed to move
      // this panel — same lockedFields the 3D gizmo already reads.
      entry.mesh.userData.lockedFields = node.lockedFields || {};
      entry.mesh.userData.lockedMoveAxes = node.lockedMoveAxes || [];
      entry.mesh.userData.lockedResizeAxes = node.lockedResizeAxes || [];
      entry.mesh.userData.isBoxPanel = !!node.isBoxPanel;
      // Sourced from the authoritative boxWallIds set (built in
      // modeller-main.js straight off the raw graph), not from
      // node.isBoxWall — see that call site's comment for why the
      // resolved node's own copy of this flag isn't trustworthy for
      // every box panel. Falls back to the old resolved-node check
      // only if no set was passed in, so this stays backward
      // compatible with any other caller of reconcile().
      entry.mesh.userData.isBoxWall = boxWallIds ? boxWallIds.has(node.id) : node.isBoxWall === true;
      // A door is never resizable or movable via the gizmo — see
      // modeller/gizmos.js's own isDoor(mesh) check, which fully
      // short-circuits both interactions the same way isBoxWall does,
      // rather than relying on lockedFields/lockedResizeAxes (which
      // only ever get set for a field that has an actual
      // spansBetween/attachedTo constraint on it — a door has none;
      // its geometry is baked as literal numbers, recomputed whole by
      // features/door.js#applyDoorAdjustmentsForGroup, not derived
      // through the constraint graph at all).
      entry.mesh.userData.isDoor = !!node.isDoor;
      // Same reasoning, drawer-front counterpart — a drawer front's
      // geometry is likewise baked as literal numbers, recomputed
      // whole by features/drawer.js#applyDrawerAdjustmentsForGroup,
      // not something to drag or resize by hand.
      entry.mesh.userData.isDrawerFront = !!node.isDrawerFront;
      // Same reasoning, drawer BOX panel counterpart (left/right/
      // bottom/back — see features/drawer.js#createDrawerBoxNodes):
      // also derived, also never resized/moved by hand.
      entry.mesh.userData.isDrawerBoxPanel = !!node.isDrawerBoxPanel;
      entry.mesh.userData.thicknessAxis = node.thicknessAxis || null;
      entry.mesh.userData.resizeProxy = node.resizeProxy || null;

      // Handle (door/drawer front only) — see shared/handle.js's own
      // header comment for why this is a plain CHILD mesh rather than
      // a graph panel: it's bought hardware, not cut from material,
      // and being a child means it automatically inherits the parent
      // panel's position/rotation (including a door's own open-swing
      // animation below) for free — nothing extra to keep in sync here.
      const handlePlacement = computeHandlePlacement(node);
      if (handlePlacement) {
        const dims = handlePlacement.axis === 'x'
          ? [handlePlacement.dims.length * MM_TO_UNIT, handlePlacement.dims.crossSection * MM_TO_UNIT, handlePlacement.dims.protrusion * MM_TO_UNIT]
          : [handlePlacement.dims.crossSection * MM_TO_UNIT, handlePlacement.dims.length * MM_TO_UNIT, handlePlacement.dims.protrusion * MM_TO_UNIT];

        if (!entry.handleMesh) {
          const handleMat = new THREE.MeshStandardMaterial({ color: 0x2b2b2b, roughness: 0.35, metalness: 0.65 });
          entry.handleMesh = new THREE.Mesh(new THREE.BoxGeometry(...dims), handleMat);
          entry.handleMesh.castShadow = true;
          const handleEdges = new THREE.LineSegments(
            new THREE.EdgesGeometry(entry.handleMesh.geometry),
            new THREE.LineBasicMaterial({ color: 0x000000 })
          );
          entry.handleMesh.add(handleEdges);
          entry.handleEdges = handleEdges;
          entry.mesh.add(entry.handleMesh); // CHILD — local position/rotation below are relative to the panel mesh, not world space
          entry.lastHandleDims = dims;
        } else if (dims.some((d, i) => Math.abs(d - entry.lastHandleDims[i]) > 1e-6)) {
          entry.handleMesh.geometry.dispose();
          entry.handleMesh.geometry = new THREE.BoxGeometry(...dims);
          entry.handleEdges.geometry.dispose();
          entry.handleEdges.geometry = new THREE.EdgesGeometry(entry.handleMesh.geometry);
          entry.lastHandleDims = dims;
        }
        entry.handleMesh.position.set(
          handlePlacement.localOffset.x * MM_TO_UNIT,
          handlePlacement.localOffset.y * MM_TO_UNIT,
          handlePlacement.localOffset.z * MM_TO_UNIT
        );
        entry.handleMesh.visible = true;
      } else if (entry.handleMesh) {
        entry.handleMesh.visible = false; // no longer a door/drawer front — shouldn't normally happen, but stay safe rather than leave a stray handle floating
      }

      const resolvedPosUnits = {
        x: node.position.x * MM_TO_UNIT,
        y: node.position.y * MM_TO_UNIT,
        z: node.position.z * MM_TO_UNIT,
      };
      autoBaseById.set(node.id, {
        x: node.basePosition.x * MM_TO_UNIT,
        y: node.basePosition.y * MM_TO_UNIT,
        z: node.basePosition.z * MM_TO_UNIT,
      });

      const isBeingDragged =
        (gizmos && gizmos.controls.some((tc) => tc.object === entry.mesh && tc.dragging)) ||
        (gizmos && gizmos.isDragging() && gizmos.isGroupMember(entry.mesh)) ||
        (view2d && view2d.isDragging() && view2d.draggedMeshRef() === entry.mesh) ||
        (view2d && view2d.isDragging() && view2d.isGroupMember(entry.mesh));

      if (!isBeingDragged) {
        entry.mesh.position.set(resolvedPosUnits.x, resolvedPosUnits.y, resolvedPosUnits.z);

        const rot = node.rotation || { x: 0, y: 0, z: 0 };
        entry.mesh.rotation.set(
          THREE.MathUtils.degToRad(rot.x),
          THREE.MathUtils.degToRad(rot.y),
          THREE.MathUtils.degToRad(rot.z)
        );

        entry.mesh.scale.set(1, 1, 1); // scale is only ever transient (see view2d.js's resize drag)
      }

      if (isSelectedSpecialPanel) {
        entry.mesh.material.color.set(0xedca05);//CONST_Face_Panel_Color_Highlight);
        entry.mesh.material.opacity = 0.5;// CONST_Face_Panel_Color_Highlight_Opacity;
      } else {
        entry.mesh.material.color.set(isSelected? 0xe0904a: isMultiSelected? 0x4f8cff: 0xdcbd8c);
        entry.mesh.material.opacity = 1;
      }
      const material = new THREE.MeshStandardMaterial({color: 0xdcbd8c,roughness: 0.75,metalness: 0.04,transparent: true,});
      entry.mesh.material.needsUpdate = true;
      entry.edges.material.color.set(isSelected? 0x8a4a1a: isMultiSelected? 0x2a5cc9: 0x8b6540);
    });

    const selectedEntry = meshRegistry.get(selectedId);
    // A WHOLE group is selected when there's a selectedGroupId but no
    // drilled-into selectedId (the two-level selection: first click
    // selects the group, a second click on a member drills in — see
    // modeller-main.js's handleCanvasSelectClick).
    const isWholeGroupSelected = !selectedId && selectedGroupId != null;
    const groupMemberMeshes = isWholeGroupSelected
      ? resolvedPanels
          .filter((p) => p.groupId === selectedGroupId)
          .map((p) => meshRegistry.get(p.id)?.mesh)
          .filter(Boolean)
      : null;

    if (gizmos) {
      if (facePickMode) {
        gizmos.detachAll(); // no move/resize handles while a collinear pick is in progress
      } else if (selectedEntry) {
        const node = resolvedPanels.find((p) => p.id === selectedId);
        gizmos.attachTo(selectedEntry.mesh, node?.lockedFields || {});
      } else if (groupMemberMeshes) {
        gizmos.attachToGroup(groupMemberMeshes);
      } else {
        gizmos.detachAll();
      }
    }
    if (view2d) {
      if (facePickMode) {
        view2d.setSelectedMesh(null); // no resize handles while a collinear pick is in progress
      } else if (selectedEntry) {
        view2d.setSelectedMesh(selectedEntry.mesh);
      } else if (groupMemberMeshes) {
        view2d.setSelectedGroup(groupMemberMeshes);
      } else {
        view2d.setSelectedMesh(null);
      }
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

  const viewCube = axesCanvas
    ? createViewCube(axesCanvas, {
        onFaceClick: (faceName) => {
          if (orbit) orbit.snapToFace(faceName); // no-op in 2D mode, where there's no orbit to snap
        },
      })
    : null;

  let animationFrameId = null;
  // function animate() {
  //   animationFrameId = requestAnimationFrame(animate);
  //   renderer.render(scene, activeCamera);
  //   if (viewCube) viewCube.render(activeCamera);
  //   if (pipRenderer) pipRenderer.render(scene, pipCameraForCurrentMode());
  // }
  function renderView(targetRenderer, camera, mode) {
    orientGridForView(mode);
    const previousOutlineVisibility =view2d?.getPanelOutlinesVisible?.() ?? false;
    view2d?.setPanelOutlinesVisible(mode === '2d');
    targetRenderer.render(scene, camera);
    view2d?.setPanelOutlinesVisible(previousOutlineVisibility);
  }
  
  function animate() {
    animationFrameId = requestAnimationFrame(animate);
    renderView(renderer, activeCamera, viewMode);
    if (viewCube) {viewCube.render(activeCamera);}
    if (pipRenderer) { // Picture-in-picture shows the opposite view
      const pipMode = viewMode === '2d' ? '3d' : '2d';
      const pipCamera = pipCameraForCurrentMode();
      renderView(pipRenderer, pipCamera, pipMode);
    }
  }
  animate();

  function dispose() {
    cancelAnimationFrame(animationFrameId);
    window.removeEventListener('resize', onResize);
    resizeObserver.disconnect();
    deactivateCurrent();
    if (viewCube) viewCube.dispose();
    if (pipRenderer) pipRenderer.dispose();

    for (const entry of meshRegistry.values()) {
      entry.mesh.geometry.dispose();
      entry.mesh.material.dispose();
      entry.edges.geometry.dispose();
      if (entry.handleMesh) {
        entry.handleMesh.geometry.dispose();
        entry.handleMesh.material.dispose();
        entry.handleEdges.geometry.dispose();
      }
    }
    meshRegistry.clear();
    faceHighlightGeo.dispose();
    faceHighlightMat.dispose();
    panelHighlightGeo.dispose();
    panelHighlightMat.dispose();
    for (const mesh of highlightSetMeshes.values()) {
      mesh.geometry.dispose();
      mesh.material.dispose();
    }
    highlightSetMeshes.clear();
    renderer.dispose();
  }

  return { reconcile, dispose, setViewMode, setFacePickMode, setFaceHighlight, setPanelHighlight, setPanelHighlightSet };
}
