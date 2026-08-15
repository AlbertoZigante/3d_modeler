/**
 * 2D (front elevation) view: an orthographic camera looking down -Z,
 * plus PowerPoint-style direct manipulation — drag a selected panel's
 * body to translate it, drag one of its four edge handles to resize
 * it, or drag one of its two move arrows to translate along a single
 * locked axis — instead of the 3D gizmos.
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
 * NO RESIZE DOTS FOR BOX WALLS OR SHELVES: a box wall's own size is
 * never directly resized — dragging a WALL (which relayoutBox in
 * modeller-main.js turns into a re-fit of the whole box) is the only
 * way to change a box's dimensions, exactly mirroring gizmos.js's 3D
 * attachTo(), which skips resize handles entirely for isBoxWall
 * meshes (checked explicitly below, not just inferred from
 * lockedResizeAxes, for the same belt-and-suspenders reason gizmos.js
 * does it directly). Shelves are excluded the same generic way every
 * other constraint-governed field already is: modeller-main.js's
 * addShelf sets lockedResizeAxes on creation (its width/height fields
 * are spansBetween-derived, so a literal resize-drag write would just
 * get overwritten by the resolver on the next pass) — no shelf-
 * specific check is needed here at all as a result.
 *
 * RESIZE is ASYMMETRIC — dragging an edge out by X moves only that
 * edge; the opposite edge's world position stays exactly fixed. That
 * means a resize here also shifts the panel's `offset` (its center
 * moves by half the growth, toward the dragged edge) — see
 * computeResizeResult() below, and modeller-main.js's
 * onDimensionChange handler for how that shift gets accumulated onto
 * the node's existing offset rather than replacing it.
 *
 * MOVE ARROWS: a small bidirectional arrow along world X and another
 * along world Y, shown at the selected panel's center (or the
 * centroid of a selected group). These move in exactly the same
 * WORLD X/Y space an ordinary body-drag already does — see
 * handlePointerMove's ordinary 'translate'/'group-translate'
 * branches, which already drag in raw world X/Y and already support
 * a Shift-to-lock-to-dominant-axis behavior. The arrows are a
 * visible, individually-grabbable version of that same lock, decided
 * up front by which handle you grab rather than inferred from drag
 * direction. Styled to match the 3D move gizmo (gizmos.js's stock
 * TransformControls) exactly: pure red (0xff0000) for X and pure
 * green (0x00ff00) for Y — the same primaries three.js's own
 * TransformControlsGizmo uses for its axis materials, at full opacity
 * (not the reduced opacity that library reserves for its invisible
 * pickers). depthTest/depthWrite are both off and renderOrder is set
 * high so the arrows always draw on top of every panel/outline/handle
 * regardless of 3D depth. The whole handle group is rescaled by
 * 1/camera.zoom on every reposition AND on every wheel-zoom (see
 * applyMoveHandleScreenScale) so it holds a constant SCREEN size —
 * an orthographic camera's zoom changes magnification, not distance,
 * so world-unit geometry would otherwise visibly grow/shrink as you
 * scroll. They are NOT rotated to match the panel's own 3D rotation —
 * a "local axis" wouldn't necessarily read as horizontal/vertical on
 * screen, and world X/Y is the space this view actually edits in
 * regardless of a panel's orientation.
 *
 * OUTLINE GEOMETRY: the panel-outline layer rebuilds each panel's
 * EdgesGeometry whenever its baked width/height/thickness change
 * (see refreshOutlineGeometryIfChanged) — not just its transform.
 * Without this, an outline stays visually stuck at whatever size the
 * panel was when the outline was first created, and only transform
 * changes (drag, live resize-preview via mesh.scale) were ever
 * reflected. Dimension changes that happen any OTHER way — a typed
 * inspector field, a material/thickness swap, or another box wall's
 * geometry being rebuilt live while you drag a different wall in 2D
 * (relayoutBox calling renderAll() every frame) — used to leave a
 * stale outline behind.
 */
import * as THREE from 'three';
import { MM_TO_UNIT, MIN_PANEL_DIM_MM, getAlignedAxis } from './modules.js';

const RESIZE_HANDLE_COLOR = 0x454441; // "this is draggable" accent

const PANEL_OUTLINE_COLOR = 0x30302e;
const PANEL_OUTLINE_OPACITY = 0.95;

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

function isBoxWall(mesh) {
  return mesh?.userData?.isBoxWall === true;
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
  const RESIZE_HANDLE_RADIUS_UNITS = 0.01;

  const edgeHandleGroup = new THREE.Group();
  edgeHandleGroup.visible = false;
  scene.add(edgeHandleGroup);


  // ---------------------------------------------------------------------------
  // PANEL OUTLINE LAYER
  // This is deliberately separate from the actual panel meshes:
  //
  //   panel mesh       -> normal rendering / raycasting
  //   outline mesh     -> visual-only, never raycast
  //
  // The outline is rebuilt whenever the panel geometry changes and its
  // transform is copied from the panel. This means live resize works without
  // changing the actual scene/reconciler architecture.
  // ---------------------------------------------------------------------------
  const PANEL_OUTLINE_LAYER = 7;
  camera.layers.enable(PANEL_OUTLINE_LAYER);
  const panelOutlineGroup = new THREE.Group();
  panelOutlineGroup.name = '2DPanelOutlines';
  panelOutlineGroup.renderOrder = 20;
  panelOutlineGroup.layers.set(PANEL_OUTLINE_LAYER);
  scene.add(panelOutlineGroup);

  const outlineEntries = new Map(); // mesh -> { line, hidden, lastDims: {width,height,depth} }
  const outlineSolidMaterial = new THREE.LineBasicMaterial({
    color: PANEL_OUTLINE_COLOR,
    transparent: true,
    opacity: PANEL_OUTLINE_OPACITY,
    depthTest: false,
    depthWrite: false,
  });

  const edgeHandleGeometry = new THREE.CircleGeometry(RESIZE_HANDLE_RADIUS_UNITS,16);
  const edgeHandleMaterial = new THREE.MeshBasicMaterial({color: 0x454441, depthTest: false,});
  const edgeHandles = {};

  ['left', 'right', 'top', 'bottom'].forEach((key) => {const handle = new THREE.Mesh(edgeHandleGeometry,edgeHandleMaterial);

    handle.renderOrder = 10;
    handle.userData.edgeName = key;
    edgeHandleGroup.add(handle);
    edgeHandles[key] = handle;
  });

  function disposeOutlineEntry(mesh) {
    const entry = outlineEntries.get(mesh);
    if (!entry) return;
    panelOutlineGroup.remove(entry.line);
    entry.line.geometry.dispose();
    outlineEntries.delete(mesh);
  }

  function createOutlineForMesh(mesh) {
    if (!mesh?.geometry) return null;
    const geometry = new THREE.EdgesGeometry(mesh.geometry, 15); // 1
    const line = new THREE.LineSegments(geometry,outlineSolidMaterial);

    line.name = '2DPanelOutline';
    line.renderOrder = 20;

    // Absolutely critical:
    // the outline must never steal pointer events from the real panel
    // or from the resize handles.
    line.raycast = () => {};
    panelOutlineGroup.add(line);
    const p = mesh.geometry.parameters;
    const entry = {
      line,
      hidden: false,
      // Snapshot of the BAKED geometry params this outline was built
      // from — see refreshOutlineGeometryIfChanged, which compares
      // against this on every render pass to know whether the
      // EdgesGeometry itself (not just position/rotation/scale) needs
      // rebuilding.
      lastDims: p ? { width: p.width, height: p.height, depth: p.depth } : null,
    };
    outlineEntries.set(mesh, entry);
    updateOutlineTransform(mesh);
    return entry;
  }

  function updateOutlineTransform(mesh) {
    const entry = outlineEntries.get(mesh);
    if (!entry) return;

    const line = entry.line;
    // Copy the complete transform rather than only position/rotation.
    // This is important during the live resize preview because mesh.scale
    // is temporarily used by the resize interaction.
    line.position.copy(mesh.position);
    line.quaternion.copy(mesh.quaternion);
    line.scale.copy(mesh.scale);
  }

  // Rebuilds this outline's EdgesGeometry if the panel's BAKED
  // width/height/thickness (mesh.geometry.parameters) have changed
  // since the outline was last built — as opposed to a transient
  // mesh.scale change during a live resize preview, which
  // updateOutlineTransform's scale-copy already tracks correctly
  // without needing a geometry rebuild at all. This is what makes the
  // outline follow ANY dimension change, not just ones driven by this
  // view's own drag handlers — a typed inspector field, a material
  // swap, or another panel's geometry being rebuilt live during a box
  // relayout (see modeller-main.js's relayoutBox) while this one is
  // simply sitting there selected or unselected.
  function refreshOutlineGeometryIfChanged(mesh, entry) {
    const p = mesh.geometry.parameters;
    if (!p) return;
    if (
      entry.lastDims &&
      entry.lastDims.width === p.width &&
      entry.lastDims.height === p.height &&
      entry.lastDims.depth === p.depth
    ) {
      return; // unchanged since last build — nothing to do
    }
    const newGeometry = new THREE.EdgesGeometry(mesh.geometry, 15);
    entry.line.geometry.dispose();
    entry.line.geometry = newGeometry;
    entry.lastDims = { width: p.width, height: p.height, depth: p.depth };
  }

  function ensureOutlineForMesh(mesh) {
    if (!mesh?.geometry) return null;
    const existing = outlineEntries.get(mesh);
    if (!existing) {return createOutlineForMesh(mesh);}
    return existing;
  }

  function updatePanelOutlines() {
    const meshes = meshList();

    // Keep the outline registry synchronized with the mesh registry.
    const liveMeshes = new Set(meshes);
    for (const mesh of outlineEntries.keys()) {
      if (!liveMeshes.has(mesh)) {disposeOutlineEntry(mesh);}
    }

    // Make sure every current panel has an outline.
    for (const mesh of meshes) {ensureOutlineForMesh(mesh);}

    // Keep every outline exactly on its corresponding panel — both
    // its geometry (size) and its transform (position/rotation/scale).
    for (const mesh of meshes) {
      mesh.updateMatrixWorld(true);
      const entry = outlineEntries.get(mesh);
      if (!entry) continue;
      refreshOutlineGeometryIfChanged(mesh, entry);
      updateOutlineTransform(mesh);
      // Selected panel gets a slightly higher render priority.
      entry.line.renderOrder = mesh === currentMesh ? 22 : 21;
    }
  }

  function setPanelOutlinesVisible(visible) {
    panelOutlineGroup.visible = !!visible;
  }

  function getPanelOutlinesVisible() {
    return panelOutlineGroup.visible;
  }

  const EDGE_TO_FIELD = { left: 'width', right: 'width', top: 'height', bottom: 'height' };

  let currentMesh = null; // the mesh the handles currently follow
  let groupMembers = null; // array of meshes when a WHOLE group (not a drilled-into member) is selected

  // ---------------------------------------------------------------------------
  // MOVE (translate) axis handles — a bidirectional arrow along world X and
  // another along world Y, shown at the selected panel's center (or a
  // selected group's centroid). Grabbing one starts an ordinary
  // 'translate'/'group-translate' drag with that axis pre-locked, instead of
  // requiring Shift + inferring the dominant drag direction.
  //
  // Styled to match the 3D move gizmo (gizmos.js's stock TransformControls)
  // exactly: pure red/green primaries, full opacity, always on top
  // (depthTest/depthWrite off + a high renderOrder), and a CONSTANT SCREEN
  // SIZE regardless of the 2D camera's zoom — see applyMoveHandleScreenScale.
  // ---------------------------------------------------------------------------
  const MOVE_ARROW_COLOR_X = 0xff0000; // same pure red three.js's own TransformControlsGizmo uses for its X axis material
  const MOVE_ARROW_COLOR_Y = 0x00ff00; // same pure green for Y
  const MOVE_ARROW_RENDER_ORDER = 999; // higher than everything else in this file (outlines top out at 22) — always drawn on top
  const MOVE_ARROW_LENGTH_UNITS = 0.2;
  const MOVE_ARROW_HEAD_LENGTH = 0.045;
  const MOVE_ARROW_HEAD_WIDTH = 0.022;
  const MOVE_ARROW_SHAFT_WIDTH = 0.005; // thin shaft — closer to TransformControls' own thin-cylinder-plus-cone silhouette than a flat wedge

  const moveHandleGroup = new THREE.Group();
  moveHandleGroup.visible = false;
  scene.add(moveHandleGroup);

  // Full opacity, no blending — this is meant to read as an unambiguous,
  // always-on-top control surface, not a soft overlay like the resize dots
  // or panel outline.
  const moveArrowMaterials = {
    x: new THREE.MeshBasicMaterial({ color: MOVE_ARROW_COLOR_X, depthTest: false, depthWrite: false }),
    y: new THREE.MeshBasicMaterial({ color: MOVE_ARROW_COLOR_Y, depthTest: false, depthWrite: false }),
  };

  function buildArrowHeadGeometry() {
    const shape = new THREE.Shape();
    shape.moveTo(0, MOVE_ARROW_HEAD_WIDTH / 2);
    shape.lineTo(MOVE_ARROW_HEAD_LENGTH, 0);
    shape.lineTo(0, -MOVE_ARROW_HEAD_WIDTH / 2);
    shape.closePath();
    return new THREE.ShapeGeometry(shape);
  }

  // A double-headed arrow through the origin (shaft + a triangular head at
  // each end, pointing outward) — visually says "drag along this line,
  // either direction" without implying a default sign, same spirit as the
  // 3D move gizmo's double-headed axis lines (see gizmos.js's
  // addNegativeDirectionLines). `axis` is 'x' (built along +X, left as-is)
  // or 'y' (built along +X, then rotated 90°) — kept in local +X space
  // during construction purely so buildArrowHeadGeometry's own local coords
  // don't need a second variant.
  function buildAxisArrow(axis) {
    const group = new THREE.Group();
    const material = moveArrowMaterials[axis];

    const shaftGeo = new THREE.PlaneGeometry(MOVE_ARROW_LENGTH_UNITS * 2, MOVE_ARROW_SHAFT_WIDTH);
    const shaft = new THREE.Mesh(shaftGeo, material);
    shaft.renderOrder = MOVE_ARROW_RENDER_ORDER;
    group.add(shaft);

    const headGeoPos = buildArrowHeadGeometry();
    const headPos = new THREE.Mesh(headGeoPos, material);
    headPos.position.x = MOVE_ARROW_LENGTH_UNITS - MOVE_ARROW_HEAD_LENGTH;
    headPos.renderOrder = MOVE_ARROW_RENDER_ORDER;
    group.add(headPos);

    const headGeoNeg = buildArrowHeadGeometry();
    const headNeg = new THREE.Mesh(headGeoNeg, material);
    headNeg.rotation.z = Math.PI;
    headNeg.position.x = -(MOVE_ARROW_LENGTH_UNITS - MOVE_ARROW_HEAD_LENGTH);
    headNeg.renderOrder = MOVE_ARROW_RENDER_ORDER;
    group.add(headNeg);

    // A wider, invisible hit-target sitting alongside the visible shaft —
    // the visible shaft/heads are thin and precise clicking on them is
    // fiddly. Same "picker vs visual" split gizmos.js's 3D TransformControls
    // already uses. Its OWN .visible is what hitTest actually checks (see
    // positionMoveHandles/visibleMoveHitTargetList below) — kept in sync
    // with, but independent of, the parent group's visible flag.
    const hitGeo = new THREE.PlaneGeometry(MOVE_ARROW_LENGTH_UNITS * 2, MOVE_ARROW_SHAFT_WIDTH * 8);
    const hitMat = new THREE.MeshBasicMaterial({ visible: false });
    const hitTarget = new THREE.Mesh(hitGeo, hitMat);
    hitTarget.userData.moveAxis = axis;
    group.add(hitTarget);

    group.userData.moveAxis = axis;

    if (axis === 'y') group.rotation.z = Math.PI / 2;

    return { group, hitTarget };
  }

  const xArrow = buildAxisArrow('x');
  const yArrow = buildAxisArrow('y');
  const moveArrows = { x: xArrow.group, y: yArrow.group };
  const moveHitTargets = { x: xArrow.hitTarget, y: yArrow.hitTarget };
  moveHandleGroup.add(moveArrows.x);
  moveHandleGroup.add(moveArrows.y);

  // Keeps the move-arrow pair at a CONSTANT SCREEN size regardless of the
  // orthographic camera's zoom. Zooming an orthographic camera changes
  // magnification (not distance-from-camera the way a perspective zoom
  // effectively does), so world-unit geometry would otherwise visibly
  // grow/shrink as the user scrolls — dividing by camera.zoom exactly
  // cancels that out. Called every time the handles are repositioned AND
  // on every wheel-zoom even when nothing is being repositioned (see
  // handleWheel below), since zooming alone doesn't otherwise touch this
  // group at all.
  function applyMoveHandleScreenScale() {
    const s = 1 / camera.zoom;
    moveHandleGroup.scale.set(s, s, s);
  }

  // Positions the whole move-arrow pair at `centerWorld` and shows/hides
  // each axis individually per lockedFields/lockedMoveAxes — same gating
  // convention the edge handles already use for width/height, applied here
  // to positionX/positionY and the 'x'/'y' entries of lockedMoveAxes.
  function positionMoveHandles(centerWorld, lockedFields = {}, lockedMoveAxes = []) {
    moveHandleGroup.position.copy(centerWorld);
    applyMoveHandleScreenScale();
    const xVisible = !lockedFields.positionX && !lockedMoveAxes.includes('x');
    const yVisible = !lockedFields.positionY && !lockedMoveAxes.includes('y');
    moveArrows.x.visible = xVisible;
    moveArrows.y.visible = yVisible;
    moveHitTargets.x.visible = xVisible;
    moveHitTargets.y.visible = yVisible;
  }

  function visibleMoveHitTargetList() {
    return [moveHitTargets.x, moveHitTargets.y].filter((t) => t.visible);
  }

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
    const lockedFields = mesh.userData.lockedFields || {};
    const lockedMoveAxes = mesh.userData.lockedMoveAxes || [];

    // Box walls are resized ONLY by dragging a wall (which relayoutBox
    // in modeller-main.js turns into a re-fit of the whole box) — never
    // by an individual edge drag, exactly mirroring gizmos.js's 3D
    // attachTo(), which skips resize handles entirely for isBoxWall
    // meshes. Without this, an edge drag here would call
    // applyDimensionChange directly on just this one wall, bypassing
    // relayoutBox and leaving the other five walls out of sync. Move
    // arrows are unaffected — a box wall still moves along its one free
    // axis exactly as before, gated the normal way just below.
    if (isBoxWall(mesh)) {
      edgeHandles.left.visible = false;
      edgeHandles.right.visible = false;
      edgeHandles.top.visible = false;
      edgeHandles.bottom.visible = false;
      positionMoveHandles(mesh.position, lockedFields, lockedMoveAxes);
      updateOutlineForSingleMesh(mesh);
      return;
    }

    const params = mesh.geometry.parameters;
    // IMPORTANT:
    // These are LOCAL geometry dimensions only.
    //
    // Do NOT multiply by mesh.scale here.
    // mesh.matrixWorld below already contains the current mesh scale.
    //
    // This is what makes the handle follow the live-resized edge
    // exactly once instead of drifting to 2x the edge movement.
    const halfW = params.width / 2;
    const halfH = params.height / 2;

    const lockedResizeAxes = mesh.userData.lockedResizeAxes || [];

    const xEditable = fieldAlignedToAxis(mesh, 'x') === 'width';
    const yEditable = fieldAlignedToAxis(mesh, 'y') === 'height';

    // Make sure matrixWorld contains the CURRENT live resize
    // scale and position before calculating the handle locations.
    mesh.updateMatrixWorld(true);

    // The four edge centers in the panel's LOCAL coordinate system.
    // matrixWorld applies:
    //   - current scale
    //   - current rotation
    //   - current position
    // exactly once.
    const localPositions = {
      left:   new THREE.Vector3(-halfW, 0, 0),
      right:  new THREE.Vector3( halfW, 0, 0),
      top:    new THREE.Vector3(0,  halfH, 0),
      bottom: new THREE.Vector3(0, -halfH, 0),
    };

    for (const edgeName of Object.keys(localPositions)) {
      const worldPosition = localPositions[edgeName]
        .clone()
        .applyMatrix4(mesh.matrixWorld);
      edgeHandles[edgeName].position.copy(worldPosition);
    }

    // The handles themselves are already in WORLD SPACE.
    // Therefore the parent group must not inherit the panel's
    // transform.
    edgeHandleGroup.position.set(0, 0, 0);
    edgeHandleGroup.rotation.set(0, 0, 0);
    edgeHandleGroup.scale.set(1, 1, 1);

    // Two gates:
    // 1. Hide a handle when its dimension is constraint-locked (this
    //    is also what naturally hides a shelf's dots — see
    //    modeller-main.js's addShelf, which sets lockedResizeAxes for
    //    exactly this reason).
    // 2. Hide it when that dimension does not correspond to the
    //    visible X/Y axis in the front elevation.
    edgeHandles.left.visible =!lockedFields.width &&
      !lockedResizeAxes.includes('x') &&
      xEditable;
    edgeHandles.right.visible =
      !lockedFields.width &&
      !lockedResizeAxes.includes('x') &&
      xEditable;
    edgeHandles.top.visible =
      !lockedFields.height &&
      !lockedResizeAxes.includes('y') &&
      yEditable;
    edgeHandles.bottom.visible =
      !lockedFields.height &&
      !lockedResizeAxes.includes('y') &&
      yEditable;

    // Move arrows sit at the panel's WORLD center — mesh.position
    // already IS that world center (mesh geometry is centered on its
    // own origin), so no matrixWorld transform is needed here the way
    // the edge handles need one.
    positionMoveHandles(mesh.position, lockedFields, lockedMoveAxes);

    updateOutlineForSingleMesh(mesh);
  }

  function updateOutlineForSingleMesh(mesh) {
    const entry = ensureOutlineForMesh(mesh);
    if (!entry) return;
    mesh.updateMatrixWorld(true);
    updateOutlineTransform(mesh);
  }

  // ---- pointer / drag state ----
  let mode = null; // null | 'translate' | 'group-translate' | 'resize'
  let draggedMesh = null;
  let dragStartWorld = null;
  let dragStartMeshPos = null;
  let resizeEdgeKey = null;
  let resizeStartMm = null; // { width, height, thickness } at drag start
  let resizeStartLocalParam = 0;
  let groupDragStart = null; // { nodeIds, startWorld, startPositions: Map<mesh, Vector3> } — set only during 'group-translate'
  let lockedDragAxis = null; // 'x' | 'y' | null — set when a move ARROW (not the plain body) was grabbed; forces that single axis for the whole drag, same effect as Shift but decided up front instead of inferred from drag direction
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
    lockedDragAxis = null;

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

        // Record where the mouse actually grabbed the edge in the panel's LOCAL coordinate system.
        // Resize movement must be measured from the grabbed edge position, NOT from the panel center.
        const startWorld = dragStartWorld;
        const rot = draggedMesh.rotation.z;
        const dx = startWorld.x - dragStartMeshPos.x;
        const dy = startWorld.y - dragStartMeshPos.y;
        const cosInv = Math.cos(-rot);
        const sinInv = Math.sin(-rot);
        const startLocalX = dx * cosInv - dy * sinInv;
        const startLocalY = dx * sinInv + dy * cosInv;
        const isWidthEdge = resizeEdgeKey === 'left' || resizeEdgeKey === 'right';
        resizeStartLocalParam = isWidthEdge ? startLocalX : startLocalY;

        return;
      }
    }

    // Move arrows take priority over a plain body-grab (same "handles
    // beat the generic surface" precedence as edge handles above) —
    // grabbing one starts an ordinary translate/group-translate drag
    // with lockedDragAxis pre-set, so handlePointerMove's existing
    // axis-lock math (previously only reachable via Shift) applies
    // from the very first frame.
    if (moveHandleGroup.visible) {
      const arrowHits = hitTest(e, visibleMoveHitTargetList());
      if (arrowHits.length > 0) {
        lockedDragAxis = arrowHits[0].object.userData.moveAxis;

        if (groupMembers) {
          mode = 'group-translate';
          groupDragStart = {
            nodeIds: groupMembers.map((m) => m.userData.nodeId),
            startWorld: screenToWorld(e),
            startPositions: new Map(groupMembers.map((m) => [m, m.position.clone()])),
          };
          onGroupDragStart?.(groupDragStart.nodeIds);
        } else if (currentMesh) {
          mode = 'translate';
          draggedMesh = currentMesh;
          dragStartWorld = screenToWorld(e);
          dragStartMeshPos = draggedMesh.position.clone();
        }

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
    const dx0 = world.x - dragStartMeshPos.x;
    const dy0 = world.y - dragStartMeshPos.y;
    const lx = dx0 * cosInv - dy0 * sinInv;
    const ly = dx0 * sinInv + dy0 * cosInv;
    const isWidthEdge = resizeEdgeKey === 'left' || resizeEdgeKey === 'right';
    const outwardSign = resizeEdgeKey === 'right' || resizeEdgeKey === 'top' ? 1 : -1;

    // Measure movement from the position where the mouse actually grabbed the handle.
    const local = isWidthEdge ? lx : ly;
    const deltaLocal = local - resizeStartLocalParam;
    const scalarMm = (outwardSign * deltaLocal) / MM_TO_UNIT;

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
      if (lockedDragAxis === 'x') {
        // grabbed the X arrow — Y is pinned regardless of drag direction
        dyWorld = 0;
      } else if (lockedDragAxis === 'y') {
        dxWorld = 0;
      } else if (e.shiftKey) {
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
      if (lockedDragAxis === 'x') {
        dyWorld = 0;
      } else if (lockedDragAxis === 'y') {
        dxWorld = 0;
      } else if (e.shiftKey) {
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
        updateOutlineForSingleMesh(mesh);
      });
      // Keep the move-arrow pair riding the group's live centroid,
      // same reasoning as gizmos.js's 3D groupProxy.
      if (moveHandleGroup.visible) {
        const centroid = new THREE.Vector3();
        groupDragStart.startPositions.forEach((_, mesh) => centroid.add(mesh.position));
        centroid.divideScalar(groupDragStart.startPositions.size);
        moveHandleGroup.position.copy(centroid);
        applyMoveHandleScreenScale();
      }
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
      lockedDragAxis = null;

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
    lockedDragAxis = null;
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
    const arrowHit = moveHandleGroup.visible ? hitTest(e, visibleMoveHitTargetList()) : [];
    if (hits.length === 0 && edgeHit.length === 0 && arrowHit.length === 0) {
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
    // Zooming alone doesn't reposition anything, so nothing else would
    // otherwise touch the move-arrow group's scale — without this they'd
    // visibly grow/shrink with the frustum until the next unrelated
    // reposition (a selection change, a drag) happened to correct it.
    if (moveHandleGroup.visible) applyMoveHandleScreenScale();
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
    edgeHandleGroup.visible = !!mesh;
    moveHandleGroup.visible = !!mesh;
    if (mesh) {positionHandle(mesh);} // also positions/gates the move arrows and box-wall resize skip — see positionHandle
    updatePanelOutlines();
  }

  // Called instead of setSelectedMesh when a GROUP is selected as a
  // whole (not drilled into one member) — no resize handles (resizing
  // a whole group isn't supported), but clicking-and-dragging any
  // member's body — or either move arrow — now moves the whole group
  // rigidly (see handlePointerDown above).
  function setSelectedGroup(memberMeshes) {
    groupMembers = memberMeshes && memberMeshes.length > 0 ? memberMeshes : null;
    currentMesh = null;
    edgeHandleGroup.visible = false;
    if (groupMembers) {
      const centroid = new THREE.Vector3();
      groupMembers.forEach((m) => centroid.add(m.position));
      centroid.divideScalar(groupMembers.length);
      moveHandleGroup.visible = true;
      // Whole-group rigid move — both axes always free here, same as
      // gizmos.js's 3D attachToGroup (no per-axis design-limit locking
      // at the group level — see that file's own note on this gap).
      positionMoveHandles(centroid, {}, []);
    } else {
      moveHandleGroup.visible = false;
    }
    updatePanelOutlines();
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

    scene.remove(moveHandleGroup);
    [moveArrows.x, moveArrows.y].forEach((group) => {
      group.children.forEach((child) => {
        child.geometry?.dispose();
        if (child.material && child.material !== moveArrowMaterials.x && child.material !== moveArrowMaterials.y) {
          child.material.dispose(); // the invisible hit-target's own private material
        }
      });
    });
    moveArrowMaterials.x.dispose();
    moveArrowMaterials.y.dispose();

    // Dispose all generated panel outline geometries.
    for (const mesh of outlineEntries.keys()) {
      disposeOutlineEntry(mesh);
    }

    scene.remove(panelOutlineGroup);
    outlineSolidMaterial.dispose();
  }

  return { isDragging, setSelectedMesh, setSelectedGroup, isGroupMember, draggedMeshRef: () => draggedMesh, setPanelOutlinesVisible, getPanelOutlinesVisible,dispose };
}