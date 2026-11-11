// ---------------------------------------------------------------
// Phase-1 semantic ordering helpers
// ---------------------------------------------------------------
// Plinth / kickboard / toe-kick (also the Italian "zoccolo").
const PLINTH_TEXT = /plinth|kick[ _-]?board|toe[ _-]?kick|zoccolo/;

export function textOfPanel(panel) {
  return [panel?.name, panel?.pieceCode, panel?.code, panel?.type, panel?.role]
    .filter(Boolean).join(' ').toLowerCase();
}

export function panelRole(panel) {
  if (!panel) return 'unknown';
  if (panel.isDoor) return 'door';
  if (panel.isDrawerFront) return 'drawer_front';
  if (panel.isDrawerBoxPanel) return 'drawer_box';
  if (panel.isPlinth || panel.isPlinthPanel || panel.role === 'plinth') return 'plinth';
  if (panel.isBack || panel.role === 'back') return 'back';
  if (panel.isTop || panel.role === 'top') return 'top';
  if (panel.isBottom || panel.role === 'bottom') return 'bottom';
  if (panel.isVerticalDivider || panel.role === 'vertical_divider') return 'vertical';
  if (panel.isShelf || panel.role === 'horizontal_shelf') return 'horizontal';

  const t = textOfPanel(panel);
  if (/drawer[ _-]*(front|face)|front[ _-]*drawer/.test(t)) return 'drawer_front';
  if (/drawer[ _-]*(box|side)|drawer/.test(t) && /box|side/.test(t)) return 'drawer_box';
  if (/door/.test(t)) return 'door';
  if (PLINTH_TEXT.test(t)) return 'plinth';
  if (/back|rear/.test(t)) return 'back';
  if (/top|upper|roof/.test(t)) return 'top';
  if (/bottom|base/.test(t)) return 'bottom';
  if (/vertical|divider|partition|upright|centre.?panel|center.?panel/.test(t)) return 'vertical';
  if (/shelf|shelves|horizontal|fixed.?shelf|adjustable.?shelf/.test(t)) return 'horizontal';
  return 'unknown';
}

export function clusterRole(cluster, rawById) {
  const roles = [...cluster].map((id) => panelRole(rawById.get(id)));
  if (roles.every((r) => r === 'door')) return 'door';
  if (roles.every((r) => r === 'drawer_box')) return 'drawer_box';
  if (roles.every((r) => r === 'drawer_front')) return 'drawer_front';
  if (roles.every((r) => r === 'plinth')) return 'plinth';
  if (roles.includes('door')) return 'door';
  if (roles.includes('drawer_box')) return 'drawer_box';
  return 'carcass';
}

export function desiredOrientation(role) {
  if (role === 'door' || role === 'drawer_box' || role === 'drawer_front') return 'flat';
  if (role === 'back') return 'rear_access';
  if (role === 'top') return 'upright';
  return 'flat';
}

export function panelPriority(role) {
  return ({
    door: 10,
    drawer_box: 20,
    drawer_front: 25,
    plinth: 30,
    bottom: 40,
    vertical: 50,
    horizontal: 60,
    unknown: 65,
    back: 90,
    top: 100,
  })[role] ?? 65;
}

export function clusterPriority(role) {
  return ({ door: 10, drawer_box: 20, drawer_front: 25, plinth: 35, carcass: 40 })[role] ?? 40;
}

export function roleOfStepPanel(panelId, rawById) {
  return panelRole(rawById.get(panelId));
}
