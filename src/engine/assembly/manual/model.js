import { PHASE4_PHASES, phase4ActionLabel, phase4Array, phase4ErgonomicLabel, phase4OrientationIcon, phase4OrientationLabel, phase4PhaseIndex, phase4Unique } from './format.js';
import { phase4BuildVisualParts } from './visualParts.js';
import { phase4BuildAssemblyStateSvg, phase4StepDiagram } from './diagram.js';
import { phase4BuildHardwareSummary, phase4BuildPartsSummary, phase4BuildProgress, phase4BuildSubassemblySummary, phase4Hardware, phase4Parts, phase4Warnings } from './summaries.js';

/**
 * Build the Phase-4 presentation model.
 *
 * This is deliberately renderer-neutral. A native PDF renderer can consume
 * it directly, while the bundled HTML renderer below provides an immediate
 * print-to-PDF implementation.
 */
export function buildAssemblyManualModel(
  sequence,
  options = {}
) {
  const steps = phase4Array(sequence?.steps);

  const title =
    options.title ||
    options.furnitureName ||
    'Furniture Assembly Manual';

  const subtitle =
    options.subtitle ||
    'Human-first assembly instructions';

  const toolNames = phase4Unique(
    options.tools || [
      'Screwdriver',
      'Assembly surface',
    ]
  );

  const placedPanelIds = new Set();
  const stepModels = steps.map(
    (step, index) => {

      const currentPanelIds =
        phase4Unique(
          step.panelIds
        );

      /*
      * Snapshot of the furniture immediately
      * AFTER this step.
      */
      const placedAfterStep = [
        ...new Set([
          ...placedPanelIds,
          ...currentPanelIds,
        ]),
      ];

      const visualParts =
        phase4BuildVisualParts(
          options
        );

      const assemblyStateSvg =
        phase4BuildAssemblyStateSvg(
          step,
          visualParts,
          [...placedPanelIds]
        );

      /*
      * Update only after taking the snapshot,
      * so the step can still distinguish the
      * newly added panel(s).
      */
      currentPanelIds.forEach(
        (id) =>
          placedPanelIds.add(id)
      );
      const warnings =
        phase4Warnings(step);

      const hardware =
        phase4Hardware(step);

      const parts =
        phase4Parts(step);

      const progress =
        phase4BuildProgress(
          steps,
          index
        );

      const ergonomicScore =
        Number(step.ergonomic?.score);

      return {
        ...step,

        displayNumber:
          index + 1,

        totalSteps:
          steps.length,

        phaseIndex:
          phase4PhaseIndex(
            step.phase
          ),

        phaseLabel:
          PHASE4_PHASES[
            phase4PhaseIndex(
              step.phase
            )
          ]?.label ||
          step.phase ||
          'Assembly',

        actionLabel:
          phase4ActionLabel(
            step.action
          ),

        orientationLabel:
          phase4OrientationLabel(
            step.orientation
          ),

        orientationIcon:
          phase4OrientationIcon(
            step.orientation
          ),

        ergonomicLabel:
          phase4ErgonomicLabel(
            ergonomicScore
          ),

        warnings,
        hardware,
        parts,
        progress,

        diagramHtml:
          assemblyStateSvg ||
          phase4StepDiagram(step),

        hasWarnings:
          warnings.length > 0,

        hasHardware:
          hardware.length > 0,

        hasPrerequisites:
          phase4Array(
            step.prerequisiteStepIds
          ).length > 0,

        isSubassemblyCompletion:
          Boolean(
            step.subassemblyComplete
          ),

        isIntegration:
          step.action === 'integrate',

        isClosure:
          step.phase === 'closure',
      };
    }
  );

  return {
    version: 'phase4',

    title,

    subtitle,

    metadata: {
      estimatedTime:
        options.estimatedTime || null,

      people:
        options.people || '1–2',

      tools:
        toolNames,

      safety:
        options.safety ||
        'Assemble on a stable, protected surface. Support large panels when required.',
    },

    phases:
      PHASE4_PHASES,

    parts:
      phase4BuildPartsSummary(
        sequence,
        options
      ),

    hardware:
      phase4BuildHardwareSummary(
        sequence
      ),

    subassemblies:
      phase4BuildSubassemblySummary(
        sequence
      ),

    visualPanels:
      phase4Array(
        options.panels
      ),

    resolvedPanels:
      phase4Array(
        options.resolvedPanels
      ),

    steps:
      stepModels,

    finalChecklist: [
      'Check that all structural fasteners are tightened.',
      'Confirm doors and drawers move freely.',
      'Adjust door gaps and fronts if required.',
      'Confirm the furniture is stable and level.',
      'Verify no hardware or loose parts remain unused.',
    ],
  };
}

// ---------------------------------------------------------------
// Phase-4 HTML renderer
// ---------------------------------------------------------------
