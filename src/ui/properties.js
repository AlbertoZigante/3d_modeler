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
  // A panel whose position is fully derived (a door or drawer front —
  // see features/door.js#createDoorNode's/features/drawer.js#createDrawerFrontNodes's
  // own lockedMoveAxes) has ALL 3 position axes locked together, never
  // a mix — nothing else currently locks all 3 at once, which is what
  // makes this a safe stand-in for "is this a door or drawer front"
  // without importing either feature's own flag here. The whole
  // Transform section below is skipped entirely in that case (not
  // just disabled) — a gizmo/gizmo-driven section is meaningless for a
  // position nothing ever drags, so showing it read-only was just
  // noise pushing everything else down.
  const transformLocked = !!(locked.positionX && locked.positionY && locked.positionZ);
  const displayName = getDisplayName(selectedPanel);

  container.innerHTML = `
    <div class="node-header-row">
      <span class="section-title" id="node-name-label">Node: ${escapeHtml(displayName)}</span>
      <button class="rename-btn" id="rename-node-btn" title="Rename this panel">✏️</button>
    </div>

    ${selectedPanel.groupId ? `<div class="group-member-note">Part of a group — Remove here deletes just this panel</div>` : ''}

    ${resolvedPanel.warnings && resolvedPanel.warnings.length > 0 ? `
      <div class="warning-banner">
        ${resolvedPanel.warnings.map((w) => `⚠ ${escapeHtml(w)}`).join('<br/>')}
      </div>` : ''}

    <div class="dims-row">
      ${DIM_FIELDS.map((f) => dimFieldHTML(f, selectedPanel, resolvedPanel, locked[f], selectedPanel.isDoor)).join('')}
    </div>
    <div class="field-row">
      <label>Thickness 🔒</label>
      <div class="field-input-wrap locked">
        <input type="text" value="${resolvedPanel.thickness.toFixed(1)}" disabled class="field-input" title="Set by Material, below — not directly editable" />
        <span class="field-unit">mm</span>
      </div>
    </div>
    <div class="field-row">
      <label>Material</label>
      <select id="material-field" class="field-input">
        ${MATERIAL_CATALOG.map((m) => `<option value="${escapeHtml(m.name)}" ${m.name === selectedPanel.material ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}
      </select>
    </div>
    ${numberFieldHTML('Quantity', 'quantity', selectedPanel.quantity, 'pc', { min: 1 })}
    <button class="remove-btn" id="remove-btn">Remove panel</button>

    ${selectedPanel.edgeFit ? edgeFitSectionHTML(selectedPanel.edgeFit) : ''}
    ${selectedPanel.isDoor ? doorSectionHTML(selectedPanel, hiddenGroupMembers || [], restoreError) : ''}

    ${transformLocked ? '' : `
      <div class="divider"></div>
      <div class="section-title">Transform (from gizmo)</div>
      <div class="transform-grid">
        ${axisFieldHTML('offset', 'x', selectedPanel.offset.x, false)}
        ${axisFieldHTML('offset', 'y', selectedPanel.offset.y, false)}
        ${axisFieldHTML('offset', 'z', selectedPanel.offset.z, false)}
      </div>
      <div class="transform-label">Position offset (mm)</div>
    `}
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

  // ---- dimension / material / quantity ----
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

  // ---- transform ----
  container.querySelectorAll('.transform-field').forEach((input) => {
    input.addEventListener('change', (e) => {
      const group = e.target.dataset.group;
      const axis = e.target.dataset.axis;
      const v = Number(e.target.value);
      if (Number.isFinite(v)) onTransformFieldChange(group, axis, v);
      else e.target.value = selectedPanel[group][axis];
    });
  });

  // ---- presets ----
  container.querySelector('#remove-btn').addEventListener('click', onRemove);

  // ---- edge fit (only present for a box's Front/Back wall — see the
  // `selectedPanel.edgeFit` check above) ----
  // Each select commits its own pick immediately via
  // onEdgeFitFieldChange (modeller-main.js's own `pendingEdgeFit` —
  // see that file's comment on why this can't just be read fresh off
  // these <select> elements at Apply time anymore: a re-render
  // triggered by anything else — most commonly resizing a DIFFERENT
  // box wall mid-edit — recreates this whole section from the node's
  // actual committed edgeFit, wiping whatever was picked-but-not-yet-
  // applied here). Apply itself now takes no arguments; the value it
  // commits was already tracked the moment each select changed.
  container.querySelectorAll('.edge-fit-field').forEach((select) => {
    select.addEventListener('change', () => {
      onEdgeFitFieldChange(select.dataset.edge, select.value);
    });
  });
  container.querySelector('#apply-edge-fit-btn')?.addEventListener('click', () => {
    onEdgeFitChange();
  });

  // ---- door (hinge + open/close — only present for a door, see the
  // `selectedPanel.isDoor` check above) ----
  container.querySelector('#door-hinge-field')?.addEventListener('change', (event) => {
    onDoorHingeChange(event.target.value);
  });
  container.querySelector('#toggle-door-open-btn')?.addEventListener('click', () => {
    onToggleDoorOpen();
  });
  wireRestoreFaceButtons(container, onRestoreFace);
}

// A box's Front/Back wall keeps the box's own outer size fixed and
// only ever changes ITS OWN width/height/position by choosing, per
// edge, whether that edge sits flush INSIDE the neighboring wall
// ('in' — an inset door/front, the long-standing default) or flush
// OUTSIDE it, covering that wall's edge ('out' — an overlay
// door/front). The 4 selects don't apply live — Apply commits all 4
// at once as ONE history entry (see modeller-main.js#updateSelectedEdgeFit),
// so switching a couple of edges mid-thought doesn't spam undo.
const EDGE_FIT_ROWS = [
  ['left', 'Left edge (vs Left wall)'],
  ['right', 'Right edge (vs Right wall)'],
  ['bottom', 'Bottom edge (vs Bottom wall)'],
  ['top', 'Top edge (vs Top wall)'],
];

function edgeFitSectionHTML(edgeFit) {
  return `
    <div class="divider"></div>
    <div class="section-title">Edge fit</div>
    ${EDGE_FIT_ROWS.map(([edge, label]) => `
      <div class="field-row">
        <label>${label}</label>
        <select class="field-input edge-fit-field" data-edge="${edge}">
          <option value="in" ${edgeFit[edge] !== 'out' ? 'selected' : ''}>In (inset)</option>
          <option value="out" ${edgeFit[edge] === 'out' ? 'selected' : ''}>Out (overlay)</option>
        </select>
      </div>
    `).join('')}
    <button class="add-btn" id="apply-edge-fit-btn">Apply edge fit</button>
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

// Hinge is a design choice (which side the actual hardware goes on),
// so changing it here goes straight through — one field, no need for
// edgeFit's own batched Apply pattern. Open/Close is the opposite: a
// purely visual toggle (see features/door.js#computeDoorOpenTransform
// and modeller-main.js#toggleSelectedDoorOpen), swinging the door 90°
// about its hinge edge in the 3D view without changing anything
// BOM/cut-list reads — normalAxis === 'y' (a door replacing a
// Top/Bottom wall, lying flat like a lid) has no vertical edge to
// hinge on, so that case hides the Open/Close button entirely rather
// than showing a button that would silently do nothing.
//
// The hidden-face Restore list is repeated here (see
// restoreFaceListHTML above) right next to Open/Close: drilling into
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
    <div class="field-row">
      <label>Hinge side</label>
      <select class="field-input" id="door-hinge-field">
        <option value="left" ${door.hinge !== 'right' ? 'selected' : ''}>Left</option>
        <option value="right" ${door.hinge === 'right' ? 'selected' : ''}>Right</option>
      </select>
    </div>
    ${canOpen ? `<button class="add-btn" id="toggle-door-open-btn">${door.doorOpen ? 'Close door' : 'Open door'}</button>` : ''}
    ${restoreFaceListHTML(hiddenGroupMembers, restoreError)}
  `;
}

function dimFieldHTML(field, selectedPanel, resolvedPanel, isLocked, isStructuralLock = false) {
  const label = field[0].toUpperCase() + field.slice(1);
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
          <span class="field-unit">mm</span>
        </div>
      </div>`;
  }
  if (isLocked) {
    return `
      <div class="field-row">
        <label>${label} 🔗</label>
        <div class="field-input-wrap locked">
          <input type="text" value="${resolvedPanel[field].toFixed(1)}" disabled class="field-input" />
          <span class="field-unit">mm</span>
        </div>
        <button class="unlink-btn" data-field="${field}">Unlink</button>
      </div>`;
  }
  return numberFieldHTML(label, field, selectedPanel[field], 'mm', { min: 1 }, 'dim-field');
}

function numberFieldHTML(label, field, value, unit = 'mm', { min } = {}, extraClass = 'dim-field') {
  return `
    <div class="field-row">
      <label>${label}</label>
      <div class="field-input-wrap">
        <input type="number" ${min != null ? `min="${min}"` : ''} value="${value}" data-field="${field}" class="field-input ${extraClass}" />
        <span class="field-unit">${unit}</span>
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
