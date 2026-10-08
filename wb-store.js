// 통합내역 운송장 캐시 저장소 (IndexedDB). localStorage 용량 한도(5MB)를 피하기 위해 사용.
(function () {
  const DB = 'mw_wb', STORE = 'kv', KEY = 'wb_cache_v1';
  const open = () => new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const tx = (mode, fn) => open().then(db => new Promise((res, rej) => {
    const t = db.transaction(STORE, mode), q = fn(t.objectStore(STORE));
    t.oncomplete = () => { db.close(); res(q && q.result); }; t.onerror = t.onabort = () => { db.close(); rej(t.error); };
  }));
  let chan = null; try { chan = new BroadcastChannel('wb_cache'); } catch (e) {}
  async function load() {
    let v = await tx('readonly', s => s.get(KEY)).catch(() => null);
    const legacy = localStorage.getItem(KEY);
    if (legacy) {
      try { v = Object.assign(JSON.parse(legacy) || {}, v || {}); await tx('readwrite', s => s.put(v, KEY)); localStorage.removeItem(KEY); } catch (e) {}
    }
    return v || {};
  }
  async function save(obj) {
    await tx('readwrite', s => s.put(obj, KEY));
    try { chan && chan.postMessage('updated'); } catch (e) {}
  }
  function onChange(fn) {
    if (!chan) return () => {};
    const h = () => fn(); chan.addEventListener('message', h);
    return () => chan.removeEventListener('message', h);
  }
  window.WbStore = { load, save, onChange };
})();
