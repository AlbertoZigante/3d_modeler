/**
 * stepEmitter.js — turns the stages' "partial" step descriptions into
 * full AssemblyStep objects (index, ids, human text, ergonomics,
 * orientation / reposition tracking). Owns the running step list.
 */
import { desiredOrientation, roleOfStepPanel } from './roles.js';
import { ergonomicStepScore } from './scoring.js';
import { actionForStep, humanInstruction, warningsForStep } from './humanModel.js';

// Section title of the steps that are not a single component.
const STAGE_TITLES = { guides: 'DRAWER GUIDES', carcass: 'CARCASS', integration: 'FINAL ASSEMBLY' };

export function createStepEmitter(ctx) {
  const { rawById, resolvedById, nameById, codeOf, clusterOfPanel } = ctx;
  const steps = [];
  let stepIndex = 1;
  let assemblyOrientation = 'flat';
  let currentStage = null;
  let currentUnit = null; // the component under construction (door, drawer, plinth...) or null

  const repositionCostBetween = (from, to) => {
    if (!from || !to || from === to || from === 'unknown' || to === 'unknown') return 0;
    return 1;
  };

  const pushStep = (partial) => {
    const primaryId = partial.panelIds?.[0];
    const sub = primaryId ? clusterOfPanel.get(primaryId) : null;
    const role = partial.role ?? roleOfStepPanel(primaryId, rawById);
    const index = stepIndex++;
    const panelCodes = partial.panelIds.map((id) => codeOf(id));
    const instruction = partial.instruction ?? humanInstruction({
      kind: partial.kind, phase: partial.phase, role,
      panelCode: panelCodes[0], otherCodes: partial.otherPanelIds?.map(codeOf) || [],
      hardware: partial.hardware, description: partial.description,
    });
    const derived = {
      stepId: `S${String(index).padStart(2, '0')}`,
      role,
      action: partial.action ?? actionForStep(partial.kind, partial.phase, role),
      subassemblyId: partial.subassemblyId ?? sub?.id ?? null,
      subassemblyName: partial.subassemblyName ?? sub?.name ?? null,
      instruction,
      warnings: [...new Set([...(partial.warnings || []), ...warningsForStep({ kind: partial.kind, phase: partial.phase, role })])],
      prerequisiteStepIds: partial.prerequisiteStepIds || [],
      subassemblyComplete: false,
    };
    steps.push({
      index,
      panelNames: partial.panelIds.map((id) => nameById.get(id) ?? '?'),
      panelCodes,
      ...derived,
      ...partial,
      // Keep the derived human-readable fields authoritative after spreading partial.
      ...derived,
    });
  };

  const emitStep = (partial) => {
    const primaryId = partial.panelIds?.[0];
    const primaryPanel = rawById.get(primaryId);
    const primaryResolved = resolvedById.get(primaryId);
    const primaryRole = roleOfStepPanel(primaryId, rawById);
    const orientation = partial.orientation ?? desiredOrientation(primaryRole);
    const repositionCost = repositionCostBetween(assemblyOrientation, orientation);
    const requiresReposition = repositionCost > 0;
    const ergonomic = ergonomicStepScore({
      panel: primaryPanel,
      resolved: primaryResolved,
      role: primaryRole,
      joints: partial.jointObjects ?? [],
      orientation,
      fromOrientation: assemblyOrientation,
      kind: partial.kind,
    });
    ergonomic.reposition = Math.max(ergonomic.reposition, repositionCost * 2);
    ergonomic.score = Math.round((ergonomic.score + repositionCost * 4) * 10) / 10;
    if (orientation !== 'unknown') assemblyOrientation = orientation;
    const primarySubassembly = primaryId != null ? clusterOfPanel.get(primaryId) : null;

    const unit = currentUnit;
    pushStep({
      componentKind: unit?.kind ?? currentStage,
      componentTitle: unit?.title ?? STAGE_TITLES[currentStage] ?? null,
      componentSubtitle: unit?.subtitle ?? null,
      // Panels shown in the manual diagram for this step; null = whole furniture.
      unitPanelIds: unit?.unitPanelIds ?? null,
      repeatCount: unit?.repeatCount ?? 1,
      repeatLabels: unit?.repeatLabels ?? null,
      phase: partial.phase ?? (partial.kind === 'integrate' ? 'integration' : partial.kind === 'pre_install' ? 'prepare' : 'subassembly'),
      stage: currentStage,
      orientation,
      requiresReposition,
      repositionCost,
      ergonomic,
      subassemblyId: partial.subassemblyId ?? unit?.subassemblyId ?? primarySubassembly?.id ?? null,
      subassemblyName: partial.subassemblyName ?? unit?.subassemblyName ?? primarySubassembly?.name ?? null,
      clusterKind: partial.clusterKind ?? primarySubassembly?.role ?? null,
      ...partial,
    });
  };

  return {
    steps,
    emitStep,
    setStage: (stageId) => { currentStage = stageId; currentUnit = null; },
    setUnit: (unit) => { currentUnit = unit; },
  };
}
