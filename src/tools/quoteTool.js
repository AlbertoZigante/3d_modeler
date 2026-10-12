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
import {
  addQuote, measureGap, previewQuote, resolveFacingFaces, planBoxDimension, previewBoxDimension, boxDimensionOffset,
} from '../engine/quotes.js';
import { AddConstraintCommand } from '../history/history.js';

/** @type {Object|null} same toolContext object the other tools receive */
let ctx = null;

let quoteActive = false;
let quotePick1 = null; // { nodeId, faceName } | null
// { drivenId, myFace, from:{node,face}, measuredMm, valueMm, drivenName, anchorName } | null
let quotePending = null;
// Last problem/hint shown in the Properties panel (in addition to the
// toast, which auto-hides and is easy to miss): string | null.
let quoteMessage = null;

function say(text, autoHide = true) {
  quoteMessage = text;
  showToast(text, autoHide);
}

export function getQuoteMessage() {
  return quoteMessage;
}

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
  if (quotePending.mode === 'box') {
    return previewBoxDimension(ctx.getPanels(), quotePending.plan, quotePending.valueMm);
  }
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
  quoteMessage = null;
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
  quoteMessage = null;
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
  try {
    pickFace(nodeId, faceName);
  } catch (err) {
    // Never fail silently inside an event handler.
    console.error('Dimension tool:', err);
    quotePick1 = null;
    quotePending = null;
    ctx.setFaceHighlight(null, null);
    say(`Dimension tool error: ${err.message}`);
    ctx.renderAll();
  }
}

function pickFace(nodeId, faceName) {
  // A third click after a pending quote starts a fresh pair.
  if (quotePending) resetPicks();
  quoteMessage = null;

  if (!quotePick1) {
    quotePick1 = { nodeId, faceName };
    ctx.setFaceHighlight(nodeId, faceName);
    say('Now click the OTHER panel (any surface facing the same direction is fine)', false);
    ctx.renderAll();
    return;
  }
  if (quotePick1.nodeId === nodeId) {
    say('Pick a DIFFERENT panel for the second click');
    ctx.renderAll();
    return;
  }

  const panels = ctx.getPanels();

  // Clicks land on visible outer surfaces, which usually point the same
  // way; resolve them to the two faces that actually face each other.
  const facing = resolveFacingFaces(panels, quotePick1, { nodeId, faceName });
  if (!facing.ok) {
    quotePick1 = null;
    ctx.setFaceHighlight(null, null);
    say(`${facing.message} Click the first panel again.`);
    ctx.renderAll();
    return;
  }
  const a = facing.a;
  const b = facing.b;

  // Two walls of the SAME box: the distance between them is the box's
  // own interior size — apply it by moving a wall (relayoutBox re-fits
  // the rest), not as a stored constraint. See engine/quotes.js#planBoxDimension.
  const plan = planBoxDimension(panels, a, b);
  if (plan) {
    quotePending = {
      mode: 'box', plan,
      measuredMm: plan.measuredMm,
      valueMm: Math.round(plan.measuredMm * 10) / 10,
      drivenName: `Box interior ${plan.label}`,
      anchorName: plan.anchorName,
    };
    quotePending.preview = computePreview();
    ctx.setFaceHighlight(b.nodeId, b.faceName);
    say(`Interior ${plan.label} of the box — type the new value, then Apply`, false);
    ctx.renderAll();
    return;
  }

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
    const why = attempts.find((x) => !x.notFacing);
    say(`${why?.message || "Can't dimension that pair of panels."} Click the first panel again.`);
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
  say(`${quotePending.drivenName} will be positioned relative to ${quotePending.anchorName} — set the distance, then Apply`, false);
  ctx.renderAll();
}

/** Commits the pending quote. Returns true on success (tool then closes). */
export function applyQuote() {
  if (!quotePending) return false;
  if (quotePending.mode === 'box') {
    const { plan, valueMm } = quotePending;
    const preview = previewBoxDimension(ctx.getPanels(), plan, valueMm);
    if (!preview.ok) {
      say(preview.blocking);
      ctx.renderAll();
      return false;
    }
    const offset = boxDimensionOffset(ctx.getPanels(), plan, valueMm);
    // main's applyBoxDimension moves the wall, runs relayoutBox, records ONE history step
    if (!ctx.applyBoxDimension(plan.moveId, offset)) return false;
    cancelQuoteMode();
    return true;
  }
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
