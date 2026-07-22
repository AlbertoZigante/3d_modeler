/**
 * Relations (constraints) panel — left sidebar.
 *
 * ITEM 11 — spansBetween's "From"/"To" are picked directly in the 3D
 * view instead of dropdowns: clicking "Pick face" puts scene.js into
 * a one-click picking mode (see modeller-main.js's onFacePick), and
 * the picked face is colored green (From) or red (To) right on the
 * mesh — see scene.js's reconcile(). `facePicks` (passed in as a
 * prop, owned by main.js) holds the current picks; this file only
 * renders what they say and asks main.js to start/clear a pick.
 * attachedTo's Target still uses dropdowns — that relation type
 * wasn't part of this request, and dropdowns remain a perfectly
 * reasonable way to pick a single reference.
 *
 * Click an existing relation in the list to load it into the form
 * below for editing. While editing, the submit area shows "Update" +
 * "Remove" instead of "Apply". Loading a spansBetween relation for
 * editing also pre-fills facePicks with its current From/To (via
 * onLoadPicksForEdit), so the 3D view immediately shows what's
 * already set — pick again on either side to change just that one.
 *
 * VALIDATION BEFORE COMMIT: onAddConstraint/onUpdateConstraint return
 * { ok: true } or { ok: false, error }. On failure, the error is shown
 * inline and the form is left exactly as the user had it.
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
  {
    selectedPanel,
    allPanels,
    facePicks,
    onStartPicking,
    onClearPick,
    onLoadPicksForEdit,
    onAddConstraint,
    onUpdateConstraint,
    onUnlinkConstraint,
  }
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

  const rerenderProps = {
    selectedPanel, allPanels, facePicks, onStartPicking, onClearPick,
    onLoadPicksForEdit, onAddConstraint, onUpdateConstraint, onUnlinkConstraint,
  };
  const rerender = () => renderRelations(container, rerenderProps);

  container.innerHTML = `
    <div class="section-title">Relations</div>
    ${renderConstraintList(constraints, allPanels)}
    ${otherPanels.length === 0
      ? `<div class="empty-state">Add another panel first to create a relation.</div>`
      : renderConstraintForm(editingConstraint, otherPanels, facePicks)}
  `;

  // ---- click a relation row to load it into the form ----
  container.querySelectorAll('.constraint-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      if (e.target.closest('.constraint-remove-btn')) return;
      const id = item.dataset.constraintId;
      const wasEditing = editingConstraintId === id;
      editingConstraintId = wasEditing ? null : id;
      if (!wasEditing) {
        const c = constraints.find((cc) => cc.id === id);
        if (c && c.type === 'spansBetween') {
          onLoadPicksForEdit(c.from, c.to);
        } else {
          onLoadPicksForEdit(null, null);
        }
      } else {
        onLoadPicksForEdit(null, null);
      }
      rerender();
    });
  });

  container.querySelectorAll('.constraint-remove-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (btn.dataset.constraintId === editingConstraintId) {
        editingConstraintId = null;
        onLoadPicksForEdit(null, null);
      }
      onUnlinkConstraint(btn.dataset.constraintId, { remove: true });
    });
  });

  // ---- pick-in-3D buttons (spansBetween only) ----
  const pickFromBtn = container.querySelector('#pick-from-btn');
  if (pickFromBtn) pickFromBtn.addEventListener('click', () => onStartPicking('from'));
  const pickToBtn = container.querySelector('#pick-to-btn');
  if (pickToBtn) pickToBtn.addEventListener('click', () => onStartPicking('to'));
  const clearFromBtn = container.querySelector('#clear-from-btn');
  if (clearFromBtn) clearFromBtn.addEventListener('click', () => { onClearPick('from'); rerender(); });
  const clearToBtn = container.querySelector('#clear-to-btn');
  if (clearToBtn) clearToBtn.addEventListener('click', () => { onClearPick('to'); rerender(); });

  // ---- the create/edit form ----
  const typeSelect = container.querySelector('#new-constraint-type');
  const formBody = container.querySelector('#new-constraint-form-body');
  const errorEl = container.querySelector('#constraint-form-error');

  function showError(message) {
    if (errorEl) errorEl.textContent = '⚠ ' + message;
  }

  if (typeSelect) {
    typeSelect.addEventListener('change', () => {
      formBody.innerHTML = renderConstraintFormBody(typeSelect.value, otherPanels, null, facePicks);
      if (errorEl) errorEl.textContent = '';
    });

    const applyBtn = container.querySelector('#apply-constraint-btn');
    if (applyBtn) {
      applyBtn.addEventListener('click', () => {
        const draft = readConstraintForm(container, typeSelect.value, facePicks);
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
        const draft = readConstraintForm(container, typeSelect.value, facePicks);
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
        onLoadPicksForEdit(null, null);
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

function renderConstraintForm(editingConstraint, otherPanels, facePicks) {
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
      <div id="new-constraint-form-body">${renderConstraintFormBody(type, otherPanels, editingConstraint, facePicks)}</div>
      <div id="constraint-form-error" class="constraint-form-error"></div>
      ${editingConstraint
        ? `<div class="constraint-form-actions">
             <button class="box-preset-btn" id="update-constraint-btn">Update</button>
             <button class="remove-btn" id="remove-constraint-btn">Remove</button>
           </div>`
        : `<button class="box-preset-btn" id="apply-constraint-btn">Apply</button>`}
    </div>`;
}

function pickerRowHTML(label, which, pick, allPanels) {
  const nameOf = (id) => {
    const p = (allPanels || []).find((pp) => pp.id === id);
    return p ? getDisplayName(p) : id;
  };
  const swatchClass = which === 'from' ? 'pick-swatch-green' : 'pick-swatch-red';
  return `
    <div class="relation-ref">
      <span class="relation-ref-label">${label}</span>
      ${pick
        ? `<div class="pick-result">
             <span class="pick-swatch ${swatchClass}"></span>
             <span class="pick-result-text">${nameOf(pick.node)} · ${pick.face}</span>
             <button type="button" class="pick-clear-btn" id="clear-${which}-btn" title="Clear">×</button>
           </div>`
        : `<button type="button" class="pick-face-btn" id="pick-${which}-btn">
             <span class="pick-swatch ${swatchClass}"></span> Click to pick face in 3D view
           </button>`}
      <input type="number" id="cf-${which}-offset" class="field-input" value="${pick?.offset ?? 0}" placeholder="offset mm" />
    </div>`;
}

function renderConstraintFormBody(type, otherPanels, current, facePicks) {
  const panelOptions = (selectedValue) => otherPanels
    .map((p) => `<option value="${p.id}" ${p.id === selectedValue ? 'selected' : ''}>${getDisplayName(p)}</option>`)
    .join('');
  const faceOptions = (selectedValue) => FACE_NAMES
    .map((f) => `<option value="${f}" ${f === selectedValue ? 'selected' : ''}>${f}</option>`)
    .join('');

  if (type === 'spansBetween') {
    // From/To picked directly in the 3D view (item 11) — no
    // node/face dropdowns here. Offset stays a plain number input,
    // since "how far outward" isn't something you'd click in 3D.
    const fromPick = facePicks?.from ? { ...facePicks.from, offset: current?.from.offset ?? facePicks.from.offset } : (current?.type === 'spansBetween' ? current.from : null);
    const toPick = facePicks?.to ? { ...facePicks.to, offset: current?.to.offset ?? facePicks.to.offset } : (current?.type === 'spansBetween' ? current.to : null);
    return `
      <div class="relation-ref-pair">
        ${pickerRowHTML('From', 'from', fromPick, otherPanels)}
        ${pickerRowHTML('To', 'to', toPick, otherPanels)}
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

function readConstraintForm(container, type, facePicks) {
  if (type === 'spansBetween') {
    if (!facePicks?.from || !facePicks?.to) return null; // Apply/Update guards on this via onAddConstraint's own check too
    const fromOffset = Number(container.querySelector('#cf-from-offset')?.value || 0);
    const toOffset = Number(container.querySelector('#cf-to-offset')?.value || 0);
    return {
      type: 'spansBetween',
      from: { node: facePicks.from.node, face: facePicks.from.face, offset: fromOffset },
      to: { node: facePicks.to.node, face: facePicks.to.face, offset: toOffset },
    };
  }

  const fromNode = container.querySelector('#cf-from-node')?.value;
  const fromFace = container.querySelector('#cf-from-face')?.value;
  const fromOffset = Number(container.querySelector('#cf-from-offset')?.value || 0);
  const field = container.querySelector('#cf-field')?.value;
  const myFace = container.querySelector('#cf-my-face')?.value;
  if (!fromNode || !fromFace || !field || !myFace) return null;
  return {
    field, type: 'attachedTo', myFace,
    from: { node: fromNode, face: fromFace, offset: fromOffset },
  };
}
