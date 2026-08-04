/**
 * Small clickable view-navigation cube, bottom-left of the viewport —
 * like Blender/Fusion360/SolidWorks' corner nav cube — PLUS the
 * original colored X/Y/Z axis lines drawn straight through it. The
 * axes use depthTest:false with a high renderOrder so they stay
 * visible even where the cube's opaque faces would otherwise occlude
 * them — they visually "pass through" the cube rather than being
 * hidden behind its near faces.
 *
 * It's a second, tiny, independent Three.js renderer/scene (not a
 * viewport/scissor split of the main one) — simplest way to keep this
 * fully decoupled from the main scene's content and camera.
 *
 * ROTATION: neither the cube nor the axes ever move; instead, this
 * module's own small camera is re-oriented every frame to match the
 * MAIN camera's current orientation (not position/zoom) — so as you
 * orbit the main view, everything here visibly rotates to match,
 * exactly as if you were looking at the same fixed cube+axes from a
 * new angle. Same trick the original axes-only indicator used.
 *
 * FACE LABELS <-> WORLD DIRECTION: matches this app's own
 * conventions, not a generic default —
 *   FRONT = +Z  (camera2d sits on +Z looking toward -Z; the "front"
 *                of a design is the face that faces that camera)
 *   BACK  = -Z
 *   RIGHT = +X  (new panels are always placed further in +X — see
 *                computeNextBasePosition in modules.js)
 *   LEFT  = -X
 *   TOP   = +Y  (height grows upward in +Y; FLOOR_MM is negative Y)
 *   BOTTOM = -Y
 * BoxGeometry's face/material order is exactly [+X, -X, +Y, -Y, +Z,
 * -Z], so FACE_NAME_BY_MATERIAL_INDEX below is just that order
 * relabeled — no remapping logic needed beyond this one list.
 *
 * CLICK-TO-SNAP: clicking a face raycasts against the cube (in this
 * module's own tiny scene), reads which face was hit off
 * intersection.face.materialIndex, and calls onFaceClick(name) — see
 * scene.js, which wires that straight to the main orbit controller's
 * snapToFace(name) (orbitControls.js).
 */
import * as THREE from 'three';

const CUBE_SIZE = 0.62;
const FACE_BG = '#2a2a3e';
const FACE_BORDER = '#5a5a7e';
const FACE_TEXT = '#e8e8f0';
const AXIS_LENGTH = CUBE_SIZE * 0.85; // extends past the cube's half-size so tips poke out both sides

// BoxGeometry's own face/material order — do not reorder this array.
const FACE_LABELS_IN_GEOMETRY_ORDER = ['RIGHT', 'LEFT', 'TOP', 'BOTTOM', 'FRONT', 'BACK'];
const FACE_NAME_BY_MATERIAL_INDEX = ['right', 'left', 'top', 'bottom', 'front', 'back'];

const AXES = [
  { axis: 'x', color: 0xd94f4f, dir: new THREE.Vector3(1, 0, 0) },
  { axis: 'y', color: 0x4fd97a, dir: new THREE.Vector3(0, 1, 0) },
  { axis: 'z', color: 0x4f8cd9, dir: new THREE.Vector3(0, 0, 1) },
];

export function createViewCube(canvasEl, { onFaceClick } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas: canvasEl, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10);

  function makeFaceMaterial(label) {
    const size = 128;
    const tex = document.createElement('canvas');
    tex.width = size;
    tex.height = size;
    const ctx = tex.getContext('2d');
    ctx.fillStyle = FACE_BG;
    ctx.fillRect(0, 0, size, size);
    ctx.strokeStyle = FACE_BORDER;
    ctx.lineWidth = 5;
    ctx.strokeRect(3, 3, size - 6, size - 6);
    ctx.font = 'bold 20px -apple-system, sans-serif';
    ctx.fillStyle = FACE_TEXT;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(label, size / 2, size / 2 + 1);
    const texture = new THREE.CanvasTexture(tex);
    return new THREE.MeshBasicMaterial({ map: texture, transparent: true });
  }

  const materials = FACE_LABELS_IN_GEOMETRY_ORDER.map(makeFaceMaterial);
  const cubeGeometry = new THREE.BoxGeometry(CUBE_SIZE, CUBE_SIZE, CUBE_SIZE);
  const cube = new THREE.Mesh(cubeGeometry, materials);
  scene.add(cube);

  const edgesGeometry = new THREE.EdgesGeometry(cubeGeometry);
  const edges = new THREE.LineSegments(edgesGeometry, new THREE.LineBasicMaterial({ color: 0x8a8ab0 }));
  cube.add(edges);

  // ---- colored X/Y/Z axis lines, drawn straight through the cube ----
  // depthTest:false + a high renderOrder keeps them visible even
  // where the cube's opaque faces would otherwise hide them, so they
  // read as "passing through" the cube rather than being occluded.
  const axisGroup = new THREE.Group();
  const disposables = [];
  function makeAxisLabel(text, color) {
    const size = 48;
    const tex = document.createElement('canvas');
    tex.width = size;
    tex.height = size;
    const ctx = tex.getContext('2d');
    ctx.font = 'bold 30px -apple-system, sans-serif';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, size / 2, size / 2 + 1);
    const texture = new THREE.CanvasTexture(tex);
    const material = new THREE.SpriteMaterial({ map: texture, depthTest: false, transparent: true });
    const sprite = new THREE.Sprite(material);
    sprite.scale.set(0.16, 0.16, 0.16);
    sprite.renderOrder = 1000;
    disposables.push(texture, material);
    return sprite;
  }

  AXES.forEach(({ axis, color, dir }) => {
    const points = [dir.clone().multiplyScalar(-AXIS_LENGTH), dir.clone().multiplyScalar(AXIS_LENGTH)];
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({ color, depthTest: false });
    const line = new THREE.Line(geometry, material);
    line.renderOrder = 999;
    axisGroup.add(line);
    disposables.push(geometry, material);

    const label = makeAxisLabel(axis.toUpperCase(), `#${color.toString(16).padStart(6, '0')}`);
    label.position.copy(dir).multiplyScalar(AXIS_LENGTH + 0.12);
    axisGroup.add(label);
  });
  scene.add(axisGroup);

  const forward = new THREE.Vector3();

  function render(mainCamera) {
    mainCamera.getWorldDirection(forward);
    camera.position.copy(forward).multiplyScalar(-3);
    camera.up.copy(mainCamera.up);
    camera.lookAt(0, 0, 0);
    renderer.render(scene, camera);
  }

  function onResize() {
    const w = canvasEl.clientWidth;
    const h = canvasEl.clientHeight;
    if (w === 0 || h === 0) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  onResize();

  // ---- click-to-snap ----
  const raycaster = new THREE.Raycaster();
  function handleClick(e) {
    const rect = canvasEl.getBoundingClientRect();
    const ndc = new THREE.Vector2(
      ((e.clientX - rect.left) / rect.width) * 2 - 1,
      -((e.clientY - rect.top) / rect.height) * 2 + 1
    );
    raycaster.setFromCamera(ndc, camera);
    const hits = raycaster.intersectObject(cube, false);
    if (hits.length === 0) return;
    const faceName = FACE_NAME_BY_MATERIAL_INDEX[hits[0].face.materialIndex];
    onFaceClick?.(faceName);
  }
  canvasEl.addEventListener('click', handleClick);
  canvasEl.style.cursor = 'pointer';

  function dispose() {
    canvasEl.removeEventListener('click', handleClick);
    renderer.dispose();
    cubeGeometry.dispose();
    edgesGeometry.dispose();
    materials.forEach((m) => {
      m.map.dispose();
      m.dispose();
    });
    disposables.forEach((d) => d.dispose());
  }

  return { render, onResize, dispose };
}
