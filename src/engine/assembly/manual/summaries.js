import { panelRole } from '../roles.js';
import { PHASE4_PHASES, phase4Array, phase4PhaseIndex, phase4Unique } from './format.js';

export function phase4Warnings(step) {
  return phase4Unique(
    step.warnings || []
  );
}

export function phase4Hardware(step) {
  return phase4Array(step.hardware)
    .map((hardware) => {
      return (
        hardware.displayId ||
        hardware.id ||
        hardware.hardware?.series ||
        hardware.hardware?.kind ||
        'Hardware'
      );
    })
    .filter(Boolean);
}

export function phase4Parts(step) {
  return phase4Unique([
    ...(step.panelCodes || []),
    ...(step.panelNames || []),
  ]);
}

export function phase4BuildProgress(steps, currentIndex) {
  const currentStep = steps[currentIndex];
  const currentPhase =
    currentStep?.phase || 'prepare';

  const phaseIndex =
    phase4PhaseIndex(currentPhase);

  return PHASE4_PHASES.map(
    (phase, index) => ({
      ...phase,
      index,
      state:
        index < phaseIndex
          ? 'complete'
          : index === phaseIndex
            ? 'current'
            : 'future',
    })
  );
}

export function phase4BuildSubassemblySummary(sequence) {
  const map = new Map();

  phase4Array(sequence?.steps).forEach(
    (step) => {
      if (!step.subassemblyId) return;

      if (!map.has(step.subassemblyId)) {
        map.set(step.subassemblyId, {
          id: step.subassemblyId,
          name:
            step.subassemblyName ||
            step.subassemblyId,
          role:
            step.clusterKind ||
            'assembly',
          panelCodes: new Set(),
          stepIds: [],
          complete: false,
          integrated: false,
        });
      }

      const item = map.get(
        step.subassemblyId
      );

      phase4Array(step.panelCodes).forEach(
        (code) => item.panelCodes.add(code)
      );

      item.stepIds.push(step.stepId);

      if (step.subassemblyComplete) {
        item.complete = true;
      }

      if (step.action === 'integrate') {
        item.integrated = true;
      }
    }
  );

  return [...map.values()].map((item) => ({
    ...item,
    panelCodes: [...item.panelCodes],
  }));
}

export function phase4NumericDimension(
  value
) {
  const n = Number(value);

  return Number.isFinite(n) && n > 0
    ? n
    : 0;
}

export function phase4PanelDimensions(
  panel,
  resolved
) {
  const width =
    phase4NumericDimension(
      panel?.width
    ) ||
    phase4NumericDimension(
      panel?.w
    ) ||
    phase4NumericDimension(
      panel?.lengthX
    ) ||
    phase4NumericDimension(
      resolved?.width
    );

  const height =
    phase4NumericDimension(
      panel?.height
    ) ||
    phase4NumericDimension(
      panel?.h
    ) ||
    phase4NumericDimension(
      panel?.lengthY
    ) ||
    phase4NumericDimension(
      resolved?.height
    );

  const thickness =
    phase4NumericDimension(
      panel?.thickness
    ) ||
    phase4NumericDimension(
      panel?.depth
    ) ||
    phase4NumericDimension(
      panel?.d
    ) ||
    phase4NumericDimension(
      resolved?.thickness
    );

  return {
    width,
    height,
    thickness,
  };
}

export function phase4RoleLabel(
  role
) {
  return ({
    bottom: 'Bottom',
    vertical: 'Vertical divider',
    horizontal: 'Shelf',
    back: 'Back',
    top: 'Top',
    door: 'Door',
    drawer_box: 'Drawer box',
    drawer_front: 'Drawer front',
    unknown: 'Panel',
  })[role] || 'Panel';
}

export function phase4BuildPartsSummary(
  sequence,
  options = {}
) {
  const parts = new Map();

  const rawPanels = phase4Array(
    options.panels
  );

  const resolvedPanels = phase4Array(
    options.resolvedPanels
  );

  const resolvedById =
    new Map(
      resolvedPanels.map(
        (panel) => [panel.id, panel]
      )
    );

  const steps =
    phase4Array(sequence?.steps);

  /*
   * First source of truth:
   * the actual model panels.
   *
   * This ensures that EVERY panel appears,
   * even if a panel does not happen to be
   * represented by a structural assembly step.
   */
  rawPanels.forEach((panel) => {
    if (!panel?.id) return;

    const resolved =
      resolvedById.get(panel.id);

    const role =
      panelRole(panel);

    const dimensions =
      phase4PanelDimensions(
        panel,
        resolved
      );

    parts.set(panel.id, {
      id: panel.id,

      code:
        panel.pieceCode ??
        panel.code ??
        resolved?.pieceCode ??
        panel.id,

      name:
        panel.name ??
        resolved?.name ??
        panel.id,

      role,

      roleLabel:
        phase4RoleLabel(role),

      subassembly:
        null,

      width:
        dimensions.width,

      height:
        dimensions.height,

      thickness:
        dimensions.thickness,

      area:
        dimensions.width *
        dimensions.height,

      aspectRatio:
        dimensions.height > 0
          ? dimensions.width /
            dimensions.height
          : 1,
    });
  });

  /*
   * Add subassembly information from the
   * actual assembly sequence.
   */
  steps.forEach((step) => {

    const subassembly =
      step.subassemblyName ||
      null;

    phase4Array(
      step.panelIds
    ).forEach((id) => {

      const part =
        parts.get(id);

      if (!part) return;

      if (
        !part.subassembly &&
        subassembly
      ) {
        part.subassembly =
          subassembly;
      }
    });
  });

  return [...parts.values()];
}

export function phase4BuildHardwareSummary(sequence) {
  const hardware = new Map();

  phase4Array(sequence?.steps).forEach(
    (step) => {
      [...phase4Array(step.hardware), ...phase4Array(step.repeatHardware)].forEach(
        (entry) => {
          const id =
            entry.displayId ||
            entry.id ||
            entry.hardware?.series ||
            entry.hardware?.kind ||
            'hardware';

          if (!hardware.has(id)) {
            hardware.set(id, {
              id,
              uses: [],
              count: 0,
            });
          }

          const item = hardware.get(id);
          item.count += 1;
          item.uses.push(step.stepId);
        }
      );
    }
  );

  return [...hardware.values()];
}
