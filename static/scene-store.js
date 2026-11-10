/**
 * Persistent storage for the current scene and user palettes.
 *
 * Uses IndexedDB as required by the plan: one current composition, saved
 * locally in the browser, restored after a reload. No server storage,
 * no accounts, no project list.
 *
 * Schema version is stored with the payload so a future schema change can
 * migrate or discard old data instead of crashing the app.
 */

const SceneStore = (typeof globalThis !== 'undefined' ? globalThis : window).SceneStore = {
  DB_NAME: 'svg_illustrator',
  DB_VERSION: 1,
  STORE: 'state',
  KEY: 'current',

  /** Open the database. Resolves with the IDBDatabase instance. */
  open() {
    return new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) {
        reject(new Error('IndexedDB is not available'));
        return;
      }
      const request = indexedDB.open(SceneStore.DB_NAME, SceneStore.DB_VERSION);

      request.onupgradeneeded = (event) => {
        const db = request.result;
        if (!db.objectStoreNames.contains(SceneStore.STORE)) {
          db.createObjectStore(SceneStore.STORE);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('IndexedDB upgrade blocked by another tab'));
    });
  },

  /**
   * Read the saved state.
   *
   * @returns {Promise<object|null>} payload or null when nothing is stored
   */
  async load() {
    try {
      const db = await SceneStore.open();
      const payload = await new Promise((resolve, reject) => {
        const tx = db.transaction(SceneStore.STORE, 'readonly');
        const request = tx.objectStore(SceneStore.STORE).get(SceneStore.KEY);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => reject(request.error);
      });
      db.close();
      return payload;
    } catch (e) {
      console.warn('SceneStore.load failed', e);
      return null;
    }
  },

  /**
   * Save the state.
   *
   * @param {object} data serialisable payload
   */
  async save(data) {
    const db = await SceneStore.open();
    const payload = {
      schemaVersion: SceneStore.DB_VERSION,
      savedAt: new Date().toISOString(),
      data,
    };
    await new Promise((resolve, reject) => {
      const tx = db.transaction(SceneStore.STORE, 'readwrite');
      tx.objectStore(SceneStore.STORE).put(payload, SceneStore.KEY);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
    db.close();
  },

  /** Remove the saved state. */
  async clear() {
    try {
      const db = await SceneStore.open();
      await new Promise((resolve, reject) => {
        const tx = db.transaction(SceneStore.STORE, 'readwrite');
        tx.objectStore(SceneStore.STORE).delete(SceneStore.KEY);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    } catch (e) {
      console.warn('SceneStore.clear failed', e);
    }
  },

  /** Human-readable warning produced by the last restore() call. */
  lastWarning: '',

  isFiniteNumber(value) {
    return typeof value === 'number' && isFinite(value);
  },

  /** Validate and normalise one scene instance. Returns null when invalid. */
  normaliseInstance(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.instanceId !== 'string' || !raw.instanceId) return null;
    if (typeof raw.assetId !== 'string' || !raw.assetId) return null;

    let role = raw.role === 'main' || raw.role === 'background' ? raw.role : null;
    let state = raw.state === 'main' || raw.state === 'background' ? raw.state : null;
    if (!role && state) role = state;
    if (!state && role) state = role;
    if (!role || !state) return null;
    // The role decides how the object is painted, so it wins on conflict.
    state = role;

    if (raw.size !== 'L' && raw.size !== 'S') return null;
    if (!SceneStore.isFiniteNumber(raw.x) || !SceneStore.isFiniteNumber(raw.y)) return null;

    return {
      instanceId: raw.instanceId,
      assetId: raw.assetId,
      role,
      x: raw.x,
      y: raw.y,
      rotation: SceneStore.isFiniteNumber(raw.rotation) ? raw.rotation : 0,
      name: typeof raw.name === 'string' && raw.name ? raw.name : raw.assetId,
      size: raw.size,
      state,
    };
  },

  /** Validate a user palette. Returns null when invalid. */
  normalisePalette(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (typeof raw.id !== 'string' || !raw.id) return null;
    if (typeof raw.name !== 'string' || !raw.name) return null;
    const validColors = (list) =>
      Array.isArray(list) && list.length === 4 &&
      list.every(c => typeof c === 'string' && /^#[0-9A-Fa-f]{6}$/.test(c));
    if (!validColors(raw.background) || !validColors(raw.object)) return null;
    return {
      id: raw.id,
      name: raw.name,
      background: raw.background.slice(),
      object: raw.object.slice(),
    };
  },

  /**
   * Validate the stored payload.
   *
   * Returns { data, dropped } or null when the scene itself is unusable.
   * Individual broken instances are dropped instead of crashing the app.
   */
  validate(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const scene = payload.scene;
    if (!scene || typeof scene !== 'object' || !Array.isArray(scene.instances)) return null;

    const instances = [];
    let dropped = 0;
    for (const raw of scene.instances) {
      const inst = SceneStore.normaliseInstance(raw);
      if (inst) instances.push(inst);
      else dropped++;
    }
    if (scene.instances.length && !instances.length) return null;

    const format = scene.format && SceneStore.isFiniteNumber(scene.format.w) &&
      SceneStore.isFiniteNumber(scene.format.h) &&
      scene.format.w > 0 && scene.format.h > 0
      ? { w: scene.format.w, h: scene.format.h }
      : { w: 1000, h: 1000 };

    let scale = Number(scene.scale);
    if (!SceneStore.isFiniteNumber(scale) || scale <= 0) scale = 1;
    scale = Math.min(1, Math.max(0.05, scale));

    const userPalettes = Array.isArray(payload.userPalettes)
      ? payload.userPalettes.map(SceneStore.normalisePalette).filter(Boolean)
      : [];

    return {
      data: {
        scene: {
          instances,
          format,
          palette: typeof scene.palette === 'string' ? scene.palette : undefined,
          scale,
        },
        currentPalette: typeof payload.currentPalette === 'string' ? payload.currentPalette : 'purple',
        userPalettes,
      },
      dropped,
    };
  },

  /**
   * Load the state, migrating or discarding data from an older schema.
   */
  async restore() {
    SceneStore.lastWarning = '';
    const payload = await SceneStore.load();
    if (!payload) return null;
    if (payload.schemaVersion !== SceneStore.DB_VERSION) {
      console.warn('Stored state has an incompatible schema version, discarding');
      SceneStore.lastWarning = 'Сохранённая сцена имеет несовместимый формат и была сброшена.';
      await SceneStore.clear();
      return null;
    }

    const validated = SceneStore.validate(payload.data);
    if (!validated) {
      console.warn('Stored state is malformed, discarding');
      SceneStore.lastWarning = 'Сохранённая сцена повреждена и была сброшена.';
      await SceneStore.clear();
      return null;
    }
    if (validated.dropped) {
      SceneStore.lastWarning = 'Часть сохранённых объектов была повреждена и удалена.';
    }
    return validated.data;
  },
};
