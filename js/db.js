// db.js — обёртка над IndexedDB (плейлисты, рингтоны, сохранённые папки)

const DB_NAME = 'ringtone-studio';
const DB_VERSION = 1;
export const STORES = ['playlists', 'ringtones', 'handles'];

let dbp = null;

export function dbOpen() {
  if (dbp) return dbp;
  dbp = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      for (const s of STORES) {
        if (!db.objectStoreNames.contains(s)) db.createObjectStore(s, { keyPath: 'id' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbp;
}

function tx(store, mode, fn) {
  return dbOpen().then(db => new Promise((resolve, reject) => {
    const t = db.transaction(store, mode);
    const os = t.objectStore(store);
    const req = fn(os);
    t.oncomplete = () => resolve(req?.result);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  }));
}

export const dbGet = (store, key) => tx(store, 'readonly', os => os.get(key));
export const dbGetAll = (store) => tx(store, 'readonly', os => os.getAll());
export const dbPut = (store, value) => tx(store, 'readwrite', os => os.put(value));
export const dbDelete = (store, key) => tx(store, 'readwrite', os => os.delete(key));
export const dbClear = (store) => tx(store, 'readwrite', os => os.clear());

export function newId() {
  return (crypto.randomUUID?.() || ('id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10)));
}
