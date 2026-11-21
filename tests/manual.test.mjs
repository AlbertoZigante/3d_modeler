/**
 * tests/manual.test.mjs — the printable assembly manual, built from the API's steps (fixtures/api-steps) in en / fr / it.
 * (Replaces the old pdfExport-assembly test, which ran the JS planner: the planner is the server's now.)
 * Run with: node tests/manual.test.mjs
 */
import { readFileSync, readdirSync } from 'node:fs';
import { buildAssemblyManualModel } from '../src/engine/assembly/manual/model.js';
import { buildAssemblyManualHtml, exportAssemblyManualPdf } from '../src/engine/assembly/manual/export.js';

let pass = 0, fail = 0;
const check = (name, ok) => { ok ? pass++ : (fail++, console.error('  FAIL:', name)); };
const json = (rel) => JSON.parse(readFileSync(new URL(rel, import.meta.url), 'utf8'));
const unescape = (h) => h.replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

const names = readdirSync(new URL('../fixtures/api-steps/', import.meta.url)).filter((f) => f.endsWith('.assembly.json')).map((f) => f.replace('.assembly.json', ''));
check('fixtures present', names.length >= 15);

for (const name of names) {
  const plan = json(`../fixtures/api-steps/${name}.assembly.json`);
  const raw = json(`../fixtures/golden/${name}/raw.json`);
  const resolved = json(`../fixtures/golden/${name}/resolved.json`);
  const opts = { panels: raw, resolvedPanels: resolved };
  const en = buildAssemblyManualModel(plan, { ...opts, locale: 'en' });

  check(`${name}: one manual step per plan step, numbered 1..n`, en.steps.length === plan.steps.length && en.steps.every((s, i) => s.displayNumber === i + 1 && s.totalSteps === plan.steps.length));
  check(`${name}: step ids keep the server's order`, en.steps.every((s, i) => s.stepId === plan.steps[i].stepId));
  const roleOfPanel = new Map();
  plan.steps.forEach((s) => { const id = s.panelIds[0]; if (id && !roleOfPanel.has(id)) roleOfPanel.set(id, s.role); });
  const parts = en.parts ?? [];
  check(`${name}: the parts list takes each panel's role from the server's steps`, parts.length === 0 || parts.every((p) => (roleOfPanel.get(p.id) ?? 'unknown') === p.role));

  for (const locale of ['en', 'fr', 'it']) {
    const html = unescape(buildAssemblyManualHtml(plan, { ...opts, locale, title: 'T', subtitle: 'S' }));
    check(`${name} ${locale}: HTML has no undefined / NaN / [object`, !/undefined|NaN|\[object/.test(html));
    const model = buildAssemblyManualModel(plan, { ...opts, locale });
    const missing = model.steps.filter((s) => !html.includes(s.instruction));
    check(`${name} ${locale}: every step's instruction is in the HTML${missing.length ? ` (missing ${missing.length})` : ''}`, missing.length === 0);
    if (locale !== 'en' && plan.steps.length) {
      check(`${name} ${locale}: instructions are translated, not the server's English`, model.steps.every((s, i) => s.instruction !== plan.steps[i].instruction));
      check(`${name} ${locale}: warnings are translated`, model.steps.every((s, i) => s.warnings.every((w, k) => w !== plan.steps[i].warnings[k])));
    }
  }

  // steps from the OLD client-side planner (no verb) still render: their English prose passes through unchanged
  const legacy = json(`../fixtures/golden/${name}/sequence.json`);
  const legacyModel = buildAssemblyManualModel(legacy, { ...opts, locale: 'fr' });
  check(`${name}: legacy (verb-less) steps pass through untouched`, legacyModel.steps.every((s, i) => s.instruction === legacy.steps[i].instruction));
}

console.log('opening the manual');
{
  const plan = json(`../fixtures/api-steps/${names[0]}.assembly.json`);
  const calls = [];
  const target = { closed: false, document: { open: () => calls.push('open'), write: (h) => calls.push(['write', h.length]), close: () => calls.push('close') } };
  globalThis.window = { open: () => { calls.push('window.open'); return null; } };
  const ok = exportAssemblyManualPdf(plan, { mode: 'open', targetWindow: target });
  check('writes into the tab opened by the click handler', ok === true && calls[0] === 'open' && calls[1][0] === 'write' && calls[1][1] > 1000 && calls[2] === 'close');
  check('does not open a second tab when given one', !calls.includes('window.open'));
  calls.length = 0;
  check('a closed target falls back to window.open (and reports failure when blocked)', exportAssemblyManualPdf(plan, { mode: 'open', targetWindow: { ...target, closed: true } }) === false && calls[0] === 'window.open');
  check('mode other than open returns the HTML', typeof exportAssemblyManualPdf(plan, { mode: 'html' }) === 'string');
  delete globalThis.window;
}

console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
