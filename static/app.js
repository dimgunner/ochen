const { createApp } = Vue;

const app = createApp({
  data() {
    return {
      tab: 'metaphor',
      metaphor: '',
      components: '',
      manifest: null,
      objects: [],
      selectedSize: 'L',
      selectedState: 'main',
      canvasWidth: 1000,
      canvasHeight: 1000,
      canvasFormat: '1000x1000',
      scene: { instances: [], format: {w:1000,h:1000}, palette: 'purple', scale: 1 },
      selectedId: null,
      dragging: false,
      dragStart: {x:0,y:0},
      palettes: [],
      currentPalette: 'purple',
      userPalettes: [],
      paletteError: '',
      paletteSuccess: '',
      layoutError: '',
      layoutWarning: '',
      llmInfo: null,
      generating: false,
      confirmDialog: null,
      storageError: '',
      rotating: false,
      rotateStart: null,
      svgData: {},
      svgLoading: false,
      maxMain: 3
    }
  },
  async mounted() {
    try {
      const res = await fetch('/api/manifest/');
      this.manifest = await res.json();
      this.objects = this.manifest.variants || [];
    } catch(e) {}
    try {
      const pres = await fetch('/static/palettes/palettes.json');
      const pdata = await pres.json();
      this.palettes = pdata.builtIn || [];
    } catch(e) {}

    this.scene.format = {w:this.canvasWidth,h:this.canvasHeight};
    const restored = await SceneStore.restore();
    if (restored && restored.scene) {
      this.scene = restored.scene;
      this.userPalettes = restored.userPalettes || [];
      const allPalettes = this.palettes.concat(this.userPalettes);
      this.currentPalette = allPalettes.some(p => p.id === restored.currentPalette)
        ? restored.currentPalette
        : (this.palettes[0] ? this.palettes[0].id : 'purple');

      const format = this.formatKeyFor(restored.scene.format && restored.scene.format.w,
        restored.scene.format && restored.scene.format.h);
      if (format) {
        this.setCanvasFormat(format);
      } else {
        this.setCanvasFormat('1000x1000');
        this.layoutError = 'Сохранённый формат холста неизвестен, выбран 1000x1000.';
      }
    }
    if (SceneStore.lastWarning) this.storageError = SceneStore.lastWarning;
    this.$nextTick(() => this.reloadAllSvgs());
  },
  watch: {
    scene: {
      handler() { this.schedulePersist(); },
      deep: true
    },
    userPalettes: {
      handler() { this.schedulePersist(); },
      deep: true
    },
    currentPalette() {
      this.svgData = {};
      this.reloadAllSvgs();
    }
  },
  computed: {
    filteredObjects() {
      if (!this.objects.length) return [];
      return this.objects.filter(o => o.size === this.selectedSize && o.state === this.selectedState);
    },
    selected() {
      return this.scene.instances.find(i => i.instanceId === this.selectedId) || null;
    },
    mainCount() {
      return this.countMains(this.scene.instances);
    },
    /** Built-in and user palettes, sorted by display name. */
    paletteOptions() {
      return this.palettes.concat(this.userPalettes).slice().sort((a, b) =>
        String(a.name || '').localeCompare(String(b.name || ''), 'ru', { sensitivity: 'base' })
      );
    },
    llmResponseText() {
      if (!this.llmInfo || !this.llmInfo.response) return '';
      return JSON.stringify(this.llmInfo.response, null, 2);
    },
    /**
     * Non-blocking hint for manual compositions that exceed the soft limit.
     * Automatic generation is limited separately in commitGenerated().
     */
    mainLimitWarning() {
      if (this.mainCount <= this.maxMain) return '';
      const scale = this.scene.scale || 1;
      const scaleText = scale < 1 - 1e-9
        ? ' Композиция уменьшена до ' + Math.round(scale * 100) + '%.'
        : '';
      return 'В композиции главных объектов: ' + this.mainCount +
        '. Рекомендуем 1–3.' + scaleText;
    },
    /** Background colour of the current palette. */
    backgroundColor() {
      const pal = this.getCurrentPalette();
      if (!pal) return '#FFFFFF';
      const bg = pal.background || (pal.colors && pal.colors.background) || [];
      return bg[0] || '#FFFFFF';
    }
  },
  methods: {
    getSvgPath(inst) {
      const v = this.objects.find(o => o.assetId === inst.assetId && o.size === inst.size && o.state === (inst.role === 'main' ? 'main' : 'background'));
      return v ? '/static/assets/' + v.path : '';
    },
    getCurrentPalette() {
      let p = this.palettes.find(x => x.id === this.currentPalette);
      if (!p) p = this.userPalettes.find(x => x.id === this.currentPalette);
      return p || this.palettes[0];
    },
    /** Find a Layout.FORMATS key by canvas dimensions. */
    formatKeyFor(w, h) {
      for (const key of Object.keys(Layout.FORMATS)) {
        const f = Layout.FORMATS[key];
        if (f.w === w && f.h === h) return key;
      }
      return null;
    },
    /** Apply a format to the canvas and the scene model. */
    setCanvasFormat(format) {
      const f = Layout.FORMATS[format];
      if (!f) return false;
      this.canvasFormat = format;
      this.canvasWidth = f.w;
      this.canvasHeight = f.h;
      this.scene.format = { w: f.w, h: f.h };
      return true;
    },
    /**
     * Change the canvas format. Reflowing the composition is destructive,
     * so it requires an explicit confirmation when the scene is not empty.
     */
    async requestFormatChange(event) {
      const select = event && event.target ? event.target : null;
      const next = select ? select.value : event;
      const prev = this.canvasFormat;
      if (!next || next === prev || !Layout.FORMATS[next]) {
        if (select) select.value = prev;
        return;
      }

      if (!this.scene.instances.length) {
        this.setCanvasFormat(next);
        return;
      }

      const confirmed = await this.askConfirm({
        title: 'Сменить формат?',
        message: 'Смена формата перераскладывает композицию и сбросит ручные позиции и повороты.',
        confirmLabel: 'Сменить формат',
        danger: true,
      });
      if (!confirmed) {
        if (select) select.value = prev;
        return;
      }

      this.setCanvasFormat(next);
      const fit = Layout.checkFit(this.scene.instances, next, (i) => this.objectSize(i));
      if (!fit.ok) {
        this.setCanvasFormat(prev);
        if (select) select.value = prev;
        this.layoutError = fit.reason;
        return;
      }
      this.applyPlacement(fit.scale);
    },
    findVariant(inst) {
      return this.objects.find(o => o.assetId === inst.assetId && o.size === inst.size && o.state === (inst.role === 'main' ? 'main' : 'background'));
    },
    /** Intrinsic size of an instance; sizes are never scaled. */
    objectSize(inst) {
      const v = this.findVariant(inst);
      if (!v || !v.width || !v.height) return null;
      return { w: v.width, h: v.height };
    },
    svgMarkup(inst) {
      return this.svgData[inst.instanceId + '_' + this.currentPalette] || '';
    },
    async loadSvg(inst) {
      const key = inst.instanceId + '_' + this.currentPalette;
      if (this.svgData[key]) return this.svgData[key];
      const variant = this.findVariant(inst);
      if (!variant) return '';
      try {
        const res = await fetch('/static/assets/' + variant.path);
        let svg = await res.text();
        const pal = this.getCurrentPalette();
        if (inst.role === 'background') {
          svg = PaletteEngine.monochrome(svg, pal, variant);
        } else {
          const map = PaletteEngine.buildColorMap(variant, pal);
          svg = PaletteEngine.recolor(svg, map);
        }
        // Strip the outer <svg> wrapper; we render it inside our own <g>
        svg = svg.replace(/^\s*<svg[^>]*>/i, '').replace(/<\/svg>\s*$/i, '');
        this.svgData[key] = svg;
        this.$forceUpdate();
        return svg;
      } catch(e) {
        console.error('loadSvg failed', e);
        return '';
      }
    },
    async reloadAllSvgs() {
      this.svgLoading = true;
      this.svgData = {};
      try {
        for (const inst of this.scene.instances) {
          await this.loadSvg(inst);
        }
      } finally {
        this.svgLoading = false;
      }
    },
    /** Make sure every visible instance has its SVG markup loaded. */
    async ensureSvgsLoaded() {
      for (const inst of this.scene.instances) {
        await this.loadSvg(inst);
      }
    },
    newInstance(variant) {
      const id = 'inst_' + Date.now() + '_' + Math.random().toString(36).substr(2,5);
      return {
        instanceId: id,
        assetId: variant.assetId,
        role: variant.state === 'main' ? 'main' : 'background',
        x: 0,
        y: 0,
        rotation: 0,
        name: variant.name,
        size: variant.size,
        state: variant.state,
      };
    },
    countMains(list) {
      return list.filter(i => i.role === 'main').length;
    },
    normaliseSearch(value) {
      return String(value || '').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim();
    },
    /** Split a component list by commas, semicolons, newlines or spaces. */
    parseComponentList(value) {
      return String(value || '')
        .split(/[,;\n]+/)
        .flatMap(part => part.trim().split(/\s+/))
        .map(part => part.trim())
        .filter(Boolean);
    },
    /** Open the in-app confirmation dialog and resolve with a boolean. */
    askConfirm(options) {
      if (this.confirmDialog) return Promise.resolve(false);
      return new Promise((resolve) => {
        this.confirmDialog = {
          title: options.title || 'Подтверждение',
          message: options.message || '',
          confirmLabel: options.confirmLabel || 'Продолжить',
          cancelLabel: options.cancelLabel || 'Отмена',
          danger: !!options.danger,
          resolve,
        };
        this.$nextTick(() => {
          if (this.$refs.confirmOk) this.$refs.confirmOk.focus();
        });
      });
    },
    resolveConfirm(result) {
      const dialog = this.confirmDialog;
      this.confirmDialog = null;
      if (dialog && dialog.resolve) dialog.resolve(result);
    },
    /** Find a variant by name, synonyms, tags or asset id. */
    findVariantByName(name) {
      const needle = this.normaliseSearch(name);
      if (!needle) return null;

      const pools = [
        this.objects.filter(v => v.size === this.selectedSize && v.state === this.selectedState),
      ];
      // Background variants sometimes have fewer synonyms than their main
      // counterparts; allow a match against the main catalog as a fallback.
      if (this.selectedState === 'background') {
        pools.push(this.objects.filter(v => v.size === this.selectedSize && v.state === 'main'));
      }

      let best = null;
      let bestScore = 0;
      for (const pool of pools) {
        for (const variant of pool) {
          if (!variant || !variant.assetId) continue;
          const values = [variant.assetId, variant.name]
            .concat(variant.synonyms || [], variant.tags || [])
            .map(v => this.normaliseSearch(v))
            .filter(Boolean);
          for (const value of values) {
            let score = 0;
            if (value === needle) score = 3;
            else if (value.startsWith(needle) || needle.startsWith(value)) score = 2;
            else if (value.includes(needle) || needle.includes(value)) score = 1;
            if (score > bestScore) {
              bestScore = score;
              best = variant;
            }
          }
        }
      }
      if (!best) return null;
      if (best.state === this.selectedState) return best;

      // Map the matched main asset to the requested state/size.
      return this.objects.find(v => v.assetId === best.assetId &&
        v.size === this.selectedSize && v.state === this.selectedState) || null;
    },
    /**
     * Replace the scene with a freshly generated composition.
     *
     * The current scene is kept untouched when the new set is empty or does
     * not fit, so a failed request never destroys the user's work.
     */
    async commitGenerated(instances, warnings) {
      this.layoutWarning = '';
      const messages = (warnings || []).slice();
      let mains = 0;
      let truncated = false;
      const limited = [];
      for (const inst of instances) {
        if (inst.role === 'main') {
          if (mains >= this.maxMain) {
            truncated = true;
            continue;
          }
          mains++;
        }
        limited.push(inst);
      }
      if (truncated) {
        messages.push('Автоматическая композиция ограничена ' + this.maxMain +
          ' главными объектами; лишние не добавлены.');
      }
      if (!limited.length) {
        this.layoutError = 'Подходящих объектов не найдено.';
        return false;
      }

      const fit = Layout.checkFit(limited, this.canvasFormat, (i) => this.objectSize(i));
      if (!fit.ok) {
        this.layoutError = fit.reason;
        return false;
      }

      const placed = Layout.place(limited, this.canvasFormat, (i) => this.objectSize(i), fit.scale);
      this.scene.instances = [];
      this.insertInstances(placed);
      this.scene.scale = fit.scale;
      this.selectedId = null;
      this.svgData = {};
      await this.reloadAllSvgs();
      this.layoutError = '';
      this.layoutWarning = messages.join(' ');
      return true;
    },
    async submitMetaphor() {
      if (this.generating) return;
      this.layoutError = '';
      this.layoutWarning = '';
      this.llmInfo = null;
      const text = (this.metaphor || '').trim();
      if (!text) {
        this.layoutError = 'Введите метафору или заголовок.';
        return;
      }
      this.generating = true;
      try {
        const res = await fetch('/api/interpret-metaphor/', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({text})
        });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        this.llmInfo = data.llm_info || null;
        if (!data.objects || !data.objects.length) {
          this.layoutError = 'По запросу «' + text + '» подходящих объектов не найдено. '
            + 'Уточните формулировку или выберите объекты из библиотеки вручную.';
          return;
        }

        const built = [];
        const warnings = [];
        for (const obj of data.objects) {
          const variant = this.objects.find(v => v.assetId === obj.assetId &&
            v.size === this.selectedSize &&
            v.state === (obj.role === 'main' ? 'main' : 'background'));
          if (!variant) {
            warnings.push('Часть объектов из ответа недоступна.');
            continue;
          }
          built.push(this.newInstance(variant));
        }
        await this.commitGenerated(built, warnings);
      } catch(e) {
        this.layoutError = 'Не удалось получить подбор: ' + e.message;
      } finally {
        this.generating = false;
      }
    },
    async submitList() {
      if (this.generating) return;
      this.layoutError = '';
      this.layoutWarning = '';
      this.llmInfo = null;
      const list = this.parseComponentList(this.components);
      if (!list.length) {
        this.layoutError = 'Введите названия компонентов через запятую.';
        return;
      }

      const built = [];
      const unknown = [];
      for (const name of list) {
        const variant = this.findVariantByName(name);
        if (!variant) {
          unknown.push(name);
          continue;
        }
        built.push(this.newInstance(variant));
      }
      if (!built.length) {
        this.layoutError = 'Неизвестный компонент: ' + unknown.join(', ');
        return;
      }

      this.generating = true;
      try {
        const replaced = await this.commitGenerated(built, []);
        const unknownMessage = unknown.length ? 'Неизвестный компонент: ' + unknown.join(', ') : '';
        if (unknownMessage) {
          this.layoutError = this.layoutError ? this.layoutError + ' ' + unknownMessage : unknownMessage;
        }
        if (!replaced && !unknownMessage) return;
      } finally {
        this.generating = false;
      }
    },
    addObject(obj) {
      this.layoutError = '';
      this.layoutWarning = '';
      const inst = this.newInstance(obj);
      const candidate = this.scene.instances.concat([inst]);
      const fit = Layout.checkFit(candidate, this.canvasFormat, (i) => this.objectSize(i));
      if (!fit.ok) {
        this.layoutError = fit.reason;
        return;
      }

      // Adding an object never moves the existing composition. If the whole
      // set only fits at a smaller composition scale, shrink it globally.
      if (fit.scale < (this.scene.scale || 1) - 1e-9) {
        this.scene.scale = fit.scale;
      }
      const scale = this.scene.scale || 1;
      const position = Layout.placeNew(inst, this.scene.instances, this.canvasFormat,
        (i) => this.objectSize(i), scale);
      if (!position) {
        this.layoutError = 'Не удалось найти свободное место для объекта. '
          + 'Нажмите «Автокомпоновка» или выберите размер S.';
        return;
      }

      inst.x = position.x;
      inst.y = position.y;
      inst.rotation = position.rotation;
      this.insertInstances([inst]);
      this.selectedId = inst.instanceId;
      this.loadSvg(inst);
    },
    select(inst) { this.selectedId = inst.instanceId; },
    /**
     * Insert new instances so that background art sits behind the main
     * objects. Array order is the paint order in SVG.
     */
    insertInstances(list) {
      const backs = list.filter(i => i.role === 'background');
      const mains = list.filter(i => i.role !== 'background');
      if (backs.length) this.scene.instances.unshift(...backs);
      this.scene.instances.push(...mains);
    },
    /** Geometry of an instance in canvas coordinates. */
    objectGeom(inst) {
      const size = this.objectSize(inst) || { w: 100, h: 100 };
      const k = this.scene.scale || 1;
      return {
        w: size.w,
        h: size.h,
        k: k,
        cx: size.w * k / 2,
        cy: size.h * k / 2,
      };
    },
    /** Transform rotating the object around its own centre. */
    groupTransform(inst) {
      return Layout.transform(inst, this.objectSize(inst) || { w: 100, h: 100 }, this.scene.scale || 1);
    },
    /** Convert a pointer event to SVG user coordinates. */
    svgPoint(e) {
      const svg = this.$refs.canvas;
      if (!svg) return { x: 0, y: 0 };
      // getScreenCTM() accounts for CSS scaling, viewBox and letterboxing.
      const ctm = svg.getScreenCTM && svg.getScreenCTM();
      if (ctm) {
        const pt = svg.createSVGPoint();
        pt.x = e.clientX;
        pt.y = e.clientY;
        const p = pt.matrixTransform(ctm.inverse());
        return { x: p.x, y: p.y };
      }
      const rect = svg.getBoundingClientRect();
      const w = Number(svg.getAttribute('width')) || rect.width;
      const h = Number(svg.getAttribute('height')) || rect.height;
      const sx = rect.width ? w / rect.width : 1;
      const sy = rect.height ? h / rect.height : 1;
      return {
        x: (e.clientX - rect.left) * sx,
        y: (e.clientY - rect.top) * sy,
      };
    },
    /** True when the object's rotated box fits inside the canvas. */
    mainFits(inst) {
      if (inst.role !== 'main') return true;
      const size = this.objectSize(inst);
      if (!size) return true;
      const k = this.scene.scale || 1;
      const box = Layout.bbox(inst.x, inst.y, size.w * k, size.h * k, inst.rotation || 0);
      return Layout.fitsInside(box, this.canvasFormat);
    },
    /**
     * Clamp a main object to the canvas. Returns false when the object is
     * larger than the canvas and therefore cannot be fully inside.
     */
    clampMain(inst) {
      if (inst.role !== 'main') return true;
      const size = this.objectSize(inst);
      if (!size) return true;
      const k = this.scene.scale || 1;
      const box = Layout.bbox(inst.x, inst.y, size.w * k, size.h * k, inst.rotation || 0);
      const f = Layout.FORMATS[this.canvasFormat] || Layout.FORMATS['1000x1000'];
      if (box.w > f.w + 0.5 || box.h > f.h + 0.5) return false;
      const p = Layout.clampToCanvas(inst.x, inst.y, size.w * k, size.h * k,
        inst.rotation || 0, this.canvasFormat);
      inst.x = p.x;
      inst.y = p.y;
      return true;
    },
    startRotate(e, inst) {
      e.preventDefault();
      e.stopPropagation();
      this.selectedId = inst.instanceId;
      const p = this.svgPoint(e);
      const geom = this.objectGeom(inst);
      const cx = inst.x + geom.cx;
      const cy = inst.y + geom.cy;
      this.rotating = true;
      this.rotateStart = {
        inst: inst,
        cx: cx,
        cy: cy,
        angle0: Math.atan2(p.y - cy, p.x - cx) * 180 / Math.PI,
        rotation0: inst.rotation || 0,
      };
      document.addEventListener('pointermove', this.onRotate);
      document.addEventListener('pointerup', this.endRotate);
      document.addEventListener('pointercancel', this.endRotate);
      document.body.style.touchAction = 'none';
    },
    onRotate(e) {
      if (!this.rotating || !this.rotateStart) return;
      const s = this.rotateStart;
      const p = this.svgPoint(e);
      const angle = Math.atan2(p.y - s.cy, p.x - s.cx) * 180 / Math.PI;
      // Snap to whole degrees so the value stays readable in the input.
      const next = Math.round(s.rotation0 + (angle - s.angle0));
      const previous = s.inst.rotation;
      s.inst.rotation = next;
      if (!this.mainFits(s.inst)) {
        s.inst.rotation = previous;
      } else {
        this.clampMain(s.inst);
      }
    },
    endRotate() {
      if (!this.rotating) return;
      this.rotating = false;
      this.rotateStart = null;
      document.removeEventListener('pointermove', this.onRotate);
      document.removeEventListener('pointerup', this.endRotate);
      document.removeEventListener('pointercancel', this.endRotate);
      document.body.style.touchAction = '';
    },
    startDrag(e, inst) {
      e.preventDefault();
      this.selectedId = inst.instanceId;
      const p = this.svgPoint(e);
      this.dragStart = {x: p.x, y: p.y, ix: inst.x, iy: inst.y, inst};
      this.dragging = true;
      document.addEventListener('pointermove', this.onDrag);
      document.addEventListener('pointerup', this.endDrag);
      document.addEventListener('pointercancel', this.endDrag);
      document.body.style.touchAction = 'none';
    },
    onDrag(e) {
      if (!this.dragging || !this.dragStart) return;
      const inst = this.dragStart.inst;
      const p = this.svgPoint(e);
      const nextX = this.dragStart.ix + (p.x - this.dragStart.x);
      const nextY = this.dragStart.iy + (p.y - this.dragStart.y);
      const previousX = inst.x;
      const previousY = inst.y;
      inst.x = nextX;
      inst.y = nextY;
      if (!this.clampMain(inst)) {
        inst.x = previousX;
        inst.y = previousY;
      }
    },
    endDrag() {
      this.dragging = false;
      this.dragStart = null;
      document.removeEventListener('pointermove', this.onDrag);
      document.removeEventListener('pointerup', this.endDrag);
      document.removeEventListener('pointercancel', this.endDrag);
      document.body.style.touchAction = '';
    },
    duplicateSelected() {
      if (!this.selected) return;
      this.layoutError = '';
      this.layoutWarning = '';
      const sourceIndex = this.scene.instances.findIndex(i => i.instanceId === this.selectedId);
      if (sourceIndex === -1) return;
      const source = this.scene.instances[sourceIndex];
      const copy = {
        ...source,
        instanceId: 'inst_' + Date.now() + '_' + Math.random().toString(36).substr(2,5),
        x: source.x + 30,
        y: source.y + 30,
      };
      // Keep the duplicate next to its source in paint order. Pushing it to
      // the end would put a duplicated background above the main objects.
      this.scene.instances.splice(sourceIndex + 1, 0, copy);
      this.selectedId = copy.instanceId;
      this.clampMain(copy);
      this.loadSvg(copy);
    },
    async deleteSelected() {
      if (!this.selectedId) return;
      const inst = this.selected;
      const confirmed = await this.askConfirm({
        title: 'Удалить объект?',
        message: inst ? 'Удалить «' + inst.name + '» из композиции?' : 'Удалить выбранный объект?',
        confirmLabel: 'Удалить',
        danger: true,
      });
      if (!confirmed) return;
      this.scene.instances = this.scene.instances.filter(i => i.instanceId !== this.selectedId);
      this.selectedId = null;
      this.layoutWarning = '';
    },
    moveLayer(dir) {
      if (!this.selectedId) return;
      const idx = this.scene.instances.findIndex(i => i.instanceId === this.selectedId);
      if (idx === -1) return;
      const inst = this.scene.instances[idx];
      if (dir === 'front') { this.scene.instances.splice(idx,1); this.scene.instances.push(inst); }
      else if (dir === 'back') { this.scene.instances.splice(idx,1); this.scene.instances.unshift(inst); }
      else if (dir === 'up' && idx < this.scene.instances.length-1) { [this.scene.instances[idx], this.scene.instances[idx+1]] = [this.scene.instances[idx+1], this.scene.instances[idx]]; }
      else if (dir === 'down' && idx > 0) { [this.scene.instances[idx], this.scene.instances[idx-1]] = [this.scene.instances[idx-1], this.scene.instances[idx]]; }
    },
    autoLayout() {
      if (this.scene.instances.length === 0) return;
      this.layoutError = '';
      this.layoutWarning = '';
      const fit = Layout.checkFit(this.scene.instances, this.canvasFormat, (i) => this.objectSize(i));
      if (!fit.ok) {
        this.layoutError = fit.reason;
        return;
      }
      this.applyPlacement(fit.scale);
    },
    /** Drop the composition scale back to the intrinsic size. */
    resetScale() {
      this.layoutError = '';
      this.layoutWarning = '';
      const fit = Layout.checkFit(this.scene.instances, this.canvasFormat, (i) => this.objectSize(i));
      if (!fit.ok) {
        this.layoutError = fit.reason;
        return;
      }
      if (fit.scale < 1 - 1e-9) {
        this.layoutError = 'Композиция не помещается в холст без масштабирования. '
          + 'Уменьшите количество объектов, выберите размер S или другой формат.';
        return;
      }
      this.applyPlacement(1);
    },
    applyPlacement(scale) {
      const k = scale || 1;
      this.scene.scale = k;
      const placed = Layout.place(this.scene.instances, this.canvasFormat, (i) => this.objectSize(i), k);
      for (const p of placed) {
        const target = this.scene.instances.find(i => i.instanceId === p.instanceId);
        if (target) { target.x = p.x; target.y = p.y; target.rotation = p.rotation; }
      }
      this.layoutError = '';
      this.layoutWarning = '';
    },
    escapeXml(value) {
      return String(value == null ? '' : value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
    },
    async exportSvg() {
      this.layoutError = '';
      await this.ensureSvgsLoaded();
      const w = this.canvasWidth;
      const h = this.canvasHeight;
      const pal = this.getCurrentPalette();
      const bg = (pal.background && pal.background[0]) || '#FFFFFF';
      let body = '';
      let missing = 0;
      for (const inst of this.scene.instances) {
        const markup = this.svgMarkup(inst);
        if (!markup) {
          missing++;
          continue;
        }
        const size = this.objectSize(inst);
        if (!size) {
          missing++;
          continue;
        }
        const safeId = String(inst.instanceId).replace(/[^A-Za-z0-9_-]/g, '_');
        const name = this.escapeXml(inst.name || inst.assetId);
        const assetId = this.escapeXml(inst.assetId);
        const role = this.escapeXml(inst.role);
        body += '<g id="obj_' + safeId + '" data-name="' + name + '" '
          + 'data-asset-id="' + assetId + '" data-role="' + role + '" '
          + 'transform="' + Layout.exportTransform(inst, size, this.scene.scale || 1) + '">'
          + '<title>' + name + '</title>'
          + markup + '</g>';
      }
      if (missing) {
        this.layoutError = 'Не удалось загрузить часть объектов для экспорта. '
          + 'Проверьте соединение и попробуйте снова.';
        return;
      }
      const svg = '<?xml version="1.0" encoding="UTF-8"?>\n'
        + '<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" '
        + 'width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">'
        + '<rect width="' + w + '" height="' + h + '" fill="' + bg + '"/>'
        + body
        + '</svg>';
      const blob = new Blob([svg], { type: 'image/svg+xml;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'composition_' + this.currentPalette + '_' + w + 'x' + h + '.svg';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(() => URL.revokeObjectURL(url), 2000);
    },
    /** Debounced persistence into IndexedDB. */
    schedulePersist() {
      if (this.persistTimer) clearTimeout(this.persistTimer);
      this.persistTimer = setTimeout(() => this.persist(), 400);
    },
    async persist() {
      try {
        // Vue wraps state in reactive Proxies, which IndexedDB cannot clone.
        // Serialise through JSON to get plain objects.
        const plain = JSON.parse(JSON.stringify({
          scene: this.scene,
          currentPalette: this.currentPalette,
          userPalettes: this.userPalettes,
        }));
        await SceneStore.save(plain);
        // A successful save clears save errors, but not a restore warning.
        if (this.storageError.indexOf('Не удалось сохранить') === 0) {
          this.storageError = '';
        }
      } catch (e) {
        this.storageError = 'Не удалось сохранить сцену: ' + e.message;
      }
    },
    async clearSavedState() {
      await SceneStore.clear();
      this.storageError = '';
    },
    async resetScene() {
      if (this.scene.instances.length) {
        const confirmed = await this.askConfirm({
          title: 'Сбросить сцену?',
          message: 'Все объекты будут удалены. Палитры и формат сохранятся.',
          confirmLabel: 'Сбросить',
          danger: true,
        });
        if (!confirmed) return;
      }
      this.scene.instances = [];
      this.scene.scale = 1;
      this.selectedId = null;
      this.svgData = {};
      this.layoutError = '';
      this.layoutWarning = '';
      this.llmInfo = null;
      this.clearSavedState();
    },
    importPalette(e) {
      this.paletteError = '';
      this.paletteSuccess = '';
      const file = e.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (ev) => {
        try {
          const data = JSON.parse(ev.target.result);
          if (!data.name || !Array.isArray(data.background) || !Array.isArray(data.object)) throw new Error('Неверный формат');
          if (data.background.length !== 4 || data.object.length !== 4) throw new Error('Нужно по 4 цвета');
          const hex = /^#[0-9A-Fa-f]{6}$/;
          if (!data.background.every(c=>hex.test(c)) || !data.object.every(c=>hex.test(c))) throw new Error('Неверный HEX');
          this.userPalettes.push({...data, id: 'user_'+Date.now()});
          this.currentPalette = this.userPalettes[this.userPalettes.length-1].id;
          this.svgData = {};
          this.paletteSuccess = 'Палитра «' + data.name + '» применена.';
        } catch(err) {
          this.paletteError = err.message;
          this.paletteSuccess = '';
        }
      };
      reader.readAsText(file);
    }
  },
  template: `
    <div id="app-root">
      <div class="app-header">
        <div class="app-title">Сборка SVG-иллюстраций</div>
        <div class="app-toolbar">
          <button @click="resetScene" :disabled="generating">Сбросить</button>
          <button @click="autoLayout" :disabled="generating">Автокомпоновка</button>
          <button @click="exportSvg" :disabled="svgLoading || generating">
            {{ (svgLoading || generating) ? 'Подготовка…' : 'Экспорт SVG' }}
          </button>
          <button v-if="scene.scale && scene.scale !== 1" @click="resetScale">Масштаб 100%</button>
        </div>
      </div>

      <div v-if="layoutError" class="app-msg error">{{ layoutError }}</div>
      <div v-if="layoutWarning" class="app-msg warn">{{ layoutWarning }}</div>
      <div v-if="mainLimitWarning" class="app-msg warn">{{ mainLimitWarning }}</div>
      <div v-if="scene.scale && scene.scale !== 1" class="app-msg">
        Масштаб композиции: {{ Math.round(scene.scale * 100) }}% (общий коэффициент, пропорции объектов сохранены)
      </div>
      <div v-if="storageError" class="app-msg warn">{{ storageError }}</div>

      <div class="tab-bar">
        <button @click="tab='metaphor'" :class="{active: tab==='metaphor'}">Метафора/заголовок</button>
        <button @click="tab='list'" :class="{active: tab==='list'}">Список компонентов</button>
      </div>

      <div v-if="tab==='metaphor'" class="field-row">
        <input type="text" v-model="metaphor" placeholder="Введите метафору или заголовок"
               style="width:100%;max-width:320px" @keydown.enter.prevent="submitMetaphor" />
        <button @click="submitMetaphor" :disabled="generating">
          {{ generating ? 'Собираем…' : 'Собрать по метафоре' }}
        </button>
      </div>
      <div v-if="tab==='list'" class="field-row">
        <input type="text" v-model="components" placeholder="Книга, Телефон, Лампа или через пробел"
               style="width:100%;max-width:320px" @keydown.enter.prevent="submitList" />
        <button @click="submitList" :disabled="generating">
          {{ generating ? 'Собираем…' : 'Собрать по списку' }}
        </button>
      </div>

      <div class="app-main">
        <div class="app-panel">
          <div class="panel-section">
            <div class="field-row">
              <label for="fmt">Формат</label>
              <select id="fmt" :value="canvasFormat" :disabled="generating" @change="requestFormatChange($event)">
                <option value="1000x1000">1000x1000</option>
                <option value="1200x630">1200x630</option>
                <option value="800x1200">800x1200</option>
              </select>
            </div>
          </div>

          <div class="panel-section">
            <div class="panel-title">Палитры</div>
            <div class="field-row">
              <select id="palette" v-model="currentPalette" style="width:100%">
                <option v-for="p in paletteOptions" :key="p.id" :value="p.id">{{p.name}}</option>
              </select>
            </div>
            <div class="field-row">
              <input type="file" accept=".json" @change="importPalette" />
            </div>
            <div v-if="paletteError" class="app-msg error">{{ paletteError }}</div>
            <div v-if="paletteSuccess" class="app-msg success">{{ paletteSuccess }}</div>
          </div>

          <div class="panel-section">
            <div class="field-row">
              <label for="size">Размер</label>
              <select id="size" v-model="selectedSize"><option>L</option><option>S</option></select>
            </div>
            <div class="field-row">
              <label for="state">Состояние</label>
              <select id="state" v-model="selectedState">
                <option value="main">Главные</option>
                <option value="background">Фоновые</option>
              </select>
            </div>
            <div class="panel-title">Объекты</div>
            <div class="object-list">
              <div v-for="obj in filteredObjects" :key="obj.assetId+obj.size+obj.state"
                   class="object-item" @click="addObject(obj)">{{obj.name}}</div>
            </div>
          </div>

          <div class="panel-section">
            <div class="panel-title">Слои</div>
            <div class="layer-list">
              <div v-for="inst in scene.instances.slice().reverse()" :key="inst.instanceId"
                   class="layer-item" :class="{active: selectedId===inst.instanceId}"
                   @click="select(inst)">{{inst.name}} ({{inst.size}}, {{inst.role === 'main' ? 'главное' : 'фоновое'}})</div>
            </div>
          </div>

          <div v-if="selected" class="panel-section">
            <div class="panel-title">Редактор</div>
            <div class="field-row">
              <button @click="moveLayer('front')">На передний</button>
              <button @click="moveLayer('back')">На задний</button>
            </div>
            <div class="field-row">
              <button @click="duplicateSelected">Дублировать</button>
              <button @click="deleteSelected">Удалить</button>
            </div>
          </div>
        </div>

        <div class="app-canvas-wrap">
          <svg ref="canvas" class="app-canvas" :width="canvasWidth" :height="canvasHeight"
               :viewBox="'0 0 ' + canvasWidth + ' ' + canvasHeight">
            <rect x="0" y="0" :width="canvasWidth" :height="canvasHeight" :fill="backgroundColor" />
            <g v-for="inst in scene.instances" :key="inst.instanceId + currentPalette"
               :transform="groupTransform(inst)"
               @pointerdown="startDrag($event, inst)" @click="select(inst)">
              <g :transform="'scale(' + (scene.scale || 1) + ')'" v-html="svgMarkup(inst)"></g>
              <g v-if="selectedId===inst.instanceId">
                <!-- The object box starts at (0,0) in this space; the group
                     transform moves its centre to the rotation origin. -->
                <rect x="0" y="0"
                      :width="objectGeom(inst).cx * 2" :height="objectGeom(inst).cy * 2"
                      fill="none" stroke="#2b6cb0" stroke-width="1" stroke-dasharray="4,3"
                      pointer-events="none"/>
                <line :x1="objectGeom(inst).cx" y1="0" :x2="objectGeom(inst).cx" y2="-24"
                      stroke="#2b6cb0" stroke-width="1.5" pointer-events="none"/>
                <circle :cx="objectGeom(inst).cx" cy="-24" r="9" fill="#ffffff"
                        stroke="#2b6cb0" stroke-width="2"/>
                <circle :cx="objectGeom(inst).cx" cy="-24" r="18" fill="transparent"
                        style="cursor: grab"
                        @pointerdown.stop="startRotate($event, inst)"/>
              </g>
            </g>
          </svg>

          <div v-if="llmInfo" class="llm-info">
            <div class="panel-title">Информация об ответе LLM</div>
            <div class="llm-meta"><span>Провайдер:</span> {{ llmInfo.provider }}</div>
            <div class="llm-meta"><span>Модель:</span> {{ llmInfo.model }}</div>
            <div v-if="llmInfo.base_url" class="llm-meta"><span>Endpoint:</span> {{ llmInfo.base_url }}</div>
            <div v-if="llmInfo.background_source === 'llm'" class="llm-meta">
              <span>Фон:</span> выбран моделью — {{ llmInfo.background_asset }}
            </div>
            <div v-else-if="llmInfo.background_source === 'local_fallback'" class="llm-meta">
              <span>Фон:</span> подобрал локальный матчер — {{ llmInfo.background_asset }}
              ({{ llmInfo.background_service }})
            </div>
            <div v-else class="llm-meta"><span>Фон:</span> не выбран</div>
            <div class="llm-response-title">Ответ LLM</div>
            <pre class="llm-response">{{ llmResponseText }}</pre>
          </div>
        </div>
      </div>

      <div v-if="confirmDialog" class="modal-backdrop" @click.self="resolveConfirm(false)">
        <div class="modal" role="dialog" aria-modal="true"
             :aria-label="confirmDialog.title"
             @keydown.esc.stop.prevent="resolveConfirm(false)">
          <div class="modal-title">{{ confirmDialog.title }}</div>
          <p class="modal-message">{{ confirmDialog.message }}</p>
          <div class="modal-actions">
            <button @click="resolveConfirm(false)">{{ confirmDialog.cancelLabel }}</button>
            <button ref="confirmOk" class="modal-confirm"
                    :class="{ danger: confirmDialog.danger }"
                    @click="resolveConfirm(true)">{{ confirmDialog.confirmLabel }}</button>
          </div>
        </div>
      </div>
    </div>
  `
});

app.mount('#q-app');
