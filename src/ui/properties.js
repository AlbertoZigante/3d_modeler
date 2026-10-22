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
import { renderDoorSchema } from './doorSchema.js';
import { renderDrawerSchema } from './drawerSchema.js';
import { DEFAULT_DRAWER_BOX_TOP_MARGIN_MM, DEFAULT_DRAWER_BOX_BOTTOM_MARGIN_MM } from '../features/drawer.js';
import { renderWallSchema } from './wallSchema.js';
import { renderPlinthSchema } from './plinthSchema.js';
import { MIN_PLINTH_HEIGHT_MM, PLINTH_EDGES, normalizePlinthEdgeFit } from '../features/plinth.js';

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
    onDrawerFrontEdgeFitChange,
    onDrawerFrontCountChange,
    drawerHasBox,
    onToggleDrawerOpen,
    onDrawerBoxMarginChange,
    onPlinthHeightChange,
    onPlinthEdgeChange,
    drawerView,
    onDeleteDrawerGroup,
    onDrawerLayoutModeChange,
    onDrawerFrontHeightChange,
    onSelectDrawer,
    onResetDrawerRow,
    onDrawerNotice,
    plinthGroupPanel,
    legGroup,
  }
) {
  if (drawerView) {
    // ONE view for everything about a drawer group — whether the group, one
    // front or one drawer-box panel is selected. A drawer's own width / height
    // / thickness are NOT shown: they are derived from the cabinet panels that
    // define the drawers (see features/drawer.js) and cannot be typed.
    let host = container;
    if (selectedPanel && resolvedPanel) {
      // one drawer panel selected: the same Node section as any other panel, then the drawer data
      container.innerHTML = `${nodeSectionHTML(selectedPanel, resolvedPanel)}<div class="divider"></div><div id="drawer-view-host"></div>`;
      wireNodeSection(container, { selectedPanel, onRename, onFieldChange, onRemove });
      host = container.querySelector('#drawer-view-host');
    }
    renderDrawerView(host, {
      view: drawerView, hiddenGroupMembers, restoreError, onRestoreFace, onGroupMaterialChange,
      onDrawerFrontEdgeFitChange, onDrawerFrontCountChange, onDrawerBoxMarginChange,
      onToggleDrawerOpen, onDrawerLayoutModeChange, onDrawerFrontHeightChange, onDeleteDrawerGroup,
      onSelectDrawer, onResetDrawerRow, onDrawerNotice,
    });
    return;
  }

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
      ${legGroup ? '' : `      <div class="field-row">
        <label>Material (all ${groupMemberCount} panels)</label>
        <select id="group-material-field" class="field-input">
          ${!groupMaterial ? '<option value="" selected disabled>— Mixed materials —</option>' : ''}
          ${MATERIAL_CATALOG.map((m) => `<option value="${escapeHtml(m.name)}" ${m.name === groupMaterial ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}
        </select>
      </div>`}
      ${plinthGroupPanel ? plinthSectionHTML(plinthGroupPanel) : ''}
      ${restoreFaceListHTML(hiddenList, restoreError)}
      <div class="empty-state">Click a member panel — in the list, or in the 3D/2D view — to select and edit it individually.</div>
      ${plinthGroupPanel || legGroup ? '' : `<button class="remove-btn" id="ungroup-btn">Ungroup (keep all ${groupMemberCount} panels)</button>`}
      <button class="remove-btn" id="delete-group-btn">${legGroup ? `Delete legs (${groupMemberCount})` : plinthGroupPanel ? `Delete plinth (${groupMemberCount} panels)` : `Delete whole group (${groupMemberCount} panels)`}</button>
    `;
    wireRestoreFaceButtons(container, onRestoreFace);
    if (plinthGroupPanel) wirePlinthSection(container, plinthGroupPanel, onPlinthHeightChange, onPlinthEdgeChange);
    container.querySelectorAll('[data-drawer-layout]').forEach((btn) => {
      btn.addEventListener('click', () => onDrawerLayoutModeChange?.(btn.dataset.drawerLayout));
    });
  container.querySelectorAll('.drawer-height-field').forEach((input) => {
      const commit = () => {
        const v = parseFloat(input.value);
        if (Number.isFinite(v)) onDrawerFrontHeightChange?.(Number(input.dataset.index), v);
      };
      input.addEventListener('change', commit);
      input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
    });
    container.querySelector('#group-material-field').addEventListener('change', (e) => onGroupMaterialChange(e.target.value));
    container.querySelector('#ungroup-btn')?.addEventListener('click', onUngroup);
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
    ${nodeSectionHTML(selectedPanel, resolvedPanel)}

    ${selectedPanel.edgeFit && !selectedPanel.isDoor && !selectedPanel.isDrawerFront ? edgeFitSectionHTML(selectedPanel.edgeFit) : ''}
    ${selectedPanel.isDoor ? doorSectionHTML(selectedPanel, hiddenGroupMembers || [], restoreError) : ''}
    ${selectedPanel.isPlinthPanel ? plinthSectionHTML(selectedPanel) : ''}
  `;

  wireNodeSection(container, { selectedPanel, onRename, onFieldChange, onRemove });
  container.querySelectorAll('.unlink-btn').forEach((btn) => {
    btn.addEventListener('click', () => onUnlinkConstraint(btn.dataset.field));
  });


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
  container.querySelectorAll('.wall-edge-arrow').forEach((g) => {
    g.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const edge = g.dataset.edge;
      const current = (selectedPanel.edgeFit || {})[edge] === 'out' ? 'out' : 'in';
      onEdgeFitFieldChange(edge, current === 'out' ? 'in' : 'out');
      onEdgeFitChange();
    });
  });

  // ---- door (edge fit + hinge live, via the shared door schema; open/
  // close — only present for a door, see the `selectedPanel.isDoor`
  // check above). Each edge-arrow click commits immediately (edge fit
  // + Apply in the same click, unlike a box wall's batched selects
  // above) since the schema itself is a single click = single change
  // control, not a multi-field form.
  container.querySelectorAll('.door-edge-arrow').forEach((g) => {
    g.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const edge = g.dataset.edge;
      const current = (selectedPanel.edgeFit || {})[edge] === 'out' ? 'out' : 'in';
      onEdgeFitFieldChange(edge, current === 'out' ? 'in' : 'out');
      onEdgeFitChange();
    });
  });
  container.querySelector('.door-hinge-swap')?.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    onDoorHingeChange(selectedPanel.hinge === 'right' ? 'left' : 'right');
  });
  container.querySelector('#toggle-door-open-btn')?.addEventListener('click', () => {
    onToggleDoorOpen();
  });

  // ---- drawer front (edge fit only — count/hinge don't apply here;
  // see the `selectedPanel.isDrawerFront` check above). NOT the
  // generic onEdgeFitFieldChange/onEdgeFitChange the door arrows
  // above use — a drawer stack's N fronts all share one edgeFit, so
  // this goes through its own onDrawerFrontEdgeFitChange, which
  // updates every front in the stack at once (see
  // modeller-main.js#updateSelectedDrawerFrontEdgeFit for why a
  // single-node patch isn't enough here).
  container.querySelectorAll('.drawer-edge-arrow').forEach((g) => {
    g.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const edge = g.dataset.edge;
      const current = (selectedPanel.edgeFit || {})[edge] === 'out' ? 'out' : 'in';
      onDrawerFrontEdgeFitChange(edge, current === 'out' ? 'in' : 'out');
    });
  });
  // 'change' (fires on blur/Enter), not 'input' — same reasoning as
  // the old confirm-phase count field: this rebuilds+re-renders the
  // whole stack/panel, which would otherwise fight an in-progress
  // keystroke.
  container.querySelector('#drawer-front-count-field')?.addEventListener('change', (event) => {
    onDrawerFrontCountChange(event.target.value);
  });

  // ---- drawer box (top/bottom margins + open/close — only present
  // when hasBox, see drawerSectionHTML's own gate).
  container.querySelectorAll('.drawer-margin-field').forEach((input) => {
    input.addEventListener('change', () => {
      onDrawerBoxMarginChange(input.dataset.field, Number(input.value));
    });
  });
  container.querySelector('#toggle-drawer-open-btn')?.addEventListener('click', () => {
    onToggleDrawerOpen();
  });

  // ---- plinth (height — only present for an isPlinthPanel selection,
  // see plinthSectionHTML's own comment on why this is its own field
  // rather than the generic dim-field path).
  wirePlinthSection(container, selectedPanel, onPlinthHeightChange, onPlinthEdgeChange);

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
function edgeFitSectionHTML(edgeFit) {
  return `
    <div class="divider"></div>
    <div class="section-title">Junctions</div>
    <div class="properties-hint">Click an edge's arrow to flip it in (inset) / out (covers the neighboring wall).</div>
    ${renderWallSchema(edgeFit)}
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

// A door's edge fit + hinge both apply live here, one click = one
// change — unlike a box wall's edgeFitSectionHTML (batched Apply,
// above), there's no multi-field form to hold pending state for: the
// schema below (ui/doorSchema.js, shared with the confirm-phase form
// in ui/toolbar.js) IS the whole control, so each click just commits
// immediately via onEdgeFitFieldChange+onEdgeFitChange (edges) or
// onDoorHingeChange (hinge) — see the wiring below.
//
// The hidden-face Restore list is repeated here (see
// restoreFaceListHTML above) right next to the schema: drilling into
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
    <div class="properties-hint">
      Click an edge's arrow to flip it in/out. Click the dotted line to swap the hinge side.
    </div>
    ${renderDoorSchema(door.edgeFit, door.hinge)}
    ${canOpen ? `<button class="add-btn" id="toggle-door-open-btn">${door.doorOpen ? 'Close door' : 'Open door'}</button>` : ''}
    ${restoreFaceListHTML(hiddenGroupMembers, restoreError)}
  `;
}

// Same "edge fit only, applies live" reasoning as doorSectionHTML
// above for the schema; count is its own field (see
// modeller-main.js#updateSelectedDrawerFrontCount — changing it tears
// down and rebuilds the whole stack, unlike edge fit, so it isn't
// something the schema itself can represent as a click).
//
// Below the schema/count: the drawer's own BOX — top/bottom margin
// fields and an Open/Close button, gated on `hasBox` (does this front
// actually have its own left/right/bottom/back panels built right
// now — drawerBoxSpec itself is always present on a front even when
// the box failed to build, see modeller-main.js's own drawerHasBox
// comment, so that alone can't gate this). The two margin inputs use
// their OWN class (drawer-margin-field), deliberately not the generic
// dim-field one wired to onFieldChange below — these live at
// drawerBoxSpec.<field>, not on the panel directly, so writing
// through the generic path would silently set the wrong property.
// Group-level controls for a drawer stack: all fronts the same height, or a
// height typed for each front. Listed top to bottom, the way they look on the
// cabinet; `index` 0 is the BOTTOM front.
// The single drawer view. Order: what the drawers ARE (material, count, fit,
// margins) first, then how tall each front is, then actions.
function renderDrawerView(container, h) {
  const v = h.view;
  const front = v.front;
  const spec = front.drawerBoxSpec || {};
  container.innerHTML = `
    <div class="section-title">Drawer group — ${v.count} drawer${v.count === 1 ? '' : 's'}</div>
    <div class="properties-hint">Sizes follow the panels that define the drawers, so they are not editable here.</div>
    <div class="field-row">
      <label>Material (all ${v.memberCount} panels)</label>
      <select id="group-material-field" class="field-input">
        ${!v.material ? '<option value="" selected disabled>— Mixed materials —</option>' : ''}
        ${MATERIAL_CATALOG.map((m) => `<option value="${escapeHtml(m.name)}" ${m.name === v.material ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}
      </select>
    </div>
    <div class="field-row">
      <label>Number of drawers</label>
      <input type="number" class="field-input" id="drawer-front-count-field" min="1" max="10" step="1" value="${Number(front.drawerCount ?? v.count)}" />
    </div>

    <div class="divider"></div>
    <div class="section-title">Front fit</div>
    <div class="properties-hint">Click an edge's arrow to flip it in/out.</div>
    ${renderDrawerSchema(front.edgeFit, front.drawerCount)}

    ${drawerTableHTML(v)}
    ${restoreFaceListHTML(h.hiddenGroupMembers || [], h.restoreError)}

    <div class="divider"></div>
    <button class="remove-btn" id="delete-drawer-group-btn">Delete drawers (${v.memberCount} panels)</button>
  `;

  wireRestoreFaceButtons(container, h.onRestoreFace);
  container.querySelector('#group-material-field')?.addEventListener('change', (e) => h.onGroupMaterialChange(e.target.value));
  container.querySelector('#drawer-front-count-field')?.addEventListener('change', (e) => h.onDrawerFrontCountChange(e.target.value));
  container.querySelectorAll('.drawer-edge-arrow').forEach((g) => {
    g.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      const edge = g.dataset.edge;
      const current = (front.edgeFit || {})[edge] === 'out' ? 'out' : 'in';
      h.onDrawerFrontEdgeFitChange(edge, current === 'out' ? 'in' : 'out');
    });
  });
  container.querySelectorAll('.drawer-margin-field').forEach((input) => {
    input.addEventListener('change', () => {
      const val = parseFloat(input.value);
      if (!Number.isFinite(val)) return;
      h.onDrawerBoxMarginChange(input.dataset.field, val, input.dataset.frontId || undefined);
    });
  });
  container.querySelectorAll('.drawer-open-btn').forEach((btn) => {
    btn.addEventListener('click', () => h.onToggleDrawerOpen(btn.dataset.frontId || undefined));
  });
  container.querySelectorAll('[data-drawer-layout]').forEach((btn) => {
    btn.addEventListener('click', () => h.onDrawerLayoutModeChange?.(btn.dataset.drawerLayout));
  });
  container.querySelectorAll('.drawer-reset-btn').forEach((btn) => {
    btn.addEventListener('click', () => h.onResetDrawerRow?.(btn.dataset.frontId || undefined));
  });
  container.querySelectorAll('.drawer-row-select').forEach((cell) => {
    cell.addEventListener('click', () => h.onSelectDrawer?.(cell.dataset.frontId));
  });
  // a height that is not free (the one left over, or every height in Apply All): explain
  container.querySelectorAll('.drawer-height-field[readonly]').forEach((input) => {
    const notice = () => h.onDrawerNotice?.(input.dataset.reason);
    input.addEventListener('focus', notice);
    input.addEventListener('click', notice);
  });
  container.querySelectorAll('.drawer-height-field:not([readonly])').forEach((input) => {
    const commit = () => {
      const val = parseFloat(input.value);
      if (Number.isFinite(val)) h.onDrawerFrontHeightChange?.(Number(input.dataset.index), val);
    };
    input.addEventListener('change', commit);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); commit(); } });
  });
  container.querySelector('#delete-drawer-group-btn')?.addEventListener('click', () => h.onDeleteDrawerGroup?.());
}

// Drawer table, two modes (v.mode):
//  - "Apply All" ('equal'): ONE row — equally spaced drawers, one top/bottom
//    margin for all of them, one Open/Close for the whole stack.
//  - "Custom": one row per drawer (1 = top). Any N-1 front heights can be set;
//    the one left over is greyed out and shows the resulting height (when
//    only some are set, the unset ones share the rest and are marked "auto").
function drawerTableHTML(v) {
  const custom = v.mode === 'custom' && v.count > 1;
  const rows = [...v.fronts].reverse(); // top -> bottom
  const boxed = rows.filter((f) => f.hasBox);
  const commonBox = (key) => (boxed.length && boxed.every((f) => f[key] === boxed[0][key]) ? boxed[0][key] : '');
  const allOpen = boxed.length > 0 && boxed.every((f) => f.open);
  const fixedCount = v.fronts.filter((f) => f.fixed).length;
  const lastFree = v.fronts.length - fixedCount === 1; // the single unfixed front is the automatic one
  const round1 = (x) => Math.round(x * 10) / 10;
  const allDirty = boxed.some((f) => f.topMarginMm !== DEFAULT_DRAWER_BOX_TOP_MARGIN_MM || f.bottomMarginMm !== DEFAULT_DRAWER_BOX_BOTTOM_MARGIN_MM);

  const marginCell = (field, f) => {
    if (f ? !f.hasBox : boxed.length === 0) return '<span class="dt-na">—</span>';
    const value = f ? f[field] : commonBox(field);
    const floor = field === 'topMarginMm' ? DEFAULT_DRAWER_BOX_TOP_MARGIN_MM : DEFAULT_DRAWER_BOX_BOTTOM_MARGIN_MM;
    return `<input type="number" class="dt-input drawer-margin-field" data-field="${field}" ${f ? `data-front-id="${f.id}"` : ''} min="${floor}" step="1" value="${value}" placeholder="mixed" />`;
  };
  const openCell = (f) => {
    if (f ? !f.hasBox : boxed.length === 0) return '<span class="dt-na">—</span>';
    const open = f ? f.open : allOpen;
    return `<button class="dt-btn drawer-open-btn ${open ? 'is-open' : ''}" ${f ? `data-front-id="${f.id}"` : ''} title="${open ? 'Close' : 'Open'}">${open ? 'Close' : 'Open'}</button>`;
  };

  const modeBar = v.count > 1 ? `
    <div class="dt-mode">
      <button class="dt-seg ${custom ? '' : 'is-active'}" data-drawer-layout="equal" title="Equally spaced drawers, one top/bottom margin for all">Apply All</button>
      <button class="dt-seg ${custom ? 'is-active' : ''}" data-drawer-layout="custom" title="Set each drawer on its own">Custom</button>
    </div>` : '';

  const applyAllRow = `
      <tr class="dt-all">
        <td class="dt-name">All</td>
        <td><input type="number" class="dt-input drawer-height-field" data-index="0" value="${round1(rows[0].heightMm)}" readonly data-reason="Apply All: every drawer has the same height. Switch to Custom to set heights one by one." /></td>
        <td>${marginCell('topMarginMm', null)}</td>
        <td>${marginCell('bottomMarginMm', null)}</td>
        <td>${openCell(null)}</td>
        <td class="dt-reset-col"><button class="dt-reset drawer-reset-btn" ${allDirty ? '' : 'disabled'} title="${allDirty ? 'Reset the top/bottom margin of every drawer to the default' : 'Already at default'}">↺</button></td>
      </tr>`;

  const customRows = rows.map((f, k) => {
    const auto = v.count > 1 && !f.fixed && lastFree;       // greyed: just shows the result
    const shared = v.count > 1 && !f.fixed && fixedCount > 0; // not set by the user
    const dirty = f.fixed || (f.hasBox && (f.topMarginMm !== DEFAULT_DRAWER_BOX_TOP_MARGIN_MM || f.bottomMarginMm !== DEFAULT_DRAWER_BOX_BOTTOM_MARGIN_MM));
    return `
      <tr class="${f.id === v.selectedFrontId ? 'dt-selected' : ''}" data-front-id="${f.id}">
        <td class="dt-name drawer-row-select" data-front-id="${f.id}" title="Select drawer ${k + 1}">${k + 1}</td>
        <td class="${auto ? 'dt-auto-cell' : ''}"><input type="number" class="dt-input drawer-height-field" data-index="${f.index}" min="10" step="1" value="${round1(f.heightMm)}" ${v.count > 1 && !auto ? '' : `readonly data-reason="${v.count > 1 ? 'This height is set by the other drawers: it is what they leave, so the stack always fills the opening. Change another drawer\'s height instead.' : 'A single drawer fills the whole opening. Add more drawers to set different heights.'}"`} />${shared ? '<span class="dt-auto">auto</span>' : ''}</td>
        <td>${marginCell('topMarginMm', f)}</td>
        <td>${marginCell('bottomMarginMm', f)}</td>
        <td>${openCell(f)}</td>
        <td class="dt-reset-col"><button class="dt-reset drawer-reset-btn" data-front-id="${f.id}" ${dirty ? '' : 'disabled'} title="${dirty ? 'Reset this drawer: default margins, height shared equally with the free drawers' : 'Already at default'}">↺</button></td>
      </tr>`;
  }).join('');

  return `
    <div class="divider"></div>
    <div class="section-title">Drawers <span class="dt-unit">(mm)</span></div>
    ${modeBar}
    <table class="drawer-table">
      <thead><tr><th>Drawer</th><th>Height</th><th>Top margin</th><th>Bottom margin</th><th>Open</th><th class="dt-reset-col"></th></tr></thead>
      <tbody>${custom || v.count === 1 ? customRows : applyAllRow}</tbody>
    </table>
    ${v.fronts.some((f) => !f.hasBox) ? '<div class="properties-hint">— : no box built for that drawer yet.</div>' : ''}
  `;
}

function drawerSectionHTML(front, hiddenGroupMembers, restoreError, hasBox) {
  const spec = front.drawerBoxSpec || {};
  return `
    <div class="divider"></div>
    <div class="section-title">Drawer</div>
    <div class="properties-hint">
      Click an edge's arrow to flip it in/out.
    </div>
    ${renderDrawerSchema(front.edgeFit, front.drawerCount)}
    <div class="field-row">
      <label>Number of drawers</label>
      <input type="number" class="field-input" id="drawer-front-count-field" min="1" max="10" step="1" value="${Number(front.drawerCount ?? 1)}" />
    </div>
    ${hasBox ? `
      <div class="divider"></div>
      <div class="section-title">Drawer box</div>
      ${numberFieldHTML('Top margin', 'topMarginMm', spec.topMarginMm ?? DEFAULT_DRAWER_BOX_TOP_MARGIN_MM, 'mm', { min: DEFAULT_DRAWER_BOX_TOP_MARGIN_MM }, 'drawer-margin-field')}
      ${numberFieldHTML('Bottom margin', 'bottomMarginMm', spec.bottomMarginMm ?? DEFAULT_DRAWER_BOX_BOTTOM_MARGIN_MM, 'mm', { min: DEFAULT_DRAWER_BOX_BOTTOM_MARGIN_MM }, 'drawer-margin-field')}
      <button class="add-btn" id="toggle-drawer-open-btn">${front.drawerOpen ? 'Close drawer' : 'Open drawer'}</button>
    ` : `
      <div class="empty-state">This drawer has no box built yet — nothing here to adjust or open.</div>
    `}
    ${restoreFaceListHTML(hiddenGroupMembers, restoreError)}
  `;
}

// Shown for ANY of the 4 plinth panels — all 4 share one height, so
// this field edits whichever one happens to be selected but applies to
// the whole plinth (modeller-main.js#updateSelectedPlinthHeight finds
// the rest by groupId+isPlinthPanel, see features/plinth.js#
// applyPlinthAdjustment). Deliberately NOT the generic dim-field path:
// same reasoning as drawerSectionHTML's own margin fields just above —
// editing one panel's own height directly would desync it from its 3
// siblings, since nothing here re-derives the other 3 to match. (This
// is the same gap drawer box panels already have for their own W/H/T —
// see features/drawer.js#createDrawerBoxNodes's own header on
// lockedMoveAxes; there's no lockedFields-for-dimensions mechanism in
// this codebase yet, only for position, so it isn't solved here either
// — the dedicated field below is the intended way in, same as the
// drawer box margins, not a true lock against the generic one.)
function wireNodeSection(container, { selectedPanel, onRename, onFieldChange, onRemove }) {
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

  container.querySelector('#material-field')?.addEventListener('change', (e) => {
    onFieldChange('material', e.target.value);
  });
  container.querySelector('#remove-btn')?.addEventListener('click', onRemove);
}

function nodeSectionHTML(selectedPanel, resolvedPanel) {
  const displayName = getDisplayName(selectedPanel);
  return `
    <div class="node-header-row">
      <span class="section-title" id="node-name-label">Node: ${escapeHtml(displayName)}${selectedPanel.pieceCode ? ` <span class="node-id-inline">${escapeHtml(selectedPanel.pieceCode)}</span>` : ''}</span>
      <button class="rename-btn" id="rename-node-btn" title="Rename this panel">✏️</button>
    </div>

    ${selectedPanel.groupId ? `<div class="group-member-note">Part of a group — Remove here deletes just this panel</div>` : ''}

    ${resolvedPanel.warnings && resolvedPanel.warnings.length > 0 ? `
      <div class="warning-banner">
        ${resolvedPanel.warnings.map((w) => `⚠ ${escapeHtml(w)}`).join('<br/>')}
      </div>` : ''}

    <div class="dims-row dims-row-compact">
      ${[['W', 'Width', resolvedPanel.width, 'Resize it in the 2D/3D view'], ['H', 'Height', resolvedPanel.height, 'Resize it in the 2D/3D view'], ['T', 'Thickness', resolvedPanel.thickness, 'Set by Material, below']].map(([short, full, value, hint]) => `
      <div class="field-row">
        <label title="${full}">${short} 🔒</label>
        <div class="field-input-wrap locked">
          <input type="text" value="${Number(value).toFixed(1)}" disabled class="field-input" title="${hint} — not directly editable" />
        </div>
      </div>`).join('')}
    </div>
    <div class="field-row">
      <label>Material</label>
      <select id="material-field" class="field-input">
        ${MATERIAL_CATALOG.map((m) => `<option value="${escapeHtml(m.name)}" ${m.name === selectedPanel.material ? 'selected' : ''}>${escapeHtml(m.name)}</option>`).join('')}
      </select>
    </div>
    <button class="remove-btn" id="remove-btn">Remove panel</button>
  `;
}

// Height field + edge arrows/offsets of the plinth section — shared by the
// single-panel view and the whole-plinth (group) view.
function wirePlinthSection(container, panel, onPlinthHeightChange, onPlinthEdgeChange) {
  container.querySelector('.plinth-height-field')?.addEventListener('change', (event) => {
    onPlinthHeightChange(Number(event.target.value));
  });
  container.querySelectorAll('.plinth-edge-arrow').forEach((g) => {
    g.addEventListener('click', () => {
      const edge = g.dataset.edge;
      const current = normalizePlinthEdgeFit(panel.plinthEdgeFit)[edge].fit;
      onPlinthEdgeChange(edge, { fit: current === 'in' ? 'out' : 'in' });
    });
  });
  container.querySelectorAll('.plinth-edge-inset').forEach((input) => {
    input.addEventListener('change', () => {
      onPlinthEdgeChange(input.dataset.edge, { insetMm: Number(input.value) });
    });
  });
}

function plinthSectionHTML(panel) {
  return `
    <div class="divider"></div>
    <div class="section-title">Plinth</div>
    ${numberFieldHTML('Height', 'heightMm', panel.height, 'mm', { min: MIN_PLINTH_HEIGHT_MM }, 'plinth-height-field')}
    <div class="section-title" title="Out = flush with the box's Bottom panel edge. In = set back by the given mm.">Edges</div>
    <div class="properties-hint">Click an edge's arrow to flip it in/out. Set the offset (mm, &gt; 0) next to each 'in' edge.</div>
    ${renderPlinthSchema(normalizePlinthEdgeFit(panel.plinthEdgeFit))}
  `;
}

function dimFieldHTML(field, selectedPanel, resolvedPanel, isLocked, isStructuralLock = false, compact = false) {
  const fullLabel = field[0].toUpperCase() + field.slice(1);
  // Compact mode (the W/H/T single-line row): a single-letter label
  // with the full word as a tooltip, and no inline "mm" unit (the row
  // has one unit for all three, implied rather than repeated) — the
  // same three visual states (plain / 🔗 unlink / 🔒 structural) as
  // the full-width version, just tighter.
  const label = compact ? `<span title="${fullLabel}">${fullLabel[0]}</span>` : fullLabel;
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
          ${compact ? '' : '<span class="field-unit">mm</span>'}
        </div>
      </div>`;
  }
  if (isLocked) {
    return `
      <div class="field-row">
        <label>${label} 🔗</label>
        <div class="field-input-wrap locked">
          <input type="text" value="${resolvedPanel[field].toFixed(1)}" disabled class="field-input" />
          ${compact ? '' : '<span class="field-unit">mm</span>'}
        </div>
        <button class="unlink-btn" data-field="${field}">Unlink</button>
      </div>`;
  }
  return numberFieldHTML(label, field, selectedPanel[field], compact ? '' : 'mm', { min: 1 }, 'dim-field');
}

function numberFieldHTML(label, field, value, unit = 'mm', { min } = {}, extraClass = 'dim-field') {
  return `
    <div class="field-row">
      <label>${label}</label>
      <div class="field-input-wrap">
        <input type="number" ${min != null ? `min="${min}"` : ''} value="${value}" data-field="${field}" class="field-input ${extraClass}" />
        ${unit ? `<span class="field-unit">${unit}</span>` : ''}
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
