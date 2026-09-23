/**
 * Relations (constraints) panel — left sidebar.
 *
 * Read-only: shows the relations currently attached to the selected
 * panel. Existing relations can be removed with the × button.
 *
 * The creation of relations is handled by the building tools
 * (Collinear / shelves) rather than this panel.
 */

import { getDisplayName } from '../modeller/modules.js';

export function renderRelations(
  container,
  {
    selectedPanel,
    allPanels,
    onUnlinkConstraint,
  } = {}
) {
  // ------------------------------------------------------------
  // IMPORTANT:
  // The toolbar can be collapsed/rebuilt while selection events
  // are still propagating. Never allow a missing mount point to
  // crash the modeller.
  // ------------------------------------------------------------
  if (!container) {
    console.warn(
      '[relations.js] Relations container not found. ' +
      'Expected an element with id="relations-container".'
    );
    return;
  }

  if (!selectedPanel) {
    container.innerHTML = `
      <div class="section-title">Relations</div>
      <div class="empty-state">No panel selected.</div>
    `;
    return;
  }

  const constraints = Array.isArray(selectedPanel.constraints)
    ? selectedPanel.constraints
    : [];

  container.innerHTML = `
    <div class="section-title">Relations</div>
    ${renderConstraintList(constraints, allPanels)}
  `;

  container
    .querySelectorAll('.constraint-remove-btn')
    .forEach((btn) => {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();

        if (typeof onUnlinkConstraint === 'function') {
          onUnlinkConstraint(
            btn.dataset.constraintId,
            { remove: true }
          );
        }
      });
    });
}


/**
 * Render the list of relations belonging to the selected panel.
 */
function renderConstraintList(constraints, allPanels) {
  if (!constraints || constraints.length === 0) {
    return `
      <div class="empty-state">
        No relations on this panel.
      </div>
    `;
  }

  const byId = new Map(
    (allPanels || []).map((p) => [p.id, p])
  );

  const nameOf = (id) => {
    const panel = byId.get(id);
    return panel ? getDisplayName(panel) : id;
  };

  return `
    <div class="constraint-list">
      ${constraints.map((c) => {
        const relationId = escapeHtml(String(c.id ?? ''));
        const field = escapeHtml(String(c.field ?? ''));
        const type = c.type;

        let description = '';

        if (type === 'spansBetween') {
          description = `
            spans
            ${escapeHtml(nameOf(c.from?.node))}
            ·${escapeHtml(c.from?.face ?? '')}
            ↔
            ${escapeHtml(nameOf(c.to?.node))}
            ·${escapeHtml(c.to?.face ?? '')}
          `;
        } else {
          description = `
            attached
            (${escapeHtml(c.myFace ?? '')})
            to
            ${escapeHtml(nameOf(c.from?.node))}
            ·${escapeHtml(c.from?.face ?? '')}
          `;
        }

        return `
          <div
            class="constraint-item ${c.overridden ? 'overridden' : ''}"
            data-constraint-id="${relationId}"
          >
            <div class="constraint-desc">
              <strong>${field}</strong>
              ${c.overridden ? '(unlinked)' : ''}
              —
              ${description}
            </div>

            <button
              type="button"
              class="constraint-remove-btn"
              data-constraint-id="${relationId}"
              title="Remove this relation"
            >×</button>
          </div>
        `;
      }).join('')}
    </div>
  `;
}


/**
 * Small HTML escaping helper.
 */
function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}