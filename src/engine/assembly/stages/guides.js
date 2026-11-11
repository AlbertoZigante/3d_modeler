/**
 * Stage 3 — drawer guides on the carcass panels.
 *
 * The carcass-side half of every drawer runner (a bracket on a side
 * panel or a shelf) is mounted while that panel is still a loose, fully
 * accessible board — i.e. before the carcass exists. It is the same
 * "pre-install before the panel's first structural joint" rule used for
 * hinges, just hoisted ahead of the plinth and the carcass.
 */
export function runGuides(ctx) {
  const { emitStep, codeOf, guideEntries, rawById } = ctx;
  guideEntries.forEach((runner) => {
    const panelId = runner.panelB;
    const code = codeOf(panelId);
    // Only the panel being prepared is shown in the manual diagram.
    ctx.setUnit({ kind: 'guides', title: 'DRAWER GUIDES', unitPanelIds: [panelId] });
    const isShelf = /shelf|horizontal/i.test([rawById.get(panelId)?.name, rawById.get(panelId)?.role].filter(Boolean).join(' '));
    emitStep({
      kind: 'pre_install',
      phase: 'prepare',
      panelIds: [panelId],
      otherPanelIds: [],
      jointIds: [],
      hardware: [runner],
      orientation: 'flat',
      description: `Mount drawer guide ${runner.displayId} on ${code} before the panel joins the carcass.`,
      instruction: `Mount drawer guide ${runner.displayId} on ${isShelf ? 'shelf' : 'panel'} ${code} while it is loose and fully accessible.`,
    });
  });
}
