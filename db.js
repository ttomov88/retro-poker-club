/* Retro Poker Club — IndexedDB layer */

const DB_NAME = "RetroPokerClubDB";
// Stays at 2: some devices already opened v2, and IndexedDB refuses to open
// an older version than the one on the device.
const DB_VERSION = 2;
const STORES = ["players", "nights", "chips"];

let _dbPromise = null;

function openDB() {
  if (_dbPromise) return _dbPromise;
  _dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      STORES.forEach((name) => {
        if (!db.objectStoreNames.contains(name)) {
          db.createObjectStore(name, { keyPath: "id", autoIncrement: true });
        }
      });
    };
    req.onsuccess = (e) => {
      const db = e.target.result;
      // If a newer version of the app opens the DB in another tab, step aside.
      db.onversionchange = () => db.close();
      resolve(db);
    };
    req.onerror = (e) => {
      _dbPromise = null; // allow a retry instead of caching the failure forever
      reject(e.target.error);
    };
  });
  return _dbPromise;
}

// Run `work(stores)` inside one transaction; resolves only after the
// transaction has actually committed (so data is on disk), rejects if it aborts.
async function runTx(storeNames, mode, work) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeNames, mode);
    const stores = {};
    storeNames.forEach((n) => (stores[n] = tx.objectStore(n)));
    let result;
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error("Transaction aborted"));
    try {
      const out = work(stores);
      if (out && typeof out.onsuccess !== "undefined") {
        out.onsuccess = () => (result = out.result);
      } else {
        result = out;
      }
    } catch (err) {
      tx.abort();
      reject(err);
    }
  });
}

function validRow(row) {
  return row && typeof row === "object" && !Array.isArray(row) &&
    (row.id === undefined || (typeof row.id === "number" && Number.isFinite(row.id)));
}

const DB = {
  getAll(storeName) {
    return runTx([storeName], "readonly", (s) => s[storeName].getAll()).then((r) => r || []);
  },

  get(storeName, id) {
    return runTx([storeName], "readonly", (s) => s[storeName].get(id)).then((r) => r || null);
  },

  add(storeName, obj) {
    return runTx([storeName], "readwrite", (s) => s[storeName].add(obj));
  },

  put(storeName, obj) {
    return runTx([storeName], "readwrite", (s) => s[storeName].put(obj));
  },

  delete(storeName, id) {
    return runTx([storeName], "readwrite", (s) => {
      s[storeName].delete(id);
    });
  },

  clearAll() {
    return runTx(STORES, "readwrite", (s) => {
      STORES.forEach((n) => s[n].clear());
    });
  },

  async exportAll() {
    const [players, nights, chips] = await Promise.all(STORES.map((n) => DB.getAll(n)));
    return {
      app: "retro-poker-club",
      version: DB_VERSION,
      exportedAt: new Date().toISOString(),
      players,
      nights,
      chips,
    };
  },

  // Validates the whole file first, then clears and restores everything in a
  // single transaction. If anything fails, the transaction aborts and the
  // data already on the device is left untouched.
  async importAll(data) {
    if (!data || !Array.isArray(data.players) || !Array.isArray(data.nights)) {
      throw new Error("That file doesn't look like a Retro Poker Club backup.");
    }
    const chips = Array.isArray(data.chips) ? data.chips : [];
    const all = { players: data.players, nights: data.nights, chips };
    for (const name of STORES) {
      if (!all[name].every(validRow)) {
        throw new Error(`The backup has damaged ${name} records. Nothing was changed.`);
      }
    }
    await runTx(STORES, "readwrite", (s) => {
      STORES.forEach((n) => {
        s[n].clear();
        all[n].forEach((row) => s[n].put(row));
      });
    });
  },
};

if (typeof window !== "undefined") window.DB = DB;
