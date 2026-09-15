/* Retro Poker Club — IndexedDB layer */

const DB_NAME = "RetroPokerClubDB";
const DB_VERSION = 1;

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains("players")) {
        db.createObjectStore("players", { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("nights")) {
        db.createObjectStore("nights", { keyPath: "id", autoIncrement: true });
      }
      if (!db.objectStoreNames.contains("chips")) {
        db.createObjectStore("chips", { keyPath: "id", autoIncrement: true });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
  return _dbPromise;
}

function tx(storeName, mode) {
  return openDB().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

const DB = {
  getAll(storeName) {
    return tx(storeName, "readonly").then(
      (store) =>
        new Promise((resolve, reject) => {
          const req = store.getAll();
          req.onsuccess = () => resolve(req.result || []);
          req.onerror = () => reject(req.error);
        })
    );
  },

  get(storeName, id) {
    return tx(storeName, "readonly").then(
      (store) =>
        new Promise((resolve, reject) => {
          const req = store.get(id);
          req.onsuccess = () => resolve(req.result || null);
          req.onerror = () => reject(req.error);
        })
    );
  },

  add(storeName, obj) {
    return tx(storeName, "readwrite").then(
      (store) =>
        new Promise((resolve, reject) => {
          const req = store.add(obj);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        })
    );
  },

  put(storeName, obj) {
    return tx(storeName, "readwrite").then(
      (store) =>
        new Promise((resolve, reject) => {
          const req = store.put(obj);
          req.onsuccess = () => resolve(req.result);
          req.onerror = () => reject(req.error);
        })
    );
  },

  delete(storeName, id) {
    return tx(storeName, "readwrite").then(
      (store) =>
        new Promise((resolve, reject) => {
          const req = store.delete(id);
          req.onsuccess = () => resolve();
          req.onerror = () => reject(req.error);
        })
    );
  },

  async clearAll() {
    const db = await openDB();
    const names = ["players", "nights", "chips"];
    await Promise.all(
      names.map(
        (name) =>
          new Promise((resolve, reject) => {
            const req = db.transaction(name, "readwrite").objectStore(name).clear();
            req.onsuccess = () => resolve();
            req.onerror = () => reject(req.error);
          })
      )
    );
  },

  async exportAll() {
    const [players, nights, chips] = await Promise.all([
      DB.getAll("players"),
      DB.getAll("nights"),
      DB.getAll("chips"),
    ]);
    return {
      app: "retro-poker-club",
      version: 1,
      exportedAt: new Date().toISOString(),
      players,
      nights,
      chips,
    };
  },

  async importAll(data) {
    if (!data || !Array.isArray(data.players) || !Array.isArray(data.nights)) {
      throw new Error("That file doesn't look like a Retro Poker Club backup.");
    }
    await DB.clearAll();
    const db = await openDB();
    async function putAll(storeName, rows) {
      const store = db.transaction(storeName, "readwrite").objectStore(storeName);
      for (const row of rows) {
        store.put(row);
      }
    }
    await putAll("players", data.players);
    await putAll("nights", data.nights);
    await putAll("chips", data.chips || []);
  },
};

if (typeof window !== "undefined") window.DB = DB;
