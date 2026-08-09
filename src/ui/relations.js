/**
 * Relations (constraints) panel — left sidebar.
 *
 * Read-only: shows the relations (spansBetween/attachedTo
 * constraints) currently on the selected panel, with a remove (×)
 * button per row. The manual "spans between two panels" / "attached
 * to one panel" creation form that used to live here (a relation-type
 * dropdown, pick-in-3D buttons, Apply/Update) has been removed — the
 * collinear tool (and the shelf tool, built the same way) is now the
 * way to create these relations, by picking faces directly in the
 * 3D/2D view rather than filling out a form. See modeller-main.js's
 * startCollinearMode/addShelf.
 *
 * Removing an EXISTING relation (the × button) is a distinct concern
 * from authoring a new one, so it stays — it calls
 * modeller-main.js's unlinkOrRemoveConstraint the same way the
 * properties panel's own "Unlink" control does.
 */
import { getDisplayName } from '../modeller/modules.js';

export function renderRelations(container, { selectedPanel, allPanels, onUnlinkConstraint }) {
  if (!selectedPanel) {
    container.innerHTML = `
      <div class="section-title">Relations</div>
      <div class="empty-state">No panel selected.</div>`;
    return;
  }

  const constraints = selectedPanel.constraints || [];
  container.innerHTML = `
    <div class="section-title">Relations</div>
    ${renderConstraintList(constraints, allPanels)}
  `;

  container.querySelectorAll('.constraint-remove-btn').forEach((btn) => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      onUnlinkConstraint(btn.dataset.constraintId, { remove: true });
    });
  });
}

function renderConstraintList(constraints, allPanels) {
  if (constraints.length === 0) {
    return `<div class="empty-state">No relations on this panel.</div>`;
  }
  const byId = new Map((allPanels || []).map((p) => [p.id, p]));
  const nameOf = (id) => (byId.has(id) ? getDisplayName(byId.get(id)) : id);

  return `
    <div class="constraint-list">
      ${constraints.map((c) => `
        <div class="constraint-item ${c.overridden ? 'overridden' : ''}" data-constraint-id="${c.id}">
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
