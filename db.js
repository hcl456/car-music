// IndexedDB：播放清單資料（playlists）與離線音樂檔（audio，key = 檔案 id）
const DB_NAME = 'car-music';
const VERSION = 1;
let dbPromise;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('playlists')) db.createObjectStore('playlists', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('audio')) db.createObjectStore('audio');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    let result;
    const req = fn(tx.objectStore(store));
    if (req) req.onsuccess = () => { result = req.result; };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new DOMException('Transaction aborted', 'AbortError'));
  });
}

export const getAllPlaylists = () => run('playlists', 'readonly', s => s.getAll());
export const putPlaylist = p => run('playlists', 'readwrite', s => s.put(structuredCloneSafe(p)));
export const deletePlaylist = id => run('playlists', 'readwrite', s => s.delete(id));

export const getAudio = id => run('audio', 'readonly', s => s.get(id));
export const putAudio = (id, blob) => run('audio', 'readwrite', s => s.put(blob, id));
export const deleteAudio = id => run('audio', 'readwrite', s => s.delete(id));

// 只存純資料欄位，避免把執行期加上的東西寫進 DB
function structuredCloneSafe(p) {
  return {
    id: p.id, type: p.type, name: p.name, folderId: p.folderId || null,
    createdAt: p.createdAt, syncedAt: p.syncedAt || null,
    tracks: p.tracks.map(t => ({ id: t.id, name: t.name, size: t.size || 0, version: t.version || '', cached: !!t.cached })),
  };
}
