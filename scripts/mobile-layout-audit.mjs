/**
 * Mobile / responsive layout audit.
 *
 * No Playwright or Puppeteer is installed in this repo, so this script drives the
 * locally installed Chrome over the DevTools Protocol using Node's global
 * WebSocket. For each page and breakpoint it:
 *   1. emulates the viewport (1440x900, 768x1024, 390x844),
 *   2. collects every element whose box escapes the viewport (ignoring elements
 *      inside an intentional horizontal scroller),
 *   3. writes a screenshot to artifacts/mobile-audit/.
 *
 * Pages audited:
 *   - merchant dashboard (`/`)
 *   - staging Payment Test Console (`/test-console`, after token login)
 *   - guest checkout (`/__audit/checkout`, rendered as a layout fixture)
 *
 * It also renders the pre-change HTML straight out of git (`HEAD:...`) so the
 * before/after screenshots are evidence rather than assertions.
 *
 * Usage: node scripts/mobile-layout-audit.mjs [--out=dir]
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Database, runMigrations } from '@youpi/db';
import { AdminServer } from '../apps/merchant-admin/src/server.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const argv = process.argv.slice(2);
const outArg = argv.find(a => a.startsWith('--out='));
const outDir = path.resolve(repoRoot, outArg ? outArg.slice('--out='.length) : 'artifacts/mobile-audit');

const VIEWPORTS = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'mobile', width: 390, height: 844 }
];

const CONSOLE_TOKEN = crypto.randomBytes(24).toString('hex');

function gitShow(file) {
  return execFileSync('git', ['show', `HEAD:${file}`], { cwd: repoRoot, encoding: 'utf8' });
}

function fillCheckoutTemplate(html) {
  const tokens = {
    MERCHANT_NAME: 'OpenUPI Demo Store',
    APP_NAME: 'OpenUPI',
    AMOUNT: '10.00',
    ORDER_ID: 'ORDER-AUDIT-1001',
    METHOD_SELECTOR_DISPLAY: 'flex',
    TAB_COD_STYLE: '',
    TAB_CASH_STYLE: '',
    TAB_CARD_STYLE: '',
    PC_CASH_STYLE: '',
    PC_CARD_STYLE: '',
    PC_COD_STYLE: '',
    SERVER_HEALTH_CLASS: '',
    SERVER_HEALTH_LABEL: 'Ready',
    DOWNTIME_ALERT_CLASS: '',
    DOWNTIME_ALERT_STYLE: 'none',
    DOWNTIME_HEADING: '',
    DOWNTIME_MSG: '',
    DOWNTIME_ALT_BTN_DISPLAY: 'none',
    DOWNTIME_ALT_BTN_LABEL: '',
    COUNTER_INSTRUCTIONS: ''
  };
  let out = html;
  for (const [key, value] of Object.entries(tokens)) {
    out = out.replaceAll(`{{${key}}}`, value);
  }
  return out.replace(/\{\{[A-Z0-9_]+\}\}/g, '');
}

function fillAdminTemplate(html, nav = '') {
  return html
    .replaceAll('{{API_BASE_URL}}', '')
    .replaceAll('{{ANDROID_ENROLLMENT_SECRET}}', '')
    .replaceAll('{{TEST_CONSOLE_NAV}}', nav);
}

function findChrome() {
  const candidates = [
    process.env.CHROME_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe') : null,
    '/usr/bin/google-chrome',
    '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 1;
    this.pending = new Map();
    ws.addEventListener('message', event => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      }
    });
  }

  send(method, params = {}, sessionId) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }
      }, 30000);
    });
  }
}

const OVERFLOW_PROBE = `(() => {
  const vw = window.innerWidth;
  const offenders = [];
  const seen = new Set();
  let rawOverflowCount = 0;
  let maxRight = -1;
  let maxRightNode = null;
  for (const el of document.querySelectorAll('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    if (cs.position === 'fixed' || cs.position === 'sticky') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) continue;
    if (rect.right <= vw + 1 && rect.left >= -1) continue;
    rawOverflowCount += 1;
    if (rect.right > maxRight) {
      maxRight = rect.right;
      maxRightNode = el.tagName.toLowerCase() + (el.id ? '#' + el.id : '') + ' w=' + Math.round(rect.width);
    }
    let parent = el.parentElement;
    let scroller = false;
    while (parent) {
      const ps = getComputedStyle(parent);
      if (ps.overflowX === 'auto' || ps.overflowX === 'scroll') { scroller = true; break; }
      parent = parent.parentElement;
    }
    if (scroller) continue;
    const key = el.tagName + '#' + (el.id || '') + '.' + (typeof el.className === 'string' ? el.className : '');
    if (seen.has(key)) continue;
    seen.add(key);
    offenders.push({
      node: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''),
      cls: (typeof el.className === 'string' ? el.className : '').slice(0, 70),
      left: Math.round(rect.left),
      right: Math.round(rect.right),
      width: Math.round(rect.width)
    });
  }
  const main = document.querySelector('main');
  const header = document.querySelector('header');
  const amountRow = document.querySelector('.amount-row');
  const mainNav = document.querySelector('.main-nav-bar');
  const layoutProbes = {
    viewportMeta: document.querySelector('meta[name="viewport"]')?.content || null,
    amountRowDirection: amountRow ? getComputedStyle(amountRow).flexDirection : null,
    mainNavPosition: mainNav ? getComputedStyle(mainNav).position : null
  };
  // Count top-level tracks: "minmax(0px, 1fr)" is ONE track, not two.
  const countTracks = value => {
    let depth = 0;
    let count = 0;
    let inToken = false;
    for (const ch of String(value)) {
      if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      if (/\\s/.test(ch) && depth === 0) { inToken = false; continue; }
      if (!inToken) { count += 1; inToken = true; }
    }
    return count;
  };
  // Keep a multi-column readout only when it still FITS its card. A panel whose
  // columns are wider than the card is the cramped case we care about on phones.
  // Tablets legitimately keep two columns, so this is a phone-width check.
  const checkCramped = vw <= 700;
  let maxInlineGridTracks = 0;
  const crampedNodes = [];
  for (const el of document.querySelectorAll('[style*="grid-template-columns"]')) {
    // Skip subtrees hidden by an ancestor: they keep their specified tracks and
    // would otherwise report columns that are not on screen.
    if (!el.getClientRects().length) continue;
    const cs = getComputedStyle(el);
    if (cs.display !== 'grid' && cs.display !== 'inline-grid') continue;
    const tracks = countTracks(cs.gridTemplateColumns);
    if (tracks > maxInlineGridTracks) maxInlineGridTracks = tracks;
    if (checkCramped && tracks > 1 && el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1) {
      crampedNodes.push({
        node: el.tagName.toLowerCase() + (el.id ? '#' + el.id : ''),
        tracks,
        gtc: cs.gridTemplateColumns,
        clientWidth: el.clientWidth,
        scrollWidth: el.scrollWidth,
        style: (el.getAttribute('style') || '').slice(0, 90)
      });
    }
  }
  return {
    layoutProbes,
    headerHeight: header ? Math.round(header.getBoundingClientRect().height) : null,
    maxInlineGridTracks,
    crampedNodes: crampedNodes.slice(0, 5),
    crampedCount: crampedNodes.length,
    innerWidth: vw,
    scrollWidth: document.documentElement.scrollWidth,
    bodyScrollWidth: document.body.scrollWidth,
    nodeCount: document.querySelectorAll('body *').length,
    textLength: (document.body.innerText || '').trim().length,
    documentHeight: document.documentElement.scrollHeight,
    mainWidth: main ? Math.round(main.getBoundingClientRect().width) : null,
    consoleState: (() => {
      const login = document.getElementById('loginView');
      const consoleView = document.getElementById('consoleView');
      if (!login || !consoleView) return null;
      return { loginHidden: login.classList.contains('hidden'), consoleHidden: consoleView.classList.contains('hidden') };
    })(),
    rawOverflowCount,
    maxRightNode,
    offenders: offenders.slice(0, 10),
    offenderCount: offenders.length
  };
})()`;

async function main() {
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  process.env.YOUPI_TEST_CONSOLE_ENABLED = '1';
  process.env.YOUPI_TEST_CONSOLE_TOKEN = CONSOLE_TOKEN;

  const db = new Database({ inMemory: true });
  runMigrations(db);

  const auditPort = Number(process.env.AUDIT_PORT || 6199);
  const admin = new AdminServer({ db, apiBaseUrl: `http://127.0.0.1:${auditPort}` });
  const adminHandler = admin.createServer().listeners('request')[0];

  const beforeAdmin = fillAdminTemplate(gitShow('apps/merchant-admin/src/views/admin.html'));
  const beforeConsole = gitShow('apps/merchant-admin/src/views/test-console.html');
  const beforeCheckout = fillCheckoutTemplate(gitShow('apps/checkout-portal/src/views/checkout.html'));

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname === '/__audit/before-admin') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(beforeAdmin);
      return;
    }
    if (url.pathname === '/__audit/before-console') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(beforeConsole);
      return;
    }
    if (url.pathname === '/__audit/checkout' || url.pathname === '/__audit/before-checkout') {
      const html = url.pathname.endsWith('before-checkout')
        ? beforeCheckout
        : fillCheckoutTemplate(fs.readFileSync(path.join(repoRoot, 'apps/checkout-portal/src/views/checkout.html'), 'utf8'));
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }
    adminHandler(req, res);
  });

  await new Promise(resolve => server.listen(auditPort, '127.0.0.1', resolve));

  const chromePath = findChrome();
  if (!chromePath) {
    server.close();
    db.close();
    console.error('Chrome not found. Set CHROME_PATH to a Chrome/Chromium binary.');
    process.exit(2);
  }

  const debugPort = Number(process.env.AUDIT_CDP_PORT || 9333);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'youpi-audit-'));
  const chrome = spawn(chromePath, [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-extensions',
    '--hide-scrollbars',
    `--user-data-dir=${userDataDir}`,
    `--remote-debugging-port=${debugPort}`,
    'about:blank'
  ], { stdio: 'ignore' });

  let ws;
  try {
    let wsUrl = null;
    for (let i = 0; i < 60 && !wsUrl; i++) {
      await sleep(250);
      try {
        const res = await fetch(`http://127.0.0.1:${debugPort}/json/version`);
        const body = await res.json();
        wsUrl = body.webSocketDebuggerUrl;
      } catch { /* keep waiting */ }
    }
    if (!wsUrl) throw new Error('Chrome DevTools endpoint did not start');

    ws = new WebSocket(wsUrl);
    await new Promise((resolve, reject) => {
      ws.addEventListener('open', resolve, { once: true });
      ws.addEventListener('error', reject, { once: true });
    });
    const cdp = new Cdp(ws);

    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank' });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    await cdp.send('Page.enable', {}, sessionId);
    await cdp.send('Runtime.enable', {}, sessionId);
    await cdp.send('Network.enable', {}, sessionId);

    const evaluate = async expression => {
      const result = await cdp.send('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true
      }, sessionId);
      if (result.exceptionDetails) {
        throw new Error(result.exceptionDetails.text || 'evaluation failed');
      }
      return result.result.value;
    };

    const waitForLoad = async () => {
      for (let i = 0; i < 80; i++) {
        const state = await evaluate('document.readyState');
        if (state === 'complete') break;
        await sleep(100);
      }
      await sleep(900);
    };

    const results = [];

    const only = process.env.AUDIT_ONLY ? process.env.AUDIT_ONLY.split(',').map(s => s.trim()) : null;
    const audit = async (label, url, viewport, { login = false, fixture = '', sections = [] } = {}) => {
      if (only && !only.includes(label)) return;
      // Isolate each page/breakpoint: a console session cookie from a previous
      // run must never make a "before" screenshot show the logged-in console.
      try { await cdp.send('Network.clearBrowserCookies', {}, sessionId); } catch {}
      await cdp.send('Emulation.setDeviceMetricsOverride', {
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        mobile: viewport.width < 800
      }, sessionId);
      await cdp.send('Page.navigate', { url }, sessionId);
      await waitForLoad();

      if (login) {
        await evaluate(`fetch('/api/test-console/session', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Console-Request': '1' }, body: JSON.stringify({ token: ${JSON.stringify(CONSOLE_TOKEN)} }) }).then(r => r.status)`);
        await cdp.send('Page.navigate', { url }, sessionId);
        await waitForLoad();
      }

      if (fixture) await evaluate(fixture);

      const measure = async name => ({ name, layout: await evaluate(OVERFLOW_PROBE) });
      const runs = [await measure('default')];
      for (const section of sections) {
        await evaluate(`switchSection(${JSON.stringify(section)})`);
        await sleep(700);
        runs.push(await measure(section));
        // Walk every sub-tab in the section: these hold the tables, inline
        // two-column panels and simulator preview that must also fit a phone.
        const labels = await evaluate(`[...document.querySelectorAll('.sub-nav-pill')].map(p => p.textContent.trim())`);
        for (let i = 0; i < labels.length; i++) {
          await evaluate(`document.querySelectorAll('.sub-nav-pill')[${i}].click()`);
          await sleep(650);
          runs.push(await measure(`${section}/${labels[i] || i}`));
        }
      }
      if (sections.length) {
        await evaluate(`switchSection('operations')`);
        await sleep(500);
      }

      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' }, sessionId);
      const file = path.join(outDir, `${label}-${viewport.name}.png`);
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));

      results.push({
        label,
        viewport: `${viewport.width}x${viewport.height}`,
        file: path.relative(repoRoot, file),
        runs
      });
      const worst = Math.max(...runs.map(r => r.layout.offenderCount));
      const first = runs[0].layout;
      console.log(`${label.padEnd(22)} ${viewport.name.padEnd(8)} overflow=${worst} header=${first.headerHeight}px vw=${first.innerWidth} text=${first.textLength}ch height=${first.documentHeight}px${first.consoleState ? ` console=${JSON.stringify(first.consoleState)}` : ''}`);
      if (viewport.width <= 700) {
        console.log(`    probes: ${JSON.stringify(first.layoutProbes)}`);
      }
      for (const run of runs) {
        if (run.layout.offenderCount === 0 && run.layout.crampedCount === 0) continue;
        console.log(`    [${run.name}] offenders=${run.layout.offenderCount} crampedGrids=${run.layout.crampedCount} tracks=${run.layout.maxInlineGridTracks}`);
        for (const item of run.layout.offenders.slice(0, 5)) {
          console.log(`      overflow ${item.node}${item.cls ? '.' + item.cls.split(' ')[0] : ''} left=${item.left} right=${item.right} w=${item.width}`);
        }
        for (const item of run.layout.crampedNodes) {
          console.log(`      cramped ${item.node} tracks=${item.tracks} (${item.clientWidth}px box vs ${item.scrollWidth}px content)`);
        }
      }
    };

    const consoleFixture = `(() => {
      const card = document.getElementById('paymentCard');
      if (card) card.classList.remove('hidden');
      const link = document.getElementById('checkoutLink');
      if (link) link.value = 'https://pay.example.test/checkout/9f2c84f1-6f0b-4f0f-9d3a-8f7d2f0c1b44';
      const open = document.getElementById('openLink');
      if (open) open.href = link ? link.value : '#';
      const amount = document.getElementById('amountBig');
      if (amount) amount.textContent = '₹10.00';
      const order = document.getElementById('orderLine');
      if (order) order.textContent = 'Order ORDER-AUDIT-1001';
      const vpa = document.getElementById('payeeVpa');
      if (vpa) vpa.textContent = 'openupi.demo@okhdfcbank';
      const pid = document.getElementById('paymentId');
      if (pid) pid.textContent = '9f2c84f1-6f0b-4f0f-9d3a-8f7d2f0c1b44';
      return true;
    })()`;

    const checkoutFixture = `(() => {
      const splash = document.getElementById('ypgSplashScreen');
      if (splash) splash.style.display = 'none';
      const pre = document.getElementById('preGatewayAuthView');
      if (pre) pre.hidden = true;
      const gateway = document.getElementById('paymentGatewayInterface');
      if (gateway) gateway.hidden = false;
      document.querySelectorAll('.rzp-sheet-backdrop').forEach(el => el.classList.remove('active'));
      return true;
    })()`;

    const adminSections = ['storeSettings', 'developerHub', 'security'];

    for (const viewport of VIEWPORTS) {
      await audit('before-admin', `http://127.0.0.1:${auditPort}/__audit/before-admin`, viewport, { sections: adminSections });
      await audit('after-admin', `http://127.0.0.1:${auditPort}/`, viewport, { sections: adminSections });

      await audit('before-console', `http://127.0.0.1:${auditPort}/__audit/before-console`, viewport, { fixture: consoleFixture });
      await audit('after-console', `http://127.0.0.1:${auditPort}/test-console`, viewport, { login: true, fixture: consoleFixture });

      await audit('before-checkout', `http://127.0.0.1:${auditPort}/__audit/before-checkout`, viewport, { fixture: checkoutFixture });
      await audit('after-checkout', `http://127.0.0.1:${auditPort}/__audit/checkout`, viewport, { fixture: checkoutFixture });
    }

    fs.writeFileSync(
      path.join(outDir, 'report.json'),
      JSON.stringify({ generatedAt: new Date().toISOString(), chrome: chromePath, results }, null, 2)
    );

    const collect = list => list.flatMap(r => r.runs
      .filter(run => run.layout.offenderCount > 0 || run.layout.crampedCount > 0)
      .map(run => `${r.label} @ ${r.viewport} [${run.name}]: ${run.layout.offenderCount} overflow / ${run.layout.crampedCount} cramped grid(s)`));

    // The `before-*` pages are the HEAD baseline captured on purpose: they are
    // evidence of what was fixed, not a gate on the current code.
    const baselineIssues = collect(results.filter(r => !r.label.startsWith('after-')));
    const failures = collect(results.filter(r => r.label.startsWith('after-')));

    if (baselineIssues.length) {
      console.log(`\nBaseline (HEAD) layout issues for comparison: ${baselineIssues.length}`);
      for (const issue of baselineIssues) console.log(`  - ${issue}`);
    }

    console.log(`\nScreenshots + report: ${path.relative(repoRoot, outDir)}`);
    if (failures.length) {
      console.error(`\nFAILED — ${failures.length} layout run(s) with horizontal overflow:`);
      for (const failure of failures) console.error(`  - ${failure}`);
      process.exitCode = 1;
    } else {
      console.log('PASS — no horizontal overflow at 1440 / 768 / 390 on audited pages.');
    }
  } finally {
    try { ws?.close(); } catch {}
    chrome.kill();
    await new Promise(resolve => server.close(resolve));
    try { db.close(); } catch {}
    try { fs.rmSync(userDataDir, { recursive: true, force: true }); } catch {}
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
