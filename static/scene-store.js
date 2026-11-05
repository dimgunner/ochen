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

const SceneStore = {
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

  /**
   * Load the state, migrating or discarding data from an older schema.
   */
  async restore() {
    const payload = await SceneStore.load();
    if (!payload) return null;
    if (payload.schemaVersion !== SceneStore.DB_VERSION) {
      console.warn('Stored state has an incompatible schema version, discarding');
      await SceneStore.clear();
      return null;
    }
    return payload.data;
  },
};
