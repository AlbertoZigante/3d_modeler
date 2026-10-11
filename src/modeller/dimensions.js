/**
 * modeller/dimensions.js
 *
 * Draws user quotes (`distance` constraints) as CAD-style dimension
 * annotations in the shared THREE scene, so they appear in BOTH the 3D
 * and the 2D view: a line between the two quoted faces, end ticks and
 * a "<mm> mm" label.
 *
 *   blue  — quote satisfied
 *   red   — the panel is not where the quote says it should be, or
 *           the quote is part of a conflict (engine/quoteConflicts.js)
 *
 * computeDimensionSpecs() is the pure geometry step (unit-tested in
 * tests/quotes.test.mjs, no DOM needed); createDimensionOverlay() turns
 * those specs into THREE objects. Labels are world-sized sprites, so
 * they work under both the perspective and the orthographic camera.
 */
import * as THREE from 'three';
import {
  MM_TO_UNIT,
  FIELD_TO_AXIS,
  FACE_TO_DIM_FIELD,
  getAlignedAxis,
  computeWorldHalfExtents,
  getDisplayName,
} from './modules.js';

const AXES = ['x', 'y', 'z'];
const OK_COLOR = 0x1d4ed8;
const BAD_COLOR = 0xdc2626;
const TICK_MM = 30;
const FRONT_OFFSET_MM = 12;
const LABEL_HEIGHT_MM = 42;

/**
 * @returns {Array<{id:string, drivenId:string, anchorId:string, axis:string,
 *   from:{x,y,z}, to:{x,y,z}, tickAxis:string, valueMm:number,
 *   actualMm:number, ok:boolean, label:string}>}  all positions in mm
 */
export function computeDimensionSpecs(rawPanels, resolvedPanels) {
  const resolved = new Map(resolvedPanels.map((r) => [r.id, r]));
  const specs = [];

  rawPanels.forEach((raw) => {
    (raw.constraints || []).forEach((c) => {
      if (c.type !== 'distance' || c.overridden) return;
      const d = resolved.get(raw.id);
      const a = resolved.get(c.from?.node);
      if (!d || !a || d.hidden || a.hidden) return;

      const axis = FIELD_TO_AXIS[c.field];
      const aAl = getAlignedAxis(a.rotation, c.from.face);
      const mAl = getAlignedAxis(d.rotation, c.myFace);
      if (!axis || !aAl || !mAl || aAl.axis !== axis || mAl.axis !== axis) return;

      const anchorMm = a.position[axis] + aAl.sign * (a[FACE_TO_DIM_FIELD[c.from.face]] / 2);
      const myMm = d.position[axis] + mAl.sign * (d[FACE_TO_DIM_FIELD[c.myFace]] / 2);
      const actualMm = (myMm - anchorMm) * aAl.sign;

      const ha = computeWorldHalfExtents(a);
      const hd = computeWorldHalfExtents(d);
      const others = AXES.filter((k) => k !== axis);
      const at = {};
      others.forEach((k) => {
        const lo = Math.max(a.position[k] - ha[k], d.position[k] - hd[k]);
        const hi = Math.min(a.position[k] + ha[k], d.position[k] + hd[k]);
        at[k] = (lo + hi) / 2; // overlap centre, or the middle of the gap if they don't overlap
      });
      // Along X/Y quotes the line sits just in FRONT of both panels so
      // it is visible in the front elevation instead of hidden inside them.
      if (axis !== 'z') {
        at.z = Math.max(a.position.z + ha.z, d.position.z + hd.z) + FRONT_OFFSET_MM;
      }

      const from = { ...at, [axis]: anchorMm };
      const to = { ...at, [axis]: myMm };
      const tickAxis = axis === 'x' ? 'y' : 'x';
      specs.push({
        id: c.id, drivenId: raw.id, anchorId: a.id, axis, from, to, tickAxis,
        valueMm: c.value, actualMm,
        ok: Math.abs(actualMm - c.value) < 0.5,
        label: `${Math.round(c.value * 10) / 10} mm`,
        title: `${getDisplayName(raw)} ↔ ${getDisplayName(a)}`,
      });
    });
  });
  return specs;
}

function makeLabelSprite(text, color) {
  const canvas = document.createElement('canvas');
  canvas.width = 256;
  canvas.height = 64;
  const g = canvas.getContext('2d');
  g.fillStyle = 'rgba(255,255,255,0.92)';
  g.strokeStyle = `#${color.toString(16).padStart(6, '0')}`;
  g.lineWidth = 3;
  g.beginPath();
  g.roundRect(3, 3, 250, 58, 12);
  g.fill();
  g.stroke();
  g.fillStyle = g.strokeStyle;
  g.font = 'bold 34px sans-serif';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 33);
  const map = new THREE.CanvasTexture(canvas);
  const mat = new THREE.SpriteMaterial({ map, depthTest: false, depthWrite: false, transparent: true });
  const sprite = new THREE.Sprite(mat);
  const h = LABEL_HEIGHT_MM * MM_TO_UNIT;
  sprite.scale.set(h * 4, h, 1);
  sprite.renderOrder = 1001;
  return sprite;
}

const toVec = (p) => new THREE.Vector3(p.x * MM_TO_UNIT, p.y * MM_TO_UNIT, p.z * MM_TO_UNIT);

export function createDimensionOverlay(scene) {
  const group = new THREE.Group();
  group.name = 'quote-dimensions';
  scene.add(group);

  function clear() {
    while (group.children.length) {
      const child = group.children[0];
      group.remove(child);
      child.geometry?.dispose();
      if (child.material) {
        child.material.map?.dispose();
        child.material.dispose();
      }
    }
  }

  function update(rawPanels, resolvedPanels, conflictedIds = new Set()) {
    clear();
    computeDimensionSpecs(rawPanels, resolvedPanels).forEach((s) => {
      const color = s.ok && !conflictedIds.has(s.drivenId) ? OK_COLOR : BAD_COLOR;
      const lineMat = new THREE.LineBasicMaterial({ color, depthTest: false, transparent: true });
      const p1 = toVec(s.from);
      const p2 = toVec(s.to);

      const tick = (p) => {
        const d = { x: 0, y: 0, z: 0 };
        d[s.tickAxis] = TICK_MM * MM_TO_UNIT;
        return [p.clone().sub(new THREE.Vector3(d.x, d.y, d.z)), p.clone().add(new THREE.Vector3(d.x, d.y, d.z))];
      };
      const pts = [p1, p2, ...tick(p1), ...tick(p2)];
      const geo = new THREE.BufferGeometry().setFromPoints(pts);
      // segments: main line + one tick at each end
      geo.setIndex([0, 1, 2, 3, 4, 5]);
      const lines = new THREE.LineSegments(geo, lineMat);
      lines.renderOrder = 1000;
      group.add(lines);

      const label = makeLabelSprite(s.label, color);
      const mid = p1.clone().add(p2).multiplyScalar(0.5);
      const lift = (LABEL_HEIGHT_MM * 0.9) * MM_TO_UNIT;
      if (s.axis === 'y') mid.x += lift * 2.2; else mid.y += lift;
      label.position.copy(mid);
      group.add(label);
    });
  }

  return {
    update,
    setVisible: (v) => { group.visible = v; },
    dispose: () => { clear(); scene.remove(group); },
  };
}
