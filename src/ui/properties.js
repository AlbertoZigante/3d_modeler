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
    onFieldChange,
    onTransformFieldChange,
    onUnlinkConstraint,
    onRename,
    onRemove,
    onUngroup,
    onGroupMaterialChange,
    onRestoreFace,
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
      ${hiddenList.length > 0 ? `
        <div class="section-title">Deleted faces — ${hiddenList.length}</div>
        <div class="restore-face-list">
          ${hiddenList.map((p) => `<button class="add-btn restore-face-btn" data-restore-id="${p.id}">↺ Restore ${escapeHtml(getDisplayName(p))}</button>`).join('')}
        </div>
      ` : ''}
      <div class="empty-state">Click a member panel — in the list, or in the 3D/2D view — to select and edit it individually.</div>
      <button class="remove-btn" id="ungroup-btn">Ungroup (keep all ${groupMemberCount} panels)</button>
      <button class="remove-btn" id="delete-group-btn">Delete whole group (${groupMemberCount} panels)</button>
    `;
    container.querySelectorAll('.restore-face-btn').forEach((btn) => {
      btn.addEventListener('click', () => onRestoreFace(btn.dataset.restoreId));
    });
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
      <span class="section-title" id="node-name-label">Node: ${escapeHtml(displayName)}</span>
      <button class="rename-btn" id="rename-node-btn" title="Rename this panel">✏️</button>
    </div>

    ${selectedPanel.groupId ? `<div class="group-member-note">Part of a group — Remove here deletes just this panel</div>` : ''}

    ${resolvedPanel.warnings && resolvedPanel.warnings.length > 0 ? `
      <div class="warning-banner">
        ${resolvedPanel.warnings.map((w) => `⚠ ${escapeHtml(w)}`).join('<br/>')}
      </div>` : ''}

    <div class="dims-row">
      ${DIM_FIELDS.map((f) => dimFieldHTML(f, selectedPanel, resolvedPanel, locked[f])).join('')}
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

    <div class="divider"></div>
    <div class="section-title">Transform (from gizmo)</div>
    <div class="transform-grid">
      ${axisFieldHTML('offset', 'x', selectedPanel.offset.x)}
      ${axisFieldHTML('offset', 'y', selectedPanel.offset.y)}
      ${axisFieldHTML('offset', 'z', selectedPanel.offset.z)}
    </div>
    <div class="transform-label">Position offset (mm)</div>
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
}

function dimFieldHTML(field, selectedPanel, resolvedPanel, isLocked) {
  const label = field[0].toUpperCase() + field.slice(1);
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

function axisFieldHTML(group, axis, value) {
  return `
    <div class="transform-field-wrap">
      <span class="axis-label axis-${axis}">${axis.toUpperCase()}</span>
      <input type="number" step="any" value="${Number(value).toFixed(1)}"
        data-group="${group}" data-axis="${axis}"
        class="field-input transform-field" />
    </div>`;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
