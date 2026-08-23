import {computeWorldHalfExtents, DESIGN_LIMITS_MM, PANEL_SIZE_LIMITS_MM} from '../modeller/modules.js'

// -------------------------------------------------------------
// Design limits (DESIGN_LIMITS_MM, in modules.js): the overall space
// a design may occupy, checked at every edit entry point below — not
// a view/camera clipping limit. Move-drags CLAMP per axis (so the
// panel slides smoothly and just stops at the wall); resize-drags and
// typed inspector fields REJECT the whole edit outright (simpler and
// clearer than silently shrinking a typed value to whatever fits).
// -------------------------------------------------------------
const AXIS_LABEL = { x: 'width (X)', y: 'height (Y)', z: 'depth (Z)' };

// Shared toast plumbing for every short-lived status/error message in
// this file (design-limit hits, panel-size hits, and — see
// startCollinearMode below — the collinear tool's own "select a
// face..." guidance). `autoHide` distinguishes a self-clearing error
// flash from a STATUS message that should stay up until the caller
// explicitly changes or clears it (e.g. while a multi-step pick is
// still in progress).
export function showToast(text, autoHide = true) {
  const toastEl =
    document.getElementById('toolbar-properties-toast');

  if (!toastEl) {
    return;
  }

  toastEl.innerHTML = `
    <div class="properties-hint">
      ${escapeHtmlLocal(text)}
    </div>
  `;

  clearTimeout(designLimitHideTimer);

  if (autoHide) {
    designLimitHideTimer = setTimeout(() => {
      hideToast();
    }, 2200);
  }
}

export function hideToast() {
  clearTimeout(designLimitHideTimer);

  const toastEl =
    document.getElementById('toolbar-properties-toast');

  if (!toastEl) {
    return;
  }

  toastEl.innerHTML = '';
}

export function showDesignLimitError(axis) {
  showToast(`Design limit reached for ${AXIS_LABEL[axis]}`);
}

export function showPanelSizeLimitError(field) {
  showToast(`Maximum panel ${field} is ${PANEL_SIZE_LIMITS_MM[field]}mm`);
}

export function escapeHtmlLocal(value) {
  const div = document.createElement('div');
  div.textContent = String(value ?? '');
  return div.innerHTML;
}
