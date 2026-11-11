import { phase4EscapeHtml } from './format.js';

export function phase4RenderCover(model) {
  const metadata = model.metadata || {};

  return `
    <section class="p4-cover">
      <div class="p4-cover-kicker">ASSEMBLY MANUAL</div>
      <h1>${phase4EscapeHtml(model.title)}</h1>
      <p class="p4-cover-subtitle">
        ${phase4EscapeHtml(model.subtitle)}
      </p>

      <div class="p4-cover-rule"></div>

      <div class="p4-cover-meta">
        <div>
          <span>PEOPLE</span>
          <strong>${phase4EscapeHtml(metadata.people || '—')}</strong>
        </div>
        <div>
          <span>TIME</span>
          <strong>${phase4EscapeHtml(metadata.estimatedTime || '—')}</strong>
        </div>
        <div>
          <span>STEPS</span>
          <strong>${model.steps.length}</strong>
        </div>
      </div>

      <div class="p4-cover-principles">
        <div class="p4-principle">
          <strong>1</strong>
          <span>Build independent components first.</span>
        </div>
        <div class="p4-principle">
          <strong>2</strong>
          <span>Install internal parts before closing access.</span>
        </div>
        <div class="p4-principle">
          <strong>3</strong>
          <span>Plug completed doors and drawers in last.</span>
        </div>
      </div>

      <div class="p4-cover-tools">
        <div class="p4-cover-section-title">TOOLS</div>
        <div class="p4-chip-row">
          ${(metadata.tools || []).map((tool) => `
            <span class="p4-chip">
              ${phase4EscapeHtml(tool)}
            </span>
          `).join('')}
        </div>
      </div>

      <div class="p4-cover-safety">
        ${phase4EscapeHtml(metadata.safety || '')}
      </div>
    </section>
  `;
}

export function phase4RenderPartsPage(model) {

  const maxWidth =
    Math.max(
      ...model.parts.map(
        (part) =>
          Number(part.width) || 0
      ),
      1
    );

  const maxHeight =
    Math.max(
      ...model.parts.map(
        (part) =>
          Number(part.height) || 0
      ),
      1
    );

  const sheetWidth = 760;
  const sheetHeight = 500;

  const padding = 35;

  const columns =
    Math.min(
      5,
      Math.max(
        1,
        model.parts.length
      )
    );

  const rows =
    Math.ceil(
      model.parts.length /
      columns
    );

  const cellWidth =
    (sheetWidth - padding * 2) /
    columns;

  const cellHeight =
    (sheetHeight - padding * 2) /
    Math.max(rows, 1);

  const svgItems =
    model.parts.map(
      (part, index) => {

        const col =
          index % columns;

        const row =
          Math.floor(
            index / columns
          );

        const cellX =
          padding +
          col * cellWidth;

        const cellY =
          padding +
          row * cellHeight;

        const availableWidth =
          cellWidth - 20;

        const availableHeight =
          cellHeight - 38;

        const pw =
          Number(part.width) ||
          1;

        const ph =
          Number(part.height) ||
          1;

        const scale =
          Math.min(
            availableWidth / pw,
            availableHeight / ph
          );

        const shapeWidth =
          Math.max(
            8,
            pw * scale
          );

        const shapeHeight =
          Math.max(
            8,
            ph * scale
          );

        const x =
          cellX +
          (
            cellWidth -
            shapeWidth
          ) / 2;

        const y =
          cellY + 4;

        const role =
          phase4EscapeHtml(
            part.roleLabel
          );

        const code =
          phase4EscapeHtml(
            part.code
          );

        const name =
          phase4EscapeHtml(
            part.name
          );

        const subassembly =
          phase4EscapeHtml(
            part.subassembly ||
            'Main carcass'
          );

        const dimensions =
          [
            part.width,
            part.height,
            part.thickness,
          ]
            .map(
              (value) =>
                Number(value) > 0
                  ? Math.round(Number(value) * 100) / 100
                  : '—'
            )
            .join(' × ');

        return `
          <g>

            <rect
              x="${cellX.toFixed(2)}"
              y="${cellY.toFixed(2)}"
              width="${cellWidth.toFixed(2)}"
              height="${cellHeight.toFixed(2)}"
              fill="#fff"
              stroke="#d0d0cc"
              stroke-width="1"
            />

            <rect
              x="${x.toFixed(2)}"
              y="${y.toFixed(2)}"
              width="${shapeWidth.toFixed(2)}"
              height="${shapeHeight.toFixed(2)}"
              fill="#eeeeea"
              stroke="#222"
              stroke-width="1.5"
            />

            <text
              x="${cellX + 5}"
              y="${cellY + cellHeight - 23}"
              font-size="10"
              font-weight="900"
              fill="#111"
            >
              ${code}
            </text>

            <text
              x="${cellX + 5}"
              y="${cellY + cellHeight - 12}"
              font-size="7.5"
              font-weight="700"
              fill="#222"
            >
              ${role} · ${name}
            </text>

            <text
              x="${cellX + 5}"
              y="${cellY + cellHeight - 3}"
              font-size="6.5"
              fill="#666"
            >
              ${dimensions} mm · ${subassembly}
            </text>

          </g>
        `;
      }
    ).join('');

  return `
    <section class="p4-reference-page p4-parts-sheet">

      <div class="p4-reference-kicker">
        REFERENCE
      </div>

      <h1>
        Parts & sub-assemblies
      </h1>

      <p class="p4-reference-intro">
        Every panel is shown once, at proportional size.
        Use the code and dimensions to identify each part
        before assembly.
      </p>

      <svg
        class="p4-parts-sheet-svg"
        viewBox="0 0 ${sheetWidth} ${sheetHeight}"
        xmlns="http://www.w3.org/2000/svg"
        preserveAspectRatio="xMidYMid meet"
      >
        ${svgItems}
      </svg>

    </section>
  `;
}

export function phase4RenderHardwarePage(model) {
  return `
    <section class="p4-reference-page">
      <div class="p4-reference-kicker">REFERENCE</div>
      <h1>Hardware</h1>
      <p class="p4-reference-intro">
        Hardware is also repeated at the point of use in each assembly step.
      </p>

      ${
        model.hardware.length
          ? `
            <div class="p4-hardware-table">
              ${model.hardware.map((item) => `
                <div class="p4-hardware-row">
                  <strong>${phase4EscapeHtml(item.id)}</strong>
                  <span>${item.count} use${item.count === 1 ? '' : 's'}</span>
                  <span>${phase4EscapeHtml(item.uses.join(', '))}</span>
                </div>
              `).join('')}
            </div>
          `
          : `
            <div class="p4-empty">
              No hardware was reported by the assembly model.
            </div>
          `
      }
    </section>
  `;
}

export function phase4RenderChecklist(model) {
  return `
    <section class="p4-checklist-page">
      <div class="p4-reference-kicker">FINISH</div>
      <h1>Final check & adjustment</h1>

      <div class="p4-final-message">
        The structure is complete. Finish by checking movement, alignment,
        stability, and unused hardware.
      </div>

      <div class="p4-checklist">
        ${model.finalChecklist.map((item, index) => `
          <div class="p4-check-row">
            <div class="p4-check-box"></div>
            <div>
              <span class="p4-check-number">${index + 1}</span>
              ${phase4EscapeHtml(item)}
            </div>
          </div>
        `).join('')}
      </div>

      <div class="p4-adjustment-box">
        <strong>DOOR / DRAWER ADJUSTMENT</strong>
        <p>
          Make final adjustments only after the furniture is fully assembled
          and standing in its normal position.
        </p>
      </div>
    </section>
  `;
}
