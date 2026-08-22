/**
 * Bill of materials / cut list.
 *
 * PER-PIECE, NOT AGGREGATE (roadmap step 1): one row per physical
 * piece, or per group of pieces that are TRULY interchangeable on the
 * saw. "Interchangeable" does NOT just mean matching width/height —
 * it means the material's OWN grainInterchangeable flag in
 * MATERIAL_CATALOG (see modules.js) says width/height may be swapped
 * at all. A material with grain or a directional pattern (most
 * wood-grain melamine/veneer, real plywood) can never have its
 * pieces freely rotated, so a piece and its width/height-swapped
 * twin are DIFFERENT cut pieces and stay on separate rows even
 * though they're the same rectangle. Only a material that explicitly
 * opts in (grainInterchangeable: true) gets those merged into one
 * row with a combined quantity.
 *
 * The default is NOT interchangeable: a material missing from the
 * catalog, or missing the field entirely, is treated as
 * grain-directional — a catalog gap can never silently start merging
 * pieces that actually needed to keep their orientation. This is
 * deliberately the SAME question the eventual nesting engine
 * (roadmap step 5) will have to ask before it's allowed to rotate a
 * piece to save material — reusing this function there, rather than
 * inventing a second rule, is the point.
 */
import { getDisplayName, MATERIAL_CATALOG } from '../modeller/modules.js';

const MM2_TO_M2 = 1 / 1_000_000;

function materialCatalogEntry(materialName) {
  return MATERIAL_CATALOG.find((m) => m.name === materialName) || null;
}

// The edge's TAPE LENGTH runs along the OTHER in-plane dimension from
// the one FACE_TO_DIM_FIELD gives — a 'right'/'left' edge sits at
// ±width/2 but the strip of banding along it runs the full HEIGHT;
// a 'top'/'bottom' edge's tape runs the full WIDTH.
const EDGE_BANDING_LENGTH_FIELD = { right: 'height', left: 'height', top: 'width', bottom: 'width' };

function pieceBandingLengthMm(node) {
  return (node.bandedEdges || []).reduce((sum, face) => {
    const lengthField = EDGE_BANDING_LENGTH_FIELD[face];
    return lengthField ? sum + (node[lengthField] || 0) : sum;
  }, 0);
}

// Human-readable summary for the "Edges" column — e.g. "L,R" or "—".
// Deliberately just the raw face-name set, not yet rotation-aware for
// grain-interchangeable materials (see footprintKey's own note below)
// — acceptable for now since no UI exists to actually set this per
// panel yet, flagged rather than silently wrong.
function bandedEdgesLabel(node) {
  const edges = node.bandedEdges || [];
  if (edges.length === 0) return '—';
  const short = { left: 'L', right: 'R', top: 'T', bottom: 'B' };
  return edges.map((e) => short[e] || e).join(',');
}

// Purely a material property — never inferred from the panel itself.
// See the file-header comment for why the safe default is false.
export function isMaterialGrainInterchangeable(materialName) {
  return materialCatalogEntry(materialName)?.grainInterchangeable === true;
}

// A stable "footprint key" for grouping: width/height in a FIXED
// (min, max) order when the material allows rotation, so a 400×300
// piece and a 300×400 piece of the same rotatable material collapse
// together — or in the piece's OWN order when it doesn't, so they
// never collapse regardless of which one happens to be wider.
function footprintKey(node) {
  const rotatable = isMaterialGrainInterchangeable(node.material);
  const [a, b] = rotatable
    ? [Math.min(node.width, node.height), Math.max(node.width, node.height)]
    : [node.width, node.height];
  // NOTE: for a rotatable material, two pieces that are the "same"
  // physical cut but banded on rotationally-equivalent edges (e.g.
  // one banded left/right, its rotated twin banded top/bottom) will
  // NOT currently merge — the banding pattern below is compared
  // as-is, not remapped through the same rotation that already
  // normalizes width/height above. Not a concern today (no UI sets
  // bandedEdges yet), but worth fixing before this field becomes
  // user-editable.
  const bandingPattern = [...(node.bandedEdges || [])].sort().join('|');
  return `${node.material}::${node.thickness}::${a}::${b}::${rotatable ? 'rot' : 'fixed'}::${bandingPattern}`;
}

// Assigns a human "Box N" / "Group N" label to each distinct groupId,
// in the order it first appears — the graph itself has no concept of
// a group's own display name, only an id borrowed from one of its
// members (see modeller-main.js's addBox/groupSelectedPanels), so
// this is purely a presentation-time label, computed fresh every call.
function buildGroupLabels(panels) {
  const labels = new Map();
  let boxCount = 0;
  let groupCount = 0;
  panels.forEach((node) => {
    if (!node.groupId || labels.has(node.groupId)) return;
    if (node.isBoxPanel) {
      boxCount += 1;
      labels.set(node.groupId, `Box ${boxCount}`);
    } else {
      groupCount += 1;
      labels.set(node.groupId, `Group ${groupCount}`);
    }
  });
  return labels;
}

function assemblyLabel(node, groupLabels) {
  if (!node.groupId) return '—'; // standalone panel, not part of any assembly
  return groupLabels.get(node.groupId) || 'Group';
}

/**
 * Builds the per-piece cut list from a RESOLVED panels array (see
 * modeller-main.js's renderAll — the same resolveConstraints(panels)
 * output already feeding the 3D/2D views, so every piece's dimensions
 * here are its true final ones, constraints included).
 *
 * Rows only ever merge within the SAME assembly (e.g. Box 1's Left
 * and Box 2's Left never share a row, even if identical) — a cut
 * list needs to say which physical assembly each piece is for, and
 * merging across assemblies would lose that.
 *
 * Each row:
 *   label                  "Box 1 — Left/Right" (merged) or "Box 1 — Back"
 *   pieceNames              the individual piece names folded into this row
 *   assembly                "Box 1" / "Group 2" / "—" for standalone
 *   widthMm, heightMm, thicknessMm
 *   material
 *   grainInterchangeable    whether THIS row's material allows swapping width/height
 *   quantity
 *   unitAreaM2, areaM2       unitAreaM2 * quantity, both in m²
 */
export function computeBom(resolvedPanels) {
  const groupLabels = buildGroupLabels(resolvedPanels);
  const rowsByKey = new Map();

  resolvedPanels.forEach((node) => {
    const assembly = assemblyLabel(node, groupLabels);
    const key = `${assembly}::${footprintKey(node)}`;
    const pieceName = getDisplayName(node);

    let row = rowsByKey.get(key);
    if (!row) {
      row = {
        label: assembly === '—' ? pieceName : `${assembly} — ${pieceName}`,
        pieceNames: [pieceName],
        pieceCodes: [node.pieceCode],
        assembly,
        widthMm: node.width,
        heightMm: node.height,
        thicknessMm: node.thickness,
        material: node.material,
        grainInterchangeable: isMaterialGrainInterchangeable(node.material),
        bandedEdges: [...(node.bandedEdges || [])], // raw face list — nestCutList's margin calc needs this, bandedEdgesLabel below is just its display form
        bandedEdgesLabel: bandedEdgesLabel(node),
        unitBandingLengthM: pieceBandingLengthMm(node) / 1000,
        quantity: 1,
        unitAreaM2: node.width * node.height * MM2_TO_M2,
      };
      rowsByKey.set(key, row);
      return;
    }

    row.quantity += 1;
    row.pieceNames.push(pieceName);
    row.pieceCodes.push(node.pieceCode);
    const uniqueNames = [...new Set(row.pieceNames)];
    row.label = assembly === '—' ? uniqueNames.join('/') : `${assembly} — ${uniqueNames.join('/')}`;
  });

  return Array.from(rowsByKey.values())
    .map((row) => {
      const bandingLengthM = row.unitBandingLengthM * row.quantity;
      const bandingPricePerM = materialCatalogEntry(row.material)?.edgeBandingPricePerM || 0;
      return {
        ...row,
        areaM2: row.unitAreaM2 * row.quantity,
        bandingLengthM,
        bandingCost: bandingLengthM * bandingPricePerM,
      };
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Aggregate material summary (total area needed per material/
 * thickness, ignoring piece/assembly identity) — kept as a SEPARATE
 * export, not folded back into computeBom, since collapsing per-piece
 * detail back into an aggregate was the exact bug this rewrite fixes
 * (roadmap step 1). Useful for a quick "how much material total"
 * glance; computeBom is the real cut list.
 */
export function computeMaterialSummary(resolvedPanels) {
  const rows = new Map();
  resolvedPanels.forEach((node) => {
    const key = `${node.material}::${node.thickness}`;
    const areaM2 = node.width * node.height * MM2_TO_M2;
    const existing = rows.get(key);
    if (existing) {
      existing.quantity += 1;
      existing.areaM2 += areaM2;
    } else {
      rows.set(key, { material: node.material, thickness: node.thickness, quantity: 1, areaM2 });
    }
  });
  return Array.from(rows.values()).sort((a, b) => a.material.localeCompare(b.material));
}