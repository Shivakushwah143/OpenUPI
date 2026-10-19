import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { Database } from '@youpi/db';
import { startAdminServer } from '../index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '../../../..');
const readView = relative => fs.readFileSync(path.join(repoRoot, relative), 'utf8');

const CONSOLE_TOKEN = 'responsive_audit_token_at_least_24_chars';

/**
 * These are static contracts over the served HTML. The pixel-level counterpart
 * lives in scripts/mobile-layout-audit.mjs (real headless Chrome at 1440/768/390);
 * this suite keeps the responsive guarantees from silently regressing in CI
 * where a browser binary may not be available.
 */
describe('Responsive UI contracts', () => {
  let serverInstance;
  let baseUrl;
  let db;
  let adminHtml;
  let consoleHtml;

  before(async () => {
    process.env.YOUPI_TEST_CONSOLE_ENABLED = '1';
    process.env.YOUPI_TEST_CONSOLE_TOKEN = CONSOLE_TOKEN;
    db = new Database({ inMemory: true });
    serverInstance = await startAdminServer(6104, { db });
    baseUrl = `http://localhost:${serverInstance.port}`;
    adminHtml = await get('/');
    consoleHtml = await get('/test-console');
  });

  after(async () => {
    delete process.env.YOUPI_TEST_CONSOLE_ENABLED;
    delete process.env.YOUPI_TEST_CONSOLE_TOKEN;
    await serverInstance.close();
    db.close();
  });

  function get(pathname) {
    return new Promise((resolve, reject) => {
      http.get(`${baseUrl}${pathname}`, res => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => resolve(data));
      }).on('error', reject);
    });
  }

  test('both merchant surfaces declare a device-width viewport', async () => {
    assert.ok(adminHtml.includes('width=device-width'), 'admin viewport meta missing');
    assert.ok(adminHtml.includes('viewport-fit=cover'), 'admin must handle notched screens');
    assert.ok(consoleHtml.includes('width=device-width'));
    assert.ok(consoleHtml.includes('viewport-fit=cover'));
  });

  test('merchant dashboard has tablet and phone breakpoints', async () => {
    assert.ok(/@media \(max-width: 1100px\)/.test(adminHtml));
    assert.ok(/@media \(max-width: 700px\)/.test(adminHtml));
    assert.ok(/@media \(max-width: 430px\)/.test(adminHtml));

    // Header stacks and the nav becomes the sticky element on small screens.
    assert.ok(/@media \(max-width: 1100px\)[\s\S]*?header\s*\{[\s\S]*?position: static;/.test(adminHtml));
    assert.ok(/@media \(max-width: 1100px\)[\s\S]*?\.main-nav-bar\s*\{[\s\S]*?position: sticky;[\s\S]*?top: 0;/.test(adminHtml));
  });

  test('desktop-first inline grids collapse to a single column on phones', async () => {
    assert.ok(/@media \(max-width: 700px\)[\s\S]*?\[style\*="grid-template-columns"\]\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\) !important;/.test(adminHtml));
  });

  test('data tables stay readable instead of squeezing into 390px', async () => {
    assert.ok(/@media \(max-width: 700px\)[\s\S]*?table\s*\{\s*min-width: 560px;/.test(adminHtml));
    // Every table still sits inside a horizontal scroll wrapper.
    const tableCount = (adminHtml.match(/<table/g) || []).length;
    const scrollerCount = (adminHtml.match(/overflow-x:\s*auto/g) || []).length;
    assert.ok(tableCount > 0);
    assert.ok(scrollerCount >= tableCount, `expected a scroll wrapper per table (${tableCount} tables, ${scrollerCount} scrollers)`);
  });

  test('payment test console stacks its form and link actions on small phones', async () => {
    assert.ok(/@media \(max-width: 520px\)/.test(consoleHtml));
    assert.ok(/@media \(max-width: 520px\)[\s\S]*?\.amount-row\s*\{\s*flex-direction: column;/.test(consoleHtml));
    assert.ok(/@media \(max-width: 520px\)[\s\S]*?\.link-box\s*\{\s*flex-direction: column;/.test(consoleHtml));
    // Touch targets: primary actions are at least 44px tall on phones.
    assert.ok(/@media \(max-width: 520px\)[\s\S]*?min-height: 44px;/.test(consoleHtml));
  });

  test('checkout portal is mobile-first and honours notches without blocking zoom', async () => {
    const checkout = readView('apps/checkout-portal/src/views/checkout.html');
    assert.ok(checkout.includes('width=device-width'));
    assert.equal(checkout.includes('user-scalable=no'), false, 'pinch-zoom must not be disabled');
    assert.ok(checkout.includes('viewport-fit=cover'));
    assert.ok(checkout.includes('env(safe-area-inset-bottom'));
    assert.ok(/@media \(max-width: 767px\)/.test(checkout), 'phone layout rules missing');
    assert.ok(/@media \(max-width: 600px\)/.test(checkout));
    // Fixed bottom pay bar must stay above the iOS home indicator.
    assert.ok(/\.ypg-sticky-footer\s*\{[\s\S]*?padding-bottom: env\(safe-area-inset-bottom/.test(checkout));
  });

  test('no surface reintroduces a legacy fixed-width desktop viewport', async () => {
    assert.equal(adminHtml.includes('width=1024'), false);
    assert.equal(consoleHtml.includes('width=1024'), false);
  });
});
