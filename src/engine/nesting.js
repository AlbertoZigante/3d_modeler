/**
 * Nesting / cut-optimization engine (roadmap step 5).
 *
 * PURE FUNCTIONS ONLY — no DOM, no THREE, no app state. Same
 * verification discipline the constraint-graph work in this project
 * has used throughout: this file is developed and checked standalone
 * (see nesting.test.mjs — 21 cases, 425 assertions, run via plain
 * `node nesting.test.mjs`) before it's ever wired into a UI.
 *
 * ALGORITHM: free-rectangle guillotine packing (best-area-fit), not
 * shelf packing and not maximal-rectangles. A guillotine cut is a
 * straight edge-to-edge line — exactly what a real panel saw does in
 * one pass; maximal-rectangles packing can produce layouts denser on
 * paper but not executable by a saw in a sequence of straight cuts,
 * which defeats the purpose of a tool meant to produce real cutting
 * instructions. Unlike an earlier shelf-based version of this file
 * (fixed horizontal rows, each row's height set by its tallest piece
 * — permanently wasting the gap above every shorter piece in that
 * row, since no later row could ever reach back into it), this
 * tracks a sheet's actual free space as a list of rectangles and
 * re-derives new candidates every time a piece is placed, searching
 * EVERY free rectangle on EVERY existing sheet (in both orientations
 * when a piece is rotatable) for the single best fit before ever
 * opening a new sheet — see nestPieces and splitFreeRect below. Every
 * placement is still produced by a single straight cut through
 * whichever free rectangle it landed in, so the result stays exactly
 * as executable as the old shelf approach — this is a smarter
 * PLACEMENT strategy, not a different, non-guillotine kind of cut.
 *
 * GRAIN: a piece may only be placed in an orientation OTHER than its
 * given (width, height) if `rotatable` is true — mirrors
 * MATERIAL_CATALOG's grainInterchangeable flag and engine/bom.js's
 * footprintKey, which already treat "can this be rotated" as a
 * material property, not a per-piece guess. This is the ONE rule the
 * whole algorithm defers to before ever trying a swapped orientation.
 *
 * GRAIN AXIS CONVENTION (pinned down, not configurable): for every
 * piece and every stock sheet in this app, the GRAIN — real or
 * simulated — is assumed to run along the HEIGHT axis, and a piece's
 * own `heightMm` is always the "with-grain" dimension. This is what
 * `rotatable: false` actually enforces here: refusing to swap width
 * and height is only meaningful because both sides of that swap
 * agree on which axis is "with the grain" in the first place.
 * Nothing in this file checks that agreement explicitly — it's a
 * convention upheld by how pieces and materials are modeled upstream
 * (MATERIAL_CATALOG, panel nodes), not by any code here — but naming
 * it (see GRAIN_AXIS below) turns what used to be an unstated
 * assumption into a documented one, which was the actual gap: not
 * that the app got grain wrong, but that nothing said what "grain"
 * meant. If a future material ever needs grain running along WIDTH
 * instead, that's a real modeling change (a `grainAxis` field on
 * MATERIAL_CATALOG, and a matching swap wherever a piece's own
 * dimensions are set) — not something to patch around here.
 * GRAIN_AXIS is exported so any future code enforcing or displaying
 * this can reference the SAME name rather than re-inventing it.
 *
 * KERF: modeled as a fixed gap added between pieces (and between a
 * piece and the sheet's own edge), not as real geometry — the same
 * simplification essentially every commercial cut-optimizer uses.
 * Defaults to DEFAULT_KERF_MM (a typical panel-saw blade width) —
 * NOT zero — since an unspecified kerf silently producing a plan
 * with zero clearance between pieces would describe a cut no real
 * saw can execute. A material may override this via an optional
 * `kerfMm` column in MATERIAL_CATALOG (blade width in practice can
 * differ by material/thickness); an explicit `kerfMm` passed to
 * nestCutList's own options always wins over any catalog value, on
 * the assumption a caller who explicitly specifies one means it.
 *
 * EDGE BANDING TRIM MARGIN: a banded edge is cut slightly OVERSIZED
 * and trimmed flush after the tape is applied — real fabrication
 * practice, not a rounding nicety. nestCutList (not nestPieces, which
 * stays a generic geometric packer with no banding concept at all)
 * inflates a piece's packing footprint by `edgeBandingMarginMm` for
 * every banded edge (see EDGE_TO_MARGIN_AXIS below) before nesting,
 * then reports both the inflated PACKED size (what the saw actually
 * cuts before banding+trim) and the true FINISHED size (after trim)
 * on each placement — see finishedWidthMm/finishedHeightMm.
 *
 * KNOWN LIMITATION: if a rotatable piece gets rotated during packing,
 * its banded-edge SET is not remapped to the new orientation (e.g. a
 * piece banded on its width-edges, if rotated 90°, is still reported
 * against its ORIGINAL edge labels, not the edges its packed footprint
 * now occupies). This never affects non-rotatable pieces (which never
 * rotate at all), and is flagged here rather than silently glossed
 * over — worth fixing before edge banding gets a real per-panel UI
 * that people build cut instructions from.
 */

export const GRAIN_AXIS = 'height';
export const DEFAULT_KERF_MM = 3; // typical panel-saw blade width
const DEFAULT_EDGE_BANDING_MARGIN_MM = 1; // typical trim allowance per banded edge

// Which packing-dimension axis a given banded edge face adds trim
// margin to — a 'left'/'right' edge is trimmed along the piece's
// WIDTH; a 'top'/'bottom' edge along its HEIGHT. Mirrors
// engine/bom.js's own EDGE_BANDING_LENGTH_FIELD (which computes tape
// LENGTH, the perpendicular concern) — deliberately not imported from
// there, since this file stays dependency-free from the rest of the
// app by design (see the file-header "PURE FUNCTIONS ONLY" note).
const EDGE_TO_MARGIN_AXIS = { left: 'width', right: 'width', top: 'height', bottom: 'height' };

// ---- geometry / fit helpers -------------------------------------

function fitsAsGiven(piece, maxWidthMm, maxHeightMm) {
  return piece.widthMm <= maxWidthMm && piece.heightMm <= maxHeightMm;
}

function fitsRotated(piece, maxWidthMm, maxHeightMm) {
  return piece.rotatable && piece.heightMm <= maxWidthMm && piece.widthMm <= maxHeightMm;
}

// Chooses an orientation for `piece` that fits within
// (maxWidthMm, maxHeightMm), preferring whichever orientation leaves
// LESS vertical slack (closer height match). Returns
// { widthMm, heightMm, rotated } or null if neither orientation fits.
function bestOrientationFor(piece, maxWidthMm, maxHeightMm) {
  const asGiven = fitsAsGiven(piece, maxWidthMm, maxHeightMm)
    ? { widthMm: piece.widthMm, heightMm: piece.heightMm, rotated: false }
    : null;
  const rotated = fitsRotated(piece, maxWidthMm, maxHeightMm)
    ? { widthMm: piece.heightMm, heightMm: piece.widthMm, rotated: true }
    : null;

  if (asGiven && rotated) {
    const asGivenSlack = maxHeightMm - asGiven.heightMm;
    const rotatedSlack = maxHeightMm - rotated.heightMm;
    return rotatedSlack < asGivenSlack ? rotated : asGiven;
  }
  return asGiven || rotated || null;
}

// ---- single-sheet free-rectangle guillotine packer ----------------
//
// Replaces the earlier shelf-based approach: instead of committing a
// whole horizontal row's height to its tallest piece (wasting the gap
// above every shorter piece in that row, permanently — no later shelf
// can ever reach back into it), this tracks the sheet's actual free
// space as a list of rectangles, and re-derives new candidate free
// rectangles every time a piece is placed. A piece can land in ANY
// leftover rectangle on ANY existing sheet, not just "the current
// shelf" — which is what lets later, smaller pieces fill gaps beside
// or below earlier ones that a fixed-height row could never reach.
// Every split is still a straight, sheet-spanning guillotine cut (see
// splitFreeRect) — this is a smarter PLACEMENT strategy, not a
// different, non-executable kind of cut.

function rectFits(rect, w, h) {
  return w <= rect.widthMm + 1e-9 && h <= rect.heightMm + 1e-9;
}

// Best-area-fit scoring: prefer the free rect that leaves the LEAST
// leftover area (packs pieces into gaps that are already close to
// their size, rather than carving up big open rects prematurely),
// tie-broken by the shorter leftover side (avoids leaving thin
// unusable slivers).
function fitScore(rect, w, h) {
  return {
    leftoverArea: rect.widthMm * rect.heightMm - w * h,
    leftoverShortSide: Math.min(rect.widthMm - w, rect.heightMm - h),
  };
}

function isBetterFit(a, b) {
  if (a.leftoverArea < b.leftoverArea - 1e-9) return true;
  if (a.leftoverArea > b.leftoverArea + 1e-9) return false;
  return a.leftoverShortSide < b.leftoverShortSide - 1e-9;
}

// After placing a (placedW x placedH) piece in the top-left corner of
// `rect`, the remaining L-shaped leftover space is split via ONE
// straight guillotine cut into exactly two rectangles — there are two
// valid ways to make that cut (a vertical cut first, or a horizontal
// cut first); this picks whichever produces the split whose LARGER
// resulting rectangle has more area, since keeping the biggest
// possible contiguous leftover space available is what lets future
// (possibly still-large) pieces keep landing on this same sheet.
function splitFreeRect(rect, placedW, placedH, kerfMm) {
  const rightW = rect.widthMm - placedW - kerfMm;
  const bottomH = rect.heightMm - placedH - kerfMm;

  // Option 1: the RIGHT piece spans the free rect's full height; the
  // BOTTOM piece spans only the placed piece's width.
  const option1 = [];
  if (rightW > 1e-6) option1.push({ xMm: rect.xMm + placedW + kerfMm, yMm: rect.yMm, widthMm: rightW, heightMm: rect.heightMm });
  if (bottomH > 1e-6) option1.push({ xMm: rect.xMm, yMm: rect.yMm + placedH + kerfMm, widthMm: placedW, heightMm: bottomH });

  // Option 2: the BOTTOM piece spans the free rect's full width; the
  // RIGHT piece spans only the placed piece's height.
  const option2 = [];
  if (bottomH > 1e-6) option2.push({ xMm: rect.xMm, yMm: rect.yMm + placedH + kerfMm, widthMm: rect.widthMm, heightMm: bottomH });
  if (rightW > 1e-6) option2.push({ xMm: rect.xMm + placedW + kerfMm, yMm: rect.yMm, widthMm: rightW, heightMm: placedH });

  const maxArea = (opts) => opts.reduce((m, r) => Math.max(m, r.widthMm * r.heightMm), 0);
  return maxArea(option1) >= maxArea(option2) ? option1 : option2;
}

// Removes any free rectangle that's fully contained inside a LARGER
// one (keeping exactly one copy of an exact duplicate) — without
// this, the free list grows unboundedly with redundant candidates
// that can never be the best choice anyway, since anything that fits
// the smaller rect also fits the larger one that contains it.
function pruneFreeRects(rects) {
  const contains = (outer, inner) =>
    outer.xMm <= inner.xMm + 1e-6 &&
    outer.yMm <= inner.yMm + 1e-6 &&
    outer.xMm + outer.widthMm >= inner.xMm + inner.widthMm - 1e-6 &&
    outer.yMm + outer.heightMm >= inner.yMm + inner.heightMm - 1e-6;

  return rects.filter((r, i) => {
    for (let j = 0; j < rects.length; j++) {
      if (j === i) continue;
      const o = rects[j];
      const oContainsR = contains(o, r);
      const rContainsO = contains(r, o);
      if (oContainsR && !rContainsO) return false; // r is strictly smaller, inside o — redundant
      if (oContainsR && rContainsO && j < i) return false; // exact duplicate — keep only the first occurrence
    }
    return true;
  });
}

function createSheet(sheetWidthMm, sheetHeightMm, sheetIndex) {
  return {
    sheetIndex,
    widthMm: sheetWidthMm,
    heightMm: sheetHeightMm,
    freeRects: [{ xMm: 0, yMm: 0, widthMm: sheetWidthMm, heightMm: sheetHeightMm }],
    placements: [], // { pieceId, xMm, yMm, widthMm, heightMm, rotated }
  };
}

function placeInFreeRect(sheet, rectIndex, w, h, rotated, pieceId, kerfMm) {
  const rect = sheet.freeRects[rectIndex];
  sheet.placements.push({ pieceId, xMm: rect.xMm, yMm: rect.yMm, widthMm: w, heightMm: h, rotated });
  sheet.freeRects.splice(rectIndex, 1);
  sheet.freeRects.push(...splitFreeRect(rect, w, h, kerfMm));
  sheet.freeRects = pruneFreeRects(sheet.freeRects);
}

function sheetUsedAreaMm2(sheet) {
  return sheet.placements.reduce((sum, p) => sum + p.widthMm * p.heightMm, 0);
}

function summarizeSheet(sheet) {
  const totalAreaMm2 = sheet.widthMm * sheet.heightMm;
  const usedAreaMm2 = sheetUsedAreaMm2(sheet);
  return {
    sheetIndex: sheet.sheetIndex,
    widthMm: sheet.widthMm,
    heightMm: sheet.heightMm,
    placements: sheet.placements,
    usedAreaM2: usedAreaMm2 / 1_000_000,
    totalAreaM2: totalAreaMm2 / 1_000_000,
    utilization: totalAreaMm2 > 0 ? usedAreaMm2 / totalAreaMm2 : 0,
  };
}

/**
 * Packs `pieces` (all assumed to be the SAME material/stock size —
 * see nestCutList below for the per-material grouping step) onto as
 * few `sheetWidthMm` × `sheetHeightMm` sheets as possible, using the
 * free-rectangle guillotine packer described above (best-area-fit
 * across EVERY existing sheet's EVERY free rectangle, in EITHER
 * orientation when the piece is rotatable, before ever opening a new
 * sheet).
 *
 * @param {Array<{id:string, widthMm:number, heightMm:number, rotatable:boolean}>} pieces
 * @param {{widthMm:number, heightMm:number}} stockSheet
 * @param {number} [kerfMm]  defaults to DEFAULT_KERF_MM — see the
 *   file-header KERF note for why this is never silently 0.
 * @returns {{sheets: object[], unplaced: object[]}}
 *   `unplaced` holds any piece that doesn't fit the stock sheet in
 *   EITHER orientation at all (a real data problem — e.g. a panel
 *   larger than the sheet stock — surfaced rather than silently
 *   dropped or looped on forever).
 * @throws {Error} if stockSheet has a non-positive width/height, or
 *   kerfMm is negative — these are caller-contract violations (a
 *   malformed stock sheet or a nonsensical kerf), not recoverable
 *   data-quality issues, so this fails loudly rather than silently
 *   producing a nonsense pack. Contrast with nestCutList below,
 *   which DOES recover from a bad per-material catalog value, since
 *   one bad catalog row shouldn't take down nesting for every other
 *   material.
 */
export function nestPieces(pieces, stockSheet, kerfMm = DEFAULT_KERF_MM) {
  const { widthMm: sheetWidthMm, heightMm: sheetHeightMm } = stockSheet || {};
  if (!(sheetWidthMm > 0) || !(sheetHeightMm > 0)) {
    throw new Error(`nestPieces: stockSheet must have positive widthMm/heightMm, got ${JSON.stringify(stockSheet)}`);
  }
  if (!(kerfMm >= 0)) {
    throw new Error(`nestPieces: kerfMm must be >= 0, got ${kerfMm}`);
  }

  // Larger pieces first (by their largest dimension, tie-broken by
  // the smaller one) — standard packing heuristic: placing big pieces
  // first and letting smaller ones fill remaining gaps packs tighter
  // than the reverse.
  const sorted = [...pieces].sort((a, b) => {
    const aMax = Math.max(a.widthMm, a.heightMm);
    const bMax = Math.max(b.widthMm, b.heightMm);
    if (bMax !== aMax) return bMax - aMax;
    return Math.min(b.widthMm, b.heightMm) - Math.min(a.widthMm, a.heightMm);
  });

  const sheets = [];
  const unplaced = [];

  for (const piece of sorted) {
    if (!fitsAsGiven(piece, sheetWidthMm, sheetHeightMm) && !fitsRotated(piece, sheetWidthMm, sheetHeightMm)) {
      unplaced.push(piece);
      continue;
    }

    // Search EVERY free rectangle on EVERY existing sheet, in every
    // orientation this piece allows, for the single best-area-fit —
    // this is what lets a later, smaller piece reuse a gap left
    // beside or below an earlier piece on ANY sheet, not just
    // whichever sheet/row was being filled most recently.
    let best = null; // { sheet, rectIndex, w, h, rotated, score }
    for (const sheet of sheets) {
      sheet.freeRects.forEach((rect, rectIndex) => {
        const candidates = [{ w: piece.widthMm, h: piece.heightMm, rotated: false }];
        if (piece.rotatable) candidates.push({ w: piece.heightMm, h: piece.widthMm, rotated: true });
        candidates.forEach(({ w, h, rotated }) => {
          if (!rectFits(rect, w, h)) return;
          const score = fitScore(rect, w, h);
          if (!best || isBetterFit(score, best.score)) {
            best = { sheet, rectIndex, w, h, rotated, score };
          }
        });
      });
    }

    if (best) {
      placeInFreeRect(best.sheet, best.rectIndex, best.w, best.h, best.rotated, piece.id, kerfMm);
    } else {
      const sheet = createSheet(sheetWidthMm, sheetHeightMm, sheets.length);
      sheets.push(sheet);
      // A fresh, empty sheet's one free rect (the whole sheet) MUST
      // fit the piece in some orientation, since we already confirmed
      // that against the stock sheet size itself above.
      const orientation = bestOrientationFor(piece, sheetWidthMm, sheetHeightMm);
      placeInFreeRect(sheet, 0, orientation.widthMm, orientation.heightMm, orientation.rotated, piece.id, kerfMm);
    }
  }

  return { sheets: sheets.map(summarizeSheet), unplaced };
}

// ---- BOM -> nesting bridge ----------------------------------------

/**
 * Expands per-piece BOM rows (engine/bom.js's computeBom output —
 * each row may represent `quantity` > 1 identical physical pieces)
 * into individual piece instances, groups them by material+thickness
 * (each material has its own stock sheet size — see
 * MATERIAL_CATALOG), inflates each piece's PACKING footprint for any
 * banded edge (see the file-header "EDGE BANDING TRIM MARGIN" note),
 * and nests each group independently.
 *
 * @param {Array} bomRows  — expects each row to optionally carry
 *   `bandedEdges: string[]` (a subset of 'left'|'right'|'top'|'bottom'
 *   — see engine/bom.js). Rows without it are treated as unbanded.
 * @param {Array} materialCatalog  (pass MATERIAL_CATALOG directly)
 * @param {{kerfMm?:number, edgeBandingMarginMm?:number}} [options]
 *   `kerfMm`, if given, OVERRIDES any per-material catalog kerfMm for
 *   every material in this call — omit it to let each material use
 *   its own catalog kerfMm (falling back to DEFAULT_KERF_MM). See the
 *   file-header KERF note.
 * @returns {Array<{material:string, thicknessMm:number, stockSheet:object|null, sheets:object[], unplaced:object[]}>}
 *   Each sheet's placements additionally carry finishedWidthMm/
 *   finishedHeightMm (the TRUE post-trim size) alongside the ordinary
 *   widthMm/heightMm (the oversized PACKED footprint) — identical
 *   when the piece has no banded edges at all.
 */
export function nestCutList(bomRows, materialCatalog, options = {}) {
  const { kerfMm: explicitKerfMm, edgeBandingMarginMm = DEFAULT_EDGE_BANDING_MARGIN_MM } = options;
  const byMaterial = new Map();

  bomRows.forEach((row) => {
    const key = `${row.material}::${row.thicknessMm}`;
    if (!byMaterial.has(key)) byMaterial.set(key, []);
    const list = byMaterial.get(key);
    const codes = row.pieceCodes || [];
    const bandedEdges = row.bandedEdges || [];

    const marginWidthMm = bandedEdges.filter((e) => EDGE_TO_MARGIN_AXIS[e] === 'width').length * edgeBandingMarginMm;
    const marginHeightMm = bandedEdges.filter((e) => EDGE_TO_MARGIN_AXIS[e] === 'height').length * edgeBandingMarginMm;

    for (let i = 0; i < row.quantity; i++) {
      list.push({
        id: codes[i] || `${row.label}#${i + 1}`,
        label: row.label,
        widthMm: row.widthMm + marginWidthMm,
        heightMm: row.heightMm + marginHeightMm,
        rotatable: !!row.grainInterchangeable,
        finishedWidthMm: row.widthMm,
        finishedHeightMm: row.heightMm,
      });
    }
  });

  const results = [];
  for (const [key, pieces] of byMaterial.entries()) {
    const [material, thicknessStr] = key.split('::');
    const catalogEntry = materialCatalog.find((m) => m.name === material);
    if (!catalogEntry || !catalogEntry.sheetWidthMm || !catalogEntry.sheetHeightMm) {
      results.push({
        material,
        thicknessMm: Number(thicknessStr),
        stockSheet: null,
        sheets: [],
        unplaced: pieces,
      });
      continue;
    }
    const stockSheet = { widthMm: catalogEntry.sheetWidthMm, heightMm: catalogEntry.sheetHeightMm };

    let kerfMm = explicitKerfMm !== undefined ? explicitKerfMm : DEFAULT_KERF_MM;
    if (explicitKerfMm === undefined && catalogEntry.kerfMm !== undefined) {
      if (Number.isFinite(catalogEntry.kerfMm) && catalogEntry.kerfMm >= 0) {
        kerfMm = catalogEntry.kerfMm;
      } else {
        console.warn(`nestCutList: ignoring invalid kerfMm on material "${material}" (${catalogEntry.kerfMm}) — using default ${DEFAULT_KERF_MM}mm`);
      }
    }

    const { sheets, unplaced } = nestPieces(pieces, stockSheet, kerfMm);

    const finishedById = new Map(pieces.map((p) => [p.id, p]));
    sheets.forEach((sheet) => {
      sheet.placements.forEach((placement) => {
        const src = finishedById.get(placement.pieceId);
        if (!src) return;
        placement.finishedWidthMm = placement.rotated ? src.finishedHeightMm : src.finishedWidthMm;
        placement.finishedHeightMm = placement.rotated ? src.finishedWidthMm : src.finishedHeightMm;
      });
    });

    results.push({ material, thicknessMm: Number(thicknessStr), stockSheet, sheets, unplaced });
  }
  return results;
}

/**
 * Cost/utilization rollup over a full nestCutList() result — closes
 * the loop back to "bridging design -> BOM -> supplier ordering"
 * (the original point of this feature): total sheets and cost per
 * material (sheetsUsed × MATERIAL_CATALOG's pricePerSheet, 0 if
 * unpriced), plus waste area and utilization, and the same totals
 * rolled up across every material.
 *
 * @param {ReturnType<typeof nestCutList>} nestResults
 * @param {Array} materialCatalog
 */
export function summarizeNestingResult(nestResults, materialCatalog) {
  const perMaterial = nestResults.map((result) => {
    const catalogEntry = materialCatalog.find((m) => m.name === result.material);
    const pricePerSheet = catalogEntry?.pricePerSheet || 0;
    const sheetsUsed = result.sheets.length;
    const totalAreaM2 = result.sheets.reduce((sum, s) => sum + s.totalAreaM2, 0);
    const usedAreaM2 = result.sheets.reduce((sum, s) => sum + s.usedAreaM2, 0);
    const unplacedAreaM2 = result.unplaced.reduce((sum, p) => {
      const w = p.finishedWidthMm ?? p.widthMm;
      const h = p.finishedHeightMm ?? p.heightMm;
      return sum + (w * h) / 1_000_000;
    }, 0);
    return {
      material: result.material,
      thicknessMm: result.thicknessMm,
      sheetsUsed,
      pricePerSheet,
      totalCost: sheetsUsed * pricePerSheet,
      totalAreaM2,
      usedAreaM2,
      wasteAreaM2: totalAreaM2 - usedAreaM2,
      utilization: totalAreaM2 > 0 ? usedAreaM2 / totalAreaM2 : 0,
      unplacedCount: result.unplaced.length,
      unplacedAreaM2,
      unplacedLabels: [...new Set(result.unplaced.map((p) => p.label).filter(Boolean))],
    };
  });

  const totals = perMaterial.reduce(
    (acc, m) => ({
      sheetsUsed: acc.sheetsUsed + m.sheetsUsed,
      totalCost: acc.totalCost + m.totalCost,
      totalAreaM2: acc.totalAreaM2 + m.totalAreaM2,
      usedAreaM2: acc.usedAreaM2 + m.usedAreaM2,
      wasteAreaM2: acc.wasteAreaM2 + m.wasteAreaM2,
      unplacedCount: acc.unplacedCount + m.unplacedCount,
      unplacedAreaM2: acc.unplacedAreaM2 + m.unplacedAreaM2,
    }),
    { sheetsUsed: 0, totalCost: 0, totalAreaM2: 0, usedAreaM2: 0, wasteAreaM2: 0, unplacedCount: 0, unplacedAreaM2: 0 }
  );
  totals.utilization = totals.totalAreaM2 > 0 ? totals.usedAreaM2 / totals.totalAreaM2 : 0;

  return { perMaterial, totals };
}