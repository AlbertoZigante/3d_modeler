/**
 * Design Warnings panel — right inspector, below Relations.
 *
 * Read-only, whole-design (not per-selection, unlike Properties and
 * Relations above it): every currently-open violation from
 * engine/validator.js#validateDesign, refreshed every render. See
 * modeller-main.js#checkJointWarnings, which computes the violations
 * this panel displays and also toasts once on a violation's first
 * appearance — this panel is the persistent counterpart to that
 * transient toast, so a collision or an oversized panel stays visible
 * for as long as it's actually still unresolved, not just for the
 * ~2 seconds the toast is on screen.
 *
 * Same "never let a missing mount point crash the modeller" contract
 * as relations.js.
 */

export function renderWarnings(container, { violations } = {}) {
  if (!container) {
    console.warn(
      '[warnings.js] Design warnings container not found. ' +
      'Expected an element with id="design-warnings-container".'
    );
    return;
  }

  const list = Array.isArray(violations) ? violations : [];

  container.innerHTML = `
    <div class="section-title">Design Warnings</div>
    ${renderViolationList(list)}
  `;
}

function renderViolationList(violations) {
  if (violations.length === 0) {
    return `
      <div class="empty-state">
        No design issues detected.
      </div>
    `;
  }

  return `
    <div class="warning-list">
      ${violations.map((v) => `
        <div class="warning-item" data-violation-type="${escapeHtml(v.type)}">
          <div class="warning-desc">
            ${escapeHtml(v.message)}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

/**
 * Small HTML escaping helper — same implementation as relations.js's
 * own, duplicated rather than shared since it's a 4-line DOM-based
 * utility, not worth a new shared/ file for two call sites.
 */
function escapeHtml(value) {
  const div = document.createElement('div');
  div.textContent = value ?? '';
  return div.innerHTML;
}
