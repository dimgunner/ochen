/**
 * Palette engine: loads library SVG, recolors by color role, returns inline SVG markup.
 *
 * Rules from the spec:
 *  - Object colors may not be used in backgrounds.
 *  - Background colors may be used in objects.
 *  - Main objects stay colored; background objects stay monochrome.
 */
const PaletteEngine = (typeof globalThis !== 'undefined' ? globalThis : window).PaletteEngine = {
  // Build a map: sourceHex -> targetHex, for a given palette + asset roles
  buildColorMap(asset, palette) {
    const map = {};
    const roles = asset.colorRoles || {};
    const bg = palette.background || [];
    const obj = palette.object || [];
    const neutrals = { '#181817': '#181817', '#FFFFFF': '#FFFFFF' };

    for (const src of Object.keys(roles)) {
      const role = roles[src];
      const key = src.toUpperCase();

      if (role === 'neutral') {
        map[key] = neutrals[key] || key;
        continue;
      }

      if (role === 'background') {
        // Background role keeps its position inside the background palette.
        // Index is derived from the reference palette so the scheme stays consistent.
        const idx = PaletteEngine.referenceIndex('background', key);
        map[key] = bg[idx % bg.length];
        continue;
      }

      if (role === 'object') {
        const idx = PaletteEngine.referenceIndex('object', key);
        map[key] = obj[idx % obj.length];
        continue;
      }

      map[key] = key;
    }
    return map;
  },

  // Position of a color inside the reference (Purple) palette
  referenceIndex(role, hex) {
    const REF = {
      background: ['#D7CDF5', '#AA9BF0', '#7864D7', '#181817'],
      object: ['#F9ECB0', '#F9A3AA', '#FFE3E1', '#FFFFFF'],
    };
    const list = REF[role] || [];
    const i = list.indexOf(hex.toUpperCase());
    return i === -1 ? 0 : i;
  },

  /**
   * Recolor raw SVG markup.
   * @param {string} svg     original SVG text
   * @param {object} map     sourceHex -> targetHex
   * @returns {string}       recolored SVG markup
   */
  recolor(svg, map) {
    if (!svg) return '';
    let out = svg;

    // fill="..." and stroke="..." attributes
    out = out.replace(/fill="(#[0-9A-Fa-f]{6})"/g, (m, hex) => {
      const t = map[hex.toUpperCase()];
      return t ? 'fill="' + t + '"' : m;
    });
    out = out.replace(/stroke="(#[0-9A-Fa-f]{6})"/g, (m, hex) => {
      const t = map[hex.toUpperCase()];
      return t ? 'stroke="' + t + '"' : m;
    });

    // fill="rgb(r, g, b)" / #rgb short forms
    out = out.replace(/fill="rgb\((\d+),\s*(\d+),\s*(\d+)\)"/g, (m, r, g, b) => {
      const hex = '#' + [r, g, b].map(v => Number(v).toString(16).padStart(2, '0')).join('').toUpperCase();
      const t = map[hex];
      return t ? 'fill="' + t + '"' : m;
    });

    // style="fill:#HEX"
    out = out.replace(/fill:\s*(#[0-9A-Fa-f]{6})/g, (m, hex) => {
      const t = map[hex.toUpperCase()];
      return t ? 'fill:' + t : m;
    });

    return out;
  },

  /**
   * Treatment for background-state assets.
   *
   * The colors are mapped by their position inside the background palette,
   * the same way the main objects are mapped. The first color of the
   * background palette is the canvas background, so it is never used as a
   * fill: that slot keeps the original light tone of the asset instead.
   * The result stays monochrome but stays readable against the canvas.
   */
  monochrome(svg, palette, asset) {
    if (!svg) return '';
    const bg = (palette.background && palette.background[0]) || '#D7CDF5';
    const map = PaletteEngine.buildBackgroundMap(asset, palette, bg);
    return PaletteEngine.recolor(svg, map);
  },

  /**
   * Build the color map for a background-state asset.
   *
   * Colors are mapped by their position in the background palette, the same
   * way the main objects are mapped. The first color of the background
   * palette is the canvas background, so it is never used as a fill:
   * that slot moves to the next color of the palette, which keeps the
   * object readable against the canvas in every scheme.
   */
  buildBackgroundMap(asset, palette, canvasBackground) {
    const map = {};
    const target = (palette.background && palette.background) || [];

    for (const src of Object.keys((asset && asset.colorRoles) || {})) {
      const key = src.toUpperCase();
      const role = asset.colorRoles[src];

      if (role === 'neutral') {
        map[key] = key;
        continue;
      }

      const idx = PaletteEngine.referenceIndex('background', key);
      // The canvas background slot moves to the next palette color.
      const targetIdx = idx === 0 ? 1 : idx;

      map[key] = target[targetIdx % target.length] || key;
    }
    return map;
  },
};
