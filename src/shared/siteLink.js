/**
 * shared/siteLink.js — links from the app back to the marketing site (repo: site).
 *
 * Config (Vite env, see .env.example):
 *   VITE_SITE_URL  base URL of the site. In `vite dev` defaults to
 *                  http://localhost:4321; in a production build it must be set,
 *                  otherwise the links keep their local fallback href.
 *
 * Any element with `data-site-home` is pointed at the site's landing page in the
 * visitor's current language (e.g. http://localhost:4321/fr).
 */
import { locale } from '../i18n/index.js';

const env = import.meta.env ?? {};
const SITE_URL = String(env.VITE_SITE_URL ?? (env.DEV ? 'http://localhost:4321' : '')).replace(/\/+$/, '');

export const siteEnabled = SITE_URL.length > 0;
export const siteHomeUrl = () => `${SITE_URL}/${locale}`;

export function bindSiteLinks() {
  if (!siteEnabled) return;
  document.querySelectorAll('[data-site-home]').forEach((a) => { a.href = siteHomeUrl(); });
}
