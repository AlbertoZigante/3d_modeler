export const PHASE4_PHASES = [
  {
    id: 'prepare',
    label: 'Prepare',
    shortLabel: 'PREP',
  },
  {
    id: 'subassembly',
    label: 'Sub-assemblies',
    shortLabel: 'BUILD',
  },
  {
    id: 'internal',
    label: 'Internal',
    shortLabel: 'INTERNAL',
  },
  {
    id: 'closure',
    label: 'Close carcass',
    shortLabel: 'CLOSE',
  },
  {
    id: 'integration',
    label: 'Final integration',
    shortLabel: 'INTEGRATE',
  },
];

export function phase4EscapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function phase4Array(value) {
  return Array.isArray(value) ? value : [];
}

export function phase4Unique(values) {
  return [...new Set(
    phase4Array(values).filter(Boolean)
  )];
}

export function phase4PhaseIndex(phase) {
  const index = PHASE4_PHASES.findIndex(
    (p) => p.id === phase
  );

  return index < 0 ? 0 : index;
}

export function phase4ActionLabel(action) {
  return ({
    prepare: 'PREPARE',
    assemble: 'ASSEMBLE',
    install: 'INSTALL',
    close: 'CLOSE',
    integrate: 'PLUG IN',
    inspect: 'CHECK',
  })[action] || String(action || 'DO');
}

export function phase4OrientationLabel(orientation) {
  return ({
    flat: 'WORK FLAT',
    rear_access: 'KEEP REAR ACCESSIBLE',
    front_access: 'KEEP FRONT ACCESSIBLE',
    upright: 'WORK UPRIGHT',
    unknown: 'KEEP ACCESS CLEAR',
  })[orientation] || 'KEEP ACCESS CLEAR';
}

export function phase4OrientationIcon(orientation) {
  return ({
    flat: '▱',
    rear_access: '↙',
    front_access: '↗',
    upright: '▯',
    unknown: '◇',
  })[orientation] || '◇';
}

export function phase4ErgonomicLabel(score) {
  if (!Number.isFinite(score)) return '—';
  if (score <= 25) return 'Easy';
  if (score <= 45) return 'Moderate';
  if (score <= 65) return 'Careful';
  return 'Difficult';
}

export function phase4PickNumber(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
