/**
 * units/index.js — display units (mm / inch). A GRAPHIC LAYER ONLY.
 *
 * The model, the engine, the API and every saved value are always in
 * millimetres, rounded to 2 decimals. This module only changes how
 * lengths are SHOWN and how typed lengths are READ:
 *
 *   - text:    "5 mm", "418 × 700 × 18 mm", "(mm)"  ->  inches   (convertText)
 *   - inputs:  any <input data-unit="mm"> shows inches, but its `.value`
 *              still reads back as millimetres (bindUnitInput)
 *   - exports: pdfExport / assembly manual run their text through convertText
 *
 * The choice is stored in localStorage ('dm_unit'); switching fires a
 * `dm:unitchange` event so the app can redraw.
 */
export const UNITS = ['mm', 'in'];
export const MM_PER_INCH = 25.4;
const STORAGE_KEY = 'dm_unit';

function readUnit() {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (UNITS.includes(saved)) return saved;
  } catch {}
  return 'mm';
}
let unit = globalThis.__DM_UNIT && UNITS.includes(globalThis.__DM_UNIT) ? globalThis.__DM_UNIT : readUnit();

export const getUnit = () => unit;

export function setUnit(next) {
  if (!UNITS.includes(next) || next === unit) return;
  unit = next;
  try { localStorage.setItem(STORAGE_KEY, unit); } catch {}
  refreshBoundInputs();
  document.dispatchEvent(new CustomEvent('dm:unitchange', { detail: { unit } }));
}

/** The model's precision: millimetres, 2 decimals. */
export const round2 = (n) => Math.round(n * 100) / 100;

// ---- numbers ---------------------------------------------------------------
const trim = (n, digits) => String(Number(n.toFixed(digits)));

/** mm (number) -> display number string in the current unit. */
export function lengthToDisplay(mm) {
  return unit === 'in' ? trim(mm / MM_PER_INCH, 3) : String(round2(mm));
}

/** Display number typed by the person -> mm, 2 decimals (what the model stores). */
export function displayToMm(value) {
  const n = Number(String(value).trim().replace(',', '.'));
  if (!Number.isFinite(n)) return NaN;
  return round2(unit === 'in' ? n * MM_PER_INCH : n);
}

// ---- text ------------------------------------------------------------------
// Material names ("Melamine White 18mm") are identifiers, not measurements.
let protectedRe = null;
export function protectNames(names) {
  const list = [...new Set((names ?? []).filter(Boolean))].sort((a, b) => b.length - a.length);
  protectedRe = list.length ? new RegExp(list.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g') : null;
}

const NUM = '-?\\d+(?:\\.\\d+)?';
const conv = (n) => trim(Number(n) / MM_PER_INCH, 3);
// 418 × 700 × 18 mm   |   418x700x18mm
const RE_SIZES = new RegExp(`((?:${NUM}\\s*[×x]\\s*)+${NUM})\\s*mm(?![²\\w])`, 'g');
// x:464.0 y:700.0 z:18.0 mm
const RE_AXES = new RegExp(`((?:[A-Za-z]:\\s?${NUM}\\s+)*[A-Za-z]:\\s?${NUM})\\s*mm(?![²\\w])`, 'g');
// 5mm   5 mm   -3.5 mm
const RE_SINGLE = new RegExp(`(${NUM})\\s?mm(?![²\\w])`, 'g');
// "(mm)", "in mm", "mm" label
const RE_LABEL = /(?<![\w²])mm(?![²\w])/g;

/** Lengths written as text ("… 5mm …") -> current unit. Identity in mm. */
export function convertText(s) {
  if (unit === 'mm' || typeof s !== 'string' || !/mm/.test(s)) return s;
  const kept = [];
  let out = protectedRe ? s.replace(protectedRe, (m) => { kept.push(m); return `\u0000${kept.length - 1}\u0000`; }) : s;
  out = out
    .replace(RE_SIZES, (_, list) => `${list.replace(new RegExp(NUM, 'g'), conv)} in`)
    .replace(RE_AXES, (_, list) => `${list.replace(new RegExp(NUM, 'g'), conv)} in`)
    .replace(RE_SINGLE, (_, n) => `${conv(n)} in`)
    .replace(/\bin mm\b/g, 'in inches')
    .replace(RE_LABEL, 'in');
  return kept.length ? out.replace(/\u0000(\d+)\u0000/g, (_, i) => kept[Number(i)]) : out;
}

/** Fixed-decimals number for tables: mm with `mmDigits`, inches with 3. */
export function lengthDigits(mm, mmDigits = 1) {
  return unit === 'in' ? trim(mm / MM_PER_INCH, 3) : mm.toFixed(mmDigits);
}

/** A length (mm number) as a short text in the current unit, e.g. "0.709 in" / "18 mm". */
export function formatLength(mm) {
  return `${lengthToDisplay(mm)} ${unit}`;
}

// ---- inputs ----------------------------------------------------------------
const hasDom = typeof HTMLInputElement !== 'undefined'; // engine tests run in plain Node
const nativeValue = hasDom ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value') : null;
const nativeAsNumber = hasDom ? Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'valueAsNumber') : null;
const bound = new Set();

function show(el, mm) {
  el.dataset.mmExact = String(mm);
  const text = lengthToDisplay(Number(mm));
  nativeValue.set.call(el, text);
  el.dataset.shown = text;
}

function readMm(el) {
  const raw = nativeValue.get.call(el);
  if (raw === '' || raw == null) return raw;
  // Untouched since we last displayed it -> the exact mm we were given (no rounding drift).
  if (el.dataset.mmExact !== undefined && raw === el.dataset.shown) return el.dataset.mmExact;
  const mm = displayToMm(raw);
  return Number.isFinite(mm) ? String(mm) : raw;
}

function convertLimits(el) {
  for (const attr of ['min', 'max', 'step']) {
    const key = `mm${attr[0].toUpperCase()}${attr.slice(1)}`;
    if (el.dataset[key] === undefined && el.hasAttribute(attr)) el.dataset[key] = el.getAttribute(attr);
    const orig = el.dataset[key];
    if (orig === undefined || orig === 'any') continue;
    const n = Number(orig);
    if (Number.isFinite(n)) el.setAttribute(attr, unit === 'in' ? trim(n / MM_PER_INCH, 4) : orig);
  }
}

/**
 * Make an <input data-unit="mm"> show the current unit while `.value` /
 * `.valueAsNumber` keep speaking millimetres to the rest of the app.
 */
export function bindUnitInput(el) {
  if (!hasDom || bound.has(el) || !(el instanceof HTMLInputElement)) return;
  bound.add(el);
  const initial = nativeValue.get.call(el);
  Object.defineProperty(el, 'value', {
    configurable: true,
    get() { return readMm(el); },
    set(v) {
      const n = Number(v);
      if (v === '' || v == null || !Number.isFinite(n)) { delete el.dataset.mmExact; nativeValue.set.call(el, v); return; }
      show(el, n);
    },
  });
  if (nativeAsNumber) {
    Object.defineProperty(el, 'valueAsNumber', {
      configurable: true,
      get() { const v = readMm(el); return v === '' ? NaN : Number(v); },
      set(v) { el.value = v; },
    });
  }
  convertLimits(el);
  const n = Number(initial);
  if (initial !== '' && Number.isFinite(n)) show(el, n);
}

function refreshBoundInputs() {
  for (const el of bound) {
    if (!el.isConnected) { bound.delete(el); continue; }
    const mm = el.dataset.mmExact;
    convertLimits(el);
    if (mm !== undefined) show(el, Number(mm));
  }
}

/** Bind every length input inside `root` (called by the DOM observer). */
export function bindUnitInputs(root) {
  if (root?.nodeType !== 1) return;
  if (root.matches?.('input[data-unit="mm"]')) bindUnitInput(root);
  root.querySelectorAll?.('input[data-unit="mm"]').forEach(bindUnitInput);
}
