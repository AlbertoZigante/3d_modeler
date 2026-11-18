/**
 * tests/stepsI18n.test.mjs — phase 10: the API's structured assembly steps render in every language.
 *   1. contract coverage: every verb / warning code / tool code / component kind / role the OpenAPI contract
 *      (src/api/openapi.json enums) can return has a translation in en, fr AND it — a new server code without a
 *      translation fails here, not in front of a user
 *   2. the three languages agree: same keys, same {placeholders}, fr/it are not English
 *   3. fixtures exported from the API (fixtures/api-steps, scripts: api repo `export_steps_fixtures.py`):
 *      English rendering == the planner's own prose, field by field; fr / it render fully (no gaps, no `{}` left)
 *   4. the printable manual built from the API steps has the same CONTENT as the one built from the client-side JS
 *      planner (fixtures/golden/<design>/sequence.json) — only the prose wording may differ
 * Run with: node tests/stepsI18n.test.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { STEP_STRINGS, STEP_LOCALES } from '../src/i18n/stepStrings.js';
import {
  localizePlan, localizeStep, renderComponentSubtitle, renderComponentTitle, renderDescription, renderInstruction,
  renderSubassemblyName, renderTool, renderToolNote, renderWarning,
} from '../src/i18n/steps.js';
import { buildAssemblyManualModel } from '../src/engine/assembly/manual/model.js';

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : (fail++, console.error('  FAIL:', name)); };
const json = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));

const spec = json('../src/api/openapi.json');
const step = spec.components.schemas.AssemblyStep.properties;
const enumOf = (prop) => prop.enum ?? prop.items?.enum ?? (prop.anyOf ?? []).flatMap((p) => p.enum ?? p.items?.enum ?? []);
const VERBS = enumOf(step.verb);
const INSTR_VERBS = enumOf(step.instructionVerb);
const WARNINGS = enumOf(step.warningCodes);
const TOOLS = enumOf(step.toolCodes);
const TOOL_NOTES = enumOf(step.toolNoteCodes);
const COMPONENT_KINDS = enumOf(spec.components.schemas.StepComponent.properties.kind);
const ROLES = enumOf(spec.components.schemas.AssemblyCluster.properties.role);
const ORIENTATIONS = ['flat', 'rear_access', 'front_access', 'upright', 'unknown'];

const holes = (s) => [...new Set([...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]))].sort().join(',');

console.log('the contract exposes the codes');
check('verbs in the contract', VERBS.length >= 25);
check('instructionVerb uses the same verb list', JSON.stringify([...INSTR_VERBS].sort()) === JSON.stringify([...VERBS].sort()));
check('warning codes in the contract', WARNINGS.length >= 8);
check('tool codes in the contract', TOOLS.length >= 4 && TOOL_NOTES.length >= 3);

console.log('every code has a translation in every language');
for (const loc of STEP_LOCALES) {
  const t = STEP_STRINGS[loc];
  for (const v of VERBS) check(`${loc}: verb ${v} has a template`, !!(t.verbs[v]?.d || t.verbs[v]?.i));
  for (const w of WARNINGS) check(`${loc}: warning ${w}`, !!t.warnings[w]);
  for (const c of TOOLS) check(`${loc}: tool ${c}`, !!t.tools[c]);
  for (const c of TOOL_NOTES) check(`${loc}: tool note ${c}`, !!t.toolNotes[c]);
  for (const o of ORIENTATIONS) check(`${loc}: orientation ${o}`, !!t.orientation[o]);
  for (const p of ['vertical_left', 'vertical_right', 'horizontal']) check(`${loc}: placement ${p}`, !!t.placements[p]);
  for (const k of COMPONENT_KINDS) check(`${loc}: component ${k}`, !!(t.component[k] || (k === 'drawer' || k === 'drawers' ? t.component[k] : null)));
  for (const r of ROLES) check(`${loc}: sub-assembly role ${r}`, !!(t.subassembly[r] || r === 'plinth' || r === 'carcass'));
  check(`${loc}: completion template`, !!t.completion);
}

console.log('the languages agree (keys, placeholders) and fr/it are really translated');
{
  const en = STEP_STRINGS.en;
  const flat = (o, prefix = '') => Object.entries(o).flatMap(([k, v]) => (typeof v === 'string' ? [[prefix + k, v]] : flat(v, `${prefix}${k}.`)));
  const enFlat = new Map(flat(en));
  for (const loc of ['fr', 'it']) {
    const other = new Map(flat(STEP_STRINGS[loc]));
    check(`${loc}: same set of keys as en`, JSON.stringify([...other.keys()].sort()) === JSON.stringify([...enFlat.keys()].sort()));
    for (const [key, text] of enFlat) {
      const t = other.get(key);
      if (t == null) continue;
      check(`${loc}: placeholders of ${key}`, holes(t) === holes(text));
      // product / spec words that stay as they are in every language
      const sameOk = /^(misc\.|tools\.(drill_bit_pilot_4_5|drill_bit_clearance_7)$)/.test(key) && key !== 'misc.generic' && key !== 'misc.barHandle';
      if (!sameOk) check(`${loc}: ${key} is not left in English`, t !== text);
    }
  }
}

console.log('rendering fixtures exported from the API');
const dir = new URL('../fixtures/api-steps/', import.meta.url);
const fixtureNames = readdirSync(dir).filter((f) => f.endsWith('.assembly.json'));
check('fixtures exported from the API are present', fixtureNames.length >= 15);
const verbsSeen = new Set(), warningsSeen = new Set();
for (const file of fixtureNames) {
  const name = file.replace('.assembly.json', '');
  const plan = JSON.parse(readFileSync(new URL(file, dir), 'utf8'));
  const en = localizePlan(plan, 'en');
  check(`${name}: steps keep their count`, en.steps.length === plan.steps.length);
  plan.steps.forEach((s, i) => {
    verbsSeen.add(s.verb); verbsSeen.add(s.instructionVerb);
    s.warningCodes.forEach((w) => warningsSeen.add(w));
    const e = en.steps[i];
    const same = (field) => JSON.stringify(e[field]) === JSON.stringify(s[field]);
    const ok = ['description', 'instruction', 'warnings', 'componentTitle', 'componentSubtitle', 'subassemblyName',
      'orientationInstruction', 'completionInstruction', 'tools', 'toolNotes'].filter((f) => !same(f));
    check(`${name} ${s.stepId}: English render equals the planner's prose${ok.length ? ' — differs: ' + ok.join(',') : ''}`, ok.length === 0);
    for (const loc of ['fr', 'it']) {
      const l = localizeStep(s, loc);
      for (const f of ['description', 'instruction']) check(`${name} ${s.stepId} ${loc}: ${f} is rendered, not the server English`, l[f] !== s[f] || /^[A-Z0-9 ]+$/.test(s[f]));
      const all = [l.description, l.instruction, l.orientationInstruction, l.componentTitle, l.componentSubtitle, l.subassemblyName, l.completionInstruction, ...l.warnings, ...l.tools, ...l.toolNotes].filter(Boolean);
      check(`${name} ${s.stepId} ${loc}: no unfilled placeholder`, all.every((x) => !/[{}]/.test(x)));
      check(`${name} ${s.stepId} ${loc}: warnings / tools fully translated`, l.warnings.every((w, k) => w !== s.warnings[k]) && l.tools.every((w, k) => w !== s.tools[k]) );
    }
  });
  const frPlan = localizePlan(plan, 'fr');
  check(`${name}: cluster names rendered`, frPlan.clusters.every((c) => c.name && c.name !== plan.clusters.find((p) => p.id === c.id).name || c.role === 'plinth'));
}
check('fixtures exercise a good part of the verbs', verbsSeen.size >= 20);
check('fixtures exercise warnings', warningsSeen.size >= 6);

console.log('direct renderers');
{
  check('title: several doors', renderComponentTitle({ kind: 'door', ordinal: 2 }, 'it') === 'ANTA 2');
  check('title: one plinth', renderComponentTitle({ kind: 'plinth', ordinal: null }, 'fr') === 'PLINTHE');
  check('title: identical drawers', renderComponentTitle({ kind: 'drawers', count: 3, numbers: [1, 2, 3] }, 'en') === 'DRAWER ×3');
  check('subtitle: identical drawers (fr)', renderComponentSubtitle({ kind: 'drawers', count: 3, numbers: [1, 2, 3] }, 'fr') === 'Les tiroirs 1, 2, 3 sont identiques — construire ce tiroir 3 fois');
  check('sub-assembly: main carcass', renderSubassemblyName({ role: 'carcass', ordinal: 1 }, 'it') === 'Cassa principale');
  check('sub-assembly: second carcass', renderSubassemblyName({ role: 'carcass', ordinal: 2 }, 'en') === 'Carcass assembly 2');
  check('sub-assembly: drawers', renderSubassemblyName({ drawers: [1, 2], count: 2 }, 'fr') === 'Tiroirs 1, 2 (×2)');
  check('sub-assembly: fallback door', renderSubassemblyName({ fallback: 'door' }, 'it') === "Montaggio dell'anta");
  check('unknown code -> null (caller keeps the server prose)', renderWarning('nope', 'fr') === null && renderTool('nope', 'it') === null && renderToolNote('nope', 'en') === null);
  check('missing param -> null', renderDescription({ verb: 'hang_door', params: { door: 'A' } }, 'en') === null);
  const s = { verb: 'hang_door', instructionVerb: 'hang_door', params: { door: 'D1', carcass: 'L1' }, description: 'x', instruction: 'x', warnings: [], warningCodes: [] };
  check('description + instruction (it)', renderDescription(s, 'it') === 'Appendi D1 a L1 usando le cerniere già montate.' && renderInstruction(s, 'it') === 'Appendi D1 a L1 usando le cerniere già montate.');
  check('a step from the JS planner (no verb) is returned unchanged', localizeStep({ instruction: 'Attach A to B.' }, 'fr').instruction === 'Attach A to B.');
  check('Bar handle series is localized', localizeStep({ verb: 'fit_handle_door', instructionVerb: 'fit_handle_door', params: { handle: 'HN01', panel: 'D1', series: 'Bar handle 128 mm', placement: 'vertical_left' }, warnings: [], warningCodes: [], description: '', instruction: '' }, 'fr').instruction === "Poser la poignée HN01 (Poignée barre 128 mm) sur D1 : verticale, sur le bord gauche (à l'opposé des charnières).");
}

console.log('manual content: API steps vs the client-side JS planner');
{
  const CONTENT = ['stepId', 'displayNumber', 'totalSteps', 'kind', 'phase', 'phaseLabel', 'action', 'actionLabel', 'role', 'stage', 'orientation',
    'orientationLabel', 'panelIds', 'otherPanelIds', 'panelCodes', 'panelNames', 'jointIds', 'prerequisiteStepIds', 'subassemblyId',
    'subassemblyComplete', 'repeatCount', 'unitPanelIds', 'isClosure', 'isIntegration', 'hasWarnings', 'hasHardware', 'hasPrerequisites',
    'componentKind', 'clusterKind', 'ergonomicLabel', 'requiresReposition'];
  const PROSE = ['description', 'instruction', 'warnings', 'componentTitle', 'componentSubtitle', 'subassemblyName', 'orientationInstruction', 'completionInstruction'];
  const goldens = readdirSync(new URL('../fixtures/golden/', import.meta.url));
  let compared = 0;
  for (const name of goldens) {
    if (!fixtureNames.includes(`${name}.assembly.json`)) continue;
    const api = JSON.parse(readFileSync(new URL(`${name}.assembly.json`, dir), 'utf8'));
    const js = json(`../fixtures/golden/${name}/sequence.json`);
    const opts = { panels: [], resolvedPanels: [], locale: 'en' };
    const a = buildAssemblyManualModel(api, opts), b = buildAssemblyManualModel(js, opts);
    check(`${name}: same number of steps in the manual`, a.steps.length === b.steps.length);
    a.steps.forEach((sa, i) => {
      const sb = b.steps[i];
      if (!sb) return;
      const diff = CONTENT.filter((f) => JSON.stringify(sa[f]) !== JSON.stringify(sb[f]));
      check(`${name} step ${i + 1}: manual content identical${diff.length ? ' — differs: ' + diff.join(',') : ''}`, diff.length === 0);
      // in English the prose is the same too (the API steps render back to the planner's own wording)
      const pd = PROSE.filter((f) => JSON.stringify(sa[f] ?? null) !== JSON.stringify(sb[f] ?? null));
      check(`${name} step ${i + 1}: English prose identical${pd.length ? ' — differs: ' + pd.join(',') : ''}`, pd.length === 0);
      const hwA = (sa.hardware ?? []).map((h) => h.displayId ?? h.id ?? h.label ?? JSON.stringify(h)), hwB = (sb.hardware ?? []).map((h) => h.displayId ?? h.id ?? h.label ?? JSON.stringify(h));
      check(`${name} step ${i + 1}: same hardware`, JSON.stringify(hwA) === JSON.stringify(hwB));
    });
    // French manual: no step keeps the English prose
    const fr = buildAssemblyManualModel(api, { ...opts, locale: 'fr' });
    check(`${name}: French manual differs from English in every step's instruction`, fr.steps.every((s, i) => s.instruction !== a.steps[i].instruction));
    compared++;
  }
  check('manual comparison ran on the golden designs', compared >= 15);
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
