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

import { getDisplayName } from '../modeller/modules.js';

const DIM_FIELDS = ['width', 'height', 'thickness'];

export function renderProperties(
  container,
  {
    selectedPanel,
    resolvedPanel,
    onFieldChange,
    onTransformFieldChange,
    onResetTransform,
    onSetOrientation,
    onCreateBox,
    onUnlinkConstraint,
    onRename,
    onRemove,
  }
) {
  if (!selectedPanel || !resolvedPanel) {
    container.innerHTML = `<div class="empty-state">No panel selected</div>`;
    return;
  }

  const locked = resolvedPanel.lockedFields || {};
  const displayName = getDisplayName(selectedPanel);

  const rx = (((Math.round(selectedPanel.rotation.x / 90) * 90) % 360) + 360) % 360;
  const isVertical = rx === 0 || rx === 180;
  const isHorizontal = rx === 90 || rx === 270;

  container.innerHTML = `
    <div class="node-header-row">
      <span class="section-title" id="node-name-label">Node: ${escapeHtml(displayName)}</span>
      <button class="rename-btn" id="rename-node-btn" title="Rename this panel">✏️</button>
    </div>

    ${resolvedPanel.warnings && resolvedPanel.warnings.length > 0 ? `
      <div class="warning-banner">
        ${resolvedPanel.warnings.map((w) => `⚠ ${escapeHtml(w)}`).join('<br/>')}
      </div>` : ''}

    <div class="section-title">Panel type</div>
    <div class="type-toggle">
      <button class="type-btn ${isVertical ? 'active' : ''}" data-orientation="vertical">Vertical panel</button>
      <button class="type-btn ${isHorizontal ? 'active' : ''}" data-orientation="horizontal">Horizontal panel</button>
    </div>
    <button class="box-preset-btn" id="create-box-btn">+ Box (4 sides + back, open front)</button>

    <div class="dims-row">
      ${DIM_FIELDS.map((f) => dimFieldHTML(f, selectedPanel, resolvedPanel, locked[f])).join('')}
    </div>
    <div class="field-row">
      <label>Material</label>
      <input type="text" value="${escapeHtml(selectedPanel.material)}" id="material-field" class="field-input" />
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
    <div class="transform-grid">
      ${axisFieldHTML('rotation', 'x', selectedPanel.rotation.x)}
      ${axisFieldHTML('rotation', 'y', selectedPanel.rotation.y)}
      ${axisFieldHTML('rotation', 'z', selectedPanel.rotation.z)}
    </div>
    <div class="transform-label">Rotation (degrees)</div>
    <button class="reset-btn" id="reset-transform-btn">Reset to original position</button>
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
  container.querySelector('#reset-transform-btn').addEventListener('click', onResetTransform);

  // ---- presets ----
  container.querySelectorAll('.type-btn').forEach((btn) => {
    btn.addEventListener('click', () => onSetOrientation(btn.dataset.orientation));
  });
  container.querySelector('#create-box-btn').addEventListener('click', onCreateBox);
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
