import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const publicDir = path.join(root, 'src', 'infrastructure', 'admin', 'public');

async function read(name) { return fs.readFile(path.join(publicDir, name), 'utf8'); }

test('standalone admin UI defaults to Arabic and contains complete English switch support', async () => {
  const [html, app] = await Promise.all([read('index.html'), read('app.js')]);
  assert.match(html, /<html lang="ar" dir="rtl">/);
  assert.match(html, /id="languageButton"/);
  assert.match(html, />English<\/button>/);
  assert.match(app, /'language\.switchText': 'العربية'/);
  assert.match(app, /document\.documentElement\.dir = isArabic \? 'rtl' : 'ltr'/);
  assert.match(app, /biometric-admin-language/);
});

test('RTL and LTR layouts use logical alignment while technical codes stay readable', async () => {
  const css = await read('styles.css');
  assert.match(css, /text-align: start/);
  assert.match(css, /margin-inline-start/);
  assert.match(css, /html\[dir="rtl"\][\s\S]*\.number[\s\S]*text-align: right/);
  assert.match(css, /html\[dir="ltr"\][\s\S]*\.number[\s\S]*text-align: left/);
  assert.match(css, /direction: ltr; unicode-bidi: isolate/);
});


test('every UI translation key referenced by markup or direct t() calls exists in Arabic and English', async () => {
  const [html, app] = await Promise.all([read('index.html'), read('app.js')]);
  const arBlock = app.match(/ar: Object\.freeze\(\{([\s\S]*?)\n  \}\),\n  en:/)?.[1] ?? '';
  const enBlock = app.match(/en: Object\.freeze\(\{([\s\S]*?)\n  \}\)\n\}\);/)?.[1] ?? '';
  const keys = (block) => new Set([...block.matchAll(/'([^']+)':/g)].map((match) => match[1]));
  const arKeys = keys(arBlock);
  const enKeys = keys(enBlock);
  const used = new Set([
    ...[...html.matchAll(/data-i18n(?:-aria|-placeholder)?="([^"]+)"/g)].map((match) => match[1]),
    ...[...app.matchAll(/\bt\('([^']+)'/g)].map((match) => match[1])
  ]);
  assert.ok(used.size > 50);
  for (const key of used) {
    assert.ok(arKeys.has(key), `Arabic translation missing: ${key}`);
    assert.ok(enKeys.has(key), `English translation missing: ${key}`);
  }
});

test('standalone operations UI includes reports, server-side filters, pagination, and safe event details without changing the theme boundary', async () => {
  const [html, app, css] = await Promise.all([read('index.html'), read('app.js'), read('styles.css')]);
  assert.match(html, /data-view="reports"/);
  assert.match(html, /id="eventsFilters"/);
  assert.match(html, /id="eventsPagination"/);
  assert.match(html, /id="eventDialog"/);
  assert.match(html, /id="reportsFilters"/);
  assert.match(app, /\/api\/reports\/operational/);
  assert.match(app, /\/api\/events\/export\.csv/);
  assert.match(css, /filter-bar/);
  assert.match(css, /report-summary-grid/);
  assert.match(css, /details-grid/);
  assert.doesNotMatch(html, /worker_id|attendance_events|payroll|cost center|مركز تكلفة/);
});

test('people UI exposes explicit manual historical reprocessing without adding main-application attendance controls', async () => {
  const [html, app] = await Promise.all([read('index.html'), read('app.js')]);
  assert.match(html, /id="historicalDialog"/);
  assert.match(html, /id="historicalConfirm"/);
  assert.match(html, /data-i18n="people\.historicalAction"/);
  assert.match(app, /historical-events\/preview/);
  assert.match(app, /historical-events\/reprocess/);
  assert.match(app, /الحركات الأصلية تبقى كما هي/);
  assert.match(html, /id="historicalPreviewResult"[^>]*role="status"[^>]*aria-live="polite"/);
  assert.match(app, /historicalPreviewResult\.textContent = message/);
  assert.doesNotMatch(app, /historicalDialog\.close\(\);\s*state\.historicalPreview = null/);
  assert.doesNotMatch(html, /worker_id|attendance_events|payroll/);
});
