/**
 * Graph node definitions for the modeller.
 *
 * STAGE 2: nodes now carry an optional `constraints` array. Each
 * constraint targets exactly one field ('width' | 'height' |
 * 'thickness' | 'positionX' | 'positionY' | 'positionZ') and is
 * either:
 *
 *   spansBetween — this field's VALUE is the distance between two
 *   referenced faces (used for width/height/thickness).
 *
 *   attachedTo — this field's VALUE is derived from touching one of
 *   THIS node's own faces (`myFace`) against one referenced face
 *   (used for positionX/positionY/positionZ).
 *
 * A face reference is always the same shape — { node, face, offset }
 * — a normal+offset representation: `face` names one of the six
 * LOCAL_FACES below, and `offset` (mm) shifts the reference point
 * outward along that face's own normal. Offset defaults to 0 (flush
 * contact); a positive value is what an inset/rabbet joint would use
 * later, so this doesn't need to change shape when that's built.
 *
 * `overridden: true` means the user manually edited a field that
 * used to be governed by this constraint — the resolver skips it
 * (keeps the literal value on the node) but the constraint's
 * definition is NOT deleted, so it's still visible/re-linkable later.
 *
 * Every existing panel (no `constraints`) keeps working exactly as
 * before — this is additive, not a breaking migration.
 */

import * as THREE from 'three';

let idCounter = 1;

export function nextId() {
  return `panel-${idCounter++}`;
}

// Guard against degenerate (zero/negative) panel geometry — used
// wherever a dimension can be derived from user interaction (the
// scale gizmo, the box preset, and now the constraint resolver).
// One shared constant so all three can never quietly drift apart.
export const MIN_PANEL_DIM_MM = 10;

/**
 * Canonical face vocabulary, in each panel's own LOCAL (unrotated)
 * frame — width along X, height along Y, thickness along Z, exactly
 * as BoxGeometry(width, height, thickness) lays it out before any
 * rotation is applied. Defining faces here, once, is what lets
 * constraints, edge-banding, and hole placement (later stages) all
 * reference the same six names instead of each inventing their own
 * — and keeps face identity independent of whatever `rotation` a
 * panel currently has: flipping a panel's orientation preset must
 * never redefine which physical edge is "top".
 *
 * The resolver combines a face's local normal with the target node's
 * ACTUAL rotation to get a world-space direction, and requires that
 * result to land on an axis (within a small tolerance) — general
 * angled joinery (a face resolved against a non-axis-aligned target)
 * is explicitly unsupported for now. When that happens the resolver
 * raises a clear, named warning rather than silently producing wrong
 * geometry; see snap.js. Lifting that restriction later only means
 * extending the resolver's math — this vocabulary doesn't change.
 */
export const LOCAL_FACES = {
  right:  { x: 1, y: 0, z: 0 },   // +width axis
  left:   { x: -1, y: 0, z: 0 },
  top:    { x: 0, y: 1, z: 0 },   // +height axis
  bottom: { x: 0, y: -1, z: 0 },
  front:  { x: 0, y: 0, z: 1 },   // +thickness axis — the "show" face
  back:   { x: 0, y: 0, z: -1 },
};

// Which of a panel's own literal dimension fields a given LOCAL face
// belongs to — e.g. the 'right'/'left' faces sit at ±width/2. The
// resolver uses this to find a face's distance from its node's own
// center, regardless of which specific face was chosen.
export const FACE_TO_DIM_FIELD = {
  right: 'width', left: 'width',
  top: 'height', bottom: 'height',
  front: 'thickness', back: 'thickness',
};

// Which world axis a constrainable field corresponds to.
export const FIELD_TO_AXIS = {
  width: 'x', height: 'y', thickness: 'z',
  positionX: 'x', positionY: 'y', positionZ: 'z',
};

const AXIS_VECTORS = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };

/**
 * Which single world axis (if any) a local face lands on, given a
 * node's rotation. Returns { axis: 'x'|'y'|'z', sign: 1|-1 }, or null
 * if the face isn't aligned with any single axis within tolerance
 * (general angled joinery is unsupported — see LOCAL_FACES above).
 * Lives here (not snap.js) because createPanelNode uses it directly
 * to compute thicknessAxis at creation time; snap.js's resolver also
 * uses it for constraint alignment checks, imported from here.
 */
export function getAlignedAxis(rotationDeg, faceName) {
  const local = LOCAL_FACES[faceName];
  if (!local) return null;
  const euler = new THREE.Euler(
    THREE.MathUtils.degToRad(rotationDeg?.x || 0),
    THREE.MathUtils.degToRad(rotationDeg?.y || 0),
    THREE.MathUtils.degToRad(rotationDeg?.z || 0)
  );
  const worldNormal = new THREE.Vector3(local.x, local.y, local.z).applyEuler(euler);
  for (const axis of ['x', 'y', 'z']) {
    const alignment = worldNormal.dot(AXIS_VECTORS[axis]);
    if (Math.abs(Math.abs(alignment) - 1) <= 0.02) {
      return { axis, sign: alignment >= 0 ? 1 : -1 };
    }
  }
  return null;
}

/**
 * Classifies a panel's six faces by whether THICKNESS is one of that
 * face's two edge lengths:
 *   - flatFaces (2): the faces perpendicular to the thickness axis
 *     itself ('front'/'back' in the local vocabulary) — their edges
 *     are width×height, thickness never appears as an edge on them.
 *   - edgeFaces (4): the other four — each has thickness as one of
 *     its two edges (e.g. 'right'/'left' are height×thickness,
 *     'top'/'bottom' are width×thickness). These are the faces edge
 *     banding would apply to.
 * Works from node.thicknessAxis if present (the normal case — every
 * node has one from creation onward), falling back to computing it
 * fresh from node.rotation otherwise.
 */
export function classifyFacesByThickness(node) {
  const thicknessAxis = node.thicknessAxis || getAlignedAxis(node.rotation, 'front')?.axis || 'z';
  const edgeFaces = [];
  const flatFaces = [];
  Object.keys(LOCAL_FACES).forEach((faceName) => {
    const aligned = getAlignedAxis(node.rotation, faceName);
    if (aligned && aligned.axis === thicknessAxis) flatFaces.push(faceName);
    else edgeFaces.push(faceName);
  });
  return { thicknessAxis, edgeFaces, flatFaces };
}

let constraintIdCounter = 1;
export function nextConstraintId() {
  return `c${constraintIdCounter++}`;
}

// ---- PIECE CODES ----
// A stable "LE0001"-style identifier assigned to every panel at
// creation time — used for assembly instructions and the cut list
// (see engine/bom.js, engine/pdfExport.js). Assigned ONCE and never
// regenerated: renaming a panel later, or reordering `panels` (a box
// relayout, an ungroup), must never change a code someone may already
// have written on a physical cut piece. This is exactly why it's
// computed from the node's INITIAL name at creation, not read live
// off node.name on every render the way getDisplayName() is.
// ---- PIECE CODES ----
// A stable "LE0001"-style identifier assigned to every panel at
// creation time — used for assembly instructions and the cut list
// (see engine/bom.js, engine/pdfExport.js). Assigned ONCE and never
// regenerated.
const PIECE_CODE_PREFIXES = {
  left: 'LE', right: 'RI', top: 'TO', bottom: 'BO', back: 'BA', front: 'FR',
};

const pieceCodeCounters = {};

function prefixForPieceName(name) {
  if (!name) return 'PA';
  const n = name.toLowerCase();
  if (n.includes('shelf')) {
    return n.includes('(v)') || n.includes('vertical') ? 'SV' : 'SH';
  }
  for (const key of Object.keys(PIECE_CODE_PREFIXES)) {
    if (n.includes(key)) return PIECE_CODE_PREFIXES[key];
  }
  return 'PA';
}

function nextPieceCode(name) {
  const prefix = prefixForPieceName(name);
  const next = (pieceCodeCounters[prefix] || 0) + 1;
  pieceCodeCounters[prefix] = next;
  return `${prefix}${String(next).padStart(4, '0')}`;
}

// ---- MATERIAL CATALOG ----
// Loaded from a CSV file at startup (see loadMaterialCatalog below)
// instead of hardcoded here — this simulates the eventual real
// database read (roadmap step 4's "stock sheet size per material"
// and price will land as extra CSV columns later, same loader).
//
// `export let`, not `const`: ES module bindings are LIVE, so every
// other file's `import { MATERIAL_CATALOG } from './modules.js'`
// automatically sees the populated array the moment
// loadMaterialCatalog() finishes reassigning it — no need to pass
// the catalog around explicitly, and no risk of a stale snapshot.
// Starts empty; anything that reads it before the app's bootstrap
// (see modeller-main.js) has awaited loadMaterialCatalog() would see
// an empty array, so nothing may read it at module-evaluation time —
// only from inside functions that run after user interaction or
// after the initial render, both of which happen after bootstrap.
export let MATERIAL_CATALOG = [];

const FALLBACK_MATERIAL_CATALOG = [
  { name: 'Melamine White 18mm', thicknessMm: 18, grainInterchangeable: true, sheetWidthMm: 2440, sheetHeightMm: 1220, pricePerSheet: 0, edgeBandingPricePerM: 0 },
];

// Minimal CSV line splitter — handles simple double-quoted fields (so
// a material name COULD contain a comma if ever needed) without
// pulling in a full CSV parsing dependency for a 3-column file.
function splitCsvLine(line) {
  const cells = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuotes = false; }
      else { current += ch; }
    } else {
      if (ch === '"') inQuotes = true;
      else if (ch === ',') { cells.push(current); current = ''; }
      else current += ch;
    }
  }
  cells.push(current);
  return cells;
}

// Row-level validation: a malformed row is skipped (with a console
// warning naming the bad line) rather than silently poisoning the
// catalog with a NaN thickness or an unnamed material — the same
// "reject outright, don't guess" convention this file already uses
// for design-limit violations elsewhere.
function parseMaterialsCsv(text) {
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length === 0) return [];
  const header = splitCsvLine(lines[0]).map((h) => h.trim());
  const rows = [];
  lines.slice(1).forEach((line, i) => {
    const cells = splitCsvLine(line);
    const raw = {};
    header.forEach((key, idx) => { raw[key] = (cells[idx] ?? '').trim(); });

    const thicknessMm = Number(raw.thicknessMm);
    const sheetWidthMm = Number(raw.sheetWidthMm);
    const sheetHeightMm = Number(raw.sheetHeightMm);

    if (!raw.name || !Number.isFinite(thicknessMm) || !Number.isFinite(sheetWidthMm) || !Number.isFinite(sheetHeightMm)) {
      console.warn(`Skipping invalid material catalog row ${i + 2} (name/thickness/sheet size required): "${line}"`);
      return;
    }

    const pricePerSheet = Number(raw.pricePerSheet);
    const edgeBandingPricePerM = Number(raw.edgeBandingPricePerM);
    const kerfMm = Number(raw.kerfMm);

    rows.push({
      name: raw.name,
      thicknessMm,
      grainInterchangeable: /^(true|1|yes)$/i.test(raw.grainInterchangeable || ''),
      sheetWidthMm,
      sheetHeightMm,
      pricePerSheet: Number.isFinite(pricePerSheet) ? pricePerSheet : 0,
      edgeBandingPricePerM: Number.isFinite(edgeBandingPricePerM) ? edgeBandingPricePerM : 0,
      ...(Number.isFinite(kerfMm) && kerfMm >= 0 ? { kerfMm } : {}), // omitted entirely if absent/invalid — nestCutList's own fallback-to-default logic (see nesting.js) only triggers off catalogEntry.kerfMm being undefined, so leaving it out here is what makes "no column value" and "explicitly no override" behave identically
    });
  });
  return rows;
}

// Awaited once, at app startup, before the initial addBox() runs —
// see modeller-main.js's bootstrap(). On any failure (network, empty
// file, every row invalid) falls back to a minimal built-in catalog
// rather than leaving MATERIAL_CATALOG empty, which would crash
// addBox()'s MATERIAL_CATALOG[0] lookup outright. The fallback is
// deliberately impoverished (one material) so it's immediately
// obvious in the UI that something's wrong, rather than silently
// degrading.
export async function loadMaterialCatalog(url = `${import.meta.env.BASE_URL}data/materials.csv`) {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();
    const rows = parseMaterialsCsv(text);
    if (rows.length === 0) throw new Error('Catalog CSV parsed to zero valid rows');
    MATERIAL_CATALOG = rows;
  } catch (err) {
    console.error(
      `Could not load material catalog from "${url}" — falling back to a minimal built-in default. The app will run, but only one material will be available until this is fixed.`,
      err
    );
    MATERIAL_CATALOG = FALLBACK_MATERIAL_CATALOG;
  }
  return MATERIAL_CATALOG;
}

export function createPanelNode(overrides = {}) {
  const rotation = overrides.rotation || { x: 0, y: 90, z: 0 };
  const node = {
    id: nextId(),
    type: 'panel',
    name: null,
    width: 350,
    height: 350,
    thickness: 18,
    material: 'Melamine White 18mm',
    quantity: 1,
    offset: { x: 0, y: 0, z: 0 },
    basePosition: { x: 0, y: 0, z: 0 },
    rotation,
    constraints: [],
    groupId: null,
    isBoxWall: false,
    hidden: false,
    // Subset of bandableEdgeFaces(node) — which edges actually get
    // banding tape. Empty by default (no UI exists yet to toggle
    // this per-panel; see the roadmap note below), NOT auto-derived
    // from anything, since whether an edge is banded is a real
    // fabrication decision, not something inferable from geometry.
    bandedEdges: [],
    ...overrides,
  };

  node.thicknessAxis =
    getAlignedAxis(node.rotation, 'front')?.axis || 'z';

  // Assigned from node.name AFTER overrides are merged in (box walls
  // and shelves set name directly via overrides) — see the file-
  // header comment above for why this never gets recomputed later.
  node.pieceCode = nextPieceCode(node.name);

  return node;
}

// Which of a node's LOCAL faces are physically edge-bandable — reuses
// classifyFacesByThickness's own edgeFaces (the 4 faces where
// THICKNESS is one of the two edge dimensions, as opposed to the 2
// flat "show" faces) rather than inventing a second face vocabulary.
// Same reasoning as why constraints and the collinear tool share
// LOCAL_FACES: 'right'/'left'/'top'/'bottom' here mean the same thing
// they always do, regardless of the panel's actual 3D rotation.
export function bandableEdgeFaces(node) {
  return classifyFacesByThickness(node).edgeFaces;
}

// Used anywhere a panel needs to be shown to a person (list, inspector,
// relation descriptions) — falls back to the stable id when no custom
// name has been set. Constraints/relations always store the id, never
// the name, so renaming a panel can never break a reference.
export function getDisplayName(node) {
  return (node && node.name) || (node ? node.id : '');
}

// Three.js scene unit = 1 metre; graph values are always mm.
export const MM_TO_UNIT = 1 / 1000;

/**
 * Placement for a BRAND NEW panel only. Unlike the old auto-layout
 * (which recomputed every existing panel's position from the whole
 * row's current widths — meaning any resize, or any add/remove
 * anywhere, could nudge panels that were never touched), this is
 * called exactly ONCE, at creation time, and its result is stored
 * permanently on the new node as `basePosition`. Nothing ever
 * recomputes an existing node's basePosition afterward — resize
 * changes `width`/`height`/`thickness` plus `offset` (to keep the
 * un-dragged edge/face anchored, see gizmos.js/view2d.js), never
 * `basePosition`; adding or removing a constraint only changes which
 * constraint governs a field, never where an unconstrained panel's
 * base sits.
 *
 * New panels go to the far right of everything that currently
 * exists, with a fixed clearance margin — not tucked into a
 * continuously-recentered row. `resolvedPanels` should be the output
 * of resolveConstraints(), so "current right edge" reflects each
 * panel's TRUE position (constraints, offset, and any manual drag),
 * not just where it started out.
 */
// Representative face for each dimension field — used to find which
// WORLD axis a given field currently lines up with, given a node's
// rotation. Single source of truth so this doesn't drift between the
// several places that need it (constraint inference, design-limit
// checks, and — the bug this comment is attached to fixing —
// far-right placement, below).
export const DIM_FIELD_PROBE_FACE = { width: 'right', height: 'top', thickness: 'front' };

/**
 * A panel's half-size along each WORLD axis, not its local width/
 * height/thickness — e.g. a Vertical panel's `width` actually extends
 * along world Z, not X; its true X-extent is its `thickness`. Used
 * both for design-limit checks (modeller-main.js) and for correct
 * far-right placement (computeNextBasePosition, below) — the latter
 * used to just read node.width/node.height directly regardless of
 * rotation, which was flat wrong for anything but a Horizontal-
 * oriented panel or footprint.
 */
export function computeWorldHalfExtents(node) {
  const halfExtents = { x: 0, y: 0, z: 0 };
  ['width', 'height', 'thickness'].forEach((field) => {
    const aligned = getAlignedAxis(node.rotation, DIM_FIELD_PROBE_FACE[field]);
    if (aligned) halfExtents[aligned.axis] = node[field] / 2;
  });
  return halfExtents;
}

const NEW_PANEL_MARGIN_MM = 300;
export const FLOOR_MM = 0.0 //-0.5 / MM_TO_UNIT; // preserves the old auto-layout's "sits on the floor" convention

/**
 * DESIGN limits — the overall space a design is allowed to occupy,
 * not a view/camera/clipping limit. X starts at 0 to match the
 * left-to-right auto-layout new panels are placed with; Y is
 * expressed relative to FLOOR_MM (floor-to-ceiling height, matching
 * the existing "sits on the floor" convention); Z is centered on 0
 * (depth extends equally either side of the design's front/back
 * reference plane). Any edit — typed field, drag-move, or drag-resize
 * — that would push a panel outside these is rejected; see
 * modeller-main.js.
 */
export const DESIGN_LIMITS_MM = {
  x: { min: -3000, max: 3000 },
  y: { min: FLOOR_MM, max: FLOOR_MM + 3000 },
  z: { min: -3000, max: 3000 },
};

/**
 * PANEL size limits — caps on a single panel's own `width`/`height`
 * fields, independent of DESIGN_LIMITS_MM above (which bounds the
 * overall scene, not any one panel). Checked at every width/height
 * edit entry point in modeller-main.js: typed inspector fields and
 * resize drags (3D face-drag + 2D edge-drag), both of which funnel
 * through onDimensionChange/updateSelectedField.
 */
export const PANEL_SIZE_LIMITS_MM = {
  width: 1500,
  height: 2000,
};

/**
 * Floor safety clamp — guarantees an object's floor-resting center Y
 * (halfExtentY + FLOOR_MM) is never pushed below FLOOR_MM itself,
 * i.e. its bottom edge never sinks below the floor plane. Kept as a
 * standalone export so any caller assembling its own basePosition by
 * hand (e.g. addBox's shared multi-panel anchor) can apply the same
 * guarantee instead of trusting arithmetic to stay correct.
 */
export function clampToFloor(y, halfExtentY) {
  return Math.max(y, halfExtentY + FLOOR_MM);
}

export function computeNextBasePosition(resolvedPanels, newDims) {
  let maxRightEdgeMm = null;
  resolvedPanels.forEach((node) => {
    const halfExtents = computeWorldHalfExtents(node);
    const rightEdgeMm = node.position.x + halfExtents.x;
    if (maxRightEdgeMm === null || rightEdgeMm > maxRightEdgeMm) maxRightEdgeMm = rightEdgeMm;
  });

  const newHalfExtents = computeWorldHalfExtents(newDims); // newDims is a node-like object with width/height/thickness/rotation, not a real node yet
  const leftEdgeMm = maxRightEdgeMm === null ? 0 : maxRightEdgeMm + NEW_PANEL_MARGIN_MM;
  return {
    x: leftEdgeMm + newHalfExtents.x,
    y: newHalfExtents.y + FLOOR_MM, // sits on the floor
    z: 0,
  };
}

// ---- BOX LAYOUT (Stage 3) ----
// Pure function: given the box's 6 wall nodes (each just needs
// .thickness and .offset), returns each wall's new width/height/
// offset so the assembly stays airtight no matter which wall(s) were
// dragged. Only left.offset.x / right.offset.x / top.offset.y /
// bottom.offset.y / back.offset.z / front.offset.z are ever treated
// as "driving" values — everything else here is derived. All
// measurements are in OFFSET space (relative to the box's shared
// basePosition anchor) — it cancels out of every difference used
// here, so the anchor itself is never read.
export function computeBoxLayout({ left, right, top, bottom, back, front }) {
  const lx = left.offset.x, rx = right.offset.x;
  const ty = top.offset.y, by = bottom.offset.y;
  const bz = back.offset.z, fz = front.offset.z;

  const xOuterMin = lx - left.thickness / 2, xOuterMax = rx + right.thickness / 2;
  const xInnerMin = lx + left.thickness / 2, xInnerMax = rx - right.thickness / 2;
  const yOuterMin = by - bottom.thickness / 2, yOuterMax = ty + top.thickness / 2;
  const yInnerMin = by + bottom.thickness / 2, yInnerMax = ty - top.thickness / 2;
  const zInnerMin = bz - back.thickness / 2, zInnerMax = fz + front.thickness / 2;

  const outerWidth = xOuterMax - xOuterMin;
  const innerWidth = xInnerMax - xInnerMin;
  const outerHeight = yOuterMax - yOuterMin;
  const innerHeight = yInnerMax - yInnerMin;
  const innerDepth = zInnerMax - zInnerMin;

  const outerWidthCenterX = (xOuterMin + xOuterMax) / 2;
  const innerWidthCenterX = (xInnerMin + xInnerMax) / 2;
  const outerHeightCenterY = (yOuterMin + yOuterMax) / 2;
  const innerHeightCenterY = (yInnerMin + yInnerMax) / 2;
  const innerDepthCenterZ = (zInnerMin + zInnerMax) / 2;

  return {
    left:   { width: innerDepth, height: innerHeight, offset: { x: lx, y: innerHeightCenterY, z: innerDepthCenterZ } },
    right:  { width: innerDepth, height: innerHeight, offset: { x: rx, y: innerHeightCenterY, z: innerDepthCenterZ } },
    top:    { width: outerWidth, height: innerDepth,  offset: { x: outerWidthCenterX, y: ty, z: innerDepthCenterZ } },
    bottom: { width: outerWidth, height: innerDepth,  offset: { x: outerWidthCenterX, y: by, z: innerDepthCenterZ } },
    back:   { width: innerWidth, height: innerHeight, offset: { x: innerWidthCenterX, y: outerHeightCenterY, z: bz } },
    front:  { width: innerWidth, height: innerHeight, offset: { x: innerWidthCenterX, y: innerHeightCenterY, z: fz } },
  };
}
