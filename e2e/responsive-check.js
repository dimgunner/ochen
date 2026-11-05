/**
 * End-to-end checks for the illustration builder.
 *
 * Run against a running instance:
 *   node e2e/responsive-check.js [baseUrl]
 *
 * Verifies the responsive layout and the core rules of the service on
 * desktop and mobile viewports, in Chromium and Firefox.
 */

const path = require('path');

const BASE_URL = process.argv[2] || 'http://localhost:8000/';

const VIEWPORTS = [
  { name: 'mobile-390', width: 390, height: 844 },
  { name: 'mobile-768', width: 768, height: 1024 },
  { name: 'desktop-1280', width: 1280, height: 800 },
];

/** Resolve browser binaries, allowing an override via env. */
function executables() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/root/.cache/ms-playwright';
  return {
    chromium: process.env.CHROMIUM_PATH || path.join(root, 'chromium-1226', 'chrome-linux64', 'chrome'),
    firefox: process.env.FIREFOX_PATH || path.join(root, 'firefox-1530', 'firefox', 'firefox'),
  };
}

async function check(browserType, label, execPath) {
  const browser = await browserType.launch({ executablePath: execPath });
  const results = [];

  for (const vp of VIEWPORTS) {
    const ctx = await browser.newContext({
      viewport: { width: vp.width, height: vp.height },
      hasTouch: vp.width <= 820,
      isMobile: label === 'chromium' && vp.width <= 820,
    });
    const page = await ctx.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));

    await page.goto(BASE_URL, { waitUntil: 'load' });
    await page.waitForSelector('.app-main');
    await page.waitForTimeout(500);

    const info = await page.evaluate(() => {
      const main = document.querySelector('.app-main');
      const panel = document.querySelector('.app-panel');
      const canvas = document.querySelector('.app-canvas');
      const btn = document.querySelector('.app-toolbar button');
      return {
        innerWidth: window.innerWidth,
        flexDirection: getComputedStyle(main).flexDirection,
        panelWidth: Math.round(panel.getBoundingClientRect().width),
        hasHScroll: document.body.scrollWidth > window.innerWidth + 1,
        objects: document.querySelectorAll('.object-item').length,
        canvasW: Math.round(canvas.getBoundingClientRect().width),
        buttonH: Math.round(btn.getBoundingClientRect().height),
      };
    });

    // Add an S-sized object and verify it is rendered without scaling.
    await page.selectOption('#size', 'S');
    await page.waitForTimeout(200);
    await page.locator('.object-item', { hasText: 'Монета' }).first().click();
    await page.waitForTimeout(700);

    const after = await page.evaluate(() => {
      const groups = Array.from(document.querySelectorAll('svg > g'));
      // Every object must use the same composition scale factor.
      const scales = groups.map(g => {
        const inner = g.querySelector('g');
        const m = inner && (inner.getAttribute('transform') || '').match(/scale\(([\d.]+)\)/);
        return m ? parseFloat(m[1]) : null;
      });
      return {
        groups: groups.length,
        scales,
        uniformScale: new Set(scales).size <= 1,
        fitError: (document.body.innerText.match(/Не помещается[^\n]*/) || [null])[0],
      };
    });

    results.push({ browser: label, viewport: vp.name, ...info, ...after, errors });
    await ctx.close();
  }

  await browser.close();
  return results;
}

function verify(r) {
  const problems = [];
  if (r.objects !== 10) problems.push('expected 10 library objects, got ' + r.objects);
  if (r.hasHScroll) problems.push('horizontal scrollbar present');
  if (r.errors.length) problems.push('JS errors: ' + r.errors.join('; '));
  if (r.groups < 1) problems.push('object was not added to the canvas');
  if (!r.uniformScale) problems.push('objects must share one composition scale');
  if (r.innerWidth <= 820) {
    if (r.flexDirection !== 'column') problems.push('mobile layout is not stacked');
    if (r.buttonH < 28) problems.push('touch targets too small: ' + r.buttonH);
  } else if (r.flexDirection !== 'row') {
    problems.push('desktop layout is not side by side');
  }
  return problems;
}

(async () => {
  let chromium, firefox;
  try {
    chromium = require('playwright').chromium;
    firefox = require('playwright').firefox;
  } catch (e) {
    console.error('playwright is not installed: npm i playwright');
    process.exit(2);
  }

  const exec = executables();
  const all = [
    ...await check(chromium, 'chromium', exec.chromium),
    ...await check(firefox, 'firefox', exec.firefox),
  ];

  let failed = 0;
  for (const r of all) {
    const problems = verify(r);
    const status = problems.length ? 'FAIL' : 'PASS';
    if (problems.length) failed++;
    console.log(
      status + ' ' + r.browser + ' ' + r.viewport +
      ' | dir=' + r.flexDirection +
      ' panel=' + r.panelWidth +
      ' hscroll=' + r.hasHScroll +
      ' obj=' + r.objects +
      ' btnH=' + r.buttonH +
      ' groups=' + r.groups +
      ' scale=' + (r.scales && r.scales[0] !== undefined ? r.scales[0] : '-') +
      (r.fitError ? ' fitErr=' + r.fitError : '')
    );
    for (const p of problems) console.log('     - ' + p);
  }

  console.log('\n' + (all.length - failed) + '/' + all.length + ' checks passed');
  process.exit(failed ? 1 : 0);
})().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
