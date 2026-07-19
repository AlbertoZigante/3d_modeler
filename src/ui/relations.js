/**
 * Relations (constraints) panel — left sidebar.
 *
 * Click an existing relation in the list to load it into the form
 * below for editing (the form's fields pre-fill with that relation's
 * current field/type/node/face/offset values). While editing, the
 * submit area shows "Update" + "Remove" instead of "Apply". Clicking
 * the same relation again — or successfully updating/removing it —
 * returns the form to "create new" mode.
 *
 * `editingConstraintId` is local module state, not threaded through
 * main.js: it only matters to this form's own rendering, and
 * main.js's `panels` shouldn't need to know "what's currently being
 * edited in some UI form" as part of the actual graph.
 */
import { LOCAL_FACES, getDisplayName } from '../modeller/modules.js';

const FACE_NAMES = Object.keys(LOCAL_FACES);
const DIM_FIELDS = ['width', 'height', 'thickness'];
const POSITION_FIELDS = ['positionX', 'positionY', 'positionZ'];
const POSITION_LABELS = { positionX: 'X position', positionY: 'Y position', positionZ: 'Z position' };

let editingConstraintId = null;
let lastSelectedPanelId = null;

export function renderRelations(
  container,
  { selectedPanel, allPanels, onAddConstraint, onUpdateConstraint, onUnlinkConstraint }
) {
  if (!selectedPanel) {
    editingConstraintId = null;
    lastSelectedPanelId = null;
    container.innerHTML = `
      <div class="section-title">Relations</div>
      <div class="empty-state">No panel selected.</div>`;
    return;
  }

  // switching to a different panel always exits edit mode — an
  // in-progress edit on the previous panel's relation doesn't carry over
  if (selectedPanel.id !== lastSelectedPanelId) {
    editingConstraintId = null;
    lastSelectedPanelId = selectedPanel.id;
  }

  const otherPanels = (allPanels || []).filter((p) => p.id !== selectedPanel.id);
  const constraints = selectedPanel.constraints || [];
  const editingConstraint = constraints.find((c) => c.id === editingConstraintId) || null;

  container.innerHTML = `
    <div class="section-title">Relations</div>
    ${renderConstraintList(constraints, allPanels)}
    ${otherPanels.length === 0
      ? `<div class="empty-state">Add another panel first to create a relation.</div>`
      : renderConstraintForm(editingConstraint, otherPanels)}
  `;

  // ---- click a relation row to load it into the form ----
  container.querySelectorAll('.constraint-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.constraint-remove-btn')) return; // × has its own handler
      const id = item.dataset.constraintId;
      editingConstraintId = editingConstraintId === id ? null : id; // click again to cancel
      renderRelations(container, { selectedPanel, allPanels, onAddConstraint, onUpdateConstraint, onUnlinkConstraint });
    });
  });

  container.querySelectorAll('.constraint-remove-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.dataset.constraintId === editingConstraintId) editingConstraintId = null;
      onUnlinkConstraint(btn.dataset.constraintId, { remove: true });
    });
  });

  // ---- the create/edit form ----
  const typeSelect = container.querySelector('#new-constraint-type');
  const formBody = container.querySelector('#new-constraint-form-body');
  if (typeSelect) {
    typeSelect.addEventListener('change', () => {
      formBody.innerHTML = renderConstraintFormBody(typeSelect.value, otherPanels, null);
    });

    const applyBtn = container.querySelector('#apply-constraint-btn');
    if (applyBtn) {
      applyBtn.addEventListener('click', () => {
        const constraint = readConstraintForm(container, typeSelect.value);
        if (constraint) onAddConstraint(constraint);
      });
    }

    const updateBtn = container.querySelector('#update-constraint-btn');
    if (updateBtn) {
      updateBtn.addEventListener('click', () => {
        const constraint = readConstraintForm(container, typeSelect.value);
        if (constraint) onUpdateConstraint(editingConstraintId, constraint);
      });
    }

    const removeFormBtn = container.querySelector('#remove-constraint-btn');
    if (removeFormBtn) {
      removeFormBtn.addEventListener('click', () => {
        onUnlinkConstraint(editingConstraintId, { remove: true });
        editingConstraintId = null;
      });
    }
  }
}

function renderConstraintList(constraints, allPanels) {
  if (constraints.length === 0) {
    return `<div class="empty-state" style="margin-bottom:10px;">No relations on this panel yet.</div>`;
  }
  const byId = new Map((allPanels || []).map((p) => [p.id, p]));
  const nameOf = (id) => (byId.has(id) ? getDisplayName(byId.get(id)) : id);

  return `
    <div class="constraint-list">
      ${constraints.map((c) => `
        <div class="constraint-item ${c.overridden ? 'overridden' : ''} ${c.id === editingConstraintId ? 'editing' : ''}"
             data-constraint-id="${c.id}" title="Click to edit this relation">
          <div class="constraint-desc">
            <strong>${c.field}</strong> ${c.overridden ? '(unlinked)' : ''} —
            ${c.type === 'spansBetween'
              ? `spans ${nameOf(c.from.node)}·${c.from.face} ↔ ${nameOf(c.to.node)}·${c.to.face}`
              : `attached (${c.myFace}) to ${nameOf(c.from.node)}·${c.from.face}`}
          </div>
          <button class="constraint-remove-btn" data-constraint-id="${c.id}" title="Remove this relation">×</button>
        </div>
      `).join('')}
    </div>`;
}

function renderConstraintForm(editingConstraint, otherPanels) {
  const type = editingConstraint ? editingConstraint.type : 'spansBetween';
  return `
    <div class="add-constraint-form">
      ${editingConstraint ? `<div class="editing-hint">Editing this relation — click it again in the list to cancel.</div>` : ''}
      <div class="field-row">
        <label>Relation type</label>
        <select id="new-constraint-type" class="field-input" ${editingConstraint ? 'disabled' : ''}>
          <option value="spansBetween" ${type === 'spansBetween' ? 'selected' : ''}>Spans between two panels (sets a dimension)</option>
          <option value="attachedTo" ${type === 'attachedTo' ? 'selected' : ''}>Attached to one panel (sets a position)</option>
        </select>
      </div>
      <div id="new-constraint-form-body">${renderConstraintFormBody(type, otherPanels, editingConstraint)}</div>
      ${editingConstraint
        ? `<div class="constraint-form-actions">
             <button class="box-preset-btn" id="update-constraint-btn">Update</button>
             <button class="remove-btn" id="remove-constraint-btn">Remove</button>
           </div>`
        : `<button class="box-preset-btn" id="apply-constraint-btn">Apply</button>`}
    </div>`;
}

function renderConstraintFormBody(type, otherPanels, current) {
  const panelOptions = (selectedValue) => otherPanels
    .map((p) => `<option value="${p.id}" ${p.id === selectedValue ? 'selected' : ''}>${getDisplayName(p)}</option>`)
    .join('');
  const faceOptions = (selectedValue) => FACE_NAMES
    .map((f) => `<option value="${f}" ${f === selectedValue ? 'selected' : ''}>${f}</option>`)
    .join('');

  if (type === 'spansBetween') {
    const c = current && current.type === 'spansBetween' ? current : null;
    return `
      <div class="field-row">
        <label>Field this sets</label>
        <select id="cf-field" class="field-input">
          ${DIM_FIELDS.map((f) => `<option value="${f}" ${c?.field === f ? 'selected' : ''}>${f}</option>`).join('')}
        </select>
      </div>
      <div class="relation-ref-pair">
        <div class="relation-ref">
          <span class="relation-ref-label">From</span>
          <select id="cf-from-node" class="field-input">${panelOptions(c?.from.node)}</select>
          <select id="cf-from-face" class="field-input">${faceOptions(c?.from.face)}</select>
          <input type="number" id="cf-from-offset" class="field-input" value="${c?.from.offset ?? 0}" placeholder="offset mm" />
        </div>
        <div class="relation-ref">
          <span class="relation-ref-label">To</span>
          <select id="cf-to-node" class="field-input">${panelOptions(c?.to.node)}</select>
          <select id="cf-to-face" class="field-input">${faceOptions(c?.to.face)}</select>
          <input type="number" id="cf-to-offset" class="field-input" value="${c?.to.offset ?? 0}" placeholder="offset mm" />
        </div>
      </div>`;
  }

  const c = current && current.type === 'attachedTo' ? current : null;
  return `
    <div class="field-row">
      <label>Field this sets</label>
      <select id="cf-field" class="field-input">
        ${POSITION_FIELDS.map((f) => `<option value="${f}" ${c?.field === f ? 'selected' : ''}>${POSITION_LABELS[f]}</option>`).join('')}
      </select>
    </div>
    <div class="field-row">
      <label>My face (touches the target)</label>
      <select id="cf-my-face" class="field-input">${faceOptions(c?.myFace)}</select>
    </div>
    <div class="relation-ref-pair">
      <div class="relation-ref">
        <span class="relation-ref-label">Target</span>
        <select id="cf-from-node" class="field-input">${panelOptions(c?.from.node)}</select>
        <select id="cf-from-face" class="field-input">${faceOptions(c?.from.face)}</select>
        <input type="number" id="cf-from-offset" class="field-input" value="${c?.from.offset ?? 0}" placeholder="offset mm" />
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
