/**
 * Small rotating axis indicator, bottom-left of the viewport — shows
 * which way world X/Y/Z currently point relative to the active
 * camera, the way Blender/most CAD tools do. It's a second, tiny,
 * independent Three.js renderer/scene (not a viewport/scissor split
 * of the main one) — simplest way to keep this fully decoupled from
 * the main scene's content and camera.
 *
 * The three axis lines never move; instead, this module's own small
 * camera is re-oriented every frame to match the MAIN camera's
 * current orientation (not position/zoom) — so as you orbit the main
 * view, the little X/Y/Z indicator visibly rotates to match, exactly
 * as if you were looking at the same fixed axes from a new angle.
 */
import * as THREE from 'three';

const AXIS_COLORS = { x: '#c0392b', y: '#2f8a4f', z: '#2f5fa8' };

export function createAxesGizmo(canvasEl) {
  const renderer = new THREE.WebGLRenderer({ canvas: canvasEl, alpha: true, antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));

  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10);

  function makeAxisLine(colorHex, dir) {
    const geo = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0, 0),
      dir.clone().multiplyScalar(0.55),
    ]);
    return new THREE.Line(geo, new THREE.LineBasicMaterial({ color: colorHex }));
  }

  function makeLabelSprite(text, color) {
    const size = 64;
    const canvasEl2 = document.createElement('canvas');
    canvasEl2.width = size;
    canvasEl2.height = size;
    const ctx = canvasEl2.getContext('2d');
    ctx.font = 'bold 42px -apple-system, sans-serif';
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, size / 2, size / 2 + 2);
    const texture = new THREE.CanvasTexture(canvasEl2);
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false }));
    sprite.scale.set(0.24, 0.24, 0.24);
    return sprite;
  }

  scene.add(makeAxisLine(AXIS_COLORS.x, new THREE.Vector3(1, 0, 0)));
  scene.add(makeAxisLine(AXIS_COLORS.y, new THREE.Vector3(0, 1, 0)));
  scene.add(makeAxisLine(AXIS_COLORS.z, new THREE.Vector3(0, 0, 1)));

  const labelX = makeLabelSprite('X', AXIS_COLORS.x); labelX.position.set(0.65, 0, 0);
  const labelY = makeLabelSprite('Y', AXIS_COLORS.y); labelY.position.set(0, 0.65, 0);
  const labelZ = makeLabelSprite('Z', AXIS_COLORS.z); labelZ.position.set(0, 0, 0.65);
  scene.add(labelX, labelY, labelZ);

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

  function dispose() {
    renderer.dispose();
  }

  return { render, onResize, dispose };
}
