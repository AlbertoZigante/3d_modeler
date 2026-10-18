/**
 * tools/spacingTool.js
 *
 * EQUAL SPACING TOOL — two steps:
 *   1) pick the panels to space (click each; click again to un-pick), then
 *      press Enter or "Next" — e.g. 3 vertical shelves;
 *   2) pick the two boundaries (e.g. the Left and Right box panels).
 * The moment the second boundary is picked the shelves are spread evenly
 * between them as a LIVE relation (engine/spacing.js). Like the other tools
 * this file only owns the interaction state; modeller-main.js applies it.
 */
import { setSelectedId, setSelectedGroupId } from '../modeller/selection.js';
import { showToast, hideToast } from '../ui/toast.js';

/** @type {Object|null} */
let ctx = null;
let active = false;
let step = 1; // 1 = pick panels, 2 = pick boundaries
let members = []; // panel ids, in pick order
let boundaries = []; // [{ nodeId, faceName }]
let message = null;

export function setSpacingToolContext(context) { ctx = context; }
export function isSpacingActive() { return active; }
export function getSpacingState() {
  return { step, memberCount: members.length, boundaryCount: boundaries.length, message };
}

function say(text, autoHide = true) {
  message = text;
  showToast(text, autoHide);
}

export function startSpacingMode() {
  active = true;
  step = 1;
  members = [];
  boundaries = [];
  message = null;
  setSelectedId(null);
  setSelectedGroupId(null);
  ctx.clearMultiSelected();
  ctx.setFaceHighlight(null, null);
  ctx.setFacePickMode(true, handleFacePick);
  showToast('Equal spacing — step 1: click the panels to space, then press Enter (or Next)', false);
  ctx.renderAll();
}

export function cancelSpacingMode() {
  if (!active) return;
  active = false;
  step = 1;
  members = [];
  boundaries = [];
  message = null;
  ctx.clearMultiSelected();
  ctx.setFaceHighlight(null, null);
  ctx.setFacePickMode(false, null);
  hideToast();
  ctx.renderAll();
}

/** Step 1 -> step 2 (Enter / the Next button). */
export function spacingNextStep() {
  if (!active || step !== 1) return;
  if (!members.length) { say('Click at least one panel to space first.'); ctx.renderAll(); return; }
  step = 2;
  boundaries = [];
  ctx.setFaceHighlight(null, null);
  showToast('Step 2: click the first boundary, then the second (e.g. the Left and Right box panels)', false);
  ctx.renderAll();
}

function handleFacePick(nodeId, faceName) {
  try {
    if (step === 1) pickMember(nodeId); else pickBoundary(nodeId, faceName);
  } catch (err) {
    console.error('Spacing tool:', err);
    say(`Equal spacing error: ${err.message}`);
    ctx.renderAll();
  }
}

function pickMember(nodeId) {
  message = null;
  const i = members.indexOf(nodeId);
  if (i >= 0) members.splice(i, 1); else members.push(nodeId);
  ctx.setMultiSelected(members);
  showToast(`${members.length} panel${members.length === 1 ? '' : 's'} picked — click more, or press Enter (Next) when done`, false);
  ctx.renderAll();
}

function pickBoundary(nodeId, faceName) {
  message = null;
  if (members.includes(nodeId)) { say('That is one of the panels being spaced — pick a boundary instead.'); ctx.renderAll(); return; }
  if (boundaries.some((b) => b.nodeId === nodeId)) { say('Pick a DIFFERENT panel for the second boundary.'); ctx.renderAll(); return; }
  boundaries.push({ nodeId, faceName });
  if (boundaries.length === 1) {
    ctx.setFaceHighlight(nodeId, faceName);
    showToast('Now click the second boundary', false);
    ctx.renderAll();
    return;
  }
  let result;
  try {
    result = ctx.onSpacingPicked(members.slice(), boundaries.map((b) => b.nodeId));
  } catch (err) {
    // The spacing may already be applied: never leave the picks selected.
    console.error('Spacing tool:', err);
    cancelSpacingMode();
    showToast(`Equal spacing: ${err.message}`);
    return;
  }
  if (result?.ok) {
    cancelSpacingMode();
    showToast(result.message || 'Panels spaced equally');
    return;
  }
  // refused: keep the picked panels, let the person choose other boundaries
  boundaries = [];
  ctx.setFaceHighlight(null, null);
  say(result?.message || 'Could not space the panels.');
  ctx.renderAll();
}
