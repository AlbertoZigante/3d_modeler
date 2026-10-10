/**
 * Inspector panel — renders and edits whichever node is currently
 * selected. Pure DOM, no framework, no direct graph mutation: it
 * only calls the callbacks it's given, so main.js stays the single
 * place that actually changes `panels`.
 *
 * Relations moved to ui/relations.js (left sidebar) — this file only
 * handles the node's own properties now: name, dims, material, qty,
 * presets, and transform.
 *
 * STAGE 2: receives BOTH the raw selected node (`selectedPanel` —
 * has `.constraints`, editable) and its resolved counterpart
 * (`resolvedPanel` — concrete numbers + `.lockedFields` +
 * `.warnings`). A field under active constraint renders locked
 * (disabled, showing the resolved value) with an "Unlink" button
 * that marks the constraint `overridden` and hands control back to
 * a literal value.
 *
 * RENAME: a pencil icon next to the node header toggles a plain text
 * input (swapped in via direct DOM manipulation, not a full
 * re-render, so typing doesn't fight the render pipeline) that sets
 * an optional `name` on the node. The stable `id` is never touched —
 * every constraint keeps referencing it regardless of what a panel
 * is renamed to.
 */

import { getDisplayName, MATERIAL_CATALOG } from '../modeller/modules.js';
import { renderDoorSchema } from './doorSchema.js';
import { renderDrawerSchema } from './drawerSchema.js';
import { renderPlinthSchema } from './plinthSchema.js';
import { renderBoxWallSchema } from './boxWallSchema.js';

const DIM_FIELDS = ['width', 'height']; // thickness is derived from material — see below, never a typed field

export function renderProperties(
  container,
  {
    selectedPanel,
    resolvedPanel,
    selectedGroupId,
    groupMemberCount,
    groupMaterial,
    hiddenGroupMembers,
    restoreError,
    onFieldChange,
    onTransformFieldChange,
    onUnlinkConstraint,
    onRename,
    onRemove,
    onUngroup,
    onGroupMaterialChange,
    onRestoreFace,
    onEdgeFitFieldChange,
    onEdgeFitChange,
    onToggleDoorOpen,
    onDoorHingeChange,
    onDrawerFrontEdgeFitChange,
    onDrawerFrontCountChange,
    onPlinthEdgeFitChange,
    onPlinthHeightChange,
    onPlinthInsetChange,
  }
) {
  if (selectedGroupId && !selectedPanel) {
    // Group-level selection (level 1, nothing drilled into) — no
    // per-panel dimension/position fields make sense for "the whole
    // box" as one thing, so this is a deliberately different, simpler
    // view: Material (applies to every member at once — groupMaterial
    // is null when members currently have DIFFERENT materials, shown
    // as a distinct "mixed" option rather than silently picking one),
    // Restore buttons for any hidden (soft-deleted) faces, plus the
    // two group-wide actions. Drilling into an individual member
    // (click it in the panel list, or click it again in the 3D/2D
    // view) switches back to the normal per-panel view below.
    const hiddenList = hiddenGroupMembers || [];
    container.innerHTML = `
      <div class="section-title">Group selected — ${groupMemberCount} panels</div>
      <div class="field-row">
        <label>Material (all ${groupMemberCount} panels)</label>
        <select id="group-material-field" class="field-input">
          ${!groupMaterial ? '<option value="" selected disabled>— Mixed materials —</option>' : ''}
          ${MATERIAL_CATALOG.map((m) => `<option value="${escapeHtml(m.name)}" ${m.name === groupMaterial ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}
        </select>
      </div>
      ${restoreFaceListHTML(hiddenList, restoreError)}
      <div class="empty-state">Click a member panel — in the list, or in the 3D/2D view — to select and edit it individually.</div>
      <button class="remove-btn" id="ungroup-btn">Ungroup (keep all ${groupMemberCount} panels)</button>
      <button class="remove-btn" id="delete-group-btn">Delete whole group (${groupMemberCount} panels)</button>
    `;
    wireRestoreFaceButtons(container, onRestoreFace);
    container.querySelector('#group-material-field').addEventListener('change', (e) => onGroupMaterialChange(e.target.value));
    container.querySelector('#ungroup-btn').addEventListener('click', onUngroup);
    container.querySelector('#delete-group-btn').addEventListener('click', onRemove);
    return;
  }

  if (!selectedPanel || !resolvedPanel) {
    container.innerHTML = `<div class="empty-state">No panel selected</div>`;
    return;
  }

  const locked = resolvedPanel.lockedFields || {};
  const displayName = getDisplayName(selectedPanel);

  container.innerHTML = `
    <div class="node-header-row">
      <span class="section-title" id="node-name-label">Node: ${escapeHtml(displayName)}${selectedPanel.pieceCode ? ` <span class="node-id-inline">${escapeHtml(selectedPanel.pieceCode)}</span>` : ''}</span>
      <button class="rename-btn" id="rename-node-btn" title="Rename this panel">✏️</button>
    </div>

    ${selectedPanel.groupId ? `<div class="group-member-note">Part of a group — Remove here deletes just this panel</div>` : ''}

    ${resolvedPanel.warnings && resolvedPanel.warnings.length > 0 ? `
      <div class="warning-banner">
        ${resolvedPanel.warnings.map((w) => `⚠ ${escapeHtml(w)}`).join('<br/>')}
      </div>` : ''}

    <div class="dims-row dims-row-compact">
      ${DIM_FIELDS.map((f) => dimFieldHTML(f, selectedPanel, resolvedPanel, locked[f], selectedPanel.isDoor || selectedPanel.isPlinthPanel, true)).join('')}
      <div class="field-row">
        <label title="Thickness — set by Material, below">T 🔒</label>
        <div class="field-input-wrap locked">
          <input type="text" value="${resolvedPanel.thickness.toFixed(1)}" disabled class="field-input" title="Set by Material, below — not directly editable" />
        </div>
      </div>
    </div>
    <div class="field-row">
      <label>Material</label>
      <select id="material-field" class="field-input">
        ${MATERIAL_CATALOG.map((m) => `<option value="${escapeHtml(m.name)}" ${m.name === selectedPanel.material ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}
      </select>
    </div>
    <button class="remove-btn" id="remove-btn">Remove panel</button>

    ${selectedPanel.edgeFit && !selectedPanel.isDoor && !selectedPanel.isDrawerFront ? edgeFitSectionHTML(selectedPanel.edgeFit) : ''}
    ${selectedPanel.isDoor ? doorSectionHTML(selectedPanel, hiddenGroupMembers || [], restoreError) : ''}
    ${selectedPanel.isDrawerFront ? drawerSectionHTML(selectedPanel, hiddenGroupMembers || [], restoreError) : ''}
    ${selectedPanel.isPlinthPanel ? plinthSectionHTML(selectedPanel) : ''}
  `;

  // ---- rename (pencil icon) ----
  const renameBtn = container.querySelector('#rename-node-btn');
  renameBtn.addEventListener('click', () => {
    const label = container.querySelector('#node-name-label');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'field-input rename-input';
    input.value = selectedPanel.name || '';
    input.placeholder = selectedPanel.id;
    label.replaceWith(input);
    input.focus();
    input.select();

    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      onRename(input.value);
    };
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); commit(); }
      if (e.key === 'Escape') { committed = true; input.replaceWith(label); }
    });
    input.addEventListener('blur', commit);
  });

  // ---- dimension / material ----
  container.querySelectorAll('.dim-field').forEach((input) => {
    input.addEventListener('change', (e) => {
      const field = e.target.dataset.field;
      const v = Number(e.target.value);
      if (Number.isFinite(v) && v > 0) onFieldChange(field, v);
      else e.target.value = selectedPanel[field];
    });
  });
  container.querySelector('#material-field').addEventListener('change', (e) => {
    onFieldChange('material', e.target.value);
  });
  container.querySelectorAll('.unlink-btn').forEach((btn) => {
    btn.addEventListener('click', () => onUnlinkConstraint(btn.dataset.field));
  });

  // ---- presets ----
  container.querySelector('#remove-btn').addEventListener('click', onRemove);

  // ---- edge fit (only present for a box's Front/Back wall — see the
  // `selectedPanel.edgeFit` check above). Each arrow click commits
  // immediately via onEdgeFitFieldChange+onEdgeFitChange in the same
  // click — same pattern as the door/drawer/plinth schemas below,
  // not a separate pending-state-plus-Apply form anymore.
  container.querySelectorAll('.box-wall-edge-arrow').forEach((g) => {
    g.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const edge = g.dataset.edge;
      const current = (selectedPanel.edgeFit || {})[edge] === 'out' ? 'out' : 'in';
      onEdgeFitFieldChange(edge, current === 'out' ? 'in' : 'out');
      onEdgeFitChange();
    });
  });

  // ---- door (edge fit + hinge live, via the shared door schema; open/
  // close — only present for a door, see the `selectedPanel.isDoor`
  // check above). Each edge-arrow click commits immediately (edge fit
  // + Apply in the same click, unlike a box wall's batched selects
  // above) since the schema itself is a single click = single change
  // control, not a multi-field form.
  container.querySelectorAll('.door-edge-arrow').forEach((g) => {
    g.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const edge = g.dataset.edge;
      const current = (selectedPanel.edgeFit || {})[edge] === 'out' ? 'out' : 'in';
      onEdgeFitFieldChange(edge, current === 'out' ? 'in' : 'out');
      onEdgeFitChange();
    });
  });
  container.querySelector('.door-hinge-swap')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onDoorHingeChange(selectedPanel.hinge === 'right' ? 'left' : 'right');
  });
  container.querySelector('#toggle-door-open-btn')?.addEventListener('click', () => {
    onToggleDoorOpen();
  });

  // ---- drawer front (edge fit only — count/hinge don't apply here;
  // see the `selectedPanel.isDrawerFront` check above). NOT the
  // generic onEdgeFitFieldChange/onEdgeFitChange the door arrows
  // above use — a drawer stack's N fronts all share one edgeFit, so
  // this goes through its own onDrawerFrontEdgeFitChange, which
  // updates every front in the stack at once (see
  // modeller-main.js#updateSelectedDrawerFrontEdgeFit for why a
  // single-node patch isn't enough here).
  container.querySelectorAll('.drawer-edge-arrow').forEach((g) => {
    g.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const edge = g.dataset.edge;
      const current = (selectedPanel.edgeFit || {})[edge] === 'out' ? 'out' : 'in';
      onDrawerFrontEdgeFitChange(edge, current === 'out' ? 'in' : 'out');
    });
  });
  // 'change' (fires on blur/Enter), not 'input' — same reasoning as
  // the old confirm-phase count field: this rebuilds+re-renders the
  // whole stack/panel, which would otherwise fight an in-progress
  // keystroke.
  container.querySelector('#drawer-front-count-field')?.addEventListener('change', (event) => {
    onDrawerFrontCountChange(event.target.value);
  });

  // ---- plinth (edge fit live via the schema; height + each edge's
  // cm inset are plain fields — see plinthSectionHTML above for why).
  container.querySelectorAll('.plinth-edge-arrow').forEach((g) => {
    g.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const edge = g.dataset.edge;
      const current = (selectedPanel.plinthEdgeFit || {})[edge]?.fit === 'out' ? 'out' : 'in';
      onPlinthEdgeFitChange(edge, current === 'out' ? 'in' : 'out');
    });
  });
  container.querySelector('#plinth-height-field')?.addEventListener('change', (event) => {
    onPlinthHeightChange(event.target.value);
  });
  container.querySelectorAll('.plinth-inset-field').forEach((input) => {
    input.addEventListener('change', (event) => {
      onPlinthInsetChange(event.target.dataset.edge, event.target.value);
    });
  });

  wireRestoreFaceButtons(container, onRestoreFace);
}

// A box's Front/Back wall keeps the box's own outer size fixed and
// only ever changes ITS OWN width/height/position by choosing, per
// edge, whether that edge sits flush INSIDE the neighboring wall
// ('in' — an inset door/front, the long-standing default) or flush
// OUTSIDE it, covering that wall's edge ('out' — an overlay
// door/front). Each arrow click below commits immediately as its own
// history entry (see modeller-main.js#applyPendingEdgeFit) — same
// shape as doorSectionHTML's schema just above, not a batched form.
//
// Same "arrows, live apply" treatment as doorSectionHTML/
// drawerSectionHTML/plinthSectionHTML — was selects + a batched Apply
// button (see modeller-main.js#applyPendingEdgeFit, still what this
// wires to; only the UI changed, not the underlying commit path).
function edgeFitSectionHTML(edgeFit) {
  return `
    <div class="divider"></div>
    <div class="section-title">Edge fit</div>
    <div class="properties-hint">
      Click an edge's arrow to flip it in/out.
    </div>
    ${renderBoxWallSchema(edgeFit)}
  `;
}

// Shared by both the group-level view (a hidden face's own natural
// home) and doorSectionHTML below (see that function's own comment
// for why a door needs this too) — one hidden-face list, one set of
// click handlers, no duplicated markup to drift out of sync.
function restoreFaceListHTML(hiddenList, restoreError) {
  if (!hiddenList || hiddenList.length === 0) return '';
  return `
    <div class="section-title">Deleted faces — ${hiddenList.length}</div>
    <div class="restore-face-list">
      ${hiddenList.map((p) => `<button class="add-btn restore-face-btn" data-restore-id="${p.id}">↺ Restore ${escapeHtml(getDisplayName(p))}</button>`).join('')}
    </div>
    ${restoreError ? `<div class="properties-error">${escapeHtml(restoreError)}</div>` : ''}
  `;
}

function wireRestoreFaceButtons(container, onRestoreFace) {
  container.querySelectorAll('.restore-face-btn').forEach((btn) => {
    btn.addEventListener('click', () => onRestoreFace(btn.dataset.restoreId));
  });
}

// A door's edge fit + hinge both apply live here, one click = one
// change — unlike a box wall's edgeFitSectionHTML (batched Apply,
// above), there's no multi-field form to hold pending state for: the
// schema below (ui/doorSchema.js, shared with the confirm-phase form
// in ui/toolbar.js) IS the whole control, so each click just commits
// immediately via onEdgeFitFieldChange+onEdgeFitChange (edges) or
// onDoorHingeChange (hinge) — see the wiring below.
//
// The hidden-face Restore list is repeated here (see
// restoreFaceListHTML above) right next to the schema: drilling into
// an individual door panel switches the WHOLE inspector away from the
// group-level view where Restore normally lives (see the
// `selectedGroupId && !selectedPanel` branch up top), so without this
// a door's own group would be unreachable from the group-level
// Restore button the moment the door itself is selected instead —
// exactly the case someone undoing a door back to its original hidden
// wall would hit.
function doorSectionHTML(door, hiddenGroupMembers, restoreError) {
  const canOpen = door.normalAxis !== 'y';
  return `
    <div class="divider"></div>
    <div class="section-title">Door</div>
    <div class="properties-hint">
      Click an edge's arrow to flip it in/out. Click the dotted line to swap the hinge side.
    </div>
    ${renderDoorSchema(door.edgeFit, door.hinge)}
    ${canOpen ? `<button class="add-btn" id="toggle-door-open-btn">${door.doorOpen ? 'Close door' : 'Open door'}</button>` : ''}
    ${restoreFaceListHTML(hiddenGroupMembers, restoreError)}
  `;
}

// Same "edge fit only, applies live" reasoning as doorSectionHTML
// above for the schema; count is its own field (see
// modeller-main.js#updateSelectedDrawerFrontCount — changing it tears
// down and rebuilds the whole stack, unlike edge fit, so it isn't
// something the schema itself can represent as a click).
function drawerSectionHTML(front, hiddenGroupMembers, restoreError) {
  return `
    <div class="divider"></div>
    <div class="section-title">Drawer</div>
    <div class="properties-hint">
      Click an edge's arrow to flip it in/out.
    </div>
    ${renderDrawerSchema(front.edgeFit, front.drawerCount)}
    <div class="field-row">
      <label>Number of drawers</label>
      <input type="number" class="field-input" id="drawer-front-count-field" min="1" max="10" step="1" value="${Number(front.drawerCount ?? 1)}" />
    </div>
    ${restoreFaceListHTML(hiddenGroupMembers, restoreError)}
  `;
}

// No restoreFaceListHTML here, unlike doorSectionHTML/drawerSectionHTML
// — a plinth doesn't replace/hide any existing box wall (it's built
// underneath the box's own Bottom, which stays exactly as it was —
// see features/plinth.js's own header comment), so there's never a
// hidden face to restore. `plinth` here can be ANY of its 4 (or more,
// with reinforcement ribs) sibling panels — plinthEdgeFit/height are
// shared by the whole plinth (see features/plinth.js#createPlinthNodes),
// so whichever one is selected edits the same live stack, same
// reasoning as drawerSectionHTML above. Height and each edge's cm
// inset are plain fields (not schema clicks) since they're typed
// numbers, not a toggle — see ui/plinthSchema.js's own header comment.
function plinthSectionHTML(plinth) {
  const edgeFit = plinth.plinthEdgeFit || {};
  const edgeRow = (edge, label) => {
    const e = edgeFit[edge] || {};
    const cm = (Number.isFinite(e.insetMm) ? e.insetMm : 30) / 10;
    return `
      <div class="field-row">
        <label>${label}</label>
        <div class="field-input-wrap">
          <input type="number" min="0" step="0.5" value="${cm}" class="field-input plinth-inset-field" data-edge="${edge}" />
          <span class="field-unit">cm</span>
        </div>
      </div>`;
  };
  return `
    <div class="divider"></div>
    <div class="section-title">Plinth</div>
    <div class="properties-hint">
      Click an edge's arrow to flip it in/out — set each inset edge's distance below.
    </div>
    ${renderPlinthSchema(edgeFit)}
    <div class="field-row">
      <label>Height</label>
      <div class="field-input-wrap">
        <input type="number" min="1" value="${Math.round(plinth.height)}" class="field-input" id="plinth-height-field" />
        <span class="field-unit">mm</span>
      </div>
    </div>
    ${edgeRow('left', 'Left inset')}
    ${edgeRow('right', 'Right inset')}
    ${edgeRow('back', 'Back inset')}
    ${edgeRow('front', 'Front inset')}
  `;
}

function dimFieldHTML(field, selectedPanel, resolvedPanel, isLocked, isStructuralLock = false, compact = false) {
  const fullLabel = field[0].toUpperCase() + field.slice(1);
  // Compact mode (the W/H/T single-line row): a single-letter label
  // with the full word as a tooltip, and no inline "mm" unit (the row
  // has one unit for all three, implied rather than repeated) — the
  // same three visual states (plain / 🔗 unlink / 🔒 structural) as
  // the full-width version, just tighter.
  const label = compact ? `<span title="${fullLabel}">${fullLabel[0]}</span>` : fullLabel;
  if (isLocked && isStructuralLock) {
    // A door's width/height come from its boundary panels, not a
    // removable relation (see features/door.js#createDoorNode) — same
    // visual treatment as the Thickness field just below, not the
    // constraint-style 🔗/Unlink variant, since there's nothing to
    // unlink.
    return `
      <div class="field-row">
        <label>${label} 🔒</label>
        <div class="field-input-wrap locked">
          <input type="text" value="${resolvedPanel[field].toFixed(1)}" disabled class="field-input" title="Derived from its boundary panels — not directly editable" />
          ${compact ? '' : '<span class="field-unit">mm</span>'}
        </div>
      </div>`;
  }
  if (isLocked) {
    return `
      <div class="field-row">
        <label>${label} 🔗</label>
        <div class="field-input-wrap locked">
          <input type="text" value="${resolvedPanel[field].toFixed(1)}" disabled class="field-input" />
          ${compact ? '' : '<span class="field-unit">mm</span>'}
        </div>
        <button class="unlink-btn" data-field="${field}">Unlink</button>
      </div>`;
  }
  return numberFieldHTML(label, field, selectedPanel[field], compact ? '' : 'mm', { min: 1 }, 'dim-field');
}

function numberFieldHTML(label, field, value, unit = 'mm', { min } = {}, extraClass = 'dim-field') {
  return `
    <div class="field-row">
      <label>${label}</label>
      <div class="field-input-wrap">
        <input type="number" ${min != null ? `min="${min}"` : ''} value="${value}" data-field="${field}" class="field-input ${extraClass}" />
        ${unit ? `<span class="field-unit">${unit}</span>` : ''}
      </div>
    </div>`;
}

function axisFieldHTML(group, axis, value, locked = false) {
  return `
    <div class="transform-field-wrap">
      <span class="axis-label axis-${axis}">${axis.toUpperCase()}</span>
      <input type="number" step="any" value="${Number(value).toFixed(1)}"
        data-group="${group}" data-axis="${axis}"
        ${locked ? 'disabled' : ''}
        class="field-input transform-field" />
    </div>`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
