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
      layoutError: '',
      storageError: '',
      pendingScale: 1,
      blockedReason: '',
      rotating: false,
      rotateStart: null,
      svgData: {}
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
      this.currentPalette = restored.currentPalette || this.currentPalette;
      this.userPalettes = restored.userPalettes || [];
    }
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
    canvasFormat(val) {
      const f = Layout.FORMATS[val];
      if (!f) return;
      this.canvasWidth = f.w;
      this.canvasHeight = f.h;
      this.scene.format = {w: f.w, h: f.h};
      // Re-place existing objects for the new format. The composition may be
      // scaled as a whole; individual objects keep their intrinsic size.
      if (this.scene.instances.length) {
        const fit = Layout.checkFit(this.scene.instances, val, (i) => this.objectSize(i));
        if (!fit.ok) {
          this.layoutError = fit.reason;
          return;
        }
        this.applyPlacement(fit.scale);
      }
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
      this.svgData = {};
      for (const inst of this.scene.instances) {
        await this.loadSvg(inst);
      }
    },
    async submitMetaphor() {
      this.layoutError = '';
      try {
        const res = await fetch('/api/interpret-metaphor/', {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({text: this.metaphor})
        });
        const data = await res.json();
        if (data.objects && data.objects.length) {
          const added = [];
          for (let obj of data.objects) {
            const variant = this.objects.find(v => v.assetId === obj.assetId && v.size === this.selectedSize && v.state === (obj.role === 'main' ? 'main' : 'background'));
            if (!variant) continue;
            const id = 'inst_' + Date.now() + '_' + Math.random().toString(36).substr(2,5);
            const inst = {instanceId:id, assetId:variant.assetId, role:variant.state==='main'?'main':'background', x:0, y:0, rotation:0, name:variant.name, size:variant.size, state:variant.state};
            const candidate = this.scene.instances.concat(added, [inst]);
            const fit = Layout.checkFit(candidate, this.canvasFormat, (i) => this.objectSize(i));
            if (!fit.ok) {
              this.blockedReason = fit.reason;
              break;
            }
            added.push(inst);
            this.pendingScale = fit.scale;
          }
          this.layoutError = added.length < (data.objects || []).length && this.layoutError ? this.layoutError : '';
          this.insertInstances(added);
          this.reloadAllSvgs();
          this.applyPlacement(this.pendingScale || 1);
          this.pendingScale = 1;
          if (this.blockedReason) {
            this.layoutError = this.blockedReason;
            this.blockedReason = '';
          }
        } else {
          this.layoutError = 'По запросу «' + this.metaphor + '» подходящих объектов не найдено. '
            + 'Уточните формулировку или выберите объекты из библиотеки вручную.';
        }
      } catch(e) {
        this.layoutError = 'Не удалось получить подбор: ' + e.message;
      }
    },
    submitList() {
      this.layoutError = '';
      const list = this.components.split(',').map(s=>s.trim().toLowerCase()).filter(Boolean);
      const added = [];
      const unknown = [];
      let blocked = '';
      for (let name of list) {
        const variant = this.objects.find(v => v.size === this.selectedSize && v.state === this.selectedState && (v.name.toLowerCase().includes(name) || v.assetId.includes(name)));
        if (!variant) {
          unknown.push(name);
          continue;
        }
        const id = 'inst_' + Date.now() + '_' + Math.random().toString(36).substr(2,5);
        const inst = {instanceId:id, assetId:variant.assetId, role:variant.state==='main'?'main':'background', x:0, y:0, rotation:0, name:variant.name, size:variant.size, state:variant.state};
        const candidate = this.scene.instances.concat(added, [inst]);
        const fit = Layout.checkFit(candidate, this.canvasFormat, (i) => this.objectSize(i));
        if (!fit.ok) {
          blocked = fit.reason;
          break;
        }
        added.push(inst);
        this.pendingScale = fit.scale;
      }
      this.insertInstances(added);
      this.reloadAllSvgs();
      this.applyPlacement(this.pendingScale || 1);
      this.pendingScale = 1;
      // applyPlacement clears layoutError, so report the problems afterwards.
      if (blocked) {
        this.layoutError = blocked;
      } else if (unknown.length) {
        this.layoutError = 'Неизвестный компонент: ' + unknown.join(', ');
      }
    },
    addObject(obj) {
      const id = 'inst_' + Date.now() + '_' + Math.random().toString(36).substr(2,5);
      const inst = {instanceId:id, assetId:obj.assetId, role:obj.state==='main'?'main':'background', x:0, y:0, rotation:0, name:obj.name, size:obj.size, state:obj.state};
      // Reject combinations that cannot fit without scaling.
      const candidate = this.scene.instances.concat([inst]);
      const fit = Layout.checkFit(candidate, this.canvasFormat, (i) => this.objectSize(i));
      if (!fit.ok) {
        this.layoutError = fit.reason;
        return;
      }
      this.insertInstances([inst]);
      this.selectedId = id;
      this.loadSvg(inst);
      this.applyPlacement(fit.scale);
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
      s.inst.rotation = Math.round(s.rotation0 + (angle - s.angle0));
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
      const cx = e.clientX || (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
      const cy = e.clientY || (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
      this.dragStart = {x: cx, y: cy, ix: inst.x, iy: inst.y};
      document.addEventListener('pointermove', this.onDrag);
      document.addEventListener('pointerup', this.endDrag);
      document.body.style.touchAction = 'none';
    },
    onDrag(e) {
      if (!this.selected) return;
      const cx = e.clientX || (e.touches && e.touches[0] ? e.touches[0].clientX : 0);
      const cy = e.clientY || (e.touches && e.touches[0] ? e.touches[0].clientY : 0);
      this.selected.x = this.dragStart.ix + (cx - this.dragStart.x);
      this.selected.y = this.dragStart.iy + (cy - this.dragStart.y);
    },
    endDrag() {
      document.removeEventListener('pointermove', this.onDrag);
      document.removeEventListener('pointerup', this.endDrag);
      document.body.style.touchAction = '';
    },
    duplicateSelected() { if (!this.selected) return; const id = 'inst_' + Date.now() + '_' + Math.random().toString(36).substr(2,5); this.scene.instances.push({...this.selected, instanceId:id, x:this.selected.x+30, y:this.selected.y+30}); this.selectedId = id; },
    deleteSelected() { if (!this.selectedId) return; this.scene.instances = this.scene.instances.filter(i => i.instanceId !== this.selectedId); this.selectedId = null; },
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
      const fit = Layout.checkFit(this.scene.instances, this.canvasFormat, (i) => this.objectSize(i));
      if (!fit.ok) {
        this.layoutError = fit.reason;
        return;
      }
      this.applyPlacement(fit.scale);
    },
    /** Place the objects with the given composition scale. */
    /** Drop the composition scale back to the intrinsic size. */
    resetScale() {
      const fit = Layout.checkFit(this.scene.instances, this.canvasFormat, (i) => this.objectSize(i));
      if (!fit.ok) {
        this.layoutError = fit.reason;
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
    },
    /** Rebuild the composition for another format without resizing objects. */
    reflowToFormat(format) {
      this.canvasFormat = format;
      const fit = Layout.checkFit(this.scene.instances, format, (i) => this.objectSize(i));
      if (!fit.ok) {
        this.layoutError = fit.reason;
        return;
      }
      this.applyPlacement(fit.scale);
    },
    async exportSvg() {
      const w = this.canvasWidth;
      const h = this.canvasHeight;
      const pal = this.getCurrentPalette();
      const bg = (pal.background && pal.background[0]) || '#FFFFFF';
      let body = '';
      for (const inst of this.scene.instances) {
        const markup = this.svgMarkup(inst);
        if (!markup) continue;
        const size = this.objectSize(inst);
        if (!size) continue;
        body += '<g transform="' + Layout.exportTransform(inst, size, this.scene.scale || 1) + '">' + markup + '</g>';
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
        this.storageError = '';
      } catch (e) {
        this.storageError = 'Не удалось сохранить сцену: ' + e.message;
      }
    },
    async clearSavedState() {
      await SceneStore.clear();
      this.storageError = '';
    },
    resetScene() { this.scene.instances = []; this.scene.scale = 1; this.selectedId = null; this.svgData = {}; this.clearSavedState(); },
    importPalette(e) {
      this.paletteError = '';
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
          alert('Палитра применена');
        } catch(err) { this.paletteError = err.message; }
      };
      reader.readAsText(file);
    }
  },
  template: `
    <div id="app-root">
      <div class="app-header">
        <div class="app-title">Сборка SVG-иллюстраций</div>
        <div class="app-toolbar">
          <button @click="resetScene">Сбросить</button>
          <button @click="autoLayout">Автокомпоновка</button>
          <button @click="exportSvg">Экспорт SVG</button>
          <button v-if="scene.scale && scene.scale !== 1" @click="resetScale">Масштаб 100%</button>
        </div>
      </div>

      <div v-if="layoutError" class="app-msg error">{{ layoutError }}</div>
      <div v-if="scene.scale && scene.scale !== 1" class="app-msg">
        Масштаб композиции: {{ Math.round(scene.scale * 100) }}% (общий коэффициент, пропорции объектов сохранены)
      </div>
      <div v-if="storageError" class="app-msg warn">{{ storageError }}</div>

      <div class="tab-bar">
        <button @click="tab='metaphor'" :class="{active: tab==='metaphor'}">Метафора/заголовок</button>
        <button @click="tab='list'" :class="{active: tab==='list'}">Список компонентов</button>
      </div>

      <div v-if="tab==='metaphor'" class="field-row">
        <input type="text" v-model="metaphor" placeholder="Введите метафору или заголовок" style="width:100%;max-width:320px" />
        <button @click="submitMetaphor">Собрать по метафоре</button>
      </div>
      <div v-if="tab==='list'" class="field-row">
        <input type="text" v-model="components" placeholder="Книга, Телефон, Лампа" style="width:100%;max-width:320px" />
        <button @click="submitList">Собрать по списку</button>
      </div>

      <div class="app-main">
        <div class="app-panel">
          <div class="panel-section">
            <div class="field-row">
              <label for="fmt">Формат</label>
              <select id="fmt" v-model="canvasFormat">
                <option value="1000x1000">1000x1000</option>
                <option value="1200x630">1200x630</option>
                <option value="800x1200">800x1200</option>
              </select>
            </div>
          </div>

          <div class="panel-section">
            <div class="panel-title">Палитры</div>
            <div class="field-row">
              <select v-model="currentPalette" style="width:100%">
                <option v-for="p in palettes" :key="p.id" :value="p.id">{{p.name}}</option>
                <option v-for="p in userPalettes" :key="p.id" :value="p.id">{{p.name}}</option>
              </select>
            </div>
            <div class="field-row">
              <input type="file" accept=".json" @change="importPalette" />
            </div>
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
          <svg ref="canvas" class="app-canvas" :width="canvasWidth" :height="canvasHeight">
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
        </div>
      </div>
    </div>
  `
});

app.mount('#q-app');
