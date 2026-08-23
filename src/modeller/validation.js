// Resize-drags and typed fields: outright rejects if a panel's own
// width/height would exceed PANEL_SIZE_LIMITS_MM — returns the
// offending field ('width'|'height'), or null if within limits.
// Separate from findDesignLimitViolation below, which bounds the
// overall scene rather than any single panel's own dimensions.
export function findPanelSizeViolation(dims) {
  if (dims.width > PANEL_SIZE_LIMITS_MM.width) return 'width';
  if (dims.height > PANEL_SIZE_LIMITS_MM.height) return 'height';
  return null;
}


// Resize-drags and typed fields: outright rejects if the FINAL
// position + dimensions would violate any axis — returns the
// offending axis, or null if the edit is fine as proposed.
function findDesignLimitViolation(rotation, positionMm, dims) {
  const halfExtents = computeWorldHalfExtents({ rotation, ...dims });
  for (const axis of ['x', 'y', 'z']) {
    const limit = DESIGN_LIMITS_MM[axis];
    const min = positionMm[axis] - halfExtents[axis];
    const max = positionMm[axis] + halfExtents[axis];
    if (min < limit.min - 0.01 || max > limit.max + 0.01) return axis;
  }
  return null;
}