import { orientationInstruction } from '../humanModel.js';
import { phase4Array, phase4EscapeHtml } from './format.js';

export function phase4RenderProgress(progress) {
  return `
    <div class="p4-progress">
      ${progress.map((item) => `
        <div class="p4-progress-item ${item.state}">
          <div class="p4-progress-dot">${item.index + 1}</div>
          <div class="p4-progress-label">
            ${phase4EscapeHtml(item.shortLabel)}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

export function phase4RenderWarningList(warnings) {
  if (!warnings.length) return '';

  return `
    <aside class="p4-warning" role="note">
      <div class="p4-warning-title">IMPORTANT</div>
      <ul>
        ${warnings.map((warning) => `
          <li>${phase4EscapeHtml(warning)}</li>
        `).join('')}
      </ul>
    </aside>
  `;
}

export function phase4RenderHardware(hardware) {
  if (!hardware.length) return '';

  return `
    <section class="p4-callout p4-hardware">
      <div class="p4-callout-title">HARDWARE FOR THIS STEP</div>
      <div class="p4-chip-row">
        ${hardware.map((item) => `
          <span class="p4-chip p4-chip-hardware">
            ${phase4EscapeHtml(item)}
          </span>
        `).join('')}
      </div>
    </section>
  `;
}

export function phase4RenderParts(parts) {
  if (!parts.length) return '';

  return `
    <section class="p4-callout p4-parts">
      <div class="p4-callout-title">PARTS</div>
      <div class="p4-chip-row">
        ${parts.map((item) => `
          <span class="p4-chip">
            ${phase4EscapeHtml(item)}
          </span>
        `).join('')}
      </div>
    </section>
  `;
}

export function phase4RenderStep(step) {
  const ergo = Number(step.ergonomic?.score);
  const ergoText = Number.isFinite(ergo)
    ? `${phase4EscapeHtml(step.ergonomicLabel)} · ${ergo}/100 effort`
    : '';

  const prerequisites =
    phase4Array(step.prerequisiteStepIds);

  return `
    <article class="p4-step ${
      step.isClosure ? 'p4-step-closure' : ''
    } ${
      step.isIntegration ? 'p4-step-integration' : ''
    }">

      <header class="p4-step-header">
        <div class="p4-step-number">
          ${phase4EscapeHtml(step.stepId)}
        </div>

        <div class="p4-step-heading">
          <div class="p4-step-phase">
            ${phase4EscapeHtml(step.phaseLabel)}
          </div>
          <h2>${phase4EscapeHtml(step.actionLabel)}</h2>
          <div class="p4-step-subassembly">
            ${phase4EscapeHtml(
              step.subassemblyName || 'Assembly'
            )}
          </div>
        </div>

        <div class="p4-step-count">
          ${step.displayNumber} / ${step.totalSteps}
        </div>
      </header>

      <div class="p4-step-progress">
        ${phase4RenderProgress(step.progress)}
      </div>

      <div class="p4-step-main">
        <section class="p4-diagram-area">
          ${step.diagramHtml}
        </section>

        <section class="p4-instruction-area">
          <div class="p4-action-banner">
            <span class="p4-orientation-icon">
              ${phase4EscapeHtml(step.orientationIcon)}
            </span>
            <span>
              ${phase4EscapeHtml(step.orientationLabel)}
            </span>
          </div>

          <div class="p4-instruction">
            ${phase4EscapeHtml(step.instruction)}
          </div>

          ${
            step.orientationInstruction
              ? `
                <div class="p4-orientation-note">
                  ${phase4EscapeHtml(
                    step.orientationInstruction
                  )}
                </div>
              `
              : ''
          }

          ${
            prerequisites.length
              ? `
                <div class="p4-prerequisite">
                  <strong>DO AFTER:</strong>
                  ${phase4EscapeHtml(
                    prerequisites.join(', ')
                  )}
                </div>
              `
              : ''
          }

          ${phase4RenderParts(step.parts)}
          ${phase4RenderHardware(step.hardware)}
          ${phase4RenderWarningList(step.warnings)}

          ${
            step.isSubassemblyCompletion
              ? `
                <div class="p4-complete">
                  <strong>SUB-ASSEMBLY COMPLETE</strong>
                  <div>
                    ${phase4EscapeHtml(
                      step.completionInstruction ||
                      `Set ${step.subassemblyName || 'this assembly'} aside until integration.`
                    )}
                  </div>
                </div>
              `
              : ''
          }

          ${
            ergoText
              ? `
                <div class="p4-ergo">
                  ${phase4EscapeHtml(ergoText)}
                </div>
              `
              : ''
          }
        </section>
      </div>
    </article>
  `;
}
