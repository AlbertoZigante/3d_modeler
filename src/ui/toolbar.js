/**
 * Panel list — lists existing graph nodes, lets the user select
 * one or add a new one. Pure DOM rendering; mutation happens only
 * through the onSelect/onAdd callbacks, same pattern as
 * ui/properties.js.
 */
import { getDisplayName } from '../modeller/modules.js';

export function renderPanelList(container, { panels, selectedId, onSelect, onAdd }) {
  container.innerHTML = `
    <div class="section-title">Panels</div>
    <div id="panel-list-items"></div>
    <button class="add-btn" id="add-panel-btn">+ Add panel</button>
  `;

  const listEl = container.querySelector('#panel-list-items');
  panels.forEach((p) => {
    const item = document.createElement('button');
    item.className = 'list-item' + (p.id === selectedId ? ' selected' : '');
    item.innerHTML = `<span class="id">${getDisplayName(p)}</span><span class="dims">${p.width}×${p.height}×${p.thickness}</span>`;
    item.addEventListener('click', () => onSelect(p.id));
    listEl.appendChild(item);
  });

  container.querySelector('#add-panel-btn').addEventListener('click', onAdd);
}
