/**
 * Panel list — lists existing graph nodes, lets the user select
 * one or add a new one. Pure DOM rendering; mutation happens only
 * through the passed-in callbacks, same pattern as ui/properties.js.
 *
 * GROUPS render as an explicit two-level hierarchy: a header row for
 * the group itself ("📦 Group (N)"), then each member indented
 * beneath it. Clicking the header selects the group as a whole;
 * clicking a member selects that specific panel directly — no
 * progressive click-count logic is needed here (unlike the 2D/3D
 * canvas — see modeller-main.js's handleCanvasSelectClick) since the
 * list already shows the hierarchy explicitly, so a single click on
 * any row unambiguously means that row.
 *
 * MULTI-SELECT (for building a NEW group): Ctrl/Cmd-click toggles a
 * standalone panel in/out of multiSelectedIds. Once 2+ are held, a
 * "Group N selected panels" button appears.
 */
import { getDisplayName } from '../modeller/modules.js';

export function renderPanelList(
  container,
  {
    panels,
    selectedId,
    selectedGroupId,
    onSelectPanel,
    onSelectGroup,
    multiSelectedIds,
    onGroupSelected,
    onAddVertical,
    onAddHorizontal,
    onAddParallel,
    onAddBox,
  }
) {
  container.innerHTML = `
    <div class="section-title">Panels</div>
    <div id="panel-list-items"></div>
    <button class="add-btn" id="group-selected-btn" style="display:none;"></button>
    <button class="add-btn" id="add-vertical-btn">+ Vertical panel</button>
    <button class="add-btn" id="add-horizontal-btn">+ Horizontal panel</button>
    <button class="add-btn" id="add-parallel-btn">+ Parallel panel</button>
    <button class="add-btn" id="add-box-btn">+ Box (6 sides, fully enclosed)</button>
  `;

  const listEl = container.querySelector('#panel-list-items');

  // Walk panels in their natural array order, but only emit a group
  // header the FIRST time we see a given groupId — its members then
  // render immediately beneath it, regardless of where in the array
  // they actually sit.
  const seenGroups = new Set();
  panels.forEach((p) => {
    if (!p.groupId) {
      appendPanelRow(listEl, p, {
        indented: false,
        isSelected: p.id === selectedId,
        isMultiSelected: multiSelectedIds.has(p.id),
        onSelectPanel,
      });
      return;
    }
    if (!seenGroups.has(p.groupId)) {
      seenGroups.add(p.groupId);
      const members = panels.filter((m) => m.groupId === p.groupId);
      const header = document.createElement('button');
      header.className = 'list-item group-header' + (selectedGroupId === p.groupId ? ' selected' : '');
      header.innerHTML = `<span class="id">📦 Group (${members.length})</span>`;
      header.addEventListener('click', () => onSelectGroup(p.groupId));
      listEl.appendChild(header);

      members.forEach((m) => {
        appendPanelRow(listEl, m, {
          indented: true,
          isSelected: m.id === selectedId,
          isMultiSelected: false, // multi-select is only for building NEW groups from standalone panels
          onSelectPanel,
        });
      });
    }
  });

  const groupBtn = container.querySelector('#group-selected-btn');
  if (multiSelectedIds.size >= 2) {
    groupBtn.style.display = '';
    groupBtn.textContent = `Group ${multiSelectedIds.size} selected panels`;
    groupBtn.addEventListener('click', onGroupSelected);
  }

  container.querySelector('#add-vertical-btn').addEventListener('click', onAddVertical);
  container.querySelector('#add-horizontal-btn').addEventListener('click', onAddHorizontal);
  container.querySelector('#add-parallel-btn').addEventListener('click', onAddParallel);
  container.querySelector('#add-box-btn').addEventListener('click', onAddBox);
}

function appendPanelRow(listEl, p, { indented, isSelected, isMultiSelected, onSelectPanel }) {
  const item = document.createElement('button');
  item.className =
    'list-item' +
    (indented ? ' group-member' : '') +
    (isSelected ? ' selected' : '') +
    (isMultiSelected ? ' multi-selected' : '');
  const prefix = indented ? '↳ ' : '';
  item.innerHTML = `<span class="id">${prefix}${getDisplayName(p)}</span><span class="dims">${p.width}×${p.height}×${p.thickness}</span>`;
  item.addEventListener('click', (e) => onSelectPanel(p.id, e.ctrlKey || e.metaKey));
  listEl.appendChild(item);
}
