/**
 * 2D (front elevation) view: orthographic camera looking down -Z,
 * plus PowerPoint-style handles for selected panels.
 *
 * HANDLES (item 12+):
 *   Arc-arrow above the panel: click once → rotate +90° CCW on the
 *     XY plane (Z-axis). The arc is positioned above the panel's
 *     world bounding sphere so it never overlaps the panel, and is
 *     always world-upright regardless of the panel's own rotation.
 *   4-directional arrow at panel center: drag to translate.
 *     Dragging the panel body also translates (fallback, kept for
 *     convenience), but the explicit handle makes the intent visible.
 *
 * FACE PICKING (item 12): see faceFromClick2D below — faces whose
 *   world normals lie in the XY plane (perpendicular to the view
 *   direction) are visible as edges and are the only pickable ones.
 */

import * as THREE from 'three';
import { LOCAL_FACES } from './modules.js';

const HANDLE_GAP = 0.22;   // world units from panel bounding edge to arc center
const ARC_R      = 0.095;  // arc circle radius
const ORANGE     = 0xd97742;
const mat  = () => new THREE.MeshBasicMaterial({ color: ORANGE, side: THREE.DoubleSide });
const lmat = () => new THREE.LineBasicMaterial({ color: ORANGE });

// ---- faceFromClick2D ------------------------------------------------
// Which face was clicked in the 2D XY view? Finds the local face whose
// world normal (after applying mesh.rotation), projected to XY, best
// matches the direction from the mesh center to the click point.
// Faces whose world normals collapse to near-zero in XY (i.e. they
// point along ±Z = they appear as the filled rectangle, not as an
// edge) are automatically excluded.
function faceFromClick2D(mesh, clickWorldPoint) {
  const dir = new THREE.Vector2(
    clickWorldPoint.x - mesh.position.x,
    clickWorldPoint.y - mesh.position.y,
  );
  if (dir.length() < 1e-6) return null;
  dir.normalize();

  let bestFace = null;
  let bestDot  = -Infinity;

  for (const [faceName, localNormal] of Object.entries(LOCAL_FACES)) {
    const worldNormal = new THREE.Vector3(localNormal.x, localNormal.y, localNormal.z)
      .applyEuler(mesh.rotation);
    const projected = new THREE.Vector2(worldNormal.x, worldNormal.y);
    if (projected.length() < 0.25) continue; // face parallel to view — not a visible edge
    projected.normalize();
    const dot = dir.dot(projected);
    if (dot > bestDot) { bestDot = dot; bestFace = faceName; }
  }
  return bestFace;
}

// ---- buildRotationArc -----------------------------------------------
// A ⟲-style circular arc with a filled arrowhead at its open end.
// Clicking the hit ring rotates the attached panel +90° CCW.
// Visual style matches PowerPoint's rotation handle.
function buildRotationArc() {
  const group = new THREE.Group();

  // Arc: ~300° CCW sweep, leaving a short gap for the arrowhead
  const gapStart = -Math.PI * 0.28;  // start just past lower-right
  const sweep    =  Math.PI * 1.72;  // ≈ 310°
  const pts = [];
  for (let i = 0; i <= 52; i++) {
    const a = gapStart + sweep * (i / 52);
    pts.push(new THREE.Vector3(ARC_R * Math.cos(a), ARC_R * Math.sin(a), 0));
  }
  group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), lmat()));

  // Arrowhead at the END of the arc (filled triangle)
  const tipA = gapStart + sweep;
  const tipX = ARC_R * Math.cos(tipA);
  const tipY = ARC_R * Math.sin(tipA);
  // CCW tangent direction at the tip: (-sin(a), cos(a)) * length
  const tLen = 0.055;
  const tx = -Math.sin(tipA) * tLen;
  const ty =  Math.cos(tipA) * tLen;
  // Perpendicular for arrowhead width
  const pLen = 0.027;
  const norm = Math.sqrt(tx*tx + ty*ty) || 1;
  const px = (-ty / norm) * pLen;
  const py = ( tx / norm) * pLen;

  const sh = new THREE.Shape();
  sh.moveTo(tipX + tx,             tipY + ty);
  sh.lineTo(tipX + px - tx * 0.4, tipY + py - ty * 0.4);
  sh.lineTo(tipX - px - tx * 0.4, tipY - py - ty * 0.4);
  sh.closePath();
  group.add(new THREE.Mesh(new THREE.ShapeGeometry(sh), mat()));

  // Stem dot at bottom of arc (visual anchor, like PowerPoint's)
  const stemDot = new THREE.Mesh(new THREE.CircleGeometry(0.015, 10), mat());
  stemDot.position.set(0, -ARC_R - 0.025, 0);
  group.add(stemDot);

  // Invisible hit ring — larger than visual for usability
  const hitMesh = new THREE.Mesh(
    new THREE.RingGeometry(ARC_R - 0.08, ARC_R + 0.08, 36),
    new THREE.MeshBasicMaterial({ visible: false, side: THREE.DoubleSide }),
  );
  group.add(hitMesh);

  return { group, hitMesh };
}

// ---- buildMoveHandle ------------------------------------------------
// Four-directional arrow at the panel's center, exactly like the
// move-cursor in PowerPoint: four arrow heads pointing N/S/E/W, each
// on a short shaft, sharing a center element.
function buildMoveHandle() {
  const group = new THREE.Group();
  const m = mat();
  const dist = 0.082;  // shaft+arrowhead total: center to tip
  const aw   = 0.022;  // arrowhead half-width at base
  const al   = 0.036;  // arrowhead height
  const sw   = 0.007;  // shaft half-width

  // One arrow shape pointing +Y, duplicated 4× by Z-rotation
  for (const deg of [0, 90, 180, 270]) {
    const s = new THREE.Shape();
    s.moveTo( 0,   dist);          // tip
    s.lineTo(-aw,  dist - al);     // arrowhead left base
    s.lineTo(-sw,  dist - al);     // join shaft
    s.lineTo(-sw,  sw);            // shaft root (small gap from center)
    s.lineTo( sw,  sw);
    s.lineTo( sw,  dist - al);
    s.lineTo( aw,  dist - al);
    s.closePath();
    const mesh = new THREE.Mesh(new THREE.ShapeGeometry(s), m);
    mesh.rotation.z = -deg * Math.PI / 180;
    group.add(mesh);
  }

  // Center square (like PowerPoint's move cursor center dot)
  const cs = 0.012;
  const c = new THREE.Shape();
  c.moveTo(-cs, -cs); c.lineTo(cs, -cs); c.lineTo(cs, cs); c.lineTo(-cs, cs);
  c.closePath();
  group.add(new THREE.Mesh(new THREE.ShapeGeometry(c), m));

  // Invisible hit circle
  const hitMesh = new THREE.Mesh(
    new THREE.CircleGeometry(dist + 0.01, 16),
    new THREE.MeshBasicMaterial({ visible: false }),
  );
  group.add(hitMesh);

  return { group, hitMesh };
}

// ---- Stem line from panel top to arc center --------------------------
function buildStemLine() {
  const geo = new THREE.BufferGeometry().setFromPoints([
    new THREE.Vector3(0, 0, 0),
    new THREE.Vector3(0, 1, 0), // will be scaled by positionHandles
  ]);
  return new THREE.Line(geo, lmat());
}

// =====================================================================

export function create2DControls(
  canvas, camera, scene, meshRegistry,
  { onSelect, onTransformChange, onFacePick } = {}
) {
  const raycaster = new THREE.Raycaster();
  const dragPlane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

  // Build handles
  const { group: arcGroup, hitMesh: arcHit } = buildRotationArc();
  const { group: moveGroup, hitMesh: moveHit } = buildMoveHandle();
  const stemLine = buildStemLine();

  arcGroup.visible  = false;
  moveGroup.visible = false;
  stemLine.visible  = false;
  scene.add(arcGroup, moveGroup, stemLine);

  let currentMesh = null;
  let facePickMode = null;

  function setFacePickMode(mode) {
    facePickMode = mode;
    canvas.style.cursor = mode ? 'crosshair' : 'grab';
  }

  // Position both handles relative to the currently selected mesh.
  // The arc is placed above the panel's bounding sphere so it never
  // overlaps the panel regardless of the panel's own 2D rotation.
  function positionHandles(mesh) {
    mesh.geometry.computeBoundingSphere();
    const bsRadius = mesh.geometry.boundingSphere?.radius ?? 0.5;
    const top = mesh.position.y + bsRadius; // world Y of panel's furthest extent

    arcGroup.position.set(mesh.position.x, top + HANDLE_GAP, mesh.position.z + 0.01);
    arcGroup.rotation.z = 0; // always world-upright

    moveGroup.position.set(mesh.position.x, mesh.position.y, mesh.position.z + 0.01);

    // Stem: from panel top to arc bottom (the stem dot on the arc is at -ARC_R-0.025 local)
    const stemBot = top + 0.01;
    const stemTop = top + HANDLE_GAP - ARC_R - 0.03;
    stemLine.position.set(mesh.position.x, stemBot, mesh.position.z + 0.01);
    stemLine.scale.set(1, Math.max(0, stemTop - stemBot), 1);
  }

  function setSelectedMesh(mesh) {
    currentMesh = mesh;
    arcGroup.visible  = !!mesh;
    moveGroup.visible = !!mesh;
    stemLine.visible  = !!mesh;
    if (mesh) positionHandles(mesh);
  }

  // ---- Utilities ------------------------------------------------------
  function screenToWorld(e) {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width)  * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    const pt = new THREE.Vector3();
    raycaster.ray.intersectPlane(dragPlane, pt);
    return pt;
  }

  function meshList() {
    return Array.from(meshRegistry.values()).map((e) => e.mesh);
  }

  function hitTest(e, objects) {
    const rect = canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width)  * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1,
    );
    raycaster.setFromCamera(ndc, camera);
    return raycaster.intersectObjects(objects, false);
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

  // ---- Pointer / drag state -------------------------------------------
  let dragMode = null;       // null | 'translate'
  let draggedMesh = null;
  let dragStartWorld = null;
  let dragStartMeshPos = null;
  const gs = { moved: false, downX: 0, downY: 0 };

  // ---- Panel drag / translate -----------------------------------------
  function handlePointerDown(e) {
    gs.moved = false;
    gs.downX = e.clientX;
    gs.downY = e.clientY;

    // ---- face-pick mode: next click picks a face, no drag ----
    if (facePickMode) {
      const which = facePickMode;
      facePickMode = null;
      canvas.style.cursor = 'grab';
      const hits = hitTest(e, meshList());
      if (hits.length > 0) {
        const mesh = hits[0].object;
        const clickPt = screenToWorld(e);
        const faceName = faceFromClick2D(mesh, clickPt);
        if (faceName && onFacePick) onFacePick(which, mesh.userData.nodeId, faceName);
      }
      return;
    }

    // ---- rotation arc click: rotate +90° immediately (no drag) ----
    if (currentMesh && arcGroup.visible) {
      if (hitTest(e, [arcHit]).length > 0) {
        const curDeg = THREE.MathUtils.radToDeg(currentMesh.rotation.z);
        const snapped = Math.round(curDeg / 90) * 90; // snap to nearest 90 first
        currentMesh.rotation.z = THREE.MathUtils.degToRad(snapped + 90);
        positionHandles(currentMesh);
        reportTransform(currentMesh);
        return; // don't start any drag
      }
    }

    // ---- move handle OR body: start translate drag ----
    const moveHits = currentMesh && moveGroup.visible ? hitTest(e, [moveHit]) : [];
    const bodyHits = hitTest(e, meshList());

    if (moveHits.length > 0) {
      dragMode = 'translate';
      draggedMesh = currentMesh;
      dragStartWorld = screenToWorld(e);
      dragStartMeshPos = draggedMesh.position.clone();
    } else if (bodyHits.length > 0) {
      dragMode = 'translate';
      draggedMesh = bodyHits[0].object;
      dragStartWorld = screenToWorld(e);
      dragStartMeshPos = draggedMesh.position.clone();
    } else {
      dragMode = null;
      draggedMesh = null;
    }
  }

  function handlePointerMove(e) {
    const dx = e.clientX - gs.downX;
    const dy = e.clientY - gs.downY;
    if (Math.abs(dx) + Math.abs(dy) > 3) gs.moved = true;

    if (dragMode === 'translate' && draggedMesh) {
      const world = screenToWorld(e);
      let dxW = world.x - dragStartWorld.x;
      let dyW = world.y - dragStartWorld.y;
      if (e.shiftKey) {
        if (Math.abs(dxW) >= Math.abs(dyW)) dyW = 0;
        else dxW = 0;
      }
      const lock = draggedMesh.userData.lockedFields || {};
      draggedMesh.position.x = lock.positionX ? dragStartMeshPos.x : dragStartMeshPos.x + dxW;
      draggedMesh.position.y = lock.positionY ? dragStartMeshPos.y : dragStartMeshPos.y + dyW;
      if (draggedMesh === currentMesh) positionHandles(draggedMesh);
      reportTransform(draggedMesh);
    }
  }

  function handlePointerUp(e) {
    if (!gs.moved && dragMode !== null) {
      // Was a non-drag click on a panel body (not on a handle): select it
      const hits = hitTest(e, meshList());
      onSelect?.(hits.length > 0 ? hits[0].object.userData.nodeId : null);
    } else if (!gs.moved && dragMode === null) {
      // Click on empty space: deselect
      const hits = hitTest(e, meshList());
      onSelect?.(hits.length > 0 ? hits[0].object.userData.nodeId : null);
    }
    dragMode = null;
    draggedMesh = null;
  }

  canvas.addEventListener('pointerdown', handlePointerDown);
  window.addEventListener('pointermove', handlePointerMove);
  window.addEventListener('pointerup', handlePointerUp);

  // ---- Pan (drag empty space) + zoom ----------------------------------
  let panning = false;
  let panStartWorld = null;

  function handlePanDown(e) {
    if (dragMode || facePickMode) return;
    const arcOrMove = [
      ...(arcGroup.visible ? [arcHit] : []),
      ...(moveGroup.visible ? [moveHit] : []),
    ];
    if (hitTest(e, meshList()).length === 0 && hitTest(e, arcOrMove).length === 0) {
      panning = true;
      panStartWorld = screenToWorld(e);
    }
  }
  function handlePanMove(e) {
    if (!panning) return;
    const world = screenToWorld(e);
    camera.position.x -= world.x - panStartWorld.x;
    camera.position.y -= world.y - panStartWorld.y;
    camera.updateProjectionMatrix();
  }
  function handlePanUp() { panning = false; }

  canvas.addEventListener('pointerdown', handlePanDown);
  window.addEventListener('pointermove', handlePanMove);
  window.addEventListener('pointerup', handlePanUp);

  function handleWheel(e) {
    e.preventDefault();
    camera.zoom = Math.max(0.2, Math.min(6, camera.zoom * Math.exp(e.deltaY * 0.001)));
    camera.updateProjectionMatrix();
  }
  canvas.addEventListener('wheel', handleWheel, { passive: false });

  // ---- Public API ------------------------------------------------------
  function isDragging() { return dragMode !== null; }
  function draggedMeshRef() { return draggedMesh; }

  function dispose() {
    canvas.removeEventListener('pointerdown', handlePointerDown);
    window.removeEventListener('pointermove', handlePointerMove);
    window.removeEventListener('pointerup', handlePointerUp);
    canvas.removeEventListener('pointerdown', handlePanDown);
    window.removeEventListener('pointermove', handlePanMove);
    window.removeEventListener('pointerup', handlePanUp);
    canvas.removeEventListener('wheel', handleWheel);
    scene.remove(arcGroup, moveGroup, stemLine);
    arcHit.geometry.dispose();
    moveHit.geometry.dispose();
    stemLine.geometry.dispose();
  }

  return { isDragging, setSelectedMesh, setFacePickMode, draggedMeshRef, dispose };
}
