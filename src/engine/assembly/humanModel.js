// ---------------------------------------------------------------
// Phase-3 human-readable assembly model
// ---------------------------------------------------------------
export function subassemblyLabel(role, ordinal) {
  if (role === 'door') return `Door assembly ${ordinal}`;
  if (role === 'drawer_box') return `Drawer assembly ${ordinal}`;
  if (role === 'drawer_front') return `Drawer front assembly ${ordinal}`;
  if (role === 'carcass') return ordinal === 1 ? 'Main carcass' : `Carcass assembly ${ordinal}`;
  return `Sub-assembly ${ordinal}`;
}

export function actionForStep(kind, phase, role) {
  if (kind === 'pre_install') return 'prepare';
  if (kind === 'integrate') return 'integrate';
  if (kind === 'unattached') return 'inspect';
  if (phase === 'closure') return 'close';
  if (role === 'door' || role === 'drawer_box' || role === 'drawer_front') return 'assemble';
  return 'install';
}

export function roleDisplay(role) {
  return ({
    door: 'door', drawer_box: 'drawer box', drawer_front: 'drawer front',
    back: 'back panel', top: 'top panel', bottom: 'bottom panel',
    vertical: 'vertical divider', horizontal: 'horizontal shelf',
  })[role] || 'component';
}

export function humanInstruction({ kind, phase, role, panelCode, otherCodes, hardware, description }) {
  if (kind === 'pre_install') {
    const hw = hardware?.[0];
    const hwName = hw?.displayId || hw?.hardware?.series || hw?.hardware?.kind || 'hardware';
    return `Prepare ${panelCode}: install ${hwName} while the panel is separate and fully accessible.`;
  }
  if (kind === 'integrate') return description;
  if (kind === 'unattached') return `Identify ${panelCode} and set it aside; no assembly connection is currently modeled for this part.`;
  if (phase === 'closure' && role === 'back') return `Install ${panelCode} as the back panel after all accessible internal components are installed.`;
  if (phase === 'closure' && role === 'top') return `Install ${panelCode} as the top panel only after the internal assembly and back panel are complete.`;
  if (role === 'vertical') return `Install ${panelCode} as the vertical divider before installing the top panel.`;
  if (role === 'horizontal') return `Install ${panelCode} as a horizontal shelf before closing the rear with the back panel.`;
  if (kind === 'join' && otherCodes?.length) return `Attach ${panelCode} to ${otherCodes.join(', ')}.`;
  return description;
}

export function warningsForStep({ kind, phase, role }) {
  const warnings = [];
  if (role === 'door') {
    warnings.push('Build the door flat before hanging it on the carcass.');
    if (kind === 'integrate') warnings.push('Support the door while connecting the pre-fitted hinges.');
  }
  if (role === 'drawer_box') warnings.push('Complete the drawer box before inserting it into the carcass.');
  if (role === 'vertical') warnings.push('Install vertical dividers before the top panel closes access.');
  if (role === 'horizontal') warnings.push('Install horizontal shelves before the back panel closes rear access.');
  if (role === 'back') warnings.push('Do not install the back until all required internal components are in place.');
  if (role === 'top') warnings.push('Do not install the top until the internal components and back panel are complete.');
  if (kind === 'pre_install') warnings.push('Keep the panel separate while fitting this hardware.');
  return [...new Set(warnings)];
}

export function orientationInstruction(orientation) {
  return ({
    flat: 'Work with the component flat on a supported surface.',
    rear_access: 'Keep the rear/open face accessible for this operation.',
    front_access: 'Keep the front face accessible for this operation.',
    upright: 'Work with the furniture upright and stable.',
    unknown: 'Use the orientation that keeps the joint and tool access clear.',
  })[orientation] || '';
}

export function finalizeHumanReadableModel(steps) {
  // Completion means the independent build is finished, not that the
  // later integration step has happened. Keep integration out of this map.
  const lastBuildStepBySubassembly = new Map();
  steps.forEach((step) => {
    if (step.subassemblyId && step.action !== 'integrate') {
      lastBuildStepBySubassembly.set(step.subassemblyId, step);
    }
  });

  steps.forEach((step) => {
    step.stepId = `S${String(step.index).padStart(2, '0')}`;
    step.prerequisiteStepIds = [];
    const warnings = [...(step.warnings || [])];

    if (step.action === 'integrate' && step.subassemblyId) {
      // Integration depends on the completion of the participating subassemblies.
      const ids = step.integrationSubassemblyIds || [];
      ids.forEach((id) => {
        const last = lastBuildStepBySubassembly.get(id);
        if (last && last.stepId !== step.stepId) step.prerequisiteStepIds.push(last.stepId);
      });
    }

    if (step.role === 'back') {
      const priorInternal = steps.filter((s) => s.index < step.index && s.phase === 'internal');
      if (priorInternal.length) step.prerequisiteStepIds.push(priorInternal[priorInternal.length - 1].stepId);
    }
    if (step.role === 'top') {
      const priorClosure = steps.filter((s) => s.index < step.index && (s.role === 'back' || s.phase === 'internal'));
      if (priorClosure.length) step.prerequisiteStepIds.push(priorClosure[priorClosure.length - 1].stepId);
    }

    step.prerequisiteStepIds = [...new Set(step.prerequisiteStepIds)];
    step.orientationInstruction = orientationInstruction(step.orientation);
    step.warnings = [...new Set(warnings)];
  });

  // Mark the last action in each independent subassembly. This gives the PDF
  // renderer a clean "finish and set aside" boundary without inventing one.
  lastBuildStepBySubassembly.forEach((step) => {
    if (step.phase === 'subassembly' || step.phase === 'prepare') {
      step.subassemblyComplete = true;
      if (step.action !== 'integrate') {
        step.completionInstruction = `Sub-assembly complete: ${step.subassemblyName}. Set it aside until final integration.`;
      }
    }
  });
  return steps;
}
