/**
 * Unit tests for the front-end logic modules.
 *
 * These modules are plain scripts loaded by the browser, so they are read
 * and evaluated in a sandbox here. Run with:
 *   node e2e/unit-tests.js
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function loadModule(file, exportName) {
  const src = fs.readFileSync(path.join(ROOT, 'static', file), 'utf8');
  const sandbox = { console, module: { exports: {} } };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox);
  return sandbox[exportName];
}

const PaletteEngine = loadModule('palette-engine.js', 'PaletteEngine');
const Layout = loadModule('layout-engine.js', 'Layout');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log('PASS ' + name);
  } catch (e) {
    failed++;
    console.log('FAIL ' + name + ' -> ' + e.message);
  }
}

function assert(cond, message) {
  if (!cond) throw new Error(message || 'assertion failed');
}

function assertEqual(actual, expected, message) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error((message || 'not equal') + ': got ' + a + ', expected ' + b);
}

// ---------------------------------------------------------------- palette

test('recolor maps object colors to the target scheme', () => {
  const asset = { colorRoles: { '#F9A3AA': 'object', '#F9ECB0': 'object', '#181817': 'neutral' } };
  const pal = { background: ['#FDD7B9', '#FAC896', '#D27532', '#181817'], object: ['#F9ECB0', '#80DADA', '#BEEBEB', '#FFFFFF'] };
  const map = PaletteEngine.buildColorMap(asset, pal);
  assertEqual(map['#F9A3AA'], '#80DADA', 'object color maps by palette position');
  assertEqual(map['#181817'], '#181817', 'neutral stays neutral');
});

test('recolor keeps the role separation between background and object', () => {
  const asset = { colorRoles: { '#AA9BF0': 'background', '#F9A3AA': 'object' } };
  const pal = { background: ['#FDD7B9', '#FAC896', '#D27532', '#181817'], object: ['#F9ECB0', '#80DADA', '#BEEBEB', '#FFFFFF'] };
  const map = PaletteEngine.buildColorMap(asset, pal);
  assert(map['#AA9BF0'] !== map['#F9A3AA'], 'background and object must not share a color');
});

test('recolor replaces fill and stroke attributes', () => {
  const map = { '#F9A3AA': '#80DADA', '#181817': '#181817' };
  const out = PaletteEngine.recolor('<path fill="#F9A3AA"/><path stroke="#181817"/>', map);
  assert(out.includes('fill="#80DADA"'), 'fill replaced');
  assert(out.includes('stroke="#181817"'), 'stroke kept');
});

test('recolor handles rgb() fills', () => {
  const map = { '#F9A3AA': '#80DADA' };
  const out = PaletteEngine.recolor('<path fill="rgb(249, 163, 170)"/>', map);
  assert(out.includes('fill="#80DADA"'), 'rgb fill replaced');
});

test('recolor handles style fills', () => {
  const map = { '#F9A3AA': '#80DADA' };
  const out = PaletteEngine.recolor('<path style="fill:#F9A3AA"/>', map);
  assert(out.includes('fill:#80DADA'), 'style fill replaced');
});

test('background objects map by palette position', () => {
  const asset = { colorRoles: { '#7864D7': 'background', '#D7CDF5': 'background' } };
  const pal = { background: ['#BEEBEB', '#80DADA', '#5ABEBE', '#181817'] };
  const map = PaletteEngine.buildBackgroundMap(asset, pal, pal.background[0]);
  // the dark color takes the color of the same position in the palette
  assertEqual(map['#7864D7'], '#5ABEBE');
  // the canvas background slot moves to the next palette color
  assertEqual(map['#D7CDF5'], '#80DADA');
});

test('background objects never use the canvas background color', () => {
  const asset = { colorRoles: { '#7864D7': 'background', '#D7CDF5': 'background' } };
  const palettes = [
    { background: ['#D7CDF5', '#AA9BF0', '#7864D7', '#181817'] },
    { background: ['#FDD7B9', '#FAC896', '#D27532', '#181817'] },
    { background: ['#BEEBEB', '#80DADA', '#5ABEBE', '#181817'] },
  ];
  for (const pal of palettes) {
    const canvas = pal.background[0];
    const map = PaletteEngine.buildBackgroundMap(asset, pal, canvas);
    for (const src of Object.keys(map)) {
      assert(map[src] !== canvas, src + ' must not take the canvas color ' + canvas);
    }
  }
});

test('background objects stay visible against the canvas', () => {
  const asset = { colorRoles: { '#7864D7': 'background', '#D7CDF5': 'background' } };
  const pal = { background: ['#BEEBEB', '#80DADA', '#5ABEBE', '#181817'] };
  const out = PaletteEngine.monochrome('<path fill="#7864D7"/><path fill="#D7CDF5"/>', pal, asset);
  assert(out.includes('fill="#5ABEBE"'), 'dark color mapped');
  assert(out.includes('fill="#80DADA"'), 'light color moved to the next palette slot');
  assert(!out.includes('fill="#BEEBEB"'), 'the canvas background is not used as a fill');
});

test('background objects keep neutral colors', () => {
  const asset = { colorRoles: { '#7864D7': 'background', '#181817': 'neutral' } };
  const pal = { background: ['#BEEBEB', '#80DADA', '#5ABEBE', '#181817'] };
  const out = PaletteEngine.monochrome('<path fill="#7864D7"/><path fill="#181817"/>', pal, asset);
  assert(out.includes('fill="#181817"'), 'neutral preserved');
});

// ---------------------------------------------------------------- layout

test('bbox of an unrotated object', () => {
  const b = Layout.bbox(10, 20, 100, 50, 0);
  assertEqual([Math.round(b.x), Math.round(b.y), Math.round(b.w), Math.round(b.h)], [10, 20, 100, 50]);
});

test('bbox grows when the object is rotated', () => {
  // At 45 degrees the axis aligned box of a 100x50 object is about 106x106
  const b = Layout.bbox(0, 0, 100, 50, 45);
  assert(b.w > 100, 'rotated width is larger: ' + b.w);
  assert(b.h > 100, 'rotated height is larger: ' + b.h);
});

test('bbox swaps the sides at 90 degrees', () => {
  const b = Layout.bbox(0, 0, 100, 50, 90);
  assert(Math.abs(b.w - 50) < 0.5, 'width becomes the height: ' + b.w);
  assert(Math.abs(b.h - 100) < 0.5, 'height becomes the width: ' + b.h);
});

test('bbox keeps the centre in place', () => {
  const b = Layout.bbox(100, 100, 100, 100, 45);
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  assert(Math.abs(cx - 150) < 0.5, 'centre x preserved');
  assert(Math.abs(cy - 150) < 0.5, 'centre y preserved');
});

test('fitsInside detects objects larger than the canvas', () => {
  const big = Layout.bbox(0, 0, 1446, 977, 0);
  assert(!Layout.fitsInside(big, '1000x1000'), 'too wide for the square format');
  const ok = Layout.bbox(10, 10, 300, 200, 0);
  assert(Layout.fitsInside(ok, '1000x1000'), 'small object fits');
});

test('checkFit accepts a large object because the composition may be scaled', () => {
  const instances = [
    { name: 'Книга', size: 'L', role: 'main' },
  ];
  const sizes = { 'Книга': { w: 1446, h: 977 } };
  const res = Layout.checkFit(instances, '1000x1000', (i) => sizes[i.name]);
  assert(res.ok, 'must fit: ' + res.reason);
  assert(res.scale < 1, 'a scale factor is reported: ' + res.scale);
});

test('checkFit rejects a row that stays too wide at the minimum scale', () => {
  // Ten wide objects: even at the 5% floor the row does not fit
  const instances = [];
  const sizes = {};
  for (let i = 0; i < 10; i++) {
    const n = 'Объект' + i;
    instances.push({ name: n, size: 'L', role: 'main' });
    sizes[n] = { w: 2000, h: 2000 };
  }
  const res = Layout.checkFit(instances, '1000x1000', (i) => sizes[i.name]);
  assert(!res.ok, 'must not fit: ' + res.reason);
  assert(res.reason.indexOf('Объект0') !== -1, 'reason names the objects');
});

test('checkFit accepts a wide row because the composition is scaled', () => {
  const instances = [];
  const sizes = {};
  for (const n of ['А', 'Б', 'В']) {
    instances.push({ name: n, size: 'L', role: 'main' });
    sizes[n] = { w: 900, h: 900 };
  }
  const res = Layout.checkFit(instances, '1000x1000', (i) => sizes[i.name]);
  assert(res.ok, 'must fit: ' + res.reason);
  assert(res.scale < 1, 'the composition is scaled down: ' + res.scale);
});

test('checkFit clamps the scale so objects stay visible', () => {
  const instances = [{ name: 'Гигант', size: 'L', role: 'main' }];
  const sizes = { 'Гигант': { w: 50000, h: 50000 } };
  const res = Layout.checkFit(instances, '1000x1000', (i) => sizes[i.name]);
  assert(res.scale >= 0.05, 'scale is clamped: ' + res.scale);
});

test('checkFit accepts objects that fit', () => {
  const instances = [
    { name: 'Книга', size: 'S', role: 'main' },
    { name: 'Монета', size: 'S', role: 'main' },
  ];
  const sizes = { 'Книга': { w: 723, h: 489 }, 'Монета': { w: 153, h: 101 } };
  const res = Layout.checkFit(instances, '1000x1000', (i) => sizes[i.name]);
  assert(res.ok, 'must fit: ' + res.reason);
});

test('place keeps the intrinsic sizes untouched without a scale', () => {
  const instances = [
    { name: 'Книга', size: 'S', role: 'main', x: 0, y: 0, rotation: 0 },
    { name: 'Монета', size: 'S', role: 'main', x: 0, y: 0, rotation: 0 },
  ];
  const sizes = { 'Книга': { w: 723, h: 489 }, 'Монета': { w: 153, h: 101 } };
  const placed = Layout.place(instances, '1000x1000', (i) => sizes[i.name], 1);
  for (const p of placed) {
    const s = sizes[p.name];
    const b = Layout.bbox(p.x, p.y, s.w, s.h, p.rotation);
    assert(Math.abs(b.w - s.w) < 0.5, 'width unchanged');
    assert(Math.abs(b.h - s.h) < 0.5, 'height unchanged');
  }
});

test('computeScale returns 1 when everything already fits', () => {
  const instances = [{ name: 'Монета', size: 'S', role: 'main' }];
  const sizes = { 'Монета': { w: 153, h: 101 } };
  const s = Layout.computeScale(instances, '1000x1000', (i) => sizes[i.name]);
  assertEqual(s, 1);
});

test('computeScale shrinks a composition that does not fit', () => {
  const instances = [{ name: 'Книга', size: 'L', role: 'main' }];
  const sizes = { 'Книга': { w: 1446, h: 977 } };
  const s = Layout.computeScale(instances, '1000x1000', (i) => sizes[i.name]);
  assert(s < 1, 'scale is below 1: ' + s);
  assert(s * 1446 <= 1000, 'scaled width fits the canvas');
});

test('the composition scale keeps the relative sizes of the objects', () => {
  const instances = [
    { name: 'Книга', size: 'L', role: 'main' },
    { name: 'Монета', size: 'L', role: 'main' },
  ];
  const sizes = { 'Книга': { w: 1446, h: 977 }, 'Монета': { w: 287, h: 189 } };
  const s = Layout.computeScale(instances, '1000x1000', (i) => sizes[i.name]);
  const ratioBefore = sizes['Книга'].w / sizes['Монета'].w;
  const ratioAfter = (sizes['Книга'].w * s) / (sizes['Монета'].w * s);
  assert(Math.abs(ratioBefore - ratioAfter) < 1e-9, 'relative sizes are preserved');
});

test('place keeps the scaled main objects inside the canvas', () => {
  const instances = [
    { name: 'Книга', size: 'L', role: 'main', x: 0, y: 0, rotation: 0 },
    { name: 'Монета', size: 'L', role: 'main', x: 0, y: 0, rotation: 0 },
  ];
  const sizes = { 'Книга': { w: 1446, h: 977 }, 'Монета': { w: 287, h: 189 } };
  const s = Layout.computeScale(instances, '1000x1000', (i) => sizes[i.name]);
  const placed = Layout.place(instances, '1000x1000', (i) => sizes[i.name], s);
  for (const p of placed) {
    const size = sizes[p.name];
    const b = Layout.bbox(p.x, p.y, size.w * s, size.h * s, p.rotation);
    assert(Layout.fitsInside(b, '1000x1000'), p.name + ' must be inside the canvas');
  }
});

test('place keeps main objects inside the canvas', () => {
  const instances = [
    { name: 'Книга', size: 'S', role: 'main', x: 0, y: 0, rotation: 0 },
    { name: 'Монета', size: 'S', role: 'main', x: 0, y: 0, rotation: 0 },
  ];
  const sizes = { 'Книга': { w: 723, h: 489 }, 'Монета': { w: 153, h: 101 } };
  const placed = Layout.place(instances, '1000x1000', (i) => sizes[i.name]);
  for (const p of placed) {
    const s = sizes[p.name];
    const b = Layout.bbox(p.x, p.y, s.w, s.h, p.rotation);
    assert(Layout.fitsInside(b, '1000x1000'), p.name + ' must be inside the canvas');
  }
});

test('place does not overlap main objects', () => {
  const instances = [
    { name: 'Книга', size: 'S', role: 'main', x: 0, y: 0, rotation: 0 },
    { name: 'Монета', size: 'S', role: 'main', x: 0, y: 0, rotation: 0 },
  ];
  const sizes = { 'Книга': { w: 723, h: 489 }, 'Монета': { w: 153, h: 101 } };
  const placed = Layout.place(instances, '1000x1000', (i) => sizes[i.name], 1);
  const a = Layout.bbox(placed[0].x, placed[0].y, 723, 489, 0);
  const b = Layout.bbox(placed[1].x, placed[1].y, 153, 101, 0);
  assert(!Layout.conflicts(a, b), 'main objects must not overlap');
});

test('place works for the horizontal format', () => {
  const instances = [
    { name: 'Книга', size: 'S', role: 'main', x: 0, y: 0, rotation: 0 },
  ];
  const sizes = { 'Книга': { w: 723, h: 489 } };
  const placed = Layout.place(instances, '1200x630', (i) => sizes[i.name], 1);
  const b = Layout.bbox(placed[0].x, placed[0].y, 723, 489, 0);
  assert(Layout.fitsInside(b, '1200x630'), 'fits the horizontal format');
});

test('place works for the vertical format', () => {
  const instances = [
    { name: 'Книга', size: 'S', role: 'main', x: 0, y: 0, rotation: 0 },
  ];
  const sizes = { 'Книга': { w: 723, h: 489 } };
  const placed = Layout.place(instances, '800x1200', (i) => sizes[i.name], 1);
  const b = Layout.bbox(placed[0].x, placed[0].y, 723, 489, 0);
  assert(Layout.fitsInside(b, '800x1200'), 'fits the vertical format');
});

test('place keeps a background only scene inside the canvas', () => {
  const instances = [
    { name: 'Книга', size: 'S', role: 'background', x: 0, y: 0, rotation: 0 },
  ];
  const sizes = { 'Книга': { w: 723, h: 489 } };
  const fit = Layout.checkFit(instances, '1000x1000', (i) => sizes[i.name]);
  const placed = Layout.place(instances, '1000x1000', (i) => sizes[i.name], fit.scale);
  const b = Layout.bbox(placed[0].x, placed[0].y, 723 * fit.scale, 489 * fit.scale, 0);
  assert(Layout.fitsInside(b, '1000x1000'), 'background object stays inside the canvas');
});

test('place keeps background objects behind the main ones', () => {
  const instances = [
    { name: 'Книга', size: 'S', role: 'main', x: 0, y: 0, rotation: 0 },
    { name: 'Монета', size: 'S', role: 'background', x: 0, y: 0, rotation: 0 },
  ];
  const sizes = { 'Книга': { w: 723, h: 489 }, 'Монета': { w: 153, h: 101 } };
  const fit = Layout.checkFit(instances, '1000x1000', (i) => sizes[i.name]);
  const placed = Layout.place(instances, '1000x1000', (i) => sizes[i.name], fit.scale);
  const main = placed.find(p => p.role === 'main');
  const back = placed.find(p => p.role === 'background');
  assert(back.y >= main.y, 'background object sits below the main one');
});

// ---------------------------------------------------------------- transform

/** Apply an SVG transform string (translate/rotate) to a point. */
function applyTransform(str, px, py) {
  const ops = [];
  const re = /(translate|rotate)\(([^)]*)\)/g;
  let m;
  while ((m = re.exec(str))) {
    ops.push({ type: m[1], args: m[2].split(',').map(Number) });
  }
  let x = px, y = py;
  // SVG applies the rightmost operation first.
  for (let i = ops.length - 1; i >= 0; i--) {
    const op = ops[i];
    if (op.type === 'translate') {
      x += op.args[0];
      y += op.args[1];
    } else {
      const r = op.args[0] * Math.PI / 180;
      const nx = x * Math.cos(r) - y * Math.sin(r);
      const ny = x * Math.sin(r) + y * Math.cos(r);
      x = nx; y = ny;
    }
  }
  return [x, y];
}

test('transform rotates around the object centre', () => {
  const size = { w: 200, h: 100 };
  const inst = { x: 50, y: 30, rotation: 45 };
  const str = Layout.transform(inst, size, 1);
  const centre = applyTransform(str, 100, 50); // local centre
  assert(Math.abs(centre[0] - 150) < 0.5, 'centre x: ' + centre[0]);
  assert(Math.abs(centre[1] - 80) < 0.5, 'centre y: ' + centre[1]);
});

test('transform keeps the centre fixed for any rotation', () => {
  const size = { w: 1446, h: 977 };
  const inst = { x: 16, y: 100, rotation: 0 };
  const cx = size.w / 2, cy = size.h / 2;
  for (const rot of [0, 30, 90, 180, -45]) {
    inst.rotation = rot;
    const str = Layout.transform(inst, size, 1);
    const p = applyTransform(str, cx, cy);
    assert(Math.abs(p[0] - (16 + cx)) < 0.5, 'rot ' + rot + ' centre x: ' + p[0]);
    assert(Math.abs(p[1] - (100 + cy)) < 0.5, 'rot ' + rot + ' centre y: ' + p[1]);
  }
});

test('transform accounts for the composition scale', () => {
  const size = { w: 400, h: 200 };
  const inst = { x: 0, y: 0, rotation: 90 };
  const str = Layout.transform(inst, size, 0.5);
  // local centre of the scaled box is (100, 50)
  const p = applyTransform(str, 100, 50);
  assert(Math.abs(p[0] - 100) < 0.5, 'centre x: ' + p[0]);
  assert(Math.abs(p[1] - 50) < 0.5, 'centre y: ' + p[1]);
});

test('transform does not contain a scale', () => {
  const str = Layout.transform({ x: 0, y: 0, rotation: 0 }, { w: 10, h: 10 }, 0.5);
  assert(str.indexOf('scale') === -1, 'scale belongs to the inner group: ' + str);
});

test('exportTransform folds in the composition scale', () => {
  const str = Layout.exportTransform({ x: 10, y: 20, rotation: 15 }, { w: 400, h: 200 }, 0.5);
  assert(str.indexOf('scale(0.5)') !== -1, 'scale present: ' + str);
  assert(str.indexOf('rotate(15)') !== -1, 'rotation present: ' + str);
  // the centre of the scaled box must stay at (x + cx, y + cy)
  const p = applyTransform(str, 100, 50);
  assert(Math.abs(p[0] - (10 + 100)) < 0.5, 'centre x: ' + p[0]);
  assert(Math.abs(p[1] - (20 + 50)) < 0.5, 'centre y: ' + p[1]);
});

test('exportTransform and transform agree on the centre', () => {
  const size = { w: 723, h: 489 };
  const inst = { x: 16, y: 511, rotation: 37 };
  const k = 0.66;
  const a = applyTransform(Layout.transform(inst, size, k), size.w * k / 2, size.h * k / 2);
  const b = applyTransform(Layout.exportTransform(inst, size, k), size.w * k / 2, size.h * k / 2);
  assert(Math.abs(a[0] - b[0]) < 0.5 && Math.abs(a[1] - b[1]) < 0.5,
    'same centre: ' + a + ' vs ' + b);
});

console.log('\n' + passed + '/' + (passed + failed) + ' unit tests passed');
process.exit(failed ? 1 : 0);
