/**
 * handles.js — door / drawer-front handles as assembly hardware.
 *
 * A handle is bought hardware, not a panel (see shared/handle.js), so
 * buildHardwarePlan knows nothing about it. The assembly planner needs
 * it as a hardware entry so it can be scheduled right after the door or
 * drawer front it belongs to is built.
 *
 * The entry mimics the shape of the hinge/runner entries
 * (kind, displayId, hardware{brand,series,kind}) so the manual layer
 * renders it with no special case.
 */
import { computeHandlePlacement } from '../../shared/handle.js';

/**
 * @param {Array} rawPanels - RAW graph (carries isDoor/hinge/doorSign...)
 * @param {Map<string, object>} resolvedById - resolved geometry (width/height/thickness)
 * @param {(id: string) => string} codeOf
 * @returns {Map<string, object>} panelId -> handle hardware entry
 */
export function buildHandleEntries(rawPanels, resolvedById, codeOf) {
  const found = [];
  rawPanels.forEach((raw) => {
    if (!raw.isDoor && !raw.isDrawerFront) return;
    const r = resolvedById.get(raw.id);
    if (!r || r.hidden) return;
    const placement = computeHandlePlacement({
      ...raw,
      width: r.width,
      height: r.height,
      thickness: r.thickness,
    });
    if (placement) found.push({ raw, placement });
  });

  // Numbered in build order: doors first, then drawer fronts.
  found.sort((a, b) => (a.raw.isDoor ? 0 : 1) - (b.raw.isDoor ? 0 : 1) || codeOf(a.raw.id).localeCompare(codeOf(b.raw.id)));

  const byPanel = new Map();
  found.forEach(({ raw, placement }, i) => {
    const lengthMm = placement.dims.length;
    byPanel.set(raw.id, {
      kind: 'handle',
      displayId: `HN${String(i + 1).padStart(2, '0')}`,
      panelA: raw.id,
      panelB: null,
      axis: placement.axis,
      hinge: raw.isDoor ? (raw.hinge ?? 'left') : null,
      hardware: {
        kind: 'handle',
        brand: 'Generic',
        series: `Bar handle ${lengthMm} mm`,
        lengthMm,
      },
    });
  });
  return byPanel;
}

/** Human wording for where the handle goes on its panel. */
export function describeHandlePlacement(entry) {
  if (entry.axis === 'y') {
    const free = entry.hinge === 'right' ? 'left' : 'right';
    return `vertical, on the ${free} edge (opposite the hinges)`;
  }
  return 'horizontal, centred on the front';
}
