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
   * Uniform factor needed to fit the given objects into the format.
   *
   * The factor accounts for the whole row of main objects, not for each
   * object on its own, so a set of objects stays side by side after the
   * composition is scaled.
   *
   * Returns 1 when everything already fits.
   */
  computeScale(instances, format, getSize) {
    const f = Layout.FORMATS[format] || Layout.FORMATS['1000x1000'];
    const usableW = f.w - Layout.MARGIN * 2;
    const usableH = f.h - Layout.MARGIN * 2;

    const mains = instances.filter(i => i.role === 'main');
    if (!mains.length) return 1;

    // A row of main objects: their widths add up, separated by gaps.
    // The gap scales together with the composition, so the row width is
    //   scale * (sum of widths + gap * (count - 1))
    // and the scale follows from that expression.
    const gapTotal = Layout.GAP * Math.max(0, mains.length - 1);
    let widths = 0;
    let maxH = 0;
    for (const inst of mains) {
      const size = getSize(inst);
      if (!size) continue;
      widths += size.w;
      maxH = Math.max(maxH, size.h);
    }
    if (!widths || !maxH) return 1;

    const rowWidth = widths + gapTotal;
    const byWidth = usableW / rowWidth;
    const byHeight = usableH / maxH;
    const need = Math.min(byWidth, byHeight);

    // Never scale up: objects keep their intrinsic size when they already fit.
    return need < 1 ? Math.max(0.05, need) : 1;
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
    const scale = Layout.computeScale(instances, format, getSize);

    const mains = instances.filter(i => i.role === 'main');
    // Same formula as computeScale: the row width is the sum of the scaled
    // object widths plus the scaled gaps.
    let totalW = Layout.GAP * scale * Math.max(0, mains.length - 1);
    let maxH = 0;
    for (const inst of mains) {
      const size = getSize(inst);
      if (!size) continue;
      totalW += size.w * scale;
      maxH = Math.max(maxH, size.h * scale);
    }
    const usableW = f.w - Layout.MARGIN * 2;
    const usableH = f.h - Layout.MARGIN * 2;

    if (totalW > usableW + 0.5 || maxH > usableH + 0.5) {
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
    const mains = result.filter(i => i.role === 'main');
    const backs = result.filter(i => i.role === 'background');

    /** Intrinsic size multiplied by the composition scale. */
    const scaledSize = (inst) => {
      const s = getSize(inst);
      return s ? { w: s.w * k, h: s.h * k } : null;
    };

    // --- main objects: horizontal band, centered, no overlap ---
    const margin = Layout.MARGIN;
    const gap = Layout.GAP;

    const sizes = mains.map(m => scaledSize(m)).filter(Boolean);
    const totalW = sizes.reduce((s, sz) => s + sz.w, 0) + gap * Math.max(0, sizes.length - 1);

    // Only the main objects decide where the band sits: a tall background
    // layer must not push the main row towards the top edge.
    const mainH = sizes.reduce((m, sz) => Math.max(m, sz.h), 0);

    let cursorX = margin;
    if (totalW + margin * 2 <= f.w) {
      cursorX = Math.max(margin, Math.round((f.w - totalW) / 2));
    }
    const bandY = Math.max(margin, Math.round((f.h - mainH) / 2));

    for (const m of mains) {
      const size = scaledSize(m);
      if (!size) continue;
      m.x = cursorX;
      m.y = bandY;
      m.rotation = 0;
      cursorX += size.w + gap;
    }

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
