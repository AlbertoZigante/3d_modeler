/**
 * Manual camera orbit/pan/zoom, extracted out of scene.js so that
 * file's job is just "own the scene + reconcile it" rather than also
 * owning camera math. Pointer-event based (mouse, trackpad, touch
 * all work identically via click-drag).
 *
 * Deliberately knows nothing about gizmos or panel selection — it's
 * handed an `isBlocked()` predicate (so it can yield the pointer to
 * something else mid-drag, e.g. an active gizmo drag) and an
 * `onClick(e)` callback (fired only for a genuine click: no drag,
 * not blocked).
 */
import * as THREE from 'three';

export function createOrbitControls(canvas, camera, { isBlocked, onClick, gestureState } = {}) {
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

  function handlePointerDown(e) {
    if (gestureState) gestureState.gizmoHandled = false;
    pointer.down = true;
    pointer.button = e.button;
    pointer.x = e.clientX;
    pointer.y = e.clientY;
    pointer.moved = false;
    canvas.style.cursor = e.button === 0 ? 'grabbing' : 'move';
  }

  function handlePointerUp(e) {
    const blocked = gestureState ? gestureState.gizmoHandled : isBlocked?.();
    if (pointer.down && !pointer.moved && pointer.button === 0 && !blocked) {
      onClick?.(e);
    }
    pointer.down = false;
    canvas.style.cursor = 'grab';
  }

  function handlePointerMove(e) {
    if (!pointer.down) return;
    const dx = e.clientX - pointer.x;
    const dy = e.clientY - pointer.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) pointer.moved = true;
    pointer.x = e.clientX;
    pointer.y = e.clientY;

    // While a gizmo is being dragged, it owns the pointer — camera
    // orbit/pan must not fight it for the same drag.
    if (isBlocked?.()) return;

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
  }

  // Trackpad two-finger scroll (or mouse wheel) still zooms.
  function handleWheel(e) {
    e.preventDefault();
    spherical.radius = Math.max(1, Math.min(30, spherical.radius + e.deltaY * 0.01));
    applyCamera();
  }

  function handleContextMenu(e) {
    e.preventDefault();
  }

  canvas.addEventListener('pointerdown', handlePointerDown);
  window.addEventListener('pointerup', handlePointerUp);
  window.addEventListener('pointermove', handlePointerMove);
  canvas.addEventListener('wheel', handleWheel, { passive: false });
  canvas.addEventListener('contextmenu', handleContextMenu);
  canvas.style.cursor = 'grab';

  function dispose() {
    canvas.removeEventListener('pointerdown', handlePointerDown);
    window.removeEventListener('pointerup', handlePointerUp);
    window.removeEventListener('pointermove', handlePointerMove);
    canvas.removeEventListener('wheel', handleWheel);
    canvas.removeEventListener('contextmenu', handleContextMenu);
  }

  return { dispose };
}
