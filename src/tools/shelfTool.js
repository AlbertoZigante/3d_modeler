import {setSelectedId, setSelectedGroupId} from '../modeller/selection.js'
import {addShelf} from '../features/shelf.js'
import {VERTICAL_ROTATION, HORIZONTAL_ROTATION, rotationsMatch} from '../shared/geometry.js'
import {showToast} from '../ui/toast.js'

// SHELF_BOUNDARY_ROTATION ?
// setFacePickMode, setFaceHighlight, setPanelHighlight :
// these come back from createModellerScene(...)'s return value
// inside modeller-main.js. This tool needs them passed in (an
// init(sceneHandles) call, or each function taking them as a parameter)
// rather than importing them, since they're created at runtime,
// not module-level exports.

export function startShelfMode(mode) {
  if (collinearActive) cancelCollinearMode();
  shelfMode = mode;
  shelfPick1 = null;
  shelfPick1ClickMm = null;
  setSelectedId(null);
  setSelectedGroupId(null);
  multiSelectedIds.clear();
  setFaceHighlight(null, null);
  setFacePickMode(true, handleShelfPick);
  const kind = mode === 'horizontal' ? 'Left/Right (or an existing vertical shelf)' : 'Top/Bottom (or an existing horizontal shelf)';
  showToast(`${mode === 'horizontal' ? 'Horizontal' : 'Vertical'} shelf: pick a box's ${kind}`, false);
  renderAll();
}

export function cancelShelfMode() {
  shelfMode = null;
  shelfPick1 = null;
  shelfPick1ClickMm = null;
  setSelectedId(null);
  setFaceHighlight(null, null);
  setFacePickMode(false, null);
  hideToast();
  renderAll();
}

function handleShelfPick(nodeId, faceName, worldPoint) {
  const node = panels.find((p) => p.id === nodeId);
  if (!node) return;

  const wantRotation = SHELF_BOUNDARY_ROTATION[shelfMode]();
  const kindLabel = shelfMode === 'horizontal' ? 'a Left/Right panel or an existing vertical shelf' : 'a Top/Bottom panel or an existing horizontal shelf';
  if (!node.groupId || !rotationsMatch(node.rotation, wantRotation)) {
    showToast(`Pick ${kindLabel}`);
    return;
  }

  if (!shelfPick1) {
    shelfPick1 = node;
    const freeAxis = shelfMode === 'horizontal' ? 'y' : 'x';
    shelfPick1ClickMm = worldPoint ? computeClickOffsetMm(node, worldPoint, freeAxis) : null;
    setPanelHighlight(nodeId, faceName);
    showToast(`Now pick the OTHER boundary of the SAME box (${kindLabel})`, false);
    renderAll();
    return;
  }

  if (shelfPick1.id === nodeId) {
    showToast('Pick a DIFFERENT panel, not the same one again');
    return;
  }
  if (shelfPick1.groupId !== node.groupId) {
    showToast('Both panels must belong to the same box');
    return;
  }

  addShelf(shelfPick1, node);
  cancelShelfMode();
}

