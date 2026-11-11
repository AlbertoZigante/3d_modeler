/** Print stylesheet for the assembly manual (A4 landscape, two A5-portrait pages per sheet, self-contained). */
export const MANUAL_CSS = `  @page {
    size: A4 landscape;
    margin: 0;
  }

  :root {
    --p4-ink: #151515;
    --p4-muted: #666;
    --p4-light: #f3f3f1;
    --p4-line: #d8d8d4;
    --p4-panel: #ffffff;
    --p4-warning: #fff1cf;
    --p4-warning-line: #d79b20;
    --p4-accent: #111111;
    --p4-success: #e8f2e9;
  }

  * {
    box-sizing: border-box;
  }

  html,
  body {
    margin: 0;
    padding: 0;
    color: var(--p4-ink);
    background: #e7e7e4;
    font-family: Arial, Helvetica, sans-serif;
    -webkit-print-color-adjust: exact;
    print-color-adjust: exact;
  }

  body {
    font-size: 12pt;
    line-height: 1.35;
  }

  h1,
  h2,
  p {
    margin-top: 0;
  }

  .p4-parts-sheet {
    height: 277mm;
    overflow: hidden;
  }

  .p4-parts-sheet-svg {
    display: block;
    width: 100%;
    height: 220mm;
    max-height: 220mm;
  }

  .p4-assembly-state {
    display: block;
    width: 100%;
    height: 100%;
    max-height: 158mm;
  }

  .p4-diagram-area {
    overflow: hidden;
  }
  .p4-cover,
  .p4-reference-page,
  .p4-checklist-page,
  .p4-step {
    width: 210mm;
    min-height: 297mm;
    margin: 0 auto 10mm;
    background: var(--p4-panel);
    padding: 17mm;
    page-break-after: always;
    break-after: page;
    position: relative;
    overflow: hidden;
  }

  .p4-cover {
    display: flex;
    flex-direction: column;
    justify-content: center;
  }

  .p4-cover-kicker,
  .p4-reference-kicker {
    font-size: 9pt;
    font-weight: 800;
    letter-spacing: .18em;
    color: var(--p4-muted);
    margin-bottom: 7mm;
  }

  .p4-cover h1 {
    font-size: 34pt;
    line-height: 1.05;
    max-width: 160mm;
    margin-bottom: 6mm;
  }

  .p4-cover-subtitle {
    font-size: 16pt;
    color: var(--p4-muted);
    max-width: 145mm;
  }

  .p4-cover-rule {
    width: 35mm;
    border-top: 3px solid var(--p4-ink);
    margin: 12mm 0;
  }

  .p4-cover-meta {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 4mm;
    margin-bottom: 14mm;
  }

  .p4-cover-meta div {
    border: 1px solid var(--p4-line);
    padding: 5mm;
  }

  .p4-cover-meta span {
    display: block;
    font-size: 8pt;
    font-weight: 800;
    color: var(--p4-muted);
    letter-spacing: .12em;
    margin-bottom: 2mm;
  }

  .p4-cover-meta strong {
    font-size: 16pt;
  }

  .p4-cover-principles {
    display: grid;
    gap: 4mm;
    margin-bottom: 12mm;
  }

  .p4-principle {
    display: grid;
    grid-template-columns: 10mm 1fr;
    gap: 4mm;
    align-items: center;
    padding: 4mm;
    background: var(--p4-light);
  }

  .p4-principle strong {
    width: 8mm;
    height: 8mm;
    border: 2px solid var(--p4-ink);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .p4-cover-section-title,
  .p4-callout-title {
    font-size: 8pt;
    font-weight: 800;
    letter-spacing: .13em;
    color: var(--p4-muted);
    margin-bottom: 2mm;
  }

  .p4-cover-tools {
    margin-bottom: 10mm;
  }

  .p4-chip-row {
    display: flex;
    flex-wrap: wrap;
    gap: 2mm;
  }

  .p4-chip {
    display: inline-flex;
    align-items: center;
    min-height: 8mm;
    padding: 1.5mm 3mm;
    border: 1px solid var(--p4-line);
    background: #fff;
    font-weight: 700;
    font-size: 9pt;
  }

  .p4-chip-hardware {
    border-width: 2px;
  }

  .p4-cover-safety {
    color: var(--p4-muted);
    font-size: 9pt;
    border-top: 1px solid var(--p4-line);
    padding-top: 4mm;
  }

  .p4-reference-page h1,
  .p4-checklist-page h1 {
    font-size: 27pt;
    margin-bottom: 5mm;
  }

  .p4-reference-intro {
    color: var(--p4-muted);
    max-width: 155mm;
    margin-bottom: 9mm;
  }

  .p4-reference-grid {
    display: grid;
    grid-template-columns: repeat(2, 1fr);
    gap: 3mm;
  }

  .p4-part-card {
    border: 1px solid var(--p4-line);
    min-height: 24mm;
    padding: 4mm;
  }

  .p4-part-code {
    font-size: 14pt;
    font-weight: 900;
    margin-bottom: 1mm;
  }

  .p4-part-name {
    font-weight: 700;
  }

  .p4-part-meta {
    color: var(--p4-muted);
    font-size: 8pt;
    margin-top: 2mm;
  }

  .p4-reference-heading {
    margin-top: 11mm;
    font-size: 16pt;
  }

  .p4-subassembly-list {
    display: grid;
    gap: 3mm;
  }

  .p4-subassembly-row {
    display: grid;
    grid-template-columns: 55mm 1fr;
    gap: 5mm;
    padding: 4mm;
    border: 1px solid var(--p4-line);
  }

  .p4-subassembly-row strong,
  .p4-subassembly-row span {
    display: block;
  }

  .p4-subassembly-row span {
    color: var(--p4-muted);
    font-size: 8pt;
    margin-top: 1mm;
  }

  .p4-hardware-table {
    border-top: 2px solid var(--p4-ink);
  }

  .p4-hardware-row {
    display: grid;
    grid-template-columns: 55mm 25mm 1fr;
    gap: 4mm;
    padding: 4mm 2mm;
    border-bottom: 1px solid var(--p4-line);
  }

  .p4-empty {
    padding: 10mm;
    background: var(--p4-light);
    color: var(--p4-muted);
  }

  .p4-step {
    padding: 11mm 13mm;
  }

  .p4-step-header {
    display: grid;
    grid-template-columns: 19mm 1fr auto;
    gap: 4mm;
    align-items: center;
    border-bottom: 1px solid var(--p4-line);
    padding-bottom: 5mm;
  }

  .p4-step-number {
    width: 15mm;
    height: 15mm;
    border: 2px solid var(--p4-ink);
    border-radius: 50%;
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 900;
    font-size: 10pt;
  }

  .p4-step-phase {
    font-size: 8pt;
    font-weight: 800;
    color: var(--p4-muted);
    letter-spacing: .12em;
    margin-bottom: 1mm;
  }

  .p4-step-heading h2 {
    margin: 0;
    font-size: 21pt;
    line-height: 1.05;
  }

  .p4-step-subassembly {
    color: var(--p4-muted);
    font-size: 9pt;
    margin-top: 1.5mm;
  }

  .p4-step-count {
    color: var(--p4-muted);
    font-size: 9pt;
    font-weight: 700;
  }

  .p4-step-progress {
    margin: 4mm 0 6mm;
  }

  .p4-progress {
    display: grid;
    grid-template-columns: repeat(5, 1fr);
    gap: 2mm;
  }

  .p4-progress-item {
    min-height: 11mm;
    display: grid;
    grid-template-columns: 7mm 1fr;
    align-items: center;
    gap: 2mm;
    color: #aaa;
  }

  .p4-progress-item.current {
    color: var(--p4-ink);
    font-weight: 900;
  }

  .p4-progress-item.complete {
    color: var(--p4-ink);
  }

  .p4-progress-dot {
    width: 6mm;
    height: 6mm;
    border-radius: 50%;
    border: 1px solid currentColor;
    display: flex;
    justify-content: center;
    align-items: center;
    font-size: 7pt;
    font-weight: 800;
  }

  .p4-progress-item.current .p4-progress-dot {
    border-width: 2px;
  }

  .p4-progress-label {
    font-size: 6.5pt;
    letter-spacing: .05em;
  }

  .p4-step-main {
    display: grid;
    grid-template-columns: 55% 45%;
    min-height: 208mm;
  }

  .p4-diagram-area {
    min-height: 165mm;
    overflow: hidden;
    border: 1px solid var(--p4-line);
    background: #fafaf8;
    padding: 7mm;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  .p4-diagram-fallback {
    width: 100%;
    height: 150mm;
    display: flex;
    flex-direction: column;
    justify-content: center;
    align-items: center;
    gap: 5mm;
    position: relative;
  }

  .p4-diagram-panel,
  .p4-diagram-target {
    width: 60mm;
    min-height: 34mm;
    border: 2px solid var(--p4-ink);
    display: flex;
    justify-content: center;
    align-items: center;
    font-weight: 900;
    text-align: center;
    padding: 3mm;
  }

  .p4-diagram-target {
    width: 78mm;
    min-height: 42mm;
    background: #ecece8;
  }

  .p4-diagram-arrow {
    font-size: 20pt;
    line-height: 1;
  }

  .p4-diagram-action {
    position: absolute;
    bottom: 3mm;
    font-size: 8pt;
    font-weight: 800;
    letter-spacing: .13em;
    color: var(--p4-muted);
  }

  .p4-instruction-area {
    padding: 0 0 0 7mm;
  }

  .p4-action-banner {
    min-height: 13mm;
    background: var(--p4-ink);
    color: #fff;
    display: flex;
    align-items: center;
    gap: 3mm;
    padding: 3mm 4mm;
    font-size: 8pt;
    font-weight: 900;
    letter-spacing: .08em;
  }

  .p4-orientation-icon {
    font-size: 16pt;
    line-height: 1;
  }

  .p4-instruction {
    font-size: 15pt;
    line-height: 1.3;
    font-weight: 700;
    padding: 6mm 0;
  }

  .p4-orientation-note {
    border-left: 3px solid var(--p4-ink);
    padding: 2mm 0 2mm 3mm;
    font-size: 9pt;
    color: var(--p4-muted);
    margin-bottom: 5mm;
  }

  .p4-prerequisite {
    background: var(--p4-light);
    padding: 3mm;
    font-size: 8pt;
    margin-bottom: 4mm;
  }

  .p4-callout {
    margin-top: 4mm;
  }

  .p4-warning {
    margin-top: 5mm;
    padding: 4mm;
    background: var(--p4-warning);
    border-left: 4px solid var(--p4-warning-line);
  }

  .p4-warning-title {
    font-size: 8pt;
    font-weight: 900;
    letter-spacing: .12em;
    margin-bottom: 2mm;
  }

  .p4-warning ul {
    margin: 0;
    padding-left: 5mm;
    font-size: 9pt;
  }

  .p4-warning li + li {
    margin-top: 1.5mm;
  }

  .p4-complete {
    margin-top: 5mm;
    padding: 4mm;
    background: var(--p4-success);
    border: 1px solid #b7ceb9;
    font-size: 9pt;
  }

  .p4-complete strong {
    display: block;
    font-size: 8pt;
    letter-spacing: .1em;
    margin-bottom: 1mm;
  }

  .p4-ergo {
    margin-top: 6mm;
    color: var(--p4-muted);
    font-size: 7pt;
  }

  .p4-step-closure .p4-action-banner,
  .p4-step-integration .p4-action-banner {
    letter-spacing: .11em;
  }

  .p4-final-message {
    max-width: 145mm;
    padding: 5mm;
    background: var(--p4-light);
    margin-bottom: 10mm;
  }

  .p4-checklist {
    display: grid;
    gap: 4mm;
  }

  .p4-check-row {
    display: grid;
    grid-template-columns: 10mm 1fr;
    gap: 4mm;
    align-items: center;
    padding: 5mm;
    border: 1px solid var(--p4-line);
    font-size: 12pt;
  }

  .p4-check-box {
    width: 7mm;
    height: 7mm;
    border: 2px solid var(--p4-ink);
  }

  .p4-check-number {
    color: var(--p4-muted);
    font-size: 8pt;
    font-weight: 900;
    margin-right: 2mm;
  }

  .p4-adjustment-box {
    margin-top: 12mm;
    border: 2px solid var(--p4-ink);
    padding: 6mm;
  }

  .p4-adjustment-box strong {
    display: block;
    margin-bottom: 2mm;
  }

  .p4-adjustment-box p {
    margin: 0;
    color: var(--p4-muted);
  }

  /*
   * Landscape layout: every sheet is A4 landscape (297 x 210 mm) holding
   * two halves side by side. Pages are still laid out at their native
   * A4-portrait size (210 x 297 mm) and scaled by 1/sqrt(2) = 0.70711,
   * which is exactly A5 portrait (148.5 x 210 mm) - so a step that used
   * to fill a page now fills half a sheet with identical proportions.
   */
  .p4-sheet {
    display: flex;
    width: 297mm;
    height: 210mm;
    margin: 0 auto 10mm;
    background: var(--p4-panel);
    overflow: hidden;
    page-break-after: always;
    break-after: page;
  }

  .p4-half {
    position: relative;
    flex: 0 0 148.5mm;
    width: 148.5mm;
    height: 210mm;
    overflow: hidden;
  }

  .p4-half + .p4-half {
    border-left: 1px solid var(--p4-line);
  }

  .p4-half > .p4-cover,
  .p4-half > .p4-reference-page,
  .p4-half > .p4-checklist-page,
  .p4-half > .p4-step {
    width: 210mm;
    height: 297mm;
    min-height: 0;
    margin: 0;
    page-break-after: auto;
    break-after: auto;
    transform: scale(0.70711);
    transform-origin: 0 0;
  }

  @media print {
    html,
    body {
      background: #fff;
    }

    .p4-cover,
    .p4-reference-page,
    .p4-checklist-page,
    .p4-step {
      margin: 0;
    }
  }`;
