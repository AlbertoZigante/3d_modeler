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

const RESIZE_HANDLE_COLOR = 0x454441; // same accent 2D's edge/rotate handles used — "this is draggable"
const HANDLE_RADIUS_UNITS = 0.01;

// Stock TransformControls draws a DOUBLE-headed arrow per axis — a
// cone on both the + and − side, joined by a connecting line/cylinder
// that only actually spans the + half. We only want the + arrowhead
// visible (the connecting line stays, since it's not an "arrow" and
// is still how the axis gets grabbed by clicking along it).
//
// TransformControls has no public option for this, so this reaches
// into its internal `_gizmo.gizmo.translate` group (three.js's own
// internal, underscore-prefixed field — not part of its public API,
// so this is coupled to the exact three.js version pinned in
// package.json and could silently stop matching in a future
// upgrade). Each axis is actually THREE separate meshes sharing one
// name ('X'/'Y'/'Z'): the connecting line and both arrowheads all get
// their position/rotation baked directly into their geometry at
// construction time (TransformControls' own setupGizmo does this,
// then resets object.position back to (0,0,0)), so there's no
// transform left to inspect afterward — telling them apart means
// computing each one's OWN geometry bounding-box center and checking
// its sign. Verified against the real, installed three.js version
// (not assumed): instantiated TransformControls standalone and
// printed each mesh's actual baked bounding-box center before
// writing this — line center ≈ +0.25, the two arrowheads ≈ ±0.55.
// Only the picker (invisible hit-target, unaffected here) still lets
// the axis be grabbed from either side — this only changes what's
// drawn, not what's clickable.

// TransformControls' translate gizmo has two arrowheads (+ and -),
// but the stock visual geometry only has ONE connecting line,
// running from the origin toward the positive direction. 
// Add a mirrored line on the negative side so each axis becomes:
//  ◀───────────────●───────────────▶ 
// The existing picker remains unchanged, so both directions are still draggable.
function addNegativeDirectionLines(transformMove) { 
  const translateGroup = transformMove._gizmo?.gizmo?.translate;
  if (!translateGroup) return;
  const axisData = {
    X: {axis: 'x', rotation: [0, 0, -Math.PI / 2], },
    Y: { axis: 'y', rotation: [0, 0, 0], },
    Z: { axis: 'z', rotation: [Math.PI / 2, 0, 0],
    },
  };

  for (const [axisName, data] of Object.entries(axisData)) { 
    const axisObjects = translateGroup.children.filter( (child) => child.name === axisName && child.geometry );
    if (!axisObjects.length) continue;
    // Find the line rather than an arrowhead.
    let positiveLine = null;
    let bestScore = Infinity;
    for (const child of axisObjects) {
      child.geometry.computeBoundingBox();
      const center = new THREE.Vector3();
      child.geometry.boundingBox.getCenter(center);
      const size = new THREE.Vector3();
      child.geometry.boundingBox.getSize(size);
      
      // A line is long and thin; arrowheads are comparatively compact.
      const componentIndex = data.axis === 'x' ? 0 : data.axis === 'y' ? 1 : 2;
      const lengthAlongAxis = size.getComponent(componentIndex);
      
      // Prefer the object whose center is positive and whose geometry is elongated along the axis.
      const score = center[data.axis] < 0 ? Infinity : Math.abs(center[data.axis] - 0.25) - lengthAlongAxis * 0.001;
      if (score < bestScore) { bestScore = score; positiveLine = child; } } if (!positiveLine) continue;
      // Clone the actual line geometry and material.
      const negativeLine = positiveLine.clone();
      negativeLine.geometry = positiveLine.geometry.clone();
      const mirror = new THREE.Matrix4(); // Mirror the baked geometry around the origin on the appropriate axis.
      if (data.axis === 'x') {
        mirror.makeScale(-1, 1, 1);
      } else if (data.axis === 'y') {
        mirror.makeScale(1, -1, 1);
      } else {
        mirror.makeScale(1, 1, -1);
      } negativeLine.geometry.applyMatrix4(mirror);
      negativeLine.name = axisName;
      negativeLine.userData.negativeDirectionLine = true; // Make sure it doesn't interfere with picking.
      negativeLine.renderOrder = positiveLine.renderOrder; // Keep the same render order as the original gizmo.
      translateGroup.add(negativeLine);
    }
  }

export function createGizmos(
  camera,
  canvas,
  scene,
  { onTransformChange, onDimensionChange, onBoxResize, onGroupDragStart, onGroupTransformChange, gestureState } = {}
) {
  const transformMove = new TransformControls(camera, canvas);
  transformMove.setMode('translate');
  transformMove.setSize(0.4);
  scene.add(transformMove.getHelper());
  addNegativeDirectionLines(transformMove);

  const allControls = [transformMove];

  // ---- GROUP drag: TransformControls only ever attaches to a single
  // Object3D, so a whole-group selection attaches it to this invisible,
  // geometry-less proxy instead of any real panel mesh. Its position is
  // just a drag HANDLE — only the DELTA the user drags it by matters
  // (see onGroupTransformChange in modeller-main.js), not where it
  // starts, so recomputing it as the live centroid on every
  // attachToGroup() call is always safe.
  const groupProxy = new THREE.Object3D();
  scene.add(groupProxy);
  let groupDrag = null; // { nodeIds, startProxyPos, startMeshPositions: Map<mesh, Vector3> }

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
    if (!transformMove.object) return;
    moveDragStart = { ...transformMove.object.position };
    if (transformMove.object === groupProxy && groupProxy.userData.memberMeshes) {
      const memberMeshes = groupProxy.userData.memberMeshes;
      groupDrag = {
        nodeIds: memberMeshes.map((m) => m.userData.nodeId),
        startProxyPos: groupProxy.position.clone(),
        startMeshPositions: new Map(memberMeshes.map((m) => [m, m.position.clone()])),
      };
      onGroupDragStart?.(groupDrag.nodeIds);
    }
  });
  transformMove.addEventListener('mouseUp', () => {
    moveDragStart = null;
    groupDrag = null;
  });
  transformMove.addEventListener('objectChange', () => {
    const mesh = transformMove.object;

    if (
      !mesh ||
      isBoxWall(mesh) ||
      !moveDragStart ||
      !shiftKeyDown
    ) {
      return;
    }

    const dx = mesh.position.x - moveDragStart.x;
    const dy = mesh.position.y - moveDragStart.y;
    const dz = mesh.position.z - moveDragStart.z;

    const absX = Math.abs(dx);
    const absY = Math.abs(dy);
    const absZ = Math.abs(dz);

    const dominant =
      absX >= absY && absX >= absZ
        ? 'x'
        : absY >= absZ
          ? 'y'
          : 'z';

    if (dominant !== 'x') mesh.position.x = moveDragStart.x;
    if (dominant !== 'y') mesh.position.y = moveDragStart.y;
    if (dominant !== 'z') mesh.position.z = moveDragStart.z;
  });

  function reportTransform(mesh) {
    if (!onTransformChange) return;

    const position = {
      x: mesh.position.x,
      y: mesh.position.y,
      z: mesh.position.z,
    };

    if (isBoxWall(mesh)) {
      const axis = mesh.userData.thicknessAxis;

      onTransformChange(mesh.userData.nodeId, {
        boxWall: true,
        axis,
        offsetDelta: position,
        rotation: {
          x: THREE.MathUtils.radToDeg(mesh.rotation.x),
          y: THREE.MathUtils.radToDeg(mesh.rotation.y),
          z: THREE.MathUtils.radToDeg(mesh.rotation.z),
        },
      });

      return;
    }

    // Send the CURRENT resolved position.
    // modeller-main.js converts this into the node's offset in mm.
    onTransformChange(mesh.userData.nodeId, {
      offsetDelta: position,
      rotation: {
        x: THREE.MathUtils.radToDeg(mesh.rotation.x),
        y: THREE.MathUtils.radToDeg(mesh.rotation.y),
        z: THREE.MathUtils.radToDeg(mesh.rotation.z),
      },
    });
  }

  transformMove.addEventListener('objectChange', () => {
    const obj = transformMove.object;
    if (!obj) return;

    if (obj === groupProxy) {
      // The proxy is the only thing TransformControls actually moves —
      // every real member mesh has to be driven by hand here, each
      // from ITS OWN drag-start position + the shared delta (same
      // replace-not-accumulate reasoning as modeller-main.js's
      // groupDragStartOffsets for the graph side of this).
      if (!groupDrag) return;
      const deltaUnits = new THREE.Vector3().subVectors(obj.position, groupDrag.startProxyPos);
      const deltaMm = {
        x: deltaUnits.x / MM_TO_UNIT,
        y: deltaUnits.y / MM_TO_UNIT,
        z: deltaUnits.z / MM_TO_UNIT,
      };
      // The caller may return a CORRECTED delta (e.g. clamped to the
      // scene's design limits) — if so, use that for the live mesh
      // positions instead of the raw drag delta. Nothing else resets
      // these positions between frames, so without this the meshes
      // would visibly overshoot the limit until some later render.
      const corrected = onGroupTransformChange?.(groupDrag.nodeIds, deltaMm);
      const finalDeltaMm = corrected || deltaMm;
      const finalDeltaUnits = new THREE.Vector3(
        finalDeltaMm.x * MM_TO_UNIT,
        finalDeltaMm.y * MM_TO_UNIT,
        finalDeltaMm.z * MM_TO_UNIT
      );
      groupDrag.startMeshPositions.forEach((startPos, mesh) => {
        mesh.position.copy(startPos).add(finalDeltaUnits);
      });
      return;
    }

    reportTransform(obj);
    positionResizeHandles(obj);
  });

  // ---- resize (visible dot handles, one per face) ----
  let getMeshEntry = null; // injected by scene.js: (mesh) => { lastDims } | undefined
  let getNodeEntry = null; // injected by scene.js: (nodeId) => { lastDims } | undefined — used only by the resize-proxy redirect below
  const raycaster = new THREE.Raycaster();
  let faceDrag = null; // { mesh, nodeId, axisKey, sign, field, dimsStartMm: {w,h,t}, worldNormal, axisOrigin, startParam, lastParam, dragStartMeshPos }
/* * Every resize face is explicitly associated with a LOCAL axis. 
* right   -> +X
* left    -> -X
* top     -> +Y
* bottom  -> -Y
* front   -> +Z
* back    -> -Z 
* The sign is important because the two opposite faces must behave 
* identically: dragging either face OUTWARD increases the dimension, 
* dragging either face INWARD decreases it. */
const FACE_RESIZE_INFO = {
  right: { axis: 'x', sign: +1, field: 'width' },
  left: { axis: 'x', sign: -1, field: 'width' },
  top: { axis: 'y', sign: +1, field: 'height' },
  bottom: { axis: 'y', sign: -1, field: 'height' },
  front: { axis: 'z', sign: +1, field: 'thickness' },
  back: { axis: 'z', sign: -1, field: 'thickness' },
};

  const resizeHandleGroup = new THREE.Group();
  resizeHandleGroup.visible = false;
  scene.add(resizeHandleGroup);

  function isBoxPanel(mesh) {
    return !!mesh?.userData?.isBoxPanel;
  }

  function isBoxWall(mesh) {
    return !!mesh?.userData?.isBoxWall ===true;
  }

  // A door: no move, no resize, full stop — unlike isBoxWall (which
  // still allows a single constrained drag axis and hides only the
  // resize handles), a door gets NEITHER. This is the one mechanism
  // that actually works for locking resize — see
  // features/door.js#createDoorNode's own comment on why
  // lockedFields.width/height can't do this on their own.
  function isDoor(mesh) {
    return !!mesh?.userData?.isDoor;
  }

  const FACE_NAMES = ['right', 'left', 'top', 'bottom', 'front', 'back'];
  const handleGeometry = new THREE.SphereGeometry(HANDLE_RADIUS_UNITS, 10, 10);
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
    // Always clear all handles first. This is important when selection
    // changes from an ordinary panel to a box wall.
    FACE_NAMES.forEach((faceName) => {
      resizeHandles[faceName].visible = false;
    });

    // Box walls are NEVER resized by dragging handles.
    //
    // thicknessAxis is the authoritative marker for the six walls:
    //   left/right -> x
    //   top/bottom -> y
    //   front/back -> z
    //
    // Do not use resizeProxy here. A resizeProxy describes how some
    // dependent box dimension is resolved; it is not the permission
    // to resize the wall itself.
    if (!mesh || isBoxWall(mesh) || isDoor(mesh)) {
      return;
    }

    const p = mesh.geometry.parameters;

    const halfW = p.width / 2;
    const halfH = p.height / 2;
    const halfT = p.depth / 2;

    const lockedFields = mesh.userData.lockedFields || {};
    const lockedResizeAxes = mesh.userData.lockedResizeAxes || [];

    mesh.updateMatrixWorld(true);

    const localFaceCenters = {
      right:  new THREE.Vector3( halfW, 0, 0),
      left:   new THREE.Vector3(-halfW, 0, 0),
      top:    new THREE.Vector3(0,  halfH, 0),
      bottom: new THREE.Vector3(0, -halfH, 0),
      front:  new THREE.Vector3(0, 0,  halfT),
      back:   new THREE.Vector3(0, 0, -halfT),
    };

    for (const faceName of FACE_NAMES) {
      resizeHandles[faceName]
        .position
        .copy(localFaceCenters[faceName])
        .applyMatrix4(mesh.matrixWorld);
    }

    if (
      faceDrag &&
      faceDrag.mesh === mesh &&
      faceDrag.fixedFaceWorldPos
    ) {
      resizeHandles[faceDrag.oppositeFaceName]
        .position
        .copy(faceDrag.fixedFaceWorldPos);
    }

    // Only ordinary panels get resize handles.
    resizeHandles.right.visible =
      !lockedFields.width &&
      !lockedResizeAxes.includes('x');

    resizeHandles.left.visible =
      !lockedFields.width &&
      !lockedResizeAxes.includes('x');

    resizeHandles.top.visible =
      !lockedFields.height &&
      !lockedResizeAxes.includes('y');

    resizeHandles.bottom.visible =
      !lockedFields.height &&
      !lockedResizeAxes.includes('y');

    // Thickness is never directly draggable.
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
    const mesh = transformMove.object;

    if (!mesh || isBoxWall(mesh) || isDoor(mesh) || !getMeshEntry || !resizeHandleGroup.visible) {
      return;
    }

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

    const resizeProxy = mesh.userData.resizeProxy;
    let targetNodeId = mesh.userData.nodeId;
    let field = FACE_TO_DIM_FIELD[faceName];
    let dimsEntry = getMeshEntry(mesh);
    let proxyTargetMesh = null;
    let proxyTargetStartPos = null;

    if (resizeProxy) {
      if (!getNodeEntry) return;
      const targetEntry = getNodeEntry(resizeProxy.targetNodeId);
      if (!targetEntry) return;
      targetNodeId = resizeProxy.targetNodeId;
      field = resizeProxy.targetField;
      dimsEntry = targetEntry;
      proxyTargetMesh = targetEntry.mesh;
      proxyTargetStartPos = targetEntry.mesh.position.clone();
    }
    if (!dimsEntry) return;

    const worldNormal = new THREE.Vector3(local.x, local.y, local.z).transformDirection(mesh.matrixWorld);
    const axisOrigin = hits[0].point.clone();
    const startMouseParam = axisDragParameter(e,axisOrigin,worldNormal);

    const oppositeFaceName = {
      right: 'left',
      left: 'right',
      top: 'bottom',
      bottom: 'top',
      front: 'back',
    }[faceName];

    const meshParams = mesh.geometry.parameters;

    const meshHalf = {
      x: meshParams.width * mesh.scale.x / 2,
      y: meshParams.height * mesh.scale.y / 2,
      z: meshParams.depth * mesh.scale.z / 2,
    };

    const oppositeLocal = LOCAL_FACES[oppositeFaceName];

    const fixedFaceWorldPos = new THREE.Vector3(
      oppositeLocal.x * meshHalf.x,
      oppositeLocal.y * meshHalf.y,
      oppositeLocal.z * meshHalf.z
    ).applyMatrix4(mesh.matrixWorld);

    // For a redirected drag, `worldNormal` is the DRAGGED mesh's OWN
    // face normal — which points TOWARD the target (e.g. Top's
    // 'front' face touches Left from above, so it points DOWN/inward)
    // for one of the two now-visible dots, and AWAY from it for the
    // other. Growth always has to mean "the dragged panel moves
    // further from the target", regardless of which of those two
    // dots was grabbed — so `proxyGrowthSign` flips the raw drag
    // scalar to match a FIXED reference direction (target → dragged
    // mesh) rather than trusting worldNormal's own sign, which can
    // point either way. Verified against concrete numbers (Left/Top's
    // real resolved positions) before shipping this — the unflipped
    // version made dragging a panel OUTWARD shrink the box.
    let proxyGrowthSign = 1;
    let proxyShiftDirection = worldNormal;
    if (proxyTargetMesh) {
      proxyShiftDirection = mesh.position.clone().sub(proxyTargetMesh.position).normalize();
      proxyGrowthSign = worldNormal.dot(proxyShiftDirection) >= 0 ? 1 : -1;
    }

    if (gestureState) gestureState.interactionHandled = true;
    faceDrag = {
      mesh,
      nodeId: targetNodeId,
      axisKey,
      sign,
      field,
      dimsStartMm: {
        w: dimsEntry.lastDims.w / MM_TO_UNIT,
        h: dimsEntry.lastDims.h / MM_TO_UNIT,
        t: dimsEntry.lastDims.t / MM_TO_UNIT,
      },
      worldNormal,
      axisOrigin,
      startParam: startMouseParam,
      lastParam: startMouseParam,
      dragStartMeshPos: mesh.position.clone(),
      fixedFaceWorldPos,
      oppositeFaceName,
      proxyTargetMesh, // set only for a redirected (box) drag — see above
      proxyTargetStartPos,
      proxyGrowthSign,
      proxyShiftDirection, // fixed target→dragged-mesh unit vector, used instead of worldNormal for the TARGET's own shift and offsetDeltaMm — see the comment above
      positionOnly: !!resizeProxy?.positionOnly,
    };
  }

  const FIELD_TO_DIM_KEY = { width: 'w', height: 'h', thickness: 't' };
  const FIELD_TO_LOCAL_AXIS = { width: 'x', height: 'y', thickness: 'z' }; // fixed by BoxGeometry's own construction convention — true for ANY mesh regardless of its rotation, which is exactly what makes the resizeProxy redirect above valid: it doesn't matter that the target mesh is a DIFFERENT node with a possibly different rotation, this mapping is rotation-independent

  function computeAsymmetricResize(e) {
    const currentParam = axisDragParameter(e, faceDrag.axisOrigin, faceDrag.worldNormal);
    const dragDeltaUnits = currentParam - faceDrag.startParam;
    const rawScalarMm = dragDeltaUnits / MM_TO_UNIT;
    faceDrag.lastParam = currentParam;
    // Box Left/Right panels resize the box by MOVING the dragged wall
    // along its normal. The opposite wall stays fixed. There is no
    // panel dimension to scale in this case: the box X span is the
    // distance between the two side panels.
    if (faceDrag.positionOnly) {
      return {
        newMm: faceDrag.dimsStartMm.w,
        startMm: faceDrag.dimsStartMm.w,
        shiftMm: rawScalarMm,
        rawScalarMm,
      };
    }

    const growthScalarMm = rawScalarMm * (faceDrag.proxyGrowthSign ?? 1);

    // Keyed off `field` (not `axisKey`) so this stays correct for a
    // redirected (resizeProxy) drag too, where axisKey describes the
    // DRAGGED mesh's own local face but field/dimsStartMm describe a
    // DIFFERENT node entirely — axisKey and field only coincide for an
    // ordinary same-mesh drag.
    const dimKey = FIELD_TO_DIM_KEY[faceDrag.field];
    const startMm = faceDrag.dimsStartMm[dimKey];
    const newMm = Math.max(MIN_PANEL_DIM_MM, startMm + growthScalarMm);
    const growthMm = newMm - startMm;
    const shiftMm = growthMm / 2;

    return { newMm, startMm, shiftMm, rawScalarMm };
  }

  function handleFacePointerMove(e) {
    if (!faceDrag) return;
    const { newMm, startMm, shiftMm, rawScalarMm } = computeAsymmetricResize(e);

    if (faceDrag.positionOnly) {
      // Box Left/Right: move the actual wall 1:1 along its own normal.
      // This changes the distance between the two literal side panels;
      // all dependent Top/Bottom/Front/Back dimensions then re-resolve.
      faceDrag.mesh.position
        .copy(faceDrag.dragStartMeshPos)
        .addScaledVector(faceDrag.worldNormal, rawScalarMm * MM_TO_UNIT);
    } else if (faceDrag.proxyTargetMesh) {
      const targetLocalAxis = FIELD_TO_LOCAL_AXIS[faceDrag.field];
      faceDrag.proxyTargetMesh.scale[targetLocalAxis] = newMm / startMm;
      faceDrag.proxyTargetMesh.position
        .copy(faceDrag.proxyTargetStartPos)
        .addScaledVector(faceDrag.proxyShiftDirection, shiftMm * MM_TO_UNIT);

      faceDrag.mesh.position
        .copy(faceDrag.dragStartMeshPos)
        .addScaledVector(faceDrag.worldNormal, rawScalarMm * MM_TO_UNIT);
    } else {
      faceDrag.mesh.scale[faceDrag.axisKey] = newMm / startMm; // live visual feedback only
      faceDrag.mesh.position
        .copy(faceDrag.dragStartMeshPos)
        .addScaledVector(faceDrag.worldNormal, shiftMm * MM_TO_UNIT);
    }

    positionResizeHandles(faceDrag.mesh); // keep the dot glued to the live-resizing face (the DRAGGED mesh, always — the dot should stay under the cursor even during a redirected drag)
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

    // Same direction as the live preview above: proxyShiftDirection
    // for a redirected drag (worldNormal is unreliable there — see
    // handleFacePointerDown), worldNormal for an ordinary one. Both
    // are unit vectors, so direction * (mm) is already a valid mm-
    // space offset delta — no MM_TO_UNIT conversion needed here (that
    // conversion is only for the transient THREE-units preview above).
    const shiftDirection = faceDrag.positionOnly
      ? faceDrag.worldNormal
      : (faceDrag.proxyTargetMesh ? faceDrag.proxyShiftDirection : faceDrag.worldNormal);
    const offsetDeltaMm = {
      x: shiftDirection.x * shiftMm,
      y: shiftDirection.y * shiftMm,
      z: shiftDirection.z * shiftMm,
    };

    faceDrag.mesh.scale.set(1, 1, 1); // bake into geometry on next reconcile, never leave scale lingering
    faceDrag.mesh.position.copy(faceDrag.dragStartMeshPos); // reconcile() will set the true final position (for a redirected drag, this mesh's OWN dims/position are untouched by onDimensionChange below — reconcile will move it via its attachedTo constraint once the target's resize lands)
    if (faceDrag.proxyTargetMesh && !faceDrag.positionOnly) {
      faceDrag.proxyTargetMesh.scale.set(1, 1, 1);
      faceDrag.proxyTargetMesh.position.copy(faceDrag.proxyTargetStartPos); // reconcile() will set the true final position once onDimensionChange below commits
    }

    // Clear faceDrag BEFORE calling onDimensionChange — see the
    // matching comment in view2d.js's handlePointerUp for why: it
    // synchronously triggers reconcile(), which checks isDragging()
    // to decide whether to skip repositioning this exact mesh.
    const nodeId = faceDrag.nodeId; // already redirected to the target node id, if this was a resizeProxy drag
    faceDrag = null;

    onDimensionChange?.(nodeId, dims, offsetDeltaMm);
  }

  canvas.addEventListener('pointerdown', handleFacePointerDown);
  window.addEventListener('pointermove', handleFacePointerMove);
  window.addEventListener('pointerup', handleFacePointerUp);

  function attachTo(mesh, lockedFields = {}) {
    if (transformMove.object !== mesh) {
      transformMove.attach(mesh);
    }

    if (isDoor(mesh)) {
      // No move, no resize — see isDoor's own comment above. Checked
      // FIRST and unconditionally (not folded into the lockedFields
      // checks below) because this must hold regardless of whatever
      // lockedFields happens to contain.
      transformMove.showX = false;
      transformMove.showY = false;
      transformMove.showZ = false;
      resizeHandleGroup.visible = false;
      return;
    }

    const lockedMoveAxes = mesh.userData.lockedMoveAxes || [];

    if (isBoxWall(mesh)) {
      const axis = mesh.userData.thicknessAxis;

      transformMove.showX =
        axis === 'x' &&
        !lockedFields.positionX &&
        !lockedMoveAxes.includes('x');

      transformMove.showY =
        axis === 'y' &&
        !lockedFields.positionY &&
        !lockedMoveAxes.includes('y');

      transformMove.showZ =
        axis === 'z' &&
        !lockedFields.positionZ &&
        !lockedMoveAxes.includes('z');

      resizeHandleGroup.visible = false;
      return;
    }

    transformMove.showX =
      !lockedFields.positionX &&
      !lockedMoveAxes.includes('x');

    transformMove.showY =
      !lockedFields.positionY &&
      !lockedMoveAxes.includes('y');

    transformMove.showZ =
      !lockedFields.positionZ &&
      !lockedMoveAxes.includes('z');

    positionResizeHandles(mesh);

    const hasResizeHandle = FACE_NAMES.some(
      faceName => resizeHandles[faceName].visible
    );

    resizeHandleGroup.visible = hasResizeHandle;
  }

  // Attaches the move gizmo to the WHOLE-GROUP proxy instead of any
  // single member mesh — dragging it then moves every member rigidly
  // (see the objectChange branch above). No resize handles: resizing
  // a whole group at once isn't supported, members keep their own
  // individual sizes. Design-limit axis-locking (lockedFields) also
  // doesn't apply here — see modeller-main.js's onGroupTransformChange
  // for why per-axis group clamping is a separate, flagged gap.
  function attachToGroup(memberMeshes) {
    if (!memberMeshes || memberMeshes.length === 0) { detachAll(); return; }

    const centroid = new THREE.Vector3();
    memberMeshes.forEach((m) => centroid.add(m.position));
    centroid.divideScalar(memberMeshes.length);
    groupProxy.position.copy(centroid);
    groupProxy.userData.memberMeshes = memberMeshes;

    if (transformMove.object !== groupProxy) transformMove.attach(groupProxy);
    transformMove.showX = true;
    transformMove.showY = true;
    transformMove.showZ = true;

    resizeHandleGroup.visible = false;
  }

  // Used by scene.js's reconcile() to skip forcibly repositioning a
  // mesh that's currently being live-driven by an in-progress group
  // drag (mirrors the single-mesh `tc.object === entry.mesh` check it
  // already does for the ordinary move gizmo).
  function isGroupMember(mesh) {
    return !!(groupDrag && groupDrag.startMeshPositions.has(mesh));
  }

  function detachAll() {
    transformMove.detach();
    resizeHandleGroup.visible = false;
    groupProxy.userData.memberMeshes = null;
    groupDrag = null;
  }

  function setMeshEntryLookup(fn) {
    getMeshEntry = fn;
  }

  function setNodeEntryLookup(fn) {
    getNodeEntry = fn;
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
    scene.remove(groupProxy);
    handleGeometry.dispose();
    FACE_NAMES.forEach((n) => resizeHandles[n].material.dispose());
  }

  return { isDragging, attachTo, attachToGroup, isGroupMember, detachAll, setMeshEntryLookup, setNodeEntryLookup, dispose, controls: allControls };
}
