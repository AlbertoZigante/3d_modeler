import { computeWorldHalfExtents } from '../../../modeller/modules.js';
import { phase4ActionLabel, phase4EscapeHtml, phase4Unique } from './format.js';

/*
 * Panel graphics: identical to the master branch's assembly diagram
 * (pdfExport-assembly.js) — every panel is a plain wireframe box of
 * its world-axis-aligned extents, drawn under a 30° "cabinet oblique"
 * projection with depth foreshortened to 50%, one projection scale
 * shared by every step. Panels placed in earlier steps are faint
 * grey, this step's panels are bold, and join/integrate steps get a
 * red insertion arrow. No fills, shading or hidden-line removal.
 */
export const PHASE4_OBLIQUE_ANGLE_RAD = Math.PI / 6;

export const PHASE4_OBLIQUE_DEPTH_SCALE = 0.5;

export const PHASE4_BOX_EDGES = (() => {
  const edges = [];

  for (let i = 0; i < 8; i++) {
    for (let bit = 0; bit < 3; bit++) {
      const j = i ^ (1 << bit);

      if (j > i) {
        edges.push([i, j]);
      }
    }
  }

  return edges;
})();

export function phase4ProjectOblique(point) {
  return {
    px:
      point.x +
      point.z *
        Math.cos(PHASE4_OBLIQUE_ANGLE_RAD) *
        PHASE4_OBLIQUE_DEPTH_SCALE,

    py:
      point.y +
      point.z *
        Math.sin(PHASE4_OBLIQUE_ANGLE_RAD) *
        PHASE4_OBLIQUE_DEPTH_SCALE,
  };
}

export function phase4WireCorners(part) {
  const half = computeWorldHalfExtents({
    rotation: part.rotation,
    width: part.width,
    height: part.height,
    thickness: part.thickness ?? part.depth,
  });

  const p = part.position;
  const corners = [];

  for (let i = 0; i < 8; i++) {
    corners.push({
      x: p.x + (i & 1 ? 1 : -1) * half.x,
      y: p.y + (i & 2 ? 1 : -1) * half.y,
      z: p.z + (i & 4 ? 1 : -1) * half.z,
    });
  }

  return corners;
}

export function phase4BuildAssemblyStateSvg(
  step,
  allParts = [],
  placedBeforeIds = []
) {
  if (!step) {
    return '';
  }

  const parts =
    (Array.isArray(allParts) ? allParts : [])
      .filter(
        part =>
          !(part?.resolved?.hidden ?? part?.raw?.hidden)
      );

  if (!parts.length) {
    return `
      <div class="phase4-assembly-state empty">
        <div class="phase4-assembly-state-title">
          3D assembly state
        </div>
        <div class="phase4-assembly-state-empty">
          Model coordinates unavailable
        </div>
      </div>
    `;
  }

  const placedBefore =
    new Set(
      (Array.isArray(placedBeforeIds) ? placedBeforeIds : [])
        .map(String)
    );

  const stepIds =
    (Array.isArray(step.panelIds) ? step.panelIds : [])
      .map(String);

  const partById =
    new Map(
      parts.map(part => [String(part.id), part])
    );

  const cornersById =
    new Map(
      parts.map(part => [
        String(part.id),
        phase4WireCorners(part),
      ])
    );

  /*
   * Shared projection bounds over the WHOLE design, so a panel is the
   * same size on every page.
   */
  let minPx = Infinity;
  let maxPx = -Infinity;
  let minPy = Infinity;
  let maxPy = -Infinity;

  cornersById.forEach(corners => {
    corners.forEach(corner => {
      const { px, py } = phase4ProjectOblique(corner);

      minPx = Math.min(minPx, px);
      maxPx = Math.max(maxPx, px);
      minPy = Math.min(minPy, py);
      maxPy = Math.max(maxPy, py);
    });
  });

  if (
    !Number.isFinite(minPx) ||
    !Number.isFinite(maxPx) ||
    !Number.isFinite(minPy) ||
    !Number.isFinite(maxPy)
  ) {
    return `
      <div class="phase4-assembly-state empty">
        <div class="phase4-assembly-state-title">
          3D assembly state
        </div>
        <div class="phase4-assembly-state-empty">
          Model coordinates unavailable
        </div>
      </div>
    `;
  }

  const viewWidth = 780;
  const viewHeight = 430;

  const spanPx = maxPx - minPx || 1;
  const spanPy = maxPy - minPy || 1;

  const scale =
    Math.min(
      viewWidth / spanPx,
      viewHeight / spanPy
    ) * 0.85;

  const offsetX = (viewWidth - spanPx * scale) / 2;
  const offsetY = (viewHeight - spanPy * scale) / 2;

  const toSvg = point => {
    const { px, py } = phase4ProjectOblique(point);

    return {
      x: offsetX + (px - minPx) * scale,
      y: offsetY + (maxPy - py) * scale,
    };
  };

  /*
   * 130 mm-wide diagram box in the master PDF == viewWidth here.
   */
  const unit = viewWidth / 130;

  const wireframe = (id, color, width) => {
    const corners =
      cornersById.get(id).map(toSvg);

    return `
      <g stroke="${color}" stroke-width="${(width * unit).toFixed(2)}" stroke-linecap="round" fill="none">
        ${
          PHASE4_BOX_EDGES.map(([i, j]) =>
            `<line x1="${corners[i].x.toFixed(2)}" y1="${corners[i].y.toFixed(2)}" x2="${corners[j].x.toFixed(2)}" y2="${corners[j].y.toFixed(2)}" />`
          ).join('')
        }
      </g>
    `;
  };

  const fadedMarkup =
    [...placedBefore]
      .filter(id => cornersById.has(id))
      .map(id => wireframe(id, 'rgb(180,180,180)', 0.25))
      .join('');

  const stepKind = String(step.kind || '');

  const focusIds =
    stepIds.filter(
      id =>
        !placedBefore.has(id) ||
        stepKind === 'join' ||
        stepKind === 'integrate' ||
        stepKind === 'pre_install'
    );

  const boldMarkup =
    focusIds
      .filter(id => cornersById.has(id))
      .map(id => wireframe(id, 'rgb(20,20,20)', 0.6))
      .join('');

  let arrowMarkup = '';

  if (stepKind === 'join' || stepKind === 'integrate') {
    const targetId =
      stepIds.find(id => !placedBefore.has(id)) ??
      stepIds[0];

    const target = partById.get(targetId);

    if (target) {
      const end = toSvg(target.position);

      const start = {
        x: end.x - viewWidth * 0.28,
        y: end.y - viewHeight * 0.28,
      };

      const dx = end.x - start.x;
      const dy = end.y - start.y;
      const len = Math.hypot(dx, dy) || 1;
      const ux = dx / len;
      const uy = dy / len;
      const headLen = 3.2 * unit;
      const headAngle = Math.PI / 7;

      const head =
        [headAngle, -headAngle].map(a => {
          const hx = ux * Math.cos(a) - uy * Math.sin(a);
          const hy = ux * Math.sin(a) + uy * Math.cos(a);

          return `<line x1="${end.x.toFixed(2)}" y1="${end.y.toFixed(2)}" x2="${(end.x - hx * headLen).toFixed(2)}" y2="${(end.y - hy * headLen).toFixed(2)}" />`;
        }).join('');

      arrowMarkup = `
        <g stroke="rgb(200,40,40)" stroke-width="${(0.5 * unit).toFixed(2)}" stroke-linecap="round" fill="none">
          <line x1="${start.x.toFixed(2)}" y1="${start.y.toFixed(2)}" x2="${end.x.toFixed(2)}" y2="${end.y.toFixed(2)}" />
          ${head}
        </g>
      `;
    }
  }

  const placedCount =
    new Set([
      ...[...placedBefore].filter(id => cornersById.has(id)),
      ...focusIds.filter(id => cornersById.has(id)),
    ]).size;

  const totalCount =
    parts.length;

  return `
    <div
      class="phase4-assembly-state"
      style="
        width:100%;
        margin:0;
        padding:0;
      "
    >
      <div
        class="phase4-assembly-state-title"
        style="
          margin-bottom:6px;
          font-size:11px;
          font-weight:700;
        "
      >
        3D assembly state · resolved geometry
      </div>

      <svg
        viewBox="0 0 ${viewWidth} ${viewHeight}"
        width="100%"
        height="auto"
        preserveAspectRatio="xMidYMid meet"
        xmlns="http://www.w3.org/2000/svg"
        style="
          display:block;
          overflow:visible;
        "
      >
        ${fadedMarkup}
        ${boldMarkup}
        ${arrowMarkup}
      </svg>

      <div
        style="
          margin-top:4px;
          font-size:8px;
          opacity:.65;
        "
      >
        ${placedCount} / ${totalCount}
        panels placed
      </div>
    </div>
  `;
}

export function phase4StepDiagram(step) {
  if (step.diagramHtml) {
    return step.diagramHtml;
  }

  if (step.diagramSvg) {
    return step.diagramSvg;
  }

  const panelCodes = phase4Unique([
    ...(step.panelCodes || []),
    ...(step.otherPanelIds || []),
  ]);

  const primary =
    phase4EscapeHtml(
      panelCodes[0] || 'PART'
    );

  const secondary =
    phase4EscapeHtml(
      panelCodes.slice(1, 4).join(' + ')
    );

  const action =
    phase4EscapeHtml(
      phase4ActionLabel(step.action)
    );

  return `
    <div class="p4-diagram-fallback" aria-label="Assembly diagram placeholder">
      <div class="p4-diagram-panel p4-diagram-panel-main">
        <span>${primary}</span>
      </div>
      <div class="p4-diagram-arrow">↓</div>
      <div class="p4-diagram-target">
        <span>${secondary || 'ASSEMBLY'}</span>
      </div>
      <div class="p4-diagram-action">${action}</div>
    </div>
  `;
}
