/**
 * Relations (constraints) panel — left sidebar.
 *
 * Click an existing relation in the list to load it into the form
 * below for editing (the form's fields pre-fill with that relation's
 * current values). While editing, the submit area shows "Update" +
 * "Remove" instead of "Apply". Clicking the same relation again — or
 * successfully updating/removing it — returns the form to "create
 * new" mode.
 *
 * SPANS-BETWEEN NO LONGER ASKS "WHICH FIELD": panels are mostly a 2D
 * shape (thickness is a small, fixed board value — not something
 * you'd span between two other panels), so which of width/height/
 * thickness gets set is inferred from the chosen From/To faces
 * themselves (see snap.js's inferSpanField). The field dropdown only
 * remains for "attached to" relations, since positionX/Y/Z aren't a
 * dimension choice the geometry can infer the same way.
 *
 * VALIDATION BEFORE COMMIT: onAddConstraint/onUpdateConstraint return
 * { ok: true } or { ok: false, error }. On failure, the error is shown
 * inline and the form is left exactly as the user had it — nothing is
 * ever created that the resolver would immediately flag as broken.
 *
 * `editingConstraintId` is local module state, not threaded through
 * main.js: it only matters to this form's own rendering.
 */
import { LOCAL_FACES, getDisplayName } from '../modeller/modules.js';

const FACE_NAMES = Object.keys(LOCAL_FACES);
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

  if (selectedPanel.id !== lastSelectedPanelId) {
    editingConstraintId = null;
    lastSelectedPanelId = selectedPanel.id;
  }

  const otherPanels = (allPanels || []).filter((p) => p.id !== selectedPanel.id);
  const constraints = selectedPanel.constraints || [];
  const editingConstraint = constraints.find((c) => c.id === editingConstraintId) || null;

  const rerender = () =>
    renderRelations(container, { selectedPanel, allPanels, onAddConstraint, onUpdateConstraint, onUnlinkConstraint });

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
      if (e.target.closest('.constraint-remove-btn')) return;
      const id = item.dataset.constraintId;
      editingConstraintId = editingConstraintId === id ? null : id;
      rerender();
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
  const errorEl = container.querySelector('#constraint-form-error');

  function showError(message) {
    if (errorEl) errorEl.textContent = '⚠ ' + message;
  }

  if (typeSelect) {
    typeSelect.addEventListener('change', () => {
      formBody.innerHTML = renderConstraintFormBody(typeSelect.value, otherPanels, null);
      if (errorEl) errorEl.textContent = '';
    });

    const applyBtn = container.querySelector('#apply-constraint-btn');
    if (applyBtn) {
      applyBtn.addEventListener('click', () => {
        const draft = readConstraintForm(container, typeSelect.value);
        if (!draft) return;
        const result = onAddConstraint(draft);
        if (result && result.ok === false) {
          showError(result.error);
        } else {
          rerender();
        }
      });
    }

    const updateBtn = container.querySelector('#update-constraint-btn');
    if (updateBtn) {
      updateBtn.addEventListener('click', () => {
        const draft = readConstraintForm(container, typeSelect.value);
        if (!draft) return;
        const result = onUpdateConstraint(editingConstraintId, draft);
        if (result && result.ok === false) {
          showError(result.error);
        } else {
          rerender();
        }
      });
    }

    const removeFormBtn = container.querySelector('#remove-constraint-btn');
    if (removeFormBtn) {
      removeFormBtn.addEventListener('click', () => {
        onUnlinkConstraint(editingConstraintId, { remove: true });
        editingConstraintId = null;
        rerender();
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
          <option value="spansBetween" ${type === 'spansBetween' ? 'selected' : ''}>Spans between two panels</option>
          <option value="attachedTo" ${type === 'attachedTo' ? 'selected' : ''}>Attached to one panel (sets a position)</option>
        </select>
      </div>
      <div id="new-constraint-form-body">${renderConstraintFormBody(type, otherPanels, editingConstraint)}</div>
      <div id="constraint-form-error" class="constraint-form-error"></div>
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
    // No "field this sets" dropdown here on purpose — see file header.
    return `
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
  const fromNode = container.querySelector('#cf-from-node')?.value;
  const fromFace = container.querySelector('#cf-from-face')?.value;
  const fromOffset = Number(container.querySelector('#cf-from-offset')?.value || 0);
  if (!fromNode || !fromFace) return null;

  if (type === 'spansBetween') {
    const toNode = container.querySelector('#cf-to-node')?.value;
    const toFace = container.querySelector('#cf-to-face')?.value;
    const toOffset = Number(container.querySelector('#cf-to-offset')?.value || 0);
    if (!toNode || !toFace) return null;
    // no `field` — main.js infers it from the faces above
    return {
      type: 'spansBetween',
      from: { node: fromNode, face: fromFace, offset: fromOffset },
      to: { node: toNode, face: toFace, offset: toOffset },
    };
  }

  const field = container.querySelector('#cf-field')?.value;
  const myFace = container.querySelector('#cf-my-face')?.value;
  if (!field || !myFace) return null;
  return {
    field, type: 'attachedTo', myFace,
    from: { node: fromNode, face: fromFace, offset: fromOffset },
  };
}
