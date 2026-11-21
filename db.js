/* Retro Poker Club — cloud data layer (Supabase)

   Same small interface the app always used (getAll / get / add / put /
   delete / exportAll / importAll), but the data now lives in the shared
   Supabase database instead of only on one phone.

   - Every row is one JSON document (an event, a player or a chip), stored
     with a version number. Saving checks the version, so if two admins edit
     the same event at the same moment, the second save is refused instead
     of silently overwriting the first.
   - The last data loaded is kept on the phone, so the app still opens and
     shows everything with a weak or no signal. Saving needs a connection.
   - Who may read or change what is enforced by the database itself. */

const SUPABASE_URL = "https://oxquuqjzyksgamrhfcdf.supabase.co";
// Publishable key: safe to be public. Access is controlled by login + database rules.
const SUPABASE_KEY = "sb_publishable_YMNEFcARbQw7grG3EnYCSQ_Q4YGzKLH";

const STORES = ["players", "nights", "chips"];
const EXPORT_VERSION = 2; // backup file format (same as the offline-only app)
const CACHE_PREFIX = "rpc-cache-";
const REQUEST_TIMEOUT_MS = 10000;
const PAGE_SIZE = 1000;

const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false },
});

class DbError extends Error {
  // kind: "offline" | "conflict" | "denied" | "server"
  constructor(kind, message, cause) {
    super(message);
    this.name = "DbError";
    this.kind = kind;
    this.cause = cause;
  }
}

// ---------- connection status (for the "offline" strip) ----------
const status = { offline: false, listeners: [] };
function setOffline(value) {
  if (status.offline === value) return;
  status.offline = value;
  status.listeners.forEach((fn) => {
    try {
      fn(value);
    } catch (_) {}
  });
}

// ---------- local copy of the last data seen ----------
const cache = {
  read(store) {
    try {
      const raw = localStorage.getItem(CACHE_PREFIX + store);
      return raw ? JSON.parse(raw) : null;
    } catch (_) {
      return null;
    }
  },
  write(store, rows) {
    try {
      localStorage.setItem(CACHE_PREFIX + store, JSON.stringify(rows));
    } catch (_) {}
  },
  upsert(store, obj) {
    const rows = cache.read(store);
    if (!rows) return;
    const i = rows.findIndex((r) => r.id === obj.id);
    if (i >= 0) rows[i] = obj;
    else rows.push(obj);
    cache.write(store, rows);
  },
  remove(store, id) {
    const rows = cache.read(store);
    if (rows) cache.write(store, rows.filter((r) => r.id !== id));
  },
  clear() {
    STORES.forEach((s) => {
      try {
        localStorage.removeItem(CACHE_PREFIX + s);
      } catch (_) {}
    });
  },
};

const clone = (o) => JSON.parse(JSON.stringify(o));

function toObj(row) {
  return { ...(row.data || {}), id: Number(row.id), _v: row.version };
}
function toData(obj) {
  const data = { ...obj };
  delete data.id;
  delete data._v;
  return data;
}

function looksOffline(err) {
  if (typeof navigator !== "undefined" && navigator.onLine === false) return true;
  const msg = String((err && (err.message || err.details)) || err || "");
  return /fetch|network|timed? ?out|load failed|abort/i.test(msg);
}

// Runs one Supabase request with a timeout and turns failures into DbError.
async function request(run) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new DbError("offline", "Request timed out")), REQUEST_TIMEOUT_MS);
  });
  try {
    const { data, error } = await Promise.race([run(), timeout]);
    if (error) {
      if (looksOffline(error)) throw new DbError("offline", "No connection", error);
      if (error.code === "42501" || error.code === "PGRST301" || /permission|row-level security|JWT/i.test(error.message || "")) {
        throw new DbError("denied", "Not allowed", error);
      }
      throw new DbError("server", error.message || "Server error", error);
    }
    setOffline(false);
    return data;
  } catch (err) {
    if (err instanceof DbError) {
      if (err.kind === "offline") setOffline(true);
      throw err;
    }
    if (looksOffline(err)) {
      setOffline(true);
      throw new DbError("offline", "No connection", err);
    }
    throw new DbError("server", (err && err.message) || "Server error", err);
  } finally {
    clearTimeout(timer);
  }
}

async function fetchAll(store) {
  const out = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const page = await request(() =>
      sb.from(store).select("id,data,version").order("id").range(from, from + PAGE_SIZE - 1)
    );
    out.push(...page.map(toObj));
    if (page.length < PAGE_SIZE) break;
  }
  return out;
}

const DB = {
  client: sb,
  DbError,
  STORES,
  get offline() {
    return status.offline;
  },
  onStatus(fn) {
    status.listeners.push(fn);
  },
  clearCache: cache.clear,
  request, // run any Supabase query with the same timeout/offline handling

  // Reads fall back to the local copy when there's no connection.
  async getAll(store) {
    try {
      const rows = await fetchAll(store);
      cache.write(store, rows);
      return rows;
    } catch (err) {
      const cached = err.kind === "offline" ? cache.read(store) : null;
      if (cached) return clone(cached);
      throw err;
    }
  },

  async get(store, id) {
    try {
      const row = await request(() => sb.from(store).select("id,data,version").eq("id", id).maybeSingle());
      const obj = row ? toObj(row) : null;
      if (obj) cache.upsert(store, obj);
      else cache.remove(store, id);
      return obj;
    } catch (err) {
      const cached = err.kind === "offline" ? cache.read(store) : null;
      if (cached) {
        const hit = cached.find((r) => r.id === id);
        return hit ? clone(hit) : null;
      }
      throw err;
    }
  },

  async add(store, obj) {
    const row = await request(() => sb.from(store).insert({ data: toData(obj) }).select("id,data,version").single());
    cache.upsert(store, toObj(row));
    return Number(row.id);
  },

  // Objects read from the database carry their version (_v). Saving one only
  // succeeds if nobody changed it in the meantime.
  async put(store, obj) {
    if (obj._v == null) {
      // brand-new row with a known id (e.g. reconnecting an old player)
      const payload = { data: toData(obj) };
      if (obj.id != null) payload.id = obj.id;
      const row = await request(() => sb.from(store).upsert(payload).select("id,data,version").single());
      Object.assign(obj, { id: Number(row.id), _v: row.version });
      cache.upsert(store, toObj(row));
      return Number(row.id);
    }
    const rows = await request(() =>
      sb.from(store).update({ data: toData(obj) }).eq("id", obj.id).eq("version", obj._v).select("id,data,version")
    );
    if (!rows.length) {
      throw new DbError("conflict", "Someone else changed this at the same time");
    }
    obj._v = rows[0].version; // so the same object can be saved again
    cache.upsert(store, toObj(rows[0]));
    return Number(rows[0].id);
  },

  async delete(store, id) {
    await request(() => sb.from(store).delete().eq("id", id));
    cache.remove(store, id);
  },

  async exportAll() {
    const [players, nights, chips] = await Promise.all(STORES.map((s) => DB.getAll(s)));
    const strip = (rows) => rows.map((r) => ({ id: r.id, ...toData(r) }));
    return {
      app: "retro-poker-club",
      version: EXPORT_VERSION,
      exportedAt: new Date().toISOString(),
      players: strip(players),
      nights: strip(nights),
      chips: strip(chips),
    };
  },

  // Replaces ALL club data with a backup, in one database transaction:
  // if anything is wrong with the file, nothing changes.
  async importAll(data) {
    if (!data || !Array.isArray(data.players) || !Array.isArray(data.nights)) {
      throw new Error("That file doesn't look like a Retro Poker Club backup.");
    }
    const payload = {
      players: data.players,
      nights: data.nights,
      chips: Array.isArray(data.chips) ? data.chips : [],
    };
    for (const name of STORES) {
      const ok = payload[name].every(
        (r) => r && typeof r === "object" && !Array.isArray(r) && typeof r.id === "number" && Number.isFinite(r.id)
      );
      if (!ok) throw new Error(`The backup has damaged ${name} records. Nothing was changed.`);
    }
    await request(() => sb.rpc("import_all", { payload }));
    cache.clear();
  },

  // Calls back (debounced) whenever anyone changes events, players or chips.
  subscribe(onChange) {
    let timer = null;
    const fire = () => {
      clearTimeout(timer);
      timer = setTimeout(onChange, 400);
    };
    const channel = sb.channel("rpc-data");
    STORES.forEach((table) => channel.on("postgres_changes", { event: "*", schema: "public", table }, fire));
    channel.subscribe();
    return () => sb.removeChannel(channel);
  },
};

// ---------- Data from the old offline-only version (this phone's IndexedDB) ----------
const LegacyDB = {
  NAME: "RetroPokerClubDB",
  async exists() {
    try {
      if (indexedDB.databases) {
        const list = await indexedDB.databases();
        return list.some((d) => d.name === LegacyDB.NAME);
      }
    } catch (_) {}
    return true; // can't tell: try opening
  },
  async readAll() {
    if (!(await LegacyDB.exists())) return null;
    const db = await new Promise((resolve, reject) => {
      const req = indexedDB.open(LegacyDB.NAME);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    try {
      const names = STORES.filter((s) => db.objectStoreNames.contains(s));
      if (!names.length) return null;
      const tx = db.transaction(names, "readonly");
      const out = { players: [], nights: [], chips: [] };
      await Promise.all(
        names.map(
          (s) =>
            new Promise((resolve, reject) => {
              const req = tx.objectStore(s).getAll();
              req.onsuccess = () => {
                out[s] = req.result || [];
                resolve();
              };
              req.onerror = () => reject(req.error);
            })
        )
      );
      return out;
    } finally {
      db.close();
    }
  },
};

window.DB = DB;
window.LegacyDB = LegacyDB;
