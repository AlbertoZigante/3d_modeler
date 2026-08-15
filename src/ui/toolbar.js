/**
 * Left toolbar / elements / building components / building tools /
 * properties.
 *
 * Structure:
 *
 *   Elements
 *      Groups
 *      Panels
 *
 *   Building Components
 *      + Vertical panel
 *      + Horizontal panel
 *      + Parallel panel
 *      + Box
 *      + Horizontal shelf
 *      + Vertical shelf
 *
 *   Building Tools
 *      Collinear
 *
 *   Properties (conditional)
 *      Only rendered while a Building Tool is active — shows
 *      whatever that tool needs live (e.g. Collinear's gap). Vanishes
 *      entirely (not just hidden) when no tool is active, so the
 *      layout collapses back to just the three sections above.
 *
 * The old "Relations" section that used to live here has been
 * removed — it was never actually wired with real data (modeller-
 * main.js's renderPanelList() call never passes selectedPanel/
 * allPanels/onUnlinkConstraint), so it always showed "No panel
 * selected." The real, functioning relations panel lives on the
 * right side via ui/relations.js's renderRelations(), unaffected by
 * this file.
 *
 * Important:
 *
 *   Clicking a group row ONLY selects the group.
 *   Clicking the dropdown arrow is the ONLY action that opens/closes
 *   the group's members.
 *
 * Section sizes are stored on the toolbar root so that rebuilding
 * the toolbar does not reset manually resized sections.
 */

import { getDisplayName } from '../modeller/modules.js';


/* ============================================================
   CONSTANTS
   ============================================================ */

const SECTION_MIN_HEIGHT = 58;
const PROPERTIES_MIN_HEIGHT = 76;
const PROPERTIES_BOTTOM_MARGIN = 12;


/* ============================================================
   BUILDING COMPONENT / TOOL ICONS
   ============================================================ */

// Minimal stroke-based icons — deliberately abstract/geometric rather
// than literal renders, so they read at a glance without needing
// color or shading.
const COMPONENT_ICONS = {
  vertical: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <rect x="10" y="4" width="4" height="16" />
      <line x1="3" y1="12" x2="8" y2="12" stroke-dasharray="1.5 2" />
      <line x1="16" y1="12" x2="21" y2="12" stroke-dasharray="1.5 2" />
    </svg>
  `,
  horizontal: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <rect x="4" y="10" width="16" height="4" />
      <line x1="12" y1="3" x2="12" y2="8" stroke-dasharray="1.5 2" />
      <line x1="12" y1="16" x2="12" y2="21" stroke-dasharray="1.5 2" />
    </svg>
  `,
  parallel: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <rect x="4" y="4" width="16" height="16" />
      <line x1="4" y1="9" x2="20" y2="9" opacity="0.35" />
      <line x1="4" y1="14" x2="20" y2="14" opacity="0.35" />
    </svg>
  `,
  box: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 3 L20 7 L20 17 L12 21 L4 17 L4 7 Z" />
      <path d="M4 7 L12 11 L20 7" />
      <line x1="12" y1="11" x2="12" y2="21" />
    </svg>
  `,
  shelfH: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <rect x="4" y="4" width="16" height="16" />
      <line x1="4" y1="12" x2="20" y2="12" />
    </svg>
  `,
  shelfV: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <rect x="4" y="4" width="16" height="16" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </svg>
  `,
  // Two picked panel edges (the bars) being pulled into alignment
  // along a shared line (the double-headed arrow) — echoes what the
  // collinear tool actually does: pick a face, pick a parallel face,
  // make them line up.
  collinear: `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">
      <rect x="3" y="5" width="4" height="14" />
      <rect x="17" y="5" width="4" height="14" />
      <line x1="9.5" y1="12" x2="14.5" y2="12" />
      <path d="M11 9.2 L8.8 12 L11 14.8" />
      <path d="M13 9.2 L15.2 12 L13 14.8" />
    </svg>
  `,
};

// Injected once into <head> rather than into container.innerHTML —
// renderPanelList rebuilds that markup often (every select/drag/
// render), and a <style> tag doesn't need to be part of that churn.
let iconStylesInjected = false;
function ensureComponentIconStyles() {
  if (iconStylesInjected) return;
  iconStylesInjected = true;
  const style = document.createElement('style');
  style.textContent = `
    .component-icon-grid {
      display: grid;
      grid-template-columns: repeat(4, 1fr);
      gap: 8px;
    }
    .component-icon-btn {
      aspect-ratio: 1 / 1;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 4px;
      border: 1px solid var(--toolbar-border, #d8d0c4);
      border-radius: 8px;
      background: var(--toolbar-btn-bg, #fff);
      color: var(--toolbar-btn-fg, #4a4238);
      cursor: pointer;
      padding: 4px;
      transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
    }
    .component-icon-btn:hover {
      background: var(--toolbar-btn-hover-bg, #f3ede0);
      border-color: var(--toolbar-btn-hover-border, #c9bda3);
    }
    .component-icon-btn.active {
      background: #e0904a;
      border-color: #c97b38;
      color: #fff;
    }
    .component-icon-btn svg {
      width: 22px;
      height: 22px;
    }
    .component-icon-btn .icon-label {
      font-size: 9.5px;
      line-height: 1.1;
      text-align: center;
    }
    .component-icon-empty {
      aspect-ratio: 1 / 1;
      border-radius: 8px;
      border: 1px dashed transparent;
    }
    .properties-section-content {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .properties-hint {
      font-size: 12.5px;
      opacity: 0.75;
      line-height: 1.4;
    }
    .properties-gap-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 8px;
    }
    .properties-gap-row label {
      font-size: 12.5px;
    }
    .properties-gap-row input {
      width: 72px;
    }
  `;
  document.head.appendChild(style);
}


/* ============================================================
   MAIN RENDER
   ============================================================ */

export function renderPanelList(
  container,
  {
    panels = [],
    selectedId,
    selectedGroupId,

    onSelectPanel,
    onSelectGroup,

    multiSelectedIds = new Set(),
    onGroupSelected,

    onAddVertical,
    onAddHorizontal,
    onAddParallel,
    onAddBox,

    onCollinear,
    collinearActive,
    collinearGapMm,
    onCollinearGapChange,

    onShelfHorizontal,
    onShelfVertical,
    shelfMode,
  }
) {

  if (!container) {
    return;
  }

  ensureComponentIconStyles();


  /*
   * Preserve the section heights before rebuilding the DOM.
   *
   * modeller-main.js may call renderPanelList() frequently after
   * selections, transformations, etc. Inline heights therefore
   * cannot be allowed to disappear when container.innerHTML is
   * rebuilt.
   */
  const previousRoot =
    container.querySelector('.toolbar-root');

  const savedSectionHeights =
    readSectionHeights(previousRoot);


  /*
   * The Properties section only exists in the DOM while a building
   * tool is active — it (and its preceding resizer) are omitted
   * entirely otherwise, rather than just hidden, so the layout
   * collapses back to the three sections above it.
   */
  const anyToolActive =
    !!(collinearActive || shelfMode);

  const propertiesSectionMarkup =
    anyToolActive
      ? `
        <div
          class="toolbar-section-resizer"
          data-resizer-after="tools"
          title="Drag to resize Building Tools"
        ></div>

        <section
          class="toolbar-section"
          data-section="properties"
        >

          <div class="toolbar-section-header">

            <div class="section-title">
              Properties
            </div>

          </div>


          <div class="toolbar-section-content">

            ${renderPropertiesContent({
              collinearActive,
              collinearGapMm,
              shelfMode,
            })}

          </div>

        </section>
      `
      : '';


  container.innerHTML = `
    <div
      class="toolbar-root"
      data-toolbar-root="true"
    >

      <!-- ====================================================
           ELEMENTS
           ==================================================== -->

      <section
        class="toolbar-section"
        data-section="elements"
      >

        <div class="toolbar-section-header">

          <div class="section-title">
            Elements
          </div>

        </div>


        <div
          class="toolbar-section-content elements-section-content"
          id="elements-section-content"
        >

          <div id="panel-list-items"></div>


          <button
            type="button"
            class="add-btn group-selected-btn"
            id="group-selected-btn"
            style="display:none;"
          ></button>

        </div>

      </section>


      <div
        class="toolbar-section-resizer"
        data-resizer-after="elements"
        title="Drag to resize Elements"
      ></div>


      <!-- ====================================================
           BUILDING COMPONENTS
           ==================================================== -->

      <section
        class="toolbar-section"
        data-section="components"
      >

        <div class="toolbar-section-header">

          <div class="section-title">
            Building Components
          </div>

        </div>


        <div class="toolbar-section-content">

          <div class="component-icon-grid">

            <button
              type="button"
              class="component-icon-btn"
              id="add-vertical-btn"
              title="Vertical panel"
            >
              ${COMPONENT_ICONS.vertical}
              <span class="icon-label">Vertical</span>
            </button>

            <button
              type="button"
              class="component-icon-btn"
              id="add-horizontal-btn"
              title="Horizontal panel"
            >
              ${COMPONENT_ICONS.horizontal}
              <span class="icon-label">Horizontal</span>
            </button>

            <button
              type="button"
              class="component-icon-btn"
              id="add-parallel-btn"
              title="Parallel panel"
            >
              ${COMPONENT_ICONS.parallel}
              <span class="icon-label">Parallel</span>
            </button>

            <button
              type="button"
              class="component-icon-btn"
              id="add-box-btn"
              title="Box (6 sides, fully enclosed)"
            >
              ${COMPONENT_ICONS.box}
              <span class="icon-label">Box</span>
            </button>

            <button
              type="button"
              class="component-icon-btn ${shelfMode === 'horizontal' ? 'active' : ''}"
              id="shelf-h-btn"
              title="${shelfMode === 'horizontal' ? 'Cancel Horizontal Shelf (Esc)' : "Horizontal shelf — pick a box's Left panel, then its Right panel"}"
            >
              ${COMPONENT_ICONS.shelfH}
              <span class="icon-label">${shelfMode === 'horizontal' ? 'Cancel' : 'H. Shelf'}</span>
            </button>

            <button
              type="button"
              class="component-icon-btn ${shelfMode === 'vertical' ? 'active' : ''}"
              id="shelf-v-btn"
              title="${shelfMode === 'vertical' ? 'Cancel Vertical Shelf (Esc)' : "Vertical shelf — pick a box's Top panel, then its Bottom panel"}"
            >
              ${COMPONENT_ICONS.shelfV}
              <span class="icon-label">${shelfMode === 'vertical' ? 'Cancel' : 'V. Shelf'}</span>
            </button>

            <div class="component-icon-empty"></div>
            <div class="component-icon-empty"></div>

          </div>

        </div>

      </section>


      <div
        class="toolbar-section-resizer"
        data-resizer-after="components"
        title="Drag to resize Building Components"
      ></div>


      <!-- ====================================================
           BUILDING TOOLS
           ==================================================== -->

      <section
        class="toolbar-section"
        data-section="tools"
      >

        <div class="toolbar-section-header">

          <div class="section-title">
            Building Tools
          </div>

        </div>


        <div class="toolbar-section-content">

          <div class="component-icon-grid">

            <button
              type="button"
              class="component-icon-btn ${collinearActive ? 'active' : ''}"
              id="collinear-btn"
              title="${collinearActive ? 'Cancel Collinear (Esc)' : 'Collinear — pick a face, then a parallel face'}"
            >
              ${COMPONENT_ICONS.collinear}
              <span class="icon-label">${collinearActive ? 'Cancel' : 'Collinear'}</span>
            </button>

          </div>

        </div>

      </section>


      <!-- ====================================================
           PROPERTIES (conditional — see propertiesSectionMarkup)
           ==================================================== -->

      ${propertiesSectionMarkup}

    </div>
  `;


  const toolbarRoot =
    container.querySelector(
      '.toolbar-root'
    );


  /*
   * Restore section heights AFTER the new DOM exists.
   */
  restoreSectionHeights(
    toolbarRoot,
    savedSectionHeights
  );


  /* ==========================================================
     ELEMENTS
     ========================================================== */

  const listEl =
    container.querySelector(
      '#panel-list-items'
    );


  const groupButton =
    container.querySelector(
      '#group-selected-btn'
    );


  const seenGroups =
    new Set();


  panels.forEach(
    (panel) => {

      /*
       * Standalone panel.
       */
      if (!panel.groupId) {

        appendPanelRow(
          listEl,
          panel,
          {
            indented: false,

            isSelected:
              panel.id === selectedId,

            isMultiSelected:
              multiSelectedIds.has(
                panel.id
              ),

            onSelectPanel,
          }
        );

        return;
      }


      /*
       * Already rendered this group.
       */
      if (
        seenGroups.has(
          panel.groupId
        )
      ) {
        return;
      }


      seenGroups.add(
        panel.groupId
      );


      const members =
        panels.filter(
          (member) =>
            member.groupId ===
            panel.groupId
        );


      appendGroup(
        listEl,
        panel.groupId,
        members,
        {
          selectedGroupId,
          selectedId,
          onSelectGroup,
          onSelectPanel,
        }
      );
    }
  );


  /* ==========================================================
     GROUP SELECTED BUTTON
     ========================================================== */

  if (
    multiSelectedIds.size >= 2
  ) {

    groupButton.style.display =
      '';

    groupButton.textContent =
      `Group ${multiSelectedIds.size} selected panels`;


    groupButton.addEventListener(
      'click',
      (event) => {

        event.preventDefault();
        event.stopPropagation();

        onGroupSelected?.();
      }
    );
  }


  /* ==========================================================
     BUILDING COMPONENT BUTTONS
     ========================================================== */

  container
    .querySelector(
      '#add-vertical-btn'
    )
    ?.addEventListener(
      'click',
      (event) => {

        event.preventDefault();
        event.stopPropagation();

        onAddVertical?.();
      }
    );


  container
    .querySelector(
      '#add-horizontal-btn'
    )
    ?.addEventListener(
      'click',
      (event) => {

        event.preventDefault();
        event.stopPropagation();

        onAddHorizontal?.();
      }
    );


  container
    .querySelector(
      '#add-parallel-btn'
    )
    ?.addEventListener(
      'click',
      (event) => {

        event.preventDefault();
        event.stopPropagation();

        onAddParallel?.();
      }
    );


  container
    .querySelector(
      '#add-box-btn'
    )
    ?.addEventListener(
      'click',
      (event) => {

        event.preventDefault();
        event.stopPropagation();

        onAddBox?.();
      }
    );


  container
    .querySelector(
      '#shelf-h-btn'
    )
    ?.addEventListener(
      'click',
      (event) => {

        event.preventDefault();
        event.stopPropagation();

        onShelfHorizontal?.();
      }
    );


  container
    .querySelector(
      '#shelf-v-btn'
    )
    ?.addEventListener(
      'click',
      (event) => {

        event.preventDefault();
        event.stopPropagation();

        onShelfVertical?.();
      }
    );


  /* ==========================================================
     COLLINEAR
     ========================================================== */

  container
    .querySelector(
      '#collinear-btn'
    )
    ?.addEventListener(
      'click',
      (event) => {

        event.preventDefault();
        event.stopPropagation();

        onCollinear?.();
      }
    );


  const gapInput =
    container.querySelector(
      '#collinear-gap-input'
    );


  gapInput?.addEventListener(
    'input',
    (event) => {

      const value =
        parseFloat(
          event.target.value
        );


      onCollinearGapChange?.(
        Number.isFinite(value)
          ? value
          : 0
      );
    }
  );


  /* ==========================================================
     SECTION RESIZERS
     ========================================================== */

  installToolbarSectionResizers(
    container
  );
}


/* ============================================================
   PROPERTIES SECTION CONTENT
   ============================================================ */

// Only ever called while anyToolActive is true (see the caller) —
// picks the right body for whichever tool is currently active.
// Collinear shows its live gap input; other tools get a short status
// hint for now, extendable per-tool as more properties come up.
function renderPropertiesContent({
  collinearActive,
  collinearGapMm,
  shelfMode,
}) {

  if (collinearActive) {
    return `
      <div class="properties-section-content">

        <div class="properties-hint">
          Pick a face, then a parallel face on a different panel.
        </div>

        <div class="properties-gap-row">

          <label
            for="collinear-gap-input"
            title="Gap between the two picked faces, in mm"
          >
            Gap (mm)
          </label>


          <input
            type="number"
            id="collinear-gap-input"
            value="${escapeAttribute(
              Number(collinearGapMm ?? 0)
            )}"
            step="1"
          />

        </div>

      </div>
    `;
  }

  if (shelfMode === 'horizontal') {
    return `
      <div class="properties-section-content">
        <div class="properties-hint">
          Pick a box's Left/Right panel (or an existing vertical shelf), then the other boundary of the same box.
        </div>
      </div>
    `;
  }

  if (shelfMode === 'vertical') {
    return `
      <div class="properties-section-content">
        <div class="properties-hint">
          Pick a box's Top/Bottom panel (or an existing horizontal shelf), then the other boundary of the same box.
        </div>
      </div>
    `;
  }

  return '';
}


/* ============================================================
   GROUP
   ============================================================ */

function appendGroup(
  listEl,
  groupId,
  members,
  {
    selectedGroupId,
    selectedId,
    onSelectGroup,
    onSelectPanel,
  }
) {

  const groupWrapper =
    document.createElement(
      'div'
    );


  groupWrapper.className =
    'group-dropdown';


  groupWrapper.dataset.groupId =
    groupId;


  /*
   * Groups start closed.
   *
   * Selecting a group NEVER changes this value.
   */
  groupWrapper.dataset.open =
    'false';


  /* ==========================================================
     GROUP HEADER
     ========================================================== */

  const header =
    document.createElement(
      'div'
    );


  header.className =
    'group-header-row' +
    (
      selectedGroupId === groupId
        ? ' selected'
        : ''
    );


  /*
   * GROUP SELECTION BUTTON
   *
   * This only selects the group.
   */
  const selectButton =
    document.createElement(
      'button'
    );


  selectButton.type =
    'button';


  selectButton.className =
    'list-item group-header-select';


  selectButton.innerHTML = `
    <span class="id">
      Group (${members.length})
    </span>
  `;


  selectButton.addEventListener(
    'click',
    (event) => {

      event.preventDefault();
      event.stopPropagation();

      /*
       * Selection ONLY.
       *
       * Absolutely no setGroupOpen() here.
       */
      onSelectGroup?.(
        groupId
      );
    }
  );


  /* ==========================================================
     DROPDOWN BUTTON
     ========================================================== */

  const dropdownButton =
    document.createElement(
      'button'
    );


  dropdownButton.type =
    'button';


  dropdownButton.className =
    'group-dropdown-toggle';


  dropdownButton.setAttribute(
    'aria-expanded',
    'false'
  );


  dropdownButton.title =
    'Show or hide group elements';


  dropdownButton.textContent =
    '▸';


  dropdownButton.addEventListener(
    'click',
    (event) => {

      event.preventDefault();
      event.stopPropagation();


      const isOpen =
        groupWrapper.dataset.open ===
        'true';


      setGroupOpen(
        groupWrapper,
        !isOpen
      );
    }
  );


  header.appendChild(
    selectButton
  );


  header.appendChild(
    dropdownButton
  );


  groupWrapper.appendChild(
    header
  );


  /* ==========================================================
     GROUP MEMBERS
     ========================================================== */

  const membersContainer =
    document.createElement(
      'div'
    );


  membersContainer.className =
    'group-members';


  membersContainer.hidden =
    true;


  members.forEach(
    (member) => {

      appendPanelRow(
        membersContainer,
        member,
        {
          indented: true,

          isSelected:
            member.id ===
            selectedId,

          isMultiSelected: false,

          onSelectPanel,
        }
      );
    }
  );


  groupWrapper.appendChild(
    membersContainer
  );


  listEl.appendChild(
    groupWrapper
  );
}


/* ============================================================
   OPEN / CLOSE GROUP
   ============================================================ */

function setGroupOpen(
  groupWrapper,
  open
) {

  groupWrapper.dataset.open =
    open ? 'true' : 'false';


  const members =
    groupWrapper.querySelector(
      '.group-members'
    );


  const button =
    groupWrapper.querySelector(
      '.group-dropdown-toggle'
    );


  if (members) {
    members.hidden =
      !open;
  }


  if (button) {

    button.textContent =
      open
        ? '▾'
        : '▸';


    button.setAttribute(
      'aria-expanded',
      String(open)
    );
  }
}


/* ============================================================
   PANEL ROW
   ============================================================ */

function appendPanelRow(
  listEl,
  panel,
  {
    indented,
    isSelected,
    isMultiSelected,
    onSelectPanel,
  }
) {

  const item =
    document.createElement(
      'button'
    );


  item.type =
    'button';


  item.className =
    'list-item' +
    (
      indented
        ? ' group-member'
        : ''
    ) +
    (
      isSelected
        ? ' selected'
        : ''
    ) +
    (
      isMultiSelected
        ? ' multi-selected'
        : ''
    );


  const prefix =
    indented
      ? '↳ '
      : '';


  item.innerHTML = `
    <span class="id">
      ${escapeHtml(
        prefix +
        getDisplayName(panel)
      )}
    </span>
  `;


  item.addEventListener(
    'click',
    (event) => {

      event.preventDefault();
      event.stopPropagation();


      onSelectPanel?.(
        panel.id,
        event.ctrlKey ||
        event.metaKey
      );
    }
  );


  listEl.appendChild(
    item
  );
}


/* ============================================================
   SECTION HEIGHT STATE
   ============================================================ */

/*
 * Read manually assigned section heights from the existing toolbar.
 *
 * This is deliberately independent of the section contents.
 * Therefore rerenderPanelList() can rebuild all buttons without
 * losing the user's layout.
 */

function readSectionHeights(
  root
) {

  const result = {};


  if (!root) {
    return result;
  }


  root
    .querySelectorAll(
      '.toolbar-section'
    )
    .forEach(
      (section) => {

        const name =
          section.dataset.section;


        if (!name) {
          return;
        }


        const inlineHeight =
          section.style.height;


        if (
          inlineHeight &&
          inlineHeight !== 'auto'
        ) {

          result[name] =
            inlineHeight;

          return;
        }


        /*
         * If the section was previously resized but the browser
         * has resolved its size, preserve the computed height.
         */
        const computed =
          getComputedStyle(
            section
          );


        if (
          computed.height &&
          computed.height !== 'auto'
        ) {

          /*
           * Only save explicitly resized sections.
           *
           * flex values such as "1 1 42%" should not become
           * permanent pixel heights unless the user actually
           * resized the section.
           */
          if (
            section.dataset.userResized ===
            'true'
          ) {

            result[name] =
              computed.height;
          }
        }
      }
    );


  return result;
}


/* ============================================================
   RESTORE SECTION HEIGHT STATE
   ============================================================ */

function restoreSectionHeights(
  root,
  heights
) {

  if (
    !root ||
    !heights
  ) {
    return;
  }


  Object.entries(
    heights
  ).forEach(
    ([name, height]) => {

      const section =
        root.querySelector(
          `.toolbar-section[data-section="${CSS.escape(name)}"]`
        );


      if (!section) {
        return;
      }


      section.style.height =
        height;


      section.style.flex =
        '0 0 auto';


      section.dataset.userResized =
        'true';
    }
  );
}


/* ============================================================
   SECTION RESIZERS
   ============================================================ */

export function installToolbarSectionResizers(
  root = document
) {

  const resizers =
    root.querySelectorAll(
      '.toolbar-section-resizer'
    );


  resizers.forEach(
    (resizer) => {

      if (
        resizer.dataset.resizeInstalled ===
        'true'
      ) {
        return;
      }


      resizer.dataset.resizeInstalled =
        'true';


      let dragging = false;

      let startY = 0;
      let startHeight = 0;

      let upperSection = null;
      let lowerSection = null;


      /* ========================================================
         MINIMUM SECTION HEIGHT
         ======================================================== */

      function minimumSectionHeight(
        section
      ) {

        if (!section) {
          return SECTION_MIN_HEIGHT;
        }


        const header =
          section.querySelector(
            '.toolbar-section-header'
          );


        const headerHeight =
          header
            ? Math.ceil(
                header
                  .getBoundingClientRect()
                  .height
              )
            : 34;


        /*
         * Properties (the last section, when present) gets extra
         * protected height — same role the old Relations section
         * used to play.
         */
        if (
          section.dataset.section ===
          'properties'
        ) {

          return Math.max(
            PROPERTIES_MIN_HEIGHT,
            headerHeight + 42
          );
        }


        return Math.max(
          SECTION_MIN_HEIGHT,
          headerHeight + 24
        );
      }


      /* ========================================================
         START
         ======================================================== */

      function startResize(
        event
      ) {

        /*
         * Only primary mouse button.
         */
        if (
          event.pointerType === 'mouse' &&
          event.button !== 0
        ) {
          return;
        }


        upperSection =
          resizer.previousElementSibling;


        lowerSection =
          resizer.nextElementSibling;


        if (
          !upperSection ||
          !lowerSection ||
          !upperSection.classList.contains(
            'toolbar-section'
          ) ||
          !lowerSection.classList.contains(
            'toolbar-section'
          )
        ) {

          upperSection = null;
          lowerSection = null;

          return;
        }


        dragging = true;


        startY =
          event.clientY;


        startHeight =
          upperSection
            .getBoundingClientRect()
            .height;


        resizer.classList.add(
          'dragging'
        );


        upperSection.classList.add(
          'resizing'
        );


        lowerSection.classList.add(
          'resizing'
        );


        document.body.classList.add(
          'toolbar-resizing'
        );


        /*
         * Mark this section as user-resized.
         *
         * This is what allows the height to survive subsequent
         * toolbar rerenders.
         */
        upperSection.dataset.userResized =
          'true';


        try {

          resizer.setPointerCapture(
            event.pointerId
          );

        } catch (_) {}


        event.preventDefault();
        event.stopPropagation();
      }


      /* ========================================================
         RESIZE
         ======================================================== */

      function resize(
        event
      ) {

        if (
          !dragging ||
          !upperSection ||
          !lowerSection
        ) {
          return;
        }


        const toolbar =
          upperSection.parentElement;


        if (!toolbar) {
          return;
        }


        const delta =
          event.clientY -
          startY;


        const toolbarHeight =
          toolbar
            .getBoundingClientRect()
            .height;


        const separatorHeight =
          resizer
            .getBoundingClientRect()
            .height;


        const upperMin =
          minimumSectionHeight(
            upperSection
          );


        const lowerMin =
          minimumSectionHeight(
            lowerSection
          );


        /*
         * Properties, when present, is the final section.
         *
         * Keep a permanent margin below it — same role the old
         * Relations section used to play.
         */
        const isLowerProperties =
          lowerSection.dataset.section ===
          'properties';


        const bottomMargin =
          isLowerProperties
            ? PROPERTIES_BOTTOM_MARGIN
            : 0;


        const available =
          toolbarHeight -
          separatorHeight -
          bottomMargin;


        /*
         * The upper section may never grow enough to push the
         * lower section below its minimum.
         */
        const maxUpper =
          Math.max(
            upperMin,
            available - lowerMin
          );


        const requestedHeight =
          startHeight + delta;


        const newHeight =
          Math.min(
            maxUpper,
            Math.max(
              upperMin,
              requestedHeight
            )
          );


        upperSection.style.height =
          `${newHeight}px`;


        upperSection.style.flex =
          '0 0 auto';


        event.preventDefault();
      }


      /* ========================================================
         STOP
         ======================================================== */

      function stopResize(
        event
      ) {

        if (!dragging) {
          return;
        }


        dragging = false;


        resizer.classList.remove(
          'dragging'
        );


        upperSection?.classList.remove(
          'resizing'
        );


        lowerSection?.classList.remove(
          'resizing'
        );


        document.body.classList.remove(
          'toolbar-resizing'
        );


        try {

          if (
            event &&
            resizer.hasPointerCapture &&
            resizer.hasPointerCapture(
              event.pointerId
            )
          ) {

            resizer.releasePointerCapture(
              event.pointerId
            );
          }

        } catch (_) {}


        upperSection = null;
        lowerSection = null;
      }


      /* ========================================================
         POINTER EVENTS
         ======================================================== */

      resizer.addEventListener(
        'pointerdown',
        startResize
      );


      resizer.addEventListener(
        'pointermove',
        resize
      );


      resizer.addEventListener(
        'pointerup',
        stopResize
      );


      resizer.addEventListener(
        'pointercancel',
        stopResize
      );


      /*
       * Safety net for lost pointer capture.
       */
      window.addEventListener(
        'pointerup',
        (event) => {

          if (dragging) {
            stopResize(event);
          }
        },
        true
      );


      window.addEventListener(
        'pointercancel',
        (event) => {

          if (dragging) {
            stopResize(event);
          }
        },
        true
      );
    }
  );
}


/* ============================================================
   HTML ESCAPE
   ============================================================ */

function escapeHtml(
  value
) {

  const div =
    document.createElement(
      'div'
    );


  div.textContent =
    String(value ?? '');


  return div.innerHTML;
}


/* ============================================================
   ATTRIBUTE ESCAPE
   ============================================================ */

function escapeAttribute(
  value
) {

  return escapeHtml(
    value
  )
    .replace(
      /"/g,
      '&quot;'
    )
    .replace(
      /'/g,
      '&#39;'
    );
}