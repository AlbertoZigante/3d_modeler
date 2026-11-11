// Side-effect module: include once per page to apply the language chosen on the site
// (or in the modeller's own selector) and the display unit (mm / in) picked in the top bar.
import { initI18n, locale, setLocale } from './index.js';
import { getUnit, setUnit } from '../units/index.js';
import { bindSiteLinks } from '../shared/siteLink.js';
import { flagFor } from '../shared/flags.js';

// Language / unit problems must never stop the app itself from starting.
try {
  initI18n();
} catch (err) {
  console.error('[i18n] init failed — the app continues in English / mm', err);
}

// Flag dropdown (#lang-dd): trigger shows the current flag, menu items carry data-lang.
const langDd = document.getElementById('lang-dd');
if (langDd) {
  const sync = () => {
    langDd.querySelectorAll('[data-flag]').forEach((el) => { el.innerHTML = flagFor(el.dataset.flag === 'current' ? locale : el.dataset.flag); });
    langDd.querySelectorAll('.lang-menu [data-lang]').forEach((b) => b.setAttribute('aria-current', String(b.dataset.lang === locale)));
  };
  sync();
  langDd.querySelectorAll('.lang-menu [data-lang]').forEach((b) =>
    b.addEventListener('click', () => {
      setLocale(b.dataset.lang);
      sync();
      document.activeElement?.blur(); // closes the menu (it opens on hover / focus)
    }));
}

// mm / in switch (#unit-select is a checkbox: off = mm, on = in).
const unitSwitch = document.getElementById('unit-select');
if (unitSwitch) {
  const showUnit = () => { unitSwitch.checked = getUnit() === 'in'; };
  showUnit();
  unitSwitch.addEventListener('change', () => setUnit(unitSwitch.checked ? 'in' : 'mm'));
  document.addEventListener('dm:unitchange', showUnit);
}

// "Back" / "Home" links (data-site-home) go to the site's landing page in the current language.
try { bindSiteLinks(); } catch (err) { console.error('[siteLink] failed', err); }
