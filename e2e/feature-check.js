/**
 * Browser checks for the behaviours fixed in plan/FIX-PLAN.md.
 *
 * Run against a running instance:
 *   node e2e/feature-check.js [baseUrl]
 *
 * Uses Chromium via Playwright. The script intentionally works through the
 * visible UI, so it exercises the real Vue application and IndexedDB path.
 */

const fs = require('fs');

const BASE_URL = process.argv[2] || 'http://localhost:8000/';

let passed = 0;
let failed = 0;
const problems = [];

function check(name, condition, detail) {
  if (condition) {
    passed++;
    console.log('PASS ' + name);
  } else {
    failed++;
    problems.push(name + (detail ? ': ' + detail : ''));
    console.log('FAIL ' + name + (detail ? ' -> ' + detail : ''));
  }
}

async function clearState(page) {
  await page.evaluate(() => new Promise((resolve) => {
    const req = indexedDB.deleteDatabase('svg_illustrator');
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  }));
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.app-main');
  await page.waitForTimeout(400);
}

async function layerNames(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('.layer-item'))
    .map(el => el.textContent.trim()));
}

async function addFromList(page, text, size) {
  await page.click('button:has-text("Список компонентов")');
  if (size) await page.selectOption('#size', size);
  await page.fill('input[placeholder*="Книга"]', text);
  await page.click('button:has-text("Собрать по списку")');
  await page.waitForTimeout(900);
}

async function generate(page, text, size) {
  await page.click('button:has-text("Метафора/заголовок")');
  if (size) await page.selectOption('#size', size);
  await page.fill('input[placeholder*="метафору"]', text);
  const response = page.waitForResponse(
    r => r.url().includes('/api/interpret-metaphor/') && r.request().method() === 'POST',
    { timeout: 20000 },
  ).catch(() => null);
  await page.click('button:has-text("Собрать по метафоре")');
  await response;
  await page.waitForTimeout(600);
}

async function groupTransforms(page) {
  return page.evaluate(() => Array.from(document.querySelectorAll('svg.app-canvas > g'))
    .map(g => g.getAttribute('transform')));
}

function translateX(transform) {
  const m = /translate\(([-\d.]+)/.exec(transform || '');
  return m ? Number(m[1]) : null;
}

async function exportText(page) {
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.click('button:has-text("Экспорт SVG")'),
  ]);
  const file = await download.path();
  return fs.readFileSync(file, 'utf8');
}

(async () => {
  let chromium;
  try {
    chromium = require('playwright').chromium;
  } catch (e) {
    console.error('playwright is not installed: npm install');
    process.exit(2);
  }

  const launchOptions = process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {};
  const browser = await chromium.launch(launchOptions);
  const context = await browser.newContext({
    viewport: { width: 1280, height: 900 },
    acceptDownloads: true,
  });
  const page = await context.newPage();
  const jsErrors = [];
  page.on('pageerror', e => jsErrors.push(String(e)));

  await page.goto(BASE_URL, { waitUntil: 'load' });
  await page.waitForSelector('.app-main');
  await page.waitForTimeout(500);

  const paletteNames = await page.$$eval('#palette option', options =>
    options.map(option => option.textContent.trim()));
  const sortedPaletteNames = paletteNames.slice().sort((a, b) =>
    a.localeCompare(b, 'ru', { sensitivity: 'base' }));
  check('palette options are sorted alphabetically',
    paletteNames.join('|') === sortedPaletteNames.join('|'), paletteNames.join(', '));

  // 1. Synonyms in the component list.
  await clearState(page);
  await addFromList(page, 'flowers, phone', 'S');
  let names = await layerNames(page);
  check('list resolves synonyms', names.some(n => n.includes('Цветы')) && names.some(n => n.includes('Телефон')),
    names.join(', '));
  check('list does not report known objects as unknown',
    !(await page.locator('.app-msg.error').allTextContents()).join(' ').includes('Неизвестный'),
    await page.locator('.app-msg.error').allTextContents());

  // 2. Adding an object does not move the existing composition.
  const beforeAdd = await groupTransforms(page);
  await page.locator('.object-item', { hasText: 'Монета' }).first().click();
  await page.waitForTimeout(400);
  const afterAdd = await groupTransforms(page);
  check('adding an object keeps existing transforms',
    afterAdd.slice(0, beforeAdd.length).join('|') === beforeAdd.join('|'),
    beforeAdd.join(' | ') + ' => ' + afterAdd.join(' | '));

  // 3. Manual additions may exceed three mains, but show a warning.
  await page.locator('.object-item', { hasText: 'Пазлы' }).first().click();
  await page.waitForTimeout(400);
  let manualNames = await layerNames(page);
  let manualMains = manualNames.filter(n => n.includes('главное')).length;
  let warnings = (await page.locator('.app-msg.warn').allTextContents()).join(' ');
  check('fourth main object is allowed manually', manualMains === 4, manualNames.join(', '));
  check('manual overflow shows a non-blocking warning',
    warnings.includes('Рекомендуем 1–3'), warnings);
  check('manual overflow is not reported as an error',
    !(await page.locator('.app-msg.error').allTextContents()).join(' ').includes('Лимит'));

  const firstMain = page.locator('.layer-item', { hasText: 'главное' }).first();
  await firstMain.click();
  await page.click('button:has-text("Дублировать")');
  await page.waitForTimeout(400);
  manualNames = await layerNames(page);
  manualMains = manualNames.filter(n => n.includes('главное')).length;
  check('duplicating a main object is allowed manually', manualMains === 5, manualNames.join(', '));

  await page.click('button:has-text("Автокомпоновка")');
  await page.waitForTimeout(500);
  const autoWarning = (await page.locator('.app-msg.warn').allTextContents()).join(' ');
  check('auto-layout allows 4+ objects and warns',
    autoWarning.includes('Рекомендуем 1–3'), autoWarning);

  // 4. A list separated by spaces and Enter submits every component.
  await clearState(page);
  await page.click('button:has-text("Список компонентов")');
  await page.selectOption('#size', 'S');
  await page.fill('input[placeholder*="Книга"]', 'книга телефон лампа');
  await page.press('input[placeholder*="Книга"]', 'Enter');
  await page.waitForTimeout(900);
  const spaceListNames = await layerNames(page);
  check('space-separated list adds all components',
    spaceListNames.length === 3 &&
    ['Книга', 'Телефон', 'Лампа'].every(name => spaceListNames.some(n => n.includes(name))),
    spaceListNames.join(', '));

  // 5. Enter submits the metaphor form.
  await clearState(page);
  await page.route('**/api/interpret-metaphor/', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      source: 'llm',
      objects: [
        { assetId: 'kniga', role: 'main' },
        { assetId: 'cveti', role: 'background' },
      ],
      llm_info: {
        provider: 'Test Provider',
        model: 'test-model',
        base_url: 'https://example.test/v1',
        response: { objects: [{ assetId: 'kniga', role: 'main' }] },
        background_source: 'local_fallback',
        background_asset: 'cveti',
        background_service: 'fallback.pick_background',
      },
    }),
  }));
  const enterResponse = page.waitForResponse(
    r => r.url().includes('/api/interpret-metaphor/') && r.request().method() === 'POST',
    { timeout: 20000 },
  ).catch(() => null);
  await page.click('button:has-text("Метафора/заголовок")');
  await page.fill('input[placeholder*="метафору"]', 'книга');
  await page.press('input[placeholder*="метафору"]', 'Enter');
  await enterResponse;
  await page.waitForTimeout(700);
  const enterNames = await layerNames(page);
  check('Enter submits the metaphor form', enterNames.some(n => n.includes('Книга')), enterNames.join(', '));
  const llmInfoText = (await page.locator('.llm-info').innerText()).replace(/\s+/g, ' ');
  check('LLM metadata is shown below the canvas',
    llmInfoText.includes('Test Provider') && llmInfoText.includes('test-model'),
    llmInfoText);
  check('LLM metadata reports the local background matcher',
    llmInfoText.includes('локальный матчер') && llmInfoText.includes('cveti'),
    llmInfoText);
  check('LLM response body is shown',
    (await page.locator('.llm-response').innerText()).includes('"assetId": "kniga"'),
    await page.locator('.llm-response').innerText());
  await page.unroute('**/api/interpret-metaphor/');

  // 6. Automatic generation is still hard-limited to three mains.
  await clearState(page);
  await page.route('**/api/interpret-metaphor/', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      source: 'llm',
      objects: [
        { assetId: 'kniga', role: 'main' },
        { assetId: 'ruchka', role: 'main' },
        { assetId: 'moneta', role: 'main' },
        { assetId: 'telefon', role: 'main' },
      ],
    }),
  }));
  await generate(page, 'Четыре объекта', 'L');
  const generatedNames = await layerNames(page);
  const generatedMains = generatedNames.filter(n => n.includes('главное')).length;
  const generationWarning = (await page.locator('.app-msg.warn').allTextContents()).join(' ');
  check('automatic generation truncates to three mains', generatedMains === 3, generatedNames.join(', '));
  check('automatic truncation is reported as a warning',
    generationWarning.includes('ограничена 3'), generationWarning);
  check('automatic truncation is not a hard error',
    !(await page.locator('.app-msg.error').allTextContents()).join(' ').includes('Лимит'));
  await page.unroute('**/api/interpret-metaphor/');

  // 7. Generation buttons are disabled while the request is in flight.
  await clearState(page);
  await page.route('**/api/interpret-metaphor/', async route => {
    await new Promise(resolve => setTimeout(resolve, 700));
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        source: 'llm',
        objects: [{ assetId: 'kniga', role: 'main' }],
      }),
    });
  });
  const slowResponse = page.waitForResponse(
    r => r.url().includes('/api/interpret-metaphor/') && r.request().method() === 'POST',
    { timeout: 20000 },
  );
  await page.click('button:has-text("Метафора/заголовок")');
  await page.fill('input[placeholder*="метафору"]', 'медленный запрос');
  await page.click('button:has-text("Собрать по метафоре")');
  await page.waitForTimeout(150);
  const generatingButton = page.locator('button:has-text("Собираем…")');
  check('generate button is disabled while waiting',
    await generatingButton.isDisabled(), 'button is not disabled');
  await slowResponse;
  await page.waitForTimeout(700);
  check('generate button is enabled after response',
    await page.locator('button:has-text("Собрать по метафоре")').isEnabled());
  await page.unroute('**/api/interpret-metaphor/');

  // 8. A new generation replaces the previous composition.
  await clearState(page);
  await page.route('**/api/interpret-metaphor/', route => {
    const body = JSON.parse(route.request().postData() || '{}');
    const text = body.text || '';
    const objects = text.includes('Финансы')
      ? [
          { assetId: 'koshchelek', role: 'main' },
          { assetId: 'moneta', role: 'main' },
          { assetId: 'papka', role: 'background' },
        ]
      : [
          { assetId: 'kniga', role: 'main' },
          { assetId: 'ruchka', role: 'main' },
          { assetId: 'cveti', role: 'background' },
        ];
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ source: 'llm', objects }),
    });
  });
  await generate(page, 'Финансы', 'L');
  const first = await layerNames(page);
  await generate(page, 'Обучение', 'L');
  const second = await layerNames(page);
  check('generation replaces the scene', second.some(n => n.includes('Книга')) &&
    !second.some(n => n.includes('Монета')), first.join(' | ') + ' => ' + second.join(' | '));
  check('generated scene keeps the main-object limit',
    second.filter(n => n.includes('главное')).length <= 3, second.join(' | '));
  await page.unroute('**/api/interpret-metaphor/');

  // 9. A failed request keeps the current scene untouched.
  await page.route('**/api/interpret-metaphor/', route => route.abort());
  await page.fill('input[placeholder*="метафору"]', 'Финансы');
  await page.click('button:has-text("Собрать по метафоре")');
  await page.waitForTimeout(700);
  const afterFailure = await layerNames(page);
  check('failed generation keeps the scene',
    afterFailure.join('|') === second.join('|'), second.join(' | ') + ' => ' + afterFailure.join(' | '));
  check('failed generation reports an error',
    (await page.locator('.app-msg.error').allTextContents()).join(' ').includes('Не удалось получить подбор'));
  await page.unroute('**/api/interpret-metaphor/');

  // 10. Format change requires confirmation, then survives a reload.
  await page.selectOption('#fmt', '1200x630');
  await page.waitForSelector('.modal');
  await page.click('.modal button:has-text("Отмена")');
  await page.waitForTimeout(300);
  check('format change is blocked without confirmation',
    await page.inputValue('#fmt') === '1000x1000' &&
    await page.getAttribute('svg.app-canvas', 'width') === '1000',
    'format=' + await page.inputValue('#fmt'));
  await page.selectOption('#fmt', '1200x630');
  await page.waitForSelector('.modal');
  await page.click('.modal button:has-text("Сменить формат")');
  await page.waitForTimeout(600);
  check('confirmed format change is applied',
    await page.inputValue('#fmt') === '1200x630' &&
    await page.getAttribute('svg.app-canvas', 'width') === '1200',
    'format=' + await page.inputValue('#fmt'));
  await page.waitForTimeout(900);
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.app-main');
  await page.waitForTimeout(700);
  check('format survives a reload',
    await page.inputValue('#fmt') === '1200x630' &&
    await page.getAttribute('svg.app-canvas', 'width') === '1200',
    'format=' + await page.inputValue('#fmt'));

  const namesBeforeReset = await layerNames(page);
  await page.click('button:has-text("Сбросить")');
  await page.waitForSelector('.modal');
  await page.click('.modal button:has-text("Отмена")');
  await page.waitForTimeout(300);
  check('reset is blocked without confirmation',
    (await layerNames(page)).join('|') === namesBeforeReset.join('|'));
  await page.click('button:has-text("Сбросить")');
  await page.waitForSelector('.modal');
  await page.click('.modal button:has-text("Сбросить")');
  await page.waitForTimeout(400);
  check('confirmed reset clears the scene', (await layerNames(page)).length === 0);

  // 11. Drag follows the pointer when the canvas is scaled by CSS.
  await clearState(page);
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.selectOption('#size', 'S');
  await page.locator('.object-item', { hasText: 'Монета' }).first().click();
  await page.waitForTimeout(500);
  const canvasBox = await page.locator('svg.app-canvas').boundingBox();
  const canvasWidth = Number(await page.getAttribute('svg.app-canvas', 'width'));
  const before = translateX((await groupTransforms(page))[0]);
  const scale = canvasWidth / canvasBox.width;
  await page.mouse.move(canvasBox.x + canvasBox.width / 2, canvasBox.y + canvasBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(canvasBox.x + canvasBox.width / 2 + 50, canvasBox.y + canvasBox.height / 2);
  await page.mouse.up();
  await page.waitForTimeout(250);
  const after = translateX((await groupTransforms(page))[0]);
  const expected = 50 * scale;
  check('drag accounts for CSS scaling', Math.abs((after - before) - expected) < 2,
    'delta=' + (after - before).toFixed(1) + ' expected=' + expected.toFixed(1));

  await page.click('.app-panel button:has-text("Удалить")');
  await page.waitForSelector('.modal');
  await page.click('.modal button:has-text("Отмена")');
  await page.waitForTimeout(300);
  check('delete is blocked without confirmation', (await groupTransforms(page)).length === 1);
  await page.click('.app-panel button:has-text("Удалить")');
  await page.waitForSelector('.modal');
  await page.click('.modal button:has-text("Удалить")');
  await page.waitForTimeout(300);
  check('confirmed delete removes the object', (await groupTransforms(page)).length === 0);

  // 12. Export contains named groups.
  await page.setViewportSize({ width: 1280, height: 900 });
  await clearState(page);
  await generate(page, 'Обучение', 'L');
  const svgText = await exportText(page);
  const exportedGroups = (svgText.match(/<g id="obj_/g) || []).length;
  check('export contains named groups', exportedGroups >= 1, 'groups=' + exportedGroups);
  check('export groups have data names', /data-name="[^"]+"/.test(svgText));
  check('export has a palette background', /<rect[^>]+fill="#/.test(svgText));

  // 13. A corrupted IndexedDB payload does not crash the application.
  await page.evaluate(() => new Promise((resolve, reject) => {
    const req = indexedDB.open('svg_illustrator', 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('state')) db.createObjectStore('state');
    };
    req.onsuccess = () => {
      const db = req.result;
      const tx = db.transaction('state', 'readwrite');
      tx.objectStore('state').put({
        schemaVersion: 1,
        savedAt: new Date().toISOString(),
        data: { scene: { instances: 'broken' } },
      }, 'current');
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onerror = () => reject(tx.error);
    };
    req.onerror = () => reject(req.error);
  }));
  await page.reload({ waitUntil: 'load' });
  await page.waitForSelector('.app-main');
  await page.waitForTimeout(500);
  const corruptionWarning = (await page.locator('.app-msg.warn').allTextContents()).join(' ');
  check('corrupted IndexedDB state is reported without a crash',
    corruptionWarning.includes('повреждена'), corruptionWarning);

  // 14. "Scale 100%" refuses to break a composition that needs scaling.
  await clearState(page);
  await addFromList(page, 'книга, ручка, телефон', 'L');
  const resetButton = page.locator('button:has-text("Масштаб 100%")');
  if (await resetButton.count()) {
    const beforeTransforms = await groupTransforms(page);
    await resetButton.click();
    await page.waitForTimeout(300);
    const afterTransforms = await groupTransforms(page);
    const resetError = (await page.locator('.app-msg.error').allTextContents()).join(' ');
    check('scale reset is refused when the scene does not fit',
      JSON.stringify(beforeTransforms) === JSON.stringify(afterTransforms) &&
      resetError.includes('не помещается'), resetError);
  } else {
    console.log('SKIP scale reset: current library sizes already fit at 100%');
  }

  check('no uncaught JavaScript errors', jsErrors.length === 0, jsErrors.join('; '));

  await browser.close();
  console.log('\n' + passed + '/' + (passed + failed) + ' feature checks passed');
  if (failed) {
    console.log(problems.map(p => ' - ' + p).join('\n'));
    process.exit(1);
  }
})().catch(e => {
  console.error('FATAL', e);
  process.exit(1);
});
