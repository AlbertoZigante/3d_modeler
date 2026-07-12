/**
 * Sidebar resize + collapse behavior for the modeller page.
 * Pure DOM/UI concern — no graph or Three.js state lives here.
 *
 * Each sidebar (#list-panel, #inspector) gets:
 *   - a drag handle (the adjacent .resizer element) to resize it
 *   - a topbar toggle button to collapse it fully for more 3D
 *     viewport space, and restore it to its last width on re-click
 */

const MIN_WIDTH = 160;
const MAX_WIDTH = 440;
const DEFAULT_WIDTH = 220;

export function initResizableLayout() {
  setupResizer('resizer-left', 'list-panel', 'left');
  setupResizer('resizer-right', 'inspector', 'right');
  setupCollapseToggle('toggle-list-btn', 'list-panel');
  setupCollapseToggle('toggle-inspector-btn', 'inspector');
}

function setupResizer(resizerId, panelId, side) {
  const resizer = document.getElementById(resizerId);
  const panel = document.getElementById(panelId);
  let dragging = false;
  let startX = 0;
  let startWidth = 0;

  resizer.addEventListener('pointerdown', (e) => {
    dragging = true;
    startX = e.clientX;
    startWidth = panel.getBoundingClientRect().width;
    resizer.classList.add('dragging');
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });

  window.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - startX;
    const delta = side === 'left' ? dx : -dx;
    const newWidth = Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, startWidth + delta));
    panel.style.width = `${newWidth}px`;
    panel.classList.remove('collapsed');
  });

  window.addEventListener('pointerup', () => {
    if (!dragging) return;
    dragging = false;
    resizer.classList.remove('dragging');
    document.body.style.userSelect = '';
  });
}

function setupCollapseToggle(buttonId, panelId) {
  const button = document.getElementById(buttonId);
  const panel = document.getElementById(panelId);
  let lastWidth = DEFAULT_WIDTH;

  // The tab lives inside the resizer handle so it can sit attached
  // to the sidebar edge — stop its pointerdown from also being
  // read as the start of a resize drag.
  button.addEventListener('pointerdown', (e) => e.stopPropagation());

  button.addEventListener('click', () => {
    const isCollapsed = panel.classList.contains('collapsed');
    if (isCollapsed) {
      panel.classList.remove('collapsed');
      panel.style.width = `${lastWidth}px`;
    } else {
      const current = panel.getBoundingClientRect().width;
      if (current > 0) lastWidth = current;
      panel.classList.add('collapsed');
    }
  });
}
