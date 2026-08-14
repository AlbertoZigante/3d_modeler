/**
 * BOM engine — a per-PIECE cut list, not a material-summary
 * aggregate. A material summary (e.g. "3.2m² of 18mm melamine")
 * isn't something a fabricator can actually cut from — a cut list
 * needs the individual piece dimensions.
 *
 * Still always a derived projection, computed fresh from `panels` —
 * no cached/stale BOM state anywhere. Callers should pass already-
 * RESOLVED panels (e.g. resolveConstraints(panels) filtered to
 * visible ones, as modeller-main.js already does) so every dimension
 * reflects live constraint values, not a stale literal node field —
 * this matters a lot here specifically, since most panels in a box
 * have constraint-derived width/height (see snap.js) that can differ
 * from whatever their own node object says.
 *
 * Rows are grouped by (material, thickness, width, height,
 * grainDirection, edgeBanding, edgeBandingMaterial) — pieces
 * IDENTICAL on every one of those collapse into one row with a
 * summed quantity, regardless of which assembly/box they came from,
 * since that's what actually matters for cutting: you don't cut two
 * separate 600×400 pieces from two different sheets just because
 * they belong to different boxes. Grain and edge banding are part of
 * the grouping key, not just extra display columns — two pieces with
 * the same dimensions but DIFFERENT banding aren't interchangeable
 * for production, so merging them into one row would silently hide a
 * real difference a fabricator needs to see. `sourceLabel` keeps a
 * human-readable trail back to which panel(s) contributed to the
 * row, for traceability into the model (e.g. "Left, Right" or
 * "Shelf (H) ×2").
 *
 * Width and height are NOT treated as interchangeable — a 600×400
 * row stays distinct from a 400×600 row, even though they're the
 * same piece rotated 90°. This is now an EXPLICIT choice driven by
 * `grainDirection` rather than a gap: a piece with no grain
 * constraint could in principle be nested either way, but rotating a
 * piece changes which of ITS OWN edges is "width" vs "height" for
 * edge-banding purposes too, so treating width/height as freely
 * interchangeable here would require the nesting engine (not yet
 * built) to also re-map edge banding on rotation — left as a
 * follow-up for whenever nesting/optimization is scoped, rather than
 * solved partially here.
 */
import { getDisplayName, getMaterialInfo } from '../modeller/modules.js';

const EDGE_LABELS = { top: 'T', bottom: 'B', left: 'L', right: 'R' };

function edgeBandingSignature(edgeBanding) {
  if (!edgeBanding) return '';
  return ['top', 'bottom', 'left', 'right'].filter((e) => edgeBanding[e]).join(',');
}

function edgeBandingLabel(edgeBanding) {
  const sig = edgeBandingSignature(edgeBanding);
  return sig ? sig.split(',').map((e) => EDGE_LABELS[e]).join('') : '—';
}

export function computeBom(panels) {
  const groups = new Map();

  for (const p of panels) {
    const edgeSig = edgeBandingSignature(p.edgeBanding);
    const grainSig = p.grainDirection || '';
    const bandingMaterialSig = edgeSig ? (p.edgeBandingMaterial || '') : ''; // banding material is irrelevant (and shouldn't split rows) when nothing is actually banded
    const key = `${p.material}__${p.thickness}__${p.width}__${p.height}__${grainSig}__${edgeSig}__${bandingMaterialSig}`;
    if (!groups.has(key)) {
      groups.set(key, {
        material: p.material,
        thickness: p.thickness,
        width: p.width,
        height: p.height,
        grainDirection: p.grainDirection || null,
        edgeBanding: p.edgeBanding || { top: false, bottom: false, left: false, right: false },
        edgeBandingMaterial: edgeSig ? p.edgeBandingMaterial || null : null,
        quantity: 0,
        areaEachM2: (p.width * p.height) / 1_000_000,
        areaTotalM2: 0,
        sources: new Map(), // display name -> total quantity contributed, preserves traceability without listing every single id
      });
    }
    const g = groups.get(key);
    g.quantity += p.quantity;
    g.areaTotalM2 += (p.width * p.height * p.quantity) / 1_000_000;
    const label = getDisplayName(p);
    g.sources.set(label, (g.sources.get(label) || 0) + p.quantity);
  }

  return Array.from(groups.values())
    .map((g) => ({
      material: g.material,
      thickness: g.thickness,
      width: g.width,
      height: g.height,
      grainDirection: g.grainDirection,
      grainLabel: g.grainDirection === 'width' ? 'Width' : g.grainDirection === 'height' ? 'Height' : '—',
      edgeBanding: g.edgeBanding,
      edgeBandingLabel: edgeBandingLabel(g.edgeBanding),
      edgeBandingMaterial: g.edgeBandingMaterial,
      stockSheetMm: getMaterialInfo(g.material)?.stockSheetMm || null,
      hasGrainMaterial: !!getMaterialInfo(g.material)?.hasGrain,
      quantity: g.quantity,
      areaEachM2: g.areaEachM2,
      areaTotalM2: g.areaTotalM2,
      sourceLabel: Array.from(g.sources.entries())
        .map(([label, count]) => (count > 1 ? `${label} ×${count}` : label))
        .join(', '),
    }))
    // Grouped visually by material/thickness first (so a person
    // scanning the list sees one material's pieces together, which
    // is also the natural grouping for sheet nesting later), largest
    // piece first within that.
    .sort((a, b) =>
      a.material.localeCompare(b.material) ||
      b.thickness - a.thickness ||
      b.areaEachM2 - a.areaEachM2
    );
}


