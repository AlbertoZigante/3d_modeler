/**
 * i18n/index.js — language layer (en / fr / it).
 *
 * The app's source text is English. Translations live in catalog.js as
 * [english, fr, it] rows; English stays the fallback for anything missing.
 * The language comes from the site: `?lang=fr` in the URL (saved in
 * localStorage so it survives navigation between the app's pages);
 * nothing received -> English.
 *
 * translateDom() rewrites text nodes and title/placeholder/aria-label
 * attributes, and a MutationObserver keeps doing it for everything the
 * UI renders later (toolbar, inspector, toasts, warnings), so the
 * rendering code does not need to know about languages.
 * `tr()` is for strings the code needs as text (alerts, PDF labels...).
 */
import { CATALOG } from './catalog.js';
import { convertText, bindUnitInputs, getUnit } from '../units/index.js';

export const LOCALES = ['en', 'fr', 'it'];
export const DEFAULT_LOCALE = 'en';
const STORAGE_KEY = 'dm_lang';

function resolveLocale() {
  if (LOCALES.includes(globalThis.__DM_LOCALE)) return globalThis.__DM_LOCALE; // tests / tooling
  try {
    const fromUrl = new URLSearchParams(location.search).get('lang');
    if (LOCALES.includes(fromUrl)) {
      try { localStorage.setItem(STORAGE_KEY, fromUrl); } catch {}
      return fromUrl;
    }
    const saved = localStorage.getItem(STORAGE_KEY);
    if (LOCALES.includes(saved)) return saved;
  } catch {}
  return DEFAULT_LOCALE;
}

export let locale = resolveLocale();

const norm = (s) => s.replace(/\s+/g, ' ').trim();
const esc = (s) => s.replace(/[.*+?^$()|[\]\\]/g, '\\$&');

// ---- compile the catalog for the active locale --------------------------
const exact = new Map();
const patterns = [];
function compileCatalog() {
  exact.clear();
  patterns.length = 0;
  if (locale === 'en') return;
  const col = LOCALES.indexOf(locale); // 1 = fr, 2 = it
  for (const row of CATALOG) {
    const src = norm(row[0]);
    const dst = row[col];
    if (!dst) continue;
    if (src.includes('{}')) {
      const re = new RegExp('^' + src.split('{}').map(esc).join('(.+?)') + '$', 's');
      patterns.push({ re, dst, len: src.length });
    } else exact.set(src, dst);
  }
  patterns.sort((a, b) => b.len - a.len); // most specific first
}
compileCatalog();

const SEPARATORS = ['  •  ', ' — ', ' · ', ' ↔ ', ' / ', '/', ', '];
const PREFIXES = ['— ', '· ', '• ', '↺ ', '↳ ', '🔒 '];

/** Translate one string (already whitespace-normalised). Returns it unchanged if unknown. */
function tx(s) {
  if (!s || locale === 'en') return s;
  if (exact.has(s)) return exact.get(s);
  for (const p of patterns) {
    const m = p.re.exec(s);
    if (m) return p.dst.replace(/\{(\d+)\}/g, (_, i) => tx(m[i] ?? '') || (m[i] ?? ''));
  }
  for (const sep of SEPARATORS) {
    if (!s.includes(sep)) continue;
    // "<timestamp> — <whole message>": translate everything after the first separator as one message.
    const at = s.indexOf(sep);
    const tail = s.slice(at + sep.length);
    const tailTx = tx(tail);
    if (tailTx !== tail) return tx(s.slice(0, at)) + sep + tailTx;
    const parts = s.split(sep);
    const out = parts.map(tx);
    if (out.some((o, i) => o !== parts[i])) return out.join(sep);
  }
  for (const pre of PREFIXES) {
    if (s.startsWith(pre)) {
      const rest = tx(s.slice(pre.length));
      if (rest !== s.slice(pre.length)) return pre + rest;
    }
  }
  return s;
}

/** Translate an English string for use in code (alerts, PDF text, tooltips set from JS). */
export function tr(text) {
  if (typeof text !== 'string') return text;
  const lead = text.match(/^\s*/)[0];
  const trail = text.match(/\s*$/)[0];
  const core = norm(text);
  const out = tx(core);
  return out === core ? text : lead + out + trail;
}

/** Language + display unit in one step (what the DOM layer and exports use). */
export function localize(text) {
  if (typeof text !== 'string') return text;
  const out = tr(text);
  return getUnit() === 'mm' ? out : convertText(out);
}

const identity = () => locale === 'en' && getUnit() === 'mm';

/** Translate with a context, for words that mean different things in different places ('grain|Free' vs plan 'Free'). */
export function trc(context, text) {
  return exact.get(`${context}|${text}`) ?? tr(text);
}

const ATTRS = ['title', 'placeholder', 'aria-label', 'alt'];
const SKIP = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'CODE', 'PRE']);

// What the app wrote (src) and what we turned it into (out), per text node / attribute,
// so the language or unit can be changed live without the app re-rendering.
const textState = new WeakMap();
const attrState = new WeakMap();

function translateTextNode(node) {
  const raw = node.nodeValue;
  if (!raw || !/[A-Za-z]{2}/.test(raw)) return;
  const st = textState.get(node);
  if (st && raw === st.out) return; // our own write
  const out = localize(raw);
  textState.set(node, { src: raw, out });
  if (out !== raw) node.nodeValue = out;
}

function translateAttrs(el) {
  for (const a of ATTRS) {
    const v = el.getAttribute?.(a);
    if (!v) continue;
    const per = attrState.get(el) ?? {};
    if (per[a] && v === per[a].out) continue; // our own write
    const out = localize(v);
    per[a] = { src: v, out };
    attrState.set(el, per);
    if (out !== v) el.setAttribute(a, out);
  }
}

function eachNode(root, onText, onEl) {
  if (root.nodeType === Node.TEXT_NODE) return onText(root);
  if (root.nodeType !== Node.ELEMENT_NODE || SKIP.has(root.tagName) || root.closest?.('[data-no-i18n]')) return;
  onEl(root);
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (n.nodeType === Node.TEXT_NODE) {
      if (!SKIP.has(n.parentNode?.tagName) && !n.parentNode?.closest?.('[data-no-i18n]')) onText(n);
    } else if (!SKIP.has(n.tagName) && !n.closest('[data-no-i18n]')) onEl(n);
  }
}

export function translateDom(root = document.body) {
  if (!root) return;
  bindUnitInputs(root);
  eachNode(root, translateTextNode, translateAttrs);
}

/** Re-render all remembered text from its original, after a language / unit change. */
export function relocalizeDom(root = document.body) {
  if (!root) return;
  const redoText = (n) => {
    const st = textState.get(n);
    if (!st) return translateTextNode(n);
    if (n.nodeValue !== st.out) return translateTextNode(n); // the app changed it meanwhile
    const out = localize(st.src);
    st.out = out;
    if (n.nodeValue !== out) n.nodeValue = out;
  };
  const redoAttrs = (el) => {
    const per = attrState.get(el);
    if (!per) return translateAttrs(el);
    for (const a of Object.keys(per)) {
      if (el.getAttribute(a) !== per[a].out) continue;
      const out = localize(per[a].src);
      per[a].out = out;
      if (el.getAttribute(a) !== out) el.setAttribute(a, out);
    }
    translateAttrs(el);
  };
  eachNode(root, redoText, redoAttrs);
}

let originalTitle = null;
let started = false;

/** Call once per page, as early as possible (after the DOM exists). */
export function initI18n() {
  document.documentElement.lang = locale;
  if (started) return;
  started = true;
  originalTitle = document.title;
  document.title = localize(originalTitle);
  translateDom(document.body);
  new MutationObserver((records) => {
    try {
      for (const r of records) {
        if (r.type === 'childList') r.addedNodes.forEach((n) => translateDom(n));
        else if (r.type === 'characterData') translateTextNode(r.target);
        else if (r.type === 'attributes' && r.target.nodeType === 1) translateAttrs(r.target);
      }
    } catch (err) {
      console.error('[i18n] translation skipped', err);
    }
  }).observe(document.body, {
    childList: true, subtree: true, characterData: true,
    attributes: true, attributeFilter: ATTRS,
  });
  // A unit change re-shows every remembered text in the new unit.
  document.addEventListener('dm:unitchange', () => relocalizeDom());
}

/**
 * Change the language while the app is running (no reload, so the design is kept).
 * Also updates ?lang= in the address so a reload keeps the choice.
 */
export function setLocale(next) {
  if (!LOCALES.includes(next) || next === locale) return;
  locale = next;
  try { localStorage.setItem(STORAGE_KEY, next); } catch {}
  try {
    const url = new URL(location.href);
    url.searchParams.set('lang', next);
    history.replaceState(history.state, '', url);
  } catch {}
  compileCatalog();
  document.documentElement.lang = next;
  if (originalTitle !== null) document.title = localize(originalTitle);
  relocalizeDom();
  document.dispatchEvent(new CustomEvent('dm:langchange', { detail: { locale: next } }));
}

/**
 * Translate a complete HTML document string (e.g. the assembly manual that is
 * written into a new window) and set its <html lang>. English input is
 * returned untouched.
 */
export function translateHtml(html) {
  if (identity() || typeof DOMParser === 'undefined') return html;
  const doc = new DOMParser().parseFromString(html, 'text/html');
  translateDom(doc.body);
  doc.title = localize(doc.title);
  doc.documentElement.lang = locale;
  return '<!doctype html>\n' + doc.documentElement.outerHTML;
}

const EDGE_LETTERS = {
  en: { left: 'L', right: 'R', top: 'T', bottom: 'B' },
  fr: { left: 'G', right: 'D', top: 'H', bottom: 'B' },
  it: { left: 'S', right: 'D', top: 'A', bottom: 'B' },
};

/** Banded edges as short letters in the active language, from the API's `bandedEdges` array. */
export function edgeLabel(bandedEdges) {
  if (!bandedEdges?.length) return '—';
  const letters = EDGE_LETTERS[locale] ?? EDGE_LETTERS.en;
  return bandedEdges.map((e) => letters[e] ?? e).join(',');
}

/** Date/time for documents, in the active language. */
export function formatDateTime(date = new Date()) {
  return date.toLocaleString(locale === 'en' ? undefined : locale);
}
