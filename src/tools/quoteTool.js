/**
 * tools/quoteTool.js
 *
 * DIMENSION (QUOTE) TOOL — the person picks two facing faces on two
 * panels, types a distance in mm, and applies it. The result is a
 * `distance` constraint on whichever panel is allowed to move (see
 * engine/quotes.js). It never defines a size.
 *
 * Flow (same pick pipeline as collinearTool.js / attachTool.js):
 *   1. pick a face            -> highlighted
 *   2. pick a face on ANOTHER panel
 *        - the two faces must face each other along one axis
 *        - roles are decided automatically: the panel that is allowed
 *          to move (user-owned, axis free, not already driven) is the
 *          driven one; the other is the fixed reference. If both
 *          could move, the FIRST pick is the reference.
 *   3. the Properties panel shows the current gap as the default;
 *      the person edits it and presses Apply (or Enter).
 *
 * Nothing is written until Apply; a rejected quote shows the reason
 * and leaves the tool open so the value can be corrected.
 */
import { setSelectedId, setSelectedGroupId } from '../modeller/selection.js';
import { showToast, hideToast } from '../ui/toast.js';
import { getDisplayName } from '../modeller/modules.js';
import { addQuote, measureGap, previewQuote } from '../engine/quotes.js';
import { AddConstraintCommand } from '../history/history.js';

/** @type {Object|null} same toolContext object the other tools receive */
let ctx = null;

let quoteActive = false;
let quotePick1 = null; // { nodeId, faceName } | null
// { drivenId, myFace, from:{node,face}, measuredMm, valueMm, drivenName, anchorName } | null
let quotePending = null;

export function setQuoteToolContext(context) {
  ctx = context;
}
export function isQuoteActive() {
  return quoteActive;
}
export function getQuotePending() {
  return quotePending;
}
function computePreview() {
  const { drivenId, myFace, from, valueMm } = quotePending;
  return previewQuote(ctx.getPanels(), { drivenId, myFace, from, value: valueMm });
}

/**
 * Called on every keystroke in the distance field. Deliberately no
 * renderAll() — re-rendering would steal focus from the input being
 * typed in; instead the fresh preview is RETURNED so the toolbar can
 * update just its preview box. Result shape: see engine/quotes.js#previewQuote.
 */
export function setQuoteValue(mm) {
  if (!quotePending) return null;
  quotePending.valueMm = mm;
  quotePending.preview = computePreview();
  return quotePending.preview;
}

export function startQuoteMode() {
  quoteActive = true;
  quotePick1 = null;
  quotePending = null;
  setSelectedId(null);
  setSelectedGroupId(null);
  ctx.clearMultiSelected();
  ctx.setFaceHighlight(null, null);
  ctx.setFacePickMode(true, handleFacePick);
  showToast('Dimension: pick a face on the first panel', false);
  ctx.renderAll();
}

export function cancelQuoteMode() {
  if (!quoteActive) return;
  quoteActive = false;
  quotePick1 = null;
  quotePending = null;
  setSelectedId(null);
  ctx.setFaceHighlight(null, null);
  ctx.setFacePickMode(false, null);
  hideToast();
  ctx.renderAll();
}

function resetPicks() {
  quotePick1 = null;
  quotePending = null;
  ctx.setFaceHighlight(null, null);
}

function handleFacePick(nodeId, faceName) {
  // A third click after a pending quote starts a fresh pair.
  if (quotePending) resetPicks();

  if (!quotePick1) {
    quotePick1 = { nodeId, faceName };
    ctx.setFaceHighlight(nodeId, faceName);
    showToast('Now pick the facing face on the OTHER panel', false);
    ctx.renderAll();
    return;
  }
  if (quotePick1.nodeId === nodeId) {
    showToast('Pick a face on a DIFFERENT panel');
    return;
  }

  const panels = ctx.getPanels();
  const a = quotePick1;
  const b = { nodeId, faceName };

  // Try both role assignments; first = reference, second = driven.
  const attempts = [
    { driven: b, anchor: a },
    { driven: a, anchor: b },
  ].map(({ driven, anchor }) => {
    const gap = measureGap(panels, driven.nodeId, driven.faceName, { node: anchor.nodeId, face: anchor.faceName });
    if (gap === null) return { ok: false, notFacing: true };
    const value = Math.max(0, Math.round(gap * 10) / 10);
    const r = addQuote(panels, {
      drivenId: driven.nodeId, myFace: driven.faceName,
      from: { node: anchor.nodeId, face: anchor.faceName }, value,
    });
    return { ...r, driven, anchor, gap, value };
  });

  const chosen = attempts.find((x) => x.ok);
  if (!chosen) {
    quotePick1 = null;
    ctx.setFaceHighlight(null, null);
    if (attempts.every((x) => x.notFacing)) {
      showToast('Those faces must be parallel and face each other (e.g. a shelf underside and the upper face below it)');
    } else {
      const why = attempts.find((x) => !x.notFacing);
      showToast(why?.message || "Can't dimension that pair");
    }
    ctx.renderAll();
    return;
  }

  const name = (id) => getDisplayName(panels.find((p) => p.id === id));
  quotePending = {
    drivenId: chosen.driven.nodeId,
    myFace: chosen.driven.faceName,
    from: { node: chosen.anchor.nodeId, face: chosen.anchor.faceName },
    measuredMm: chosen.gap,
    valueMm: chosen.value,
    drivenName: name(chosen.driven.nodeId),
    anchorName: name(chosen.anchor.nodeId),
  };
  quotePending.preview = computePreview();
  ctx.setFaceHighlight(chosen.driven.nodeId, chosen.driven.faceName);
  showToast(`${quotePending.drivenName} will be positioned relative to ${quotePending.anchorName} — set the distance, then Apply`, false);
  ctx.renderAll();
}

/** Commits the pending quote. Returns true on success (tool then closes). */
export function applyQuote() {
  if (!quotePending) return false;
  const { drivenId, myFace, from, valueMm } = quotePending;
  const before = ctx.getPanels();
  const result = addQuote(before, { drivenId, myFace, from, value: valueMm });
  if (!result.ok) {
    showToast(result.message || "Can't apply that distance");
    return false;
  }
  const driven = result.panels.find((p) => p.id === drivenId);
  ctx.updateNode(drivenId, { constraints: driven.constraints });
  ctx.recordHistoryCommand(AddConstraintCommand, before, ctx.getPanels());
  cancelQuoteMode();
  return true;
}
