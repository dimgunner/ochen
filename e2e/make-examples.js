/**
 * Regenerates the example compositions through the running service.
 *
 * Each example is produced exactly like a user would produce it: the
 * metaphor scenario picks the objects and their roles, the layout engine
 * places them, the palette is applied and the SVG is exported.
 *
 * Usage:
 *   node e2e/make-examples.js [baseUrl] [outputDir]
 */

const path = require('path');
const fs = require('fs');

const BASE_URL = process.argv[2] || 'http://localhost:8000/';
const OUT_DIR = process.argv[3] || path.join(__dirname, '..', 'examples');

const CASES = [
  { slug: 'finansy', metaphor: 'Финансы', format: '1200x630', palette: 'purple', size: 'L' },
  { slug: 'obrazovanie', metaphor: 'Обучение', format: '1000x1000', palette: 'warm', size: 'S' },
  { slug: 'tehnologii', metaphor: 'Технологии', format: '800x1200', palette: 'aqua', size: 'S' },
];

async function setSelect(page, value) {
  await page.evaluate((val) => {
    const sel = Array.from(document.querySelectorAll('select'))
      .find(s => Array.from(s.options).some(o => o.value === val));
    if (!sel) throw new Error('select with value ' + val + ' not found');
    sel.value = val;
    sel.dispatchEvent(new Event('change', { bubbles: true }));
  }, value);
  await page.waitForTimeout(150);
}

(async () => {
  let chromium;
  try {
    chromium = require('playwright').chromium;
  } catch (e) {
    console.error('playwright is not installed: npm i playwright');
    process.exit(2);
  }

  const execPath = process.env.CHROMIUM_PATH
    || '/root/.cache/ms-playwright/chromium-1226/chrome-linux64/chrome';
  const launchOptions = {};
  if (fs.existsSync(execPath)) launchOptions.executablePath = execPath;

  fs.mkdirSync(OUT_DIR, { recursive: true });

  const browser = await chromium.launch(launchOptions);
  const ctx = await browser.newContext({
    viewport: { width: 1400, height: 1000 },
    acceptDownloads: true,
  });
  const page = await ctx.newPage();

  await page.goto(BASE_URL, { waitUntil: 'load' });
  await page.waitForSelector('.app-main');

  for (const c of CASES) {
    await page.click('button:has-text("Сбросить")');
    await page.waitForTimeout(250);

    // Size must be chosen before objects are added: it is captured per object.
    await setSelect(page, c.size);
    await setSelect(page, c.format);
    await setSelect(page, c.palette);

    await page.click('button:has-text("Метафора/заголовок")');
    await page.fill('input[placeholder*="метафору"]', c.metaphor);
    await page.click('button:has-text("Собрать по метафоре")');
    await page.waitForTimeout(900);

    const chosen = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.layer-item')).map(e => e.textContent.trim()));
    console.log(c.slug + ' [' + c.format + ', ' + c.palette + ', ' + c.size + '] -> ' + chosen.join(', '));

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.click('button:has-text("Экспорт SVG")'),
    ]);
    const name = c.slug + '_' + c.format + '.svg';
    await download.saveAs(path.join(OUT_DIR, name));
    console.log('  saved ' + name);
  }

  await browser.close();
})().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
