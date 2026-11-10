/**
 * Layout engine.
 *
 * Hard rules from the spec:
 *  - Individual objects are never scaled. Their intrinsic size comes from
 *    the L/S variant.
 *  - The composition as a whole may be scaled by a single factor so it fits
 *    the target format. The same factor applies to every object, so the
 *    relative sizes of the objects stay exactly the same.
 *  - Only position, rotation, z-order, palette and state may change.
 *  - Main objects must fit fully inside the canvas and must not overlap
 *    each other substantially.
 *  - Background objects and decor may overlap and may be cropped.
 */

const Layout = (typeof globalThis !== 'undefined' ? globalThis : window).Layout = {
  /** Formats supported by the service. */
  FORMATS: {
    '1000x1000': { w: 1000, h: 1000 },
    '1200x630': { w: 1200, h: 630 },
    '800x1200': { w: 800, h: 1200 },
  },

  /** Margin kept between main objects and the canvas edge. */
  MARGIN: 16,

  /** Minimum gap between two main objects so they do not overlap. */
  GAP: 12,

  /**
   * Uniform factor applied to the whole composition.
   *
   * It is derived from the intrinsic sizes, so objects keep their relative
   * proportions. The factor is never stored per object.
   */
  scale: 1,

  /**
   * Build one arrangement candidate with the given number of columns.
   *
   * Items are placed row-major. The candidate records the required scale
   * and the row layout; the actual coordinates are produced by place().
   */
  mainPlanForColumns(items, format, columns) {
    const f = Layout.FORMATS[format] || Layout.FORMATS['1000x1000'];
    const cols = Math.max(1, Math.min(columns, items.length));
    const rows = [];
    for (let i = 0; i < items.length; i += cols) {
      rows.push(items.slice(i, i + cols));
    }

    const gap = Layout.GAP;
    const metrics = rows.map(row => {
      const width = row.reduce((sum, item) => sum + item.w, 0) +
        gap * Math.max(0, row.length - 1);
      const height = row.reduce((max, item) => Math.max(max, item.h), 0);
      return { width, height };
    });
    const maxWidth = metrics.reduce((max, m) => Math.max(max, m.width), 0);
    const totalHeight = metrics.reduce((sum, m) => sum + m.height, 0) +
      gap * Math.max(0, rows.length - 1);

    const usableW = Math.max(1, f.w - Layout.MARGIN * 2);
    const usableH = Math.max(1, f.h - Layout.MARGIN * 2);
    const scale = Math.min(usableW / maxWidth, usableH / totalHeight, 1);

    return { columns: cols, rows, metrics, maxWidth, totalHeight, scale };
  },

  /**
   * Choose the best arrangement for the current set of main objects.
   *
   * Tries every column count from a single column to a single row and picks
   * the arrangement that needs the largest (least destructive) scale.
   * Rotation-aware boxes are used so manually rotated objects are not
   * under-estimated.
   */
  planMain(instances, format, getSize) {
    const f = Layout.FORMATS[format] || Layout.FORMATS['1000x1000'];
    const mains = instances.filter(i => i.role === 'main');
    const items = mains.map(inst => {
      const size = getSize(inst);
      if (!size) return null;
      const box = Layout.bbox(0, 0, size.w, size.h, inst.rotation || 0);
      return { inst, w: box.w, h: box.h };
    }).filter(Boolean);

    if (!items.length) {
      return { columns: 0, rows: [], metrics: [], maxWidth: 0, totalHeight: 0, scale: 1 };
    }

    const aspect = f.w / f.h;
    const candidates = [];
    for (let columns = 1; columns <= items.length; columns++) {
      candidates.push(Layout.mainPlanForColumns(items, format, columns));
    }

    const preference = (plan) => {
      if (aspect > 1.3) return plan.columns;
      if (aspect < 0.77) return plan.rows.length;
      return -plan.rows.length;
    };

    candidates.sort((a, b) => {
      if (Math.abs(a.scale - b.scale) > 1e-9) return b.scale - a.scale;
      const prefA = preference(a);
      const prefB = preference(b);
      if (prefA !== prefB) return prefB - prefA;
      return b.columns - a.columns;
    });

    return candidates[0];
  },

  /**
   * Uniform factor needed to fit the chosen arrangement into the format.
   *
   * Returns 1 when everything already fits.
   */
  computeScale(instances, format, getSize) {
    const scale = Layout.planMain(instances, format, getSize).scale;
    // Never scale up: objects keep their intrinsic size when they fit.
    return scale < 1 ? Math.max(0.05, scale) : 1;
  },

  /**
   * Axis aligned bounding box of an object placed at (x, y) with a rotation.
   *
   * The object's intrinsic box starts at its top-left corner and is rotated
   * around its own centre, so the centre stays at (x + w/2, y + h/2).
   */
  bbox(x, y, width, height, rotationDeg) {
    const rad = (rotationDeg || 0) * Math.PI / 180;
    const cx = x + width / 2;
    const cy = y + height / 2;
    const cos = Math.abs(Math.cos(rad));
    const sin = Math.abs(Math.sin(rad));
    const w = width * cos + height * sin;
    const h = width * sin + height * cos;
    return { x: cx - w / 2, y: cy - h / 2, w, h };
  },

  /** True when the box lies fully inside the canvas. */
  fitsInside(box, format) {
    const f = Layout.FORMATS[format] || Layout.FORMATS['1000x1000'];
    return box.x >= 0 && box.y >= 0 &&
           box.x + box.w <= f.w + 0.5 &&
           box.y + box.h <= f.h + 0.5;
  },

  /**
   * Clamp an object's position so its rotated box stays inside the canvas.
   *
   * Returns the corrected top-left position. Objects larger than the canvas
   * cannot be made to fit; they are centred so the overflow is symmetric.
   */
  clampToCanvas(x, y, width, height, rotationDeg, format) {
    const f = Layout.FORMATS[format] || Layout.FORMATS['1000x1000'];
    const box = Layout.bbox(x, y, width, height, rotationDeg);
    let dx = 0;
    let dy = 0;

    if (box.w >= f.w) {
      dx = (f.w - box.w) / 2 - box.x;
    } else if (box.x < 0) {
      dx = -box.x;
    } else if (box.x + box.w > f.w) {
      dx = f.w - (box.x + box.w);
    }

    if (box.h >= f.h) {
      dy = (f.h - box.h) / 2 - box.y;
    } else if (box.y < 0) {
      dy = -box.y;
    } else if (box.y + box.h > f.h) {
      dy = f.h - (box.y + box.h);
    }

    return { x: x + dx, y: y + dy };
  },

  /** Overlap area of two boxes. */
  overlap(a, b) {
    const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
    const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
    return w > 0 && h > 0 ? w * h : 0;
  },

  /** True when two main objects overlap by more than the allowed fraction. */
  conflicts(a, b) {
    const area = Layout.overlap(a, b);
    if (area <= 0) return false;
    const smallest = Math.min(a.w * a.h, b.w * b.h);
    return smallest > 0 && area / smallest > 0.05;
  },

  /**
   * Check whether a set of instances can be placed in the given format.
   *
   * Objects may be scaled as a whole, so a set is rejected only when it
   * cannot fit even after the composition scale is applied, for example
   * when a single object is larger than the format in both directions.
   *
   * @returns {{ok: boolean, reason: string, scale: number}}
   */
  checkFit(instances, format, getSize) {
    const f = Layout.FORMATS[format] || Layout.FORMATS['1000x1000'];
    const plan = Layout.planMain(instances, format, getSize);
    const mains = instances.filter(i => i.role === 'main');

    if (!plan.rows.length) {
      return { ok: true, reason: '', scale: 1 };
    }

    const scale = Math.min(1, Math.max(0.05, plan.scale));
    const usableW = f.w - Layout.MARGIN * 2;
    const usableH = f.h - Layout.MARGIN * 2;
    const totalW = plan.maxWidth * scale;
    const totalH = plan.totalHeight * scale;

    if (totalW > usableW + 0.5 || totalH > usableH + 0.5) {
      const names = mains.map(i => i.name + ' (' + i.size + ')').join(', ');
      return {
        ok: false,
        reason: 'Не помещается даже при общем масштабе композиции: ' + names +
                '. Выберите размер S, другой формат или меньше объектов.',
        scale,
      };
    }
    return { ok: true, reason: '', scale };
  },

  /**
   * Transform that rotates an object around its own centre.
   *
   * The object's top-left corner sits at (inst.x, inst.y), its box is
   * size * scale and the rotation happens around the box centre, which is
   * what Layout.bbox() assumes as well.
   *
   * @returns {string} SVG transform, without the scale
   */
  transform(inst, size, scale) {
    const k = scale || 1;
    const cx = size.w * k / 2;
    const cy = size.h * k / 2;
    const rot = inst.rotation || 0;
    return 'translate(' + (inst.x + cx) + ',' + (inst.y + cy) + ') rotate(' + rot +
           ') translate(' + (-cx) + ',' + (-cy) + ')';
  },

  /**
   * Same as Layout.transform, with the composition scale folded in.
   *
   * Used for the exported SVG, where the object markup is drawn in its
   * source coordinates and has to be scaled in the same group.
   */
  exportTransform(inst, size, scale) {
    const k = scale || 1;
    const cx = size.w * k / 2;
    const cy = size.h * k / 2;
    const rot = inst.rotation || 0;
    return 'translate(' + (inst.x + cx) + ',' + (inst.y + cy) + ') rotate(' + rot +
           ') translate(' + (-cx) + ',' + (-cy) + ') scale(' + k + ')';
  },

  /**
   * Find a free position for one new object without moving existing ones.
   *
   * This is used when the user adds an object manually: the current
   * composition is preserved and only the new object is positioned.
   * Returns null when no free spot exists at the current composition scale.
   */
  placeNew(inst, instances, format, getSize, scale) {
    const f = Layout.FORMATS[format] || Layout.FORMATS['1000x1000'];
    const k = scale || 1;
    const size = getSize(inst);
    if (!size) return null;

    const w = size.w * k;
    const h = size.h * k;
    const margin = Layout.MARGIN;

    if (inst.role === 'background') {
      // Background objects may overlap and be cropped; place them along the
      // bottom edge, offset from the already present background layers.
      let x = margin;
      for (const other of instances) {
        if (other.role !== 'background') continue;
        const otherSize = getSize(other);
        if (otherSize) x += Math.round(otherSize.w * k * 0.75);
      }
      x = Math.min(x, Math.max(margin, f.w - w));
      return { x, y: Math.max(0, f.h - h), rotation: 0 };
    }

    const existingMains = instances.filter(i => i.role === 'main');
    if (!existingMains.length) {
      return {
        x: Math.max(margin, Math.round((f.w - w) / 2)),
        y: Math.max(margin, Math.round((f.h - h) / 2)),
        rotation: 0,
      };
    }

    const existingBoxes = existingMains.map(i => {
      const s = getSize(i);
      return s ? Layout.bbox(i.x, i.y, s.w * k, s.h * k, i.rotation || 0) : null;
    }).filter(Boolean);

    // Search a grid of candidate positions, closest to the canvas centre
    // first, and take the first one that does not substantially overlap.
    const candidates = [];
    const step = 20;
    for (let y = margin; y + h <= f.h - margin + 0.5; y += step) {
      for (let x = margin; x + w <= f.w - margin + 0.5; x += step) {
        const dx = x + w / 2 - f.w / 2;
        const dy = y + h / 2 - f.h / 2;
        candidates.push({ x, y, d: dx * dx + dy * dy });
      }
    }
    candidates.sort((a, b) => a.d - b.d);

    for (const c of candidates) {
      const box = Layout.bbox(c.x, c.y, w, h, 0);
      if (!existingBoxes.some(b => Layout.conflicts(box, b))) {
        return { x: c.x, y: c.y, rotation: 0 };
      }
    }

    return null;
  },

  /**
   * Place instances in the canvas without changing their sizes.
   *
   * Main objects are laid out in a row (up to 3) and never overlap.
   * Background objects are spread behind them and may be cropped.
   *
   * @returns {Array} instances with updated x, y and rotation
   */
  place(instances, format, getSize, scale) {
    const f = Layout.FORMATS[format] || Layout.FORMATS['1000x1000'];
    const k = scale || 1;
    const result = instances.map(i => Object.assign({}, i));
    const backs = result.filter(i => i.role === 'background');

    // --- main objects: best grid for the current count, centered ---
    const margin = Layout.MARGIN;
    const gap = Layout.GAP * k;
    const plan = Layout.planMain(result, format, getSize);

    if (plan.rows.length) {
      const rowWidths = plan.rows.map(row =>
        row.reduce((sum, item) => sum + item.w * k, 0) +
        gap * Math.max(0, row.length - 1)
      );
      const rowHeights = plan.rows.map(row =>
        row.reduce((max, item) => Math.max(max, item.h * k), 0)
      );
      const totalW = Math.max.apply(null, rowWidths);
      const totalH = rowHeights.reduce((sum, h) => sum + h, 0) +
        gap * Math.max(0, rowHeights.length - 1);

      let cursorY = Math.max(margin, (f.h - totalH) / 2);
      for (let r = 0; r < plan.rows.length; r++) {
        const row = plan.rows[r];
        const rowWidth = rowWidths[r];
        const rowHeight = rowHeights[r];
        let cursorX = Math.max(margin, (f.w - rowWidth) / 2);

        for (const item of row) {
          item.inst.x = cursorX;
          item.inst.y = cursorY + (rowHeight - item.h * k) / 2;
          item.inst.rotation = 0;
          cursorX += item.w * k + gap;
        }
        cursorY += rowHeight + gap;
      }
    }

    /** Intrinsic size multiplied by the composition scale. */
    const scaledSize = (inst) => {
      const s = getSize(inst);
      return s ? { w: s.w * k, h: s.h * k } : null;
    };

    // --- background objects: a row behind the main objects ---
    // They are placed above the bottom edge, so they stay visible; being
    // partly covered by the main objects is expected for background art.
    let backX = margin;
    for (const b of backs) {
      const size = scaledSize(b);
      if (!size) continue;
      b.x = backX;
      b.y = Math.max(0, f.h - size.h);
      b.rotation = 0;
      backX += Math.round(size.w * 0.75);
    }

    return result;
  },
};
