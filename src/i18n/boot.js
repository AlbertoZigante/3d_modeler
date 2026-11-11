// Side-effect module: include once per page to apply the language chosen on the site
// (or in the modeller's own selector) and the display unit (mm / in) picked in the top bar.
import { initI18n, locale, setLocale } from './index.js';
import { getUnit, setUnit } from '../units/index.js';

// Language / unit problems must never stop the app itself from starting.
try {
  initI18n();
} catch (err) {
  console.error('[i18n] init failed — the app continues in English / mm', err);
}

const langSelect = document.getElementById('lang-select');
if (langSelect) {
  langSelect.value = locale;
  langSelect.addEventListener('change', () => setLocale(langSelect.value));
}

const unitSelect = document.getElementById('unit-select');
if (unitSelect) {
  unitSelect.value = getUnit();
  unitSelect.addEventListener('change', () => setUnit(unitSelect.value));
}
