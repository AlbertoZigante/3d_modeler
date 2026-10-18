/**
 * tools/quoteTool.js
 *
 * DIMENSION TOOL — pick two panels; the measured distance between them
 * appears IMMEDIATELY in the viewport as a grey dimension (see
 * modeller/dimensions.js). Nothing is imposed yet and there is no form or
 * menu: the person clicks the dimension, types a value in place and presses
 * Enter, which turns it into an imposed (black) one. That final step is
 * handled by modeller-main.js (it owns the graph and the history); this tool
 * only owns the two picks.
 *
 *   click 1: a face on the first panel (highlighted)
 *   click 2: any parallel surface on another panel — the two facing faces
 *            are found automatically (engine/quotes.js#resolveFacingFaces)
 *            and the pair is planned (engine/quotes.js#planDimension):
 *            ordinary quote, or box resize for two walls of one box.
 *
 * Refusals (system-owned panel, locked axis, overlap, not parallel, ...)
 * are shown in the toast AND in the Properties panel.
 */
import { setSelectedId, setSelectedGroupId } from '../modeller/selection.js';
import { showToast, hideToast } from '../ui/toast.js';
import { resolveFacingFaces, planDimension } from '../engine/quotes.js';

/** @type {Object|null} same toolContext object the other tools receive */
let ctx = null;

let quoteActive = false;
let quotePick1 = null; // { nodeId, faceName } | null
// { pair: {a, b}, plan } | null — the pair currently shown as a grey dimension
let quotePending = null;
// Last problem/hint shown in the Properties panel (the toast auto-hides
// and is easy to miss): string | null.
let quoteMessage = null;

let lastSaid = { text: null, at: 0 };
function say(text, autoHide = true) {
  quoteMessage = text;
  // The same message twice in a row (a double-fired click, a repeated pick of
  // an already dimensioned pair) is shown once, not stacked.
  const now = Date.now();
  if (lastSaid.text === text && now - lastSaid.at < 2500) return;
  lastSaid = { text, at: now };
  showToast(text, autoHide);
}

// Some pointer paths report one physical click twice; ignore an identical
// pick arriving right after the previous one.
let lastPick = { key: null, at: 0 };
function isEchoPick(nodeId, faceName) {
  const now = Date.now();
  const key = `${nodeId}:${faceName}`;
  const echo = lastPick.key === key && now - lastPick.at < 250;
  lastPick = { key, at: now };
  return echo;
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
export function getQuoteMessage() {
  return quoteMessage;
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
  showToast('Dimension: click a panel, then another panel', false);
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
  if (isEchoPick(nodeId, faceName)) return;
  try {
    pickFace(nodeId, faceName);
  } catch (err) {
    // Never fail silently inside an event handler.
    console.error('Dimension tool:', err);
    resetPicks();
    say(`Dimension tool error: ${err.message}`);
    ctx.renderAll();
  }
}

function pickFace(nodeId, faceName) {
  // A click after a pair is shown starts a fresh pair.
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
    resetPicks();
    say(`${facing.message} Click the first panel again.`);
    ctx.renderAll();
    return;
  }
  const plan = planDimension(panels, facing.a, facing.b);
  if (!plan.ok && plan.reason === 'duplicate') {
    // Already dimensioned: show the existing dimension (the overlay swaps the
    // grey one for it) instead of letting a second one be applied.
    quotePick1 = null;
    quotePending = { pair: { a: facing.a, b: facing.b }, plan: null, duplicate: true };
    ctx.setFaceHighlight(null, null);
    say(plan.message);
    ctx.renderAll();
    return;
  }
  if (!plan.ok) {
    resetPicks();
    say(`${plan.message} Click the first panel again.`);
    ctx.renderAll();
    return;
  }

  quotePick1 = null;
  quotePending = { pair: { a: facing.a, b: facing.b }, plan };
  ctx.setFaceHighlight(null, null);
  // The grey dimension is drawn by the viewport overlay from getQuotePending().
  say('Click the dimension to type a value, then press Enter', false);
  ctx.renderAll();
}
