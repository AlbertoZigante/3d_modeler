/**
 * Inspector panel — renders and edits whichever node is currently
 * selected. Pure DOM, no framework, no direct graph mutation: it
 * only calls the callbacks it's given, so main.js stays the single
 * place that actually changes `panels`.
 *
 * STAGE 2: receives BOTH the raw selected node (`selectedPanel` —
 * has `.constraints`, editable) and its resolved counterpart
 * (`resolvedPanel` — concrete numbers + `.lockedFields` +
 * `.warnings`). A field under active constraint renders locked
 * (disabled, showing the resolved value) with an "Unlink" button
 * that marks the constraint `overridden` and hands control back to
 * a literal value — the override-breaks-link pattern used
 * everywhere else in this app (dimension overrides, transform
 * offsets) applied here too.
 *
 * Relation creation is a plain dropdown form (no drag-to-snap): pick
 * a type, a field, then the target panel(s)/face(s)/offset(s).
 * Deterministic and easy to get right, versus proximity-based
 * snapping which is meaningfully more work for a first pass.
 */

import { LOCAL_FACES } from '../modeller/modules.js';

const FACE_NAMES = Object.keys(LOCAL_FACES);
const DIM_FIELDS = ['width', 'height', 'thickness'];
const POSITION_FIELDS = ['positionX', 'positionY', 'positionZ'];
const POSITION_LABELS = { positionX: 'X position', positionY: 'Y position', positionZ: 'Z position' };

export function renderProperties(
  container,
  {
    selectedPanel,
    resolvedPanel,
    allPanels,
    onFieldChange,
    onTransformFieldChange,
    onResetTransform,
    onSetOrientation,
    onCreateBox,
    onAddConstraint,
    onUnlinkConstraint,
    onRemove,
  }
) {
  if (!selectedPanel || !resolvedPanel) {
    container.innerHTML = `<div class="empty-state">No panel selected</div>`;
    return;
  }

  const locked = resolvedPanel.lockedFields || {};
  const otherPanels = (allPanels || []).filter((p) => p.id !== selectedPanel.id);

  const rx = (((Math.round(selectedPanel.rotation.x / 90) * 90) % 360) + 360) % 360;
  const isVertical = rx === 0 || rx === 180;
  const isHorizontal = rx === 90 || rx === 270;

  container.innerHTML = `
    <div class="section-title">Node: ${selectedPanel.id}</div>

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

    <div class="divider"></div>
    <div class="section-title">Relations</div>
    ${renderConstraintList(selectedPanel)}
    ${renderAddConstraintForm(selectedPanel, otherPanels)}
  `;

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

  // ---- relations: remove existing ----
  container.querySelectorAll('.constraint-remove-btn').forEach((btn) => {
    btn.addEventListener('click', () => onUnlinkConstraint(btn.dataset.constraintId, { remove: true }));
  });

  // ---- relations: add-constraint form ----
  const typeSelect = container.querySelector('#new-constraint-type');
  const formBody = container.querySelector('#new-constraint-form-body');
  if (typeSelect) {
    typeSelect.addEventListener('change', () => {
      formBody.innerHTML = renderConstraintFormBody(typeSelect.value, otherPanels);
    });
    const addBtn = container.querySelector('#add-constraint-btn');
    addBtn.addEventListener('click', () => {
      const type = typeSelect.value;
      const constraint = readConstraintForm(container, type);
      if (constraint) onAddConstraint(constraint);
    });
  }
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

function renderConstraintList(selectedPanel) {
  const constraints = selectedPanel.constraints || [];
  if (constraints.length === 0) {
    return `<div class="empty-state" style="margin-bottom:10px;">No relations on this panel yet.</div>`;
  }
  return `
    <div class="constraint-list">
      ${constraints.map((c) => `
        <div class="constraint-item ${c.overridden ? 'overridden' : ''}">
          <div class="constraint-desc">
            <strong>${c.field}</strong> ${c.overridden ? '(unlinked)' : ''} —
            ${c.type === 'spansBetween'
              ? `spans ${c.from.node}·${c.from.face} ↔ ${c.to.node}·${c.to.face}`
              : `attached (${c.myFace}) to ${c.from.node}·${c.from.face}`}
          </div>
          <button class="constraint-remove-btn" data-constraint-id="${c.id}" title="Remove this relation">×</button>
        </div>
      `).join('')}
    </div>`;
}

function renderAddConstraintForm(selectedPanel, otherPanels) {
  if (otherPanels.length === 0) {
    return `<div class="empty-state">Add another panel first to create a relation.</div>`;
  }
  return `
    <div class="add-constraint-form">
      <div class="field-row">
        <label>New relation type</label>
        <select id="new-constraint-type" class="field-input">
          <option value="spansBetween">Spans between two panels (sets a dimension)</option>
          <option value="attachedTo">Attached to one panel (sets a position)</option>
        </select>
      </div>
      <div id="new-constraint-form-body">${renderConstraintFormBody('spansBetween', otherPanels)}</div>
      <button class="box-preset-btn" id="add-constraint-btn">+ Add relation</button>
    </div>`;
}

function renderConstraintFormBody(type, otherPanels) {
  const panelOptions = otherPanels.map((p) => `<option value="${p.id}">${p.id}</option>`).join('');
  const faceOptions = FACE_NAMES.map((f) => `<option value="${f}">${f}</option>`).join('');

  if (type === 'spansBetween') {
    return `
      <div class="field-row">
        <label>Field this sets</label>
        <select id="cf-field" class="field-input">
          ${DIM_FIELDS.map((f) => `<option value="${f}">${f}</option>`).join('')}
        </select>
      </div>
      <div class="relation-ref-pair">
        <div class="relation-ref">
          <span class="relation-ref-label">From</span>
          <select id="cf-from-node" class="field-input">${panelOptions}</select>
          <select id="cf-from-face" class="field-input">${faceOptions}</select>
          <input type="number" id="cf-from-offset" class="field-input" value="0" placeholder="offset mm" />
        </div>
        <div class="relation-ref">
          <span class="relation-ref-label">To</span>
          <select id="cf-to-node" class="field-input">${panelOptions}</select>
          <select id="cf-to-face" class="field-input">${faceOptions}</select>
          <input type="number" id="cf-to-offset" class="field-input" value="0" placeholder="offset mm" />
        </div>
      </div>`;
  }

  return `
    <div class="field-row">
      <label>Field this sets</label>
      <select id="cf-field" class="field-input">
        ${POSITION_FIELDS.map((f) => `<option value="${f}">${POSITION_LABELS[f]}</option>`).join('')}
      </select>
    </div>
    <div class="field-row">
      <label>My face (touches the target)</label>
      <select id="cf-my-face" class="field-input">${faceOptions}</select>
    </div>
    <div class="relation-ref-pair">
      <div class="relation-ref">
        <span class="relation-ref-label">Target</span>
        <select id="cf-from-node" class="field-input">${panelOptions}</select>
        <select id="cf-from-face" class="field-input">${faceOptions}</select>
        <input type="number" id="cf-from-offset" class="field-input" value="0" placeholder="offset mm" />
      </div>
    </div>`;
}

function readConstraintForm(container, type) {
  const field = container.querySelector('#cf-field')?.value;
  const fromNode = container.querySelector('#cf-from-node')?.value;
  const fromFace = container.querySelector('#cf-from-face')?.value;
  const fromOffset = Number(container.querySelector('#cf-from-offset')?.value || 0);
  if (!field || !fromNode || !fromFace) return null;

  if (type === 'spansBetween') {
    const toNode = container.querySelector('#cf-to-node')?.value;
    const toFace = container.querySelector('#cf-to-face')?.value;
    const toOffset = Number(container.querySelector('#cf-to-offset')?.value || 0);
    if (!toNode || !toFace) return null;
    return {
      field, type: 'spansBetween',
      from: { node: fromNode, face: fromFace, offset: fromOffset },
      to: { node: toNode, face: toFace, offset: toOffset },
    };
  }

  const myFace = container.querySelector('#cf-my-face')?.value;
  if (!myFace) return null;
  return {
    field, type: 'attachedTo', myFace,
    from: { node: fromNode, face: fromFace, offset: fromOffset },
  };
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
