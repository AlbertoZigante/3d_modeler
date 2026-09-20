/**
 * pdfExport-assembly.js
 *
 * ASSEMBLY PLAN PDF — Option A: schematic line diagrams, one per
 * step, in the style of a real flat-pack instruction booklet:
 * already-placed panels drawn faint/grey, this step's new panel(s)
 * drawn bold, a simple arrow showing where it goes, plus the
 * step's own tools/hardware/ergonomics text underneath.
 *
 * DELIBERATELY NOT a photorealistic render (see the original plan's
 * own "Option A vs Option B" split) — every panel is drawn as a plain
 * wireframe box (12 edges, no shading/hidden-line removal) under a
 * simple oblique ("cabinet") projection: depth (Z) is drawn receding
 * at a fixed angle instead of vanishing to a perspective point. This
 * is genuinely close to how real assembly diagrams are drawn, and —
 * same reasoning as the joints/nesting diagrams in the other split
 * files — it's implementable with jsPDF's own line-drawing primitives
 * directly, no separate rendering pipeline or 3D engine involved.
 *
 * The projection scale/origin is computed ONCE from the whole
 * design's bounding box and reused for every step, so proportions
 * stay consistent across the booklet — a panel is always the same
 * size on the page whether it's introduced in step 2 or step 9,
 * matching how a real instruction booklet never rescales between
 * pages.
 *
 * The assembly branch's own export file, split out of the old
 * monolithic engine/pdfExport.js so this domain never needs to touch
 * what -bom.js, -joints.js or -history.js own.
 */

import { jsPDF } from 'jspdf';
import { computeWorldHalfExtents } from '../modeller/modules.js';
import { PAGE_MARGIN_MM, TEXT_LINE_HEIGHT_MM, outputPdf } from './pdfExport-shared.js';

const OBLIQUE_ANGLE_RAD = Math.PI / 6; // 30° receding depth axis — a common "cabinet oblique" convention
const OBLIQUE_DEPTH_SCALE = 0.5; // depth foreshortened to 50% — keeps the drawing from reading as badly skewed

function projectOblique(point3d) {
  return {
    px: point3d.x + point3d.z * Math.cos(OBLIQUE_ANGLE_RAD) * OBLIQUE_DEPTH_SCALE,
    py: point3d.y + point3d.z * Math.sin(OBLIQUE_ANGLE_RAD) * OBLIQUE_DEPTH_SCALE,
  };
}

// The 8 corners of a resolved panel's own AABB, indexed 0-7 by the
// sign of (x,y,z) — bit0=x, bit1=y, bit2=z, 0=negative/1=positive.
// Keeping this bit-indexed (rather than an arbitrary corner order)
// is what makes edge generation below a one-liner instead of 12
// hand-written pairs.
function computeBoxCorners(resolvedPanel) {
  const half = computeWorldHalfExtents(resolvedPanel);
  const p = resolvedPanel.position;
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

// Every pair of corners whose bit-index differs by exactly one bit is
// a real cube edge — this generates all 12 without hardcoding them.
function boxEdges() {
  const edges = [];
  for (let i = 0; i < 8; i++) {
    for (let bit = 0; bit < 3; bit++) {
      const j = i ^ (1 << bit);
      if (j > i) edges.push([i, j]);
    }
  }
  return edges;
}
const BOX_EDGES = boxEdges();

/**
 * Computes the shared projection scale/bounds for the WHOLE design,
 * so every step's diagram uses the same scale (see file header).
 *
 * @param {Array} resolvedPanels
 * @returns {{minPx:number, maxPx:number, minPy:number, maxPy:number}}
 */
function computeSharedProjectionBounds(resolvedPanels) {
  let minPx = Infinity;
  let maxPx = -Infinity;
  let minPy = Infinity;
  let maxPy = -Infinity;
  resolvedPanels.filter((p) => !p.hidden).forEach((panel) => {
    computeBoxCorners(panel).forEach((corner) => {
      const { px, py } = projectOblique(corner);
      minPx = Math.min(minPx, px);
      maxPx = Math.max(maxPx, px);
      minPy = Math.min(minPy, py);
      maxPy = Math.max(maxPy, py);
    });
  });
  if (!Number.isFinite(minPx)) return { minPx: 0, maxPx: 1, minPy: 0, maxPy: 1 }; // no visible panels at all — degenerate but safe
  return { minPx, maxPx, minPy, maxPy };
}

// Maps one projected (px,py) point into PDF coordinates within a
// given diagram box (originX/Y, width/height), flipping Y since PDF
// grows downward while world/projected Y grows upward, and centering
// the (possibly non-square) projected bounds within the box.
function toDiagramXY(projectedPoint, bounds, box) {
  const spanPx = bounds.maxPx - bounds.minPx || 1;
  const spanPy = bounds.maxPy - bounds.minPy || 1;
  const scale = Math.min(box.width / spanPx, box.height / spanPy) * 0.85; // 15% padding inside the box
  const drawWidth = spanPx * scale;
  const drawHeight = spanPy * scale;
  const offsetX = box.x + (box.width - drawWidth) / 2;
  const offsetY = box.y + (box.height - drawHeight) / 2;
  return {
    x: offsetX + (projectedPoint.px - bounds.minPx) * scale,
    y: offsetY + (bounds.maxPy - projectedPoint.py) * scale,
  };
}

function drawPanelWireframe(doc, resolvedPanel, bounds, box, style) {
  const corners = computeBoxCorners(resolvedPanel).map((c) => toDiagramXY(projectOblique(c), bounds, box));
  doc.setDrawColor(...style.color);
  doc.setLineWidth(style.lineWidth);
  BOX_EDGES.forEach(([i, j]) => doc.line(corners[i].x, corners[i].y, corners[j].x, corners[j].y));
}

// A short, plain arrow (shaft + two-line arrowhead) from just outside
// the diagram box toward a panel's own projected center — enough to
// read as "this piece goes here" without a real vector-graphics
// arrowhead library.
function drawInsertionArrow(doc, targetResolvedPanel, bounds, box) {
  const centerProjected = projectOblique(targetResolvedPanel.position);
  const target = toDiagramXY(centerProjected, bounds, box);
  const start = { x: target.x - box.width * 0.28, y: target.y - box.height * 0.28 };

  doc.setDrawColor(200, 40, 40);
  doc.setLineWidth(0.5);
  doc.line(start.x, start.y, target.x, target.y);

  const dx = target.x - start.x;
  const dy = target.y - start.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const headLen = 3.2;
  const headAngle = Math.PI / 7;
  [headAngle, -headAngle].forEach((a) => {
    const hx = ux * Math.cos(a) - uy * Math.sin(a);
    const hy = ux * Math.sin(a) + uy * Math.cos(a);
    doc.line(target.x, target.y, target.x - hx * headLen, target.y - hy * headLen);
  });
}

const DIAGRAM_BOX = { width: 130, height: 95 };
const ALREADY_PLACED_STYLE = { color: [180, 180, 180], lineWidth: 0.25 };
const NEW_PANEL_STYLE = { color: [20, 20, 20], lineWidth: 0.6 };

/**
 * Renders one step's diagram box: every panel placed up to (and
 * including) this step drawn faint, this step's own new panel(s)
 * drawn bold, plus an insertion arrow for join/integrate steps (a
 * pre_install/unattached/anchor step introduces its panel with
 * nothing to point INTO yet, so no arrow is drawn for those).
 */
function drawStepDiagram(doc, step, resolvedById, placedIdsSoFar, bounds, box) {
  doc.setLineWidth(0.2);
  doc.setDrawColor(210, 210, 210);
  doc.rect(box.x, box.y, box.width, box.height);

  [...placedIdsSoFar].forEach((id) => {
    const panel = resolvedById.get(id);
    if (panel) drawPanelWireframe(doc, panel, bounds, box, ALREADY_PLACED_STYLE);
  });

  const focusIds = step.panelIds.filter((id) => !placedIdsSoFar.has(id) || step.kind === 'join' || step.kind === 'integrate' || step.kind === 'pre_install');
  focusIds.forEach((id) => {
    const panel = resolvedById.get(id);
    if (panel) drawPanelWireframe(doc, panel, bounds, box, NEW_PANEL_STYLE);
  });

  if (step.kind === 'join' || step.kind === 'integrate') {
    const newlyIntroduced = step.panelIds.find((id) => !placedIdsSoFar.has(id)) ?? step.panelIds[0];
    const panel = resolvedById.get(newlyIntroduced);
    if (panel) drawInsertionArrow(doc, panel, bounds, box);
  }
}

/**
 * @param {ReturnType<typeof import('./ergonomics.js').buildAssemblyPlan>} plan
 * @param {Array} resolvedPanels - resolved (not raw) panels, same array the plan's own panel ids resolve against
 * @param {{projectName?:string, fileName?:string, mode?:'save'|'open'}} [options]
 */
export function exportAssemblyPlanPdf(plan, resolvedPanels, { projectName = 'Assembly Instructions', fileName = 'assembly-instructions.pdf', mode = 'save' } = {}) {
  const doc = new jsPDF({ unit: 'mm', format: 'a4' });
  const pageWidth = doc.internal.pageSize.getWidth();
  const startX = PAGE_MARGIN_MM;

  const resolvedById = new Map(resolvedPanels.map((p) => [p.id, p]));
  const bounds = computeSharedProjectionBounds(resolvedPanels);

  // --- Cover page: parts list + tools needed, same convention as a
  // real flat-pack booklet's opening page ------------------------------
  let y = PAGE_MARGIN_MM;
  doc.setFontSize(16);
  doc.setFont(undefined, 'bold');
  doc.text(projectName, startX, y);
  y += 10;

  doc.setFontSize(11);
  doc.setFont(undefined, 'bold');
  doc.text('Tools needed', startX, y);
  y += 6;
  doc.setFontSize(9);
  doc.setFont(undefined, 'normal');
  if (plan.toolsSummary.length === 0) {
    doc.text('None.', startX, y);
    y += TEXT_LINE_HEIGHT_MM;
  } else {
    plan.toolsSummary.forEach((tool) => {
      doc.text(`- ${tool}`, startX, y);
      y += TEXT_LINE_HEIGHT_MM;
    });
  }

  y += 4;
  doc.setFontSize(11);
  doc.setFont(undefined, 'bold');
  doc.text('Parts', startX, y);
  y += 6;
  doc.setFontSize(9);
  doc.setFont(undefined, 'normal');
  resolvedPanels.filter((p) => !p.hidden).forEach((p) => {
    doc.text(`- ${p.pieceCode ?? p.id}  (${p.name ?? '?'})`, startX, y);
    y += TEXT_LINE_HEIGHT_MM;
  });

  // --- One page per step ------------------------------------------
  const placedIdsSoFar = new Set();
  plan.steps.forEach((step) => {
    doc.addPage();
    let stepY = PAGE_MARGIN_MM;

    doc.setFontSize(13);
    doc.setFont(undefined, 'bold');
    doc.text(`Step ${step.index}`, startX, stepY);
    stepY += 7;

    doc.setFontSize(10);
    doc.setFont(undefined, 'normal');
    doc.text(step.description, startX, stepY, { maxWidth: pageWidth - PAGE_MARGIN_MM * 2 });
    stepY += 8;

    const box = { x: startX, y: stepY, width: Math.min(DIAGRAM_BOX.width, pageWidth - PAGE_MARGIN_MM * 2), height: DIAGRAM_BOX.height };
    drawStepDiagram(doc, step, resolvedById, placedIdsSoFar, bounds, box);
    stepY += box.height + 8;

    doc.setFontSize(9);
    doc.setFont(undefined, 'normal');
    const ergonomicsBits = [
      `~${step.ergonomics.weightKg}kg`,
      `work surface: ${step.ergonomics.recommendedSurface}`,
    ];
    if (step.ergonomics.twoPersonJob) ergonomicsBits.push('TWO-PERSON JOB');
    if (step.ergonomics.singleJointCaution) ergonomicsBits.push('single joint — support before fastening');
    if (step.ergonomics.reorientationNeeded) ergonomicsBits.push(`flip so ${step.ergonomics.orientationAxis?.toUpperCase()} faces up`);
    doc.text(ergonomicsBits.join('   •   '), startX, stepY);
    stepY += TEXT_LINE_HEIGHT_MM;

    if (step.hardware.length > 0) {
      doc.text(`Hardware: ${step.hardware.map((h) => h.displayId).join(', ')}`, startX, stepY);
      stepY += TEXT_LINE_HEIGHT_MM;
    }
    if (step.tools.length > 0) {
      doc.text(`Tools: ${step.tools.join(', ')}`, startX, stepY, { maxWidth: pageWidth - PAGE_MARGIN_MM * 2 });
      stepY += TEXT_LINE_HEIGHT_MM;
    }

    // Update the placed-set AFTER drawing, so this step's own new
    // panel(s) still render bold rather than immediately faint.
    step.panelIds.forEach((id) => placedIdsSoFar.add(id));
  });

  outputPdf(doc, mode, fileName);
}
