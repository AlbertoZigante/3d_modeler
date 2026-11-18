/**
 * i18n/steps.js — RENDER: structured assembly steps (from the API) -> text in a language.
 *
 * Pure (no DOM, no globals): every function takes the locale explicitly, so it is tested in node for all three
 * languages. Missing translation => returns null and `localizeStep` keeps the server's English prose for that field,
 * so a gap degrades to English instead of breaking the manual (tests/stepsI18n.test.mjs makes any gap a failing test).
 *
 * A step whose planner is the old client-side JS (no `verb`) is returned unchanged: that path only has English prose.
 */
import { STEP_STRINGS } from './stepStrings.js';

const table = (locale) => STEP_STRINGS[locale] ?? STEP_STRINGS.en;

function format(locale, key, value) {
  if (Array.isArray(value)) return value.join(', ');
  const s = table(locale);
  if (key === 'placement') return s.placements[value] ?? String(value);
  if (key === 'brand' && value === 'Generic') return s.misc.generic;
  if (key === 'series') {
    const m = /^Bar handle (\d+(?:\.\d+)?) mm$/.exec(String(value));
    if (m) return s.misc.barHandle.replace('{mm}', m[1]);
  }
  return String(value);
}

/** Fills `{name}` placeholders; returns null if the template or a needed param is missing. */
export function fill(locale, template, params = {}) {
  if (typeof template !== 'string') return null;
  let missing = false;
  const out = template.replace(/\{(\w+)\}/g, (_, k) => {
    if (params[k] === undefined || params[k] === null) { missing = true; return ''; }
    return format(locale, k, params[k]);
  });
  return missing ? null : out;
}

export const renderDescription = (step, locale) => {
  const v = table(locale).verbs[step.verb];
  return fill(locale, v?.d ?? v?.i, step.params);
};

export const renderInstruction = (step, locale) => {
  const v = table(locale).verbs[step.instructionVerb ?? step.verb];
  return fill(locale, v?.i ?? v?.d, step.params);
};

export const renderWarning = (code, locale) => table(locale).warnings[code] ?? null;
export const renderTool = (code, locale) => table(locale).tools[code] ?? null;
export const renderToolNote = (code, locale) => table(locale).toolNotes[code] ?? null;
export const renderOrientation = (orientation, locale) => table(locale).orientation[orientation] ?? null;

export function renderComponentTitle(c, locale) {
  if (!c) return null;
  const t = table(locale).component;
  switch (c.kind) {
    case 'door': return c.ordinal != null ? fill(locale, t.doorN, { n: c.ordinal }) : t.door;
    case 'plinth': return c.ordinal != null ? fill(locale, t.plinthN, { n: c.ordinal }) : t.plinth;
    case 'drawer': return fill(locale, t.drawer, { n: c.number });
    case 'drawers': return fill(locale, t.drawers, { count: c.count });
    default: return t[c.kind] ?? null;
  }
}

export function renderComponentSubtitle(c, locale) {
  if (!c || c.kind !== 'drawers') return null;
  return fill(locale, table(locale).component.drawersSubtitle, { numbers: c.numbers, count: c.count });
}

/** Name of a sub-assembly from its structured reference ({role, ordinal} | {drawers, count} | {drawer} | {fallback}). */
export function renderSubassemblyName(ref, locale) {
  if (!ref) return null;
  const t = table(locale).subassembly;
  if (ref.role) {
    const n = ref.ordinal;
    if (ref.role === 'plinth') return n === 1 ? t.plinth : fill(locale, t.plinthN, { n });
    if (ref.role === 'carcass') return n === 1 ? t.carcass : fill(locale, t.carcassN, { n });
    return fill(locale, t[ref.role] ?? t.generic, { n });
  }
  if (ref.drawers) return fill(locale, t.drawers, { numbers: ref.drawers, count: ref.count });
  if (ref.drawer != null) return fill(locale, t.drawerOne, { n: ref.drawer });
  if (ref.fallback === 'drawer') return t.fallbackDrawer;
  if (ref.fallback === 'door') return t.fallbackDoor;
  return null;
}

export function renderCompletion(ref, locale) {
  const name = renderSubassemblyName(ref, locale);
  return name == null ? null : fill(locale, table(locale).completion, { name });
}

/**
 * The step with every human-readable string rendered in `locale` (fields the codes cannot render keep the
 * server's prose). Pure: returns a new object.
 */
export function localizeStep(step, locale) {
  if (!step || !step.verb) return step;
  const out = { ...step };
  const set = (field, value) => { if (value != null) out[field] = value; };
  set('description', renderDescription(step, locale));
  set('instruction', renderInstruction(step, locale));
  set('orientationInstruction', renderOrientation(step.orientation, locale));
  set('componentTitle', renderComponentTitle(step.component, locale));
  set('componentSubtitle', renderComponentSubtitle(step.component, locale));
  set('subassemblyName', renderSubassemblyName(step.subassemblyRef, locale));
  if (step.completionRef) set('completionInstruction', renderCompletion(step.completionRef, locale));
  if (Array.isArray(step.warningCodes)) {
    out.warnings = step.warningCodes.map((c, i) => renderWarning(c, locale) ?? step.warnings?.[i] ?? c);
  }
  if (Array.isArray(step.toolCodes)) {
    out.tools = step.toolCodes.map((c, i) => renderTool(c, locale) ?? step.tools?.[i] ?? c);
  }
  if (Array.isArray(step.toolNoteCodes)) {
    out.toolNotes = step.toolNoteCodes.map((c, i) => renderToolNote(c, locale) ?? step.toolNotes?.[i] ?? c);
  }
  return out;
}

/** Same for a whole API plan / sequence: { steps, clusters, toolsSummary... } -> localized copy. */
export function localizePlan(plan, locale) {
  if (!plan) return plan;
  const out = { ...plan, steps: (plan.steps ?? []).map((s) => localizeStep(s, locale)) };
  if (Array.isArray(plan.clusters)) {
    out.clusters = plan.clusters.map((c) => ({
      ...c,
      name: c.ordinal != null ? renderSubassemblyName({ role: c.role, ordinal: c.ordinal }, locale) ?? c.name : c.name,
    }));
  }
  if (Array.isArray(plan.toolsSummaryCodes)) {
    out.toolsSummary = plan.toolsSummaryCodes.map((c, i) => renderTool(c, locale) ?? plan.toolsSummary?.[i] ?? c);
  }
  return out;
}
