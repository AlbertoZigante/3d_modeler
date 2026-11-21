/**
 * tests/e2e/smoke.mjs — REAL-BROWSER smoke test of the thin client against the real API (migration plan phase 12).
 *
 *   npm run test:e2e:browser            (starts uvicorn from ../api and the Vite dev server itself, tears them down)
 *   API_DIR=... BASE_URL=http://localhost:5173 API_URL=http://localhost:8000 npm run test:e2e:browser
 *
 * Covers what no unit test can: the built app in Chromium builds the default cabinet, and
 *   - cut list opens  (POST /v1/bom)            - nesting opens (POST /v1/nesting)
 *   - assembly manual (POST /v1/assembly), in English AND French (structured steps rendered by i18n/steps.js)
 *   - joint report PDF + JSON (POST /v1/hardware-plan)
 *   - API failure: the person gets a message, the editor keeps working
 *   - no uncaught page error, no request outside the API contract
 * Needs: playwright (devDependency) + a Chromium (`npx playwright install chromium`), python deps of ../api.
 */
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { chromium } from 'playwright';

const BASE = process.env.BASE_URL ?? 'http://localhost:5173';
const API = process.env.API_URL ?? 'http://localhost:8000';
const API_DIR = process.env.API_DIR ?? fileURLToPath(new URL('../../../api', import.meta.url));
let pass = 0, fail = 0;
const check = (name, ok, extra = '') => { ok ? pass++ : (fail++, console.error(`  FAIL: ${name} ${extra}`)); if (ok) console.log(`  ok: ${name}`); };

const up = async (url) => { try { return (await fetch(url)).ok; } catch { return false; } };
const children = [];
async function ensure(url, cmd, args, opts) {
  if (await up(url)) return;
  // shell:true so Windows resolves npx.cmd (spawn('npx') alone fails with ENOENT there)
  const child = spawn(cmd, args, { ...opts, stdio: 'ignore', shell: process.platform === 'win32' });
  child.on('error', (e) => { throw new Error(`could not spawn ${cmd}: ${e.message}`); });
  children.push(child);
  for (let i = 0; i < 100 && !(await up(url)); i++) await new Promise((r) => setTimeout(r, 300));
  if (!(await up(url))) throw new Error(`could not start ${cmd} for ${url}`);
}

await ensure(`${API}/health`, 'python', ['-m', 'uvicorn', 'app.main:app', '--port', new URL(API).port, '--log-level', 'warning'],
  { cwd: API_DIR, env: { ...process.env, API_KEYS: '', ENV: 'development', RATE_LIMIT: '100000/minute', RATE_LIMIT_HEAVY: '100000/minute' } });
await ensure(`${BASE}/modeller.html`, 'npx', ['vite', '--port', new URL(BASE).port, '--host', 'localhost'],
  { cwd: fileURLToPath(new URL('../..', import.meta.url)), env: { ...process.env, VITE_API_URL: API } });

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1500, height: 900 }, acceptDownloads: true });
const page = await context.newPage();
// PDFs open in a tab as a blob URL, which headless Chromium has no viewer for: capture the blobs the app creates instead.
await context.addInitScript(() => {
  window.__pdfs = [];
  const orig = URL.createObjectURL.bind(URL);
  URL.createObjectURL = (blob) => {
    if (blob && /pdf/.test(blob.type)) blob.slice(0, 5).text().then((head) => window.__pdfs.push({ size: blob.size, head }));
    return orig(blob);
  };
});
const pageErrors = [], apiCalls = [];
page.on('pageerror', (e) => pageErrors.push(e.message));
page.on('response', (r) => { const u = new URL(r.url()); if (r.url().startsWith(API) && u.pathname.startsWith('/v1/')) apiCalls.push(`${r.request().method()} ${u.pathname} ${r.status()}`); });

async function popupFrom(buttonSelector) {
  const [popup] = await Promise.all([page.waitForEvent('popup', { timeout: 20000 }), page.click(buttonSelector)]);
  await popup.waitForLoadState('domcontentloaded').catch(() => {});
  return popup;
}
const hits = (re) => apiCalls.filter((c) => re.test(c));
// click a button that opens a PDF tab; resolves with the PDF the app generated for it
async function pdfFrom(buttonSelector) {
  const before = await page.evaluate(() => window.__pdfs.length);
  const [popup] = await Promise.all([page.waitForEvent('popup', { timeout: 20000 }), page.click(buttonSelector)]);
  await page.waitForFunction((n) => window.__pdfs.length > n, before, { timeout: 30000 });
  const pdf = await page.evaluate((n) => window.__pdfs[n], before);
  await popup.close().catch(() => {});
  return pdf;
}

try {
  await page.goto(`${BASE}/modeller.html`);
  await page.waitForSelector('#print-assembly-btn');
  if (await page.isVisible('#onboarding-skip')) await page.click('#onboarding-skip');
  await page.waitForTimeout(800);
  check('app loads with the default cabinet', (await page.textContent('body')).includes('LE0001'));

  console.log('cut list + nesting');
  let pdf = await pdfFrom('#topbar-open-cutlist-btn');
  check('cut list PDF is generated', pdf.head === '%PDF-' && pdf.size > 2000, JSON.stringify(pdf));
  pdf = await pdfFrom('#topbar-nest-cutlist-btn');
  check('nesting PDF is generated', pdf.head === '%PDF-' && pdf.size > 2000, JSON.stringify(pdf));
  check('POST /v1/bom and /v1/nesting answered 200', hits(/POST \/v1\/bom 200/).length >= 1 && hits(/POST \/v1\/nesting 200/).length >= 1, JSON.stringify(apiCalls));

  console.log('assembly manual (en, fr)');
  let popup = await popupFrom('#print-assembly-btn');
  await popup.waitForFunction(() => document.body && document.body.innerText.length > 200, null, { timeout: 20000 });
  const en = await popup.textContent('body');
  check('assembly manual (English) has steps', /Attach|Install|Start the/.test(en), en.slice(0, 200));
  await popup.close();
  check('POST /v1/assembly answered 200', hits(/POST \/v1\/assembly 200/).length >= 1);

  await page.click('#lang-dd .lang-trigger');
  await page.locator('#lang-dd .lang-menu').getByText(/Fran/).first().click();
  await page.waitForTimeout(500);
  popup = await popupFrom('#print-assembly-btn');
  await popup.waitForFunction(() => document.body && document.body.innerText.length > 200, null, { timeout: 20000 });
  const fr = await popup.textContent('body');
  check('assembly manual (French) is in French', /Fixer|Installer|Commencer/.test(fr) && !/Attach LE|Install .* as the/.test(fr), fr.slice(0, 300));
  await popup.close();

  console.log('joint report');
  const [download] = await Promise.all([page.waitForEvent('download', { timeout: 20000 }), page.click('#export-joints-json-btn')]);
  const report = JSON.parse(readFileSync(await download.path(), 'utf8'));
  check('joint JSON has joints and the server hardware plan', Array.isArray(report.joints) && report.hardware?.summary && Array.isArray(report.hardware.fasteners), Object.keys(report).join());
  check('hardware plan fasteners come from the API (displayId FS001)', report.hardware.fasteners[0]?.displayId === 'FS001');
  pdf = await pdfFrom('#print-joints-btn');
  check('joint report PDF is generated', pdf.head === '%PDF-' && pdf.size > 2000, JSON.stringify(pdf));
  check('POST /v1/hardware-plan answered 200', hits(/POST \/v1\/hardware-plan 200/).length >= 1);

  console.log('API failure');
  await page.route('**/v1/assembly', (route) => route.abort('failed'));
  await page.click('#print-assembly-btn');
  await page.waitForTimeout(1500);
  const toast = (await page.textContent('#action-toast'))?.trim() ?? '';
  check('a failed API call tells the person (toast)', toast.length > 5, `toast="${toast}"`);
  await page.unroute('**/v1/assembly');
  await page.click('#add-box-btn');
  check('editing still works after the failure', !(await page.isDisabled('#add-box-btn')));

  check('no uncaught page error', pageErrors.length === 0, pageErrors.join(' | '));
  check('every request went through the contract (no 5xx / 4xx from /v1)', apiCalls.every((c) => /\s200$/.test(c)), apiCalls.filter((c) => !/\s200$/.test(c)).join(' | '));
} catch (e) {
  fail++; console.error('  FAIL: exception', e.message);
  await page.screenshot({ path: 'e2e-failure.png' }).catch(() => {});
} finally {
  await browser.close();
  children.forEach((c) => c.kill());
}
console.log(`\n${pass}/${pass + fail} checks passed`);
process.exit(fail ? 1 : 0);
