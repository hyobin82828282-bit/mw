// 통합내역 운송장 캐시 저장소 (IndexedDB). localStorage 용량 한도(5MB)를 피하기 위해 사용.
// 저장 시 빈 칸·중복 상품명을 빼고(compact), 불러올 때 다시 채움(hydrate).
(function () {
  const DB = 'mw_wb', STORE = 'kv', KEY = 'wb_cache_v1', DROP_KEY = 'wb_drop_months_v1', KEEP = 6;
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
  const has = v => v !== '' && v != null;
  function compact(e) {
    if (!e || typeof e !== 'object') return e;
    const o = {};
    ['mall', 'name', 'ship', 'ym'].forEach(k => { if (has(e[k])) o[k] = e[k]; });
    if (e.group && e.group.length > 1) o.group = e.group;
    const items = (e.items || []).map(i => { const x = {}; ['code', 'product', 'qty', 'amount'].forEach(k => { if (has(i[k])) x[k] = i[k]; }); return x; }).filter(x => x.code || x.product);
    if (items.length) o.items = items;
    const extra = (e.products || []).filter(p => p && !items.some(i => i.product === p));
    if (extra.length) o.products = extra;
    return o;
  }
  function hydrate(e) {
    if (!e || typeof e !== 'object') return e;
    const items = (e.items || []).map(i => ({ code: i.code || '', product: i.product || '', qty: has(i.qty) ? i.qty : '', amount: has(i.amount) ? i.amount : '' }));
    const products = [...new Set(items.map(i => i.product).filter(Boolean).concat(e.products || []))];
    const o = Object.assign({}, e, { mall: e.mall || '', name: e.name || '', ship: e.ship || '', items, products });
    return o;
  }
  const mapObj = (obj, f) => { const o = {}; Object.keys(obj || {}).forEach(k => { o[k] = f(obj[k]); }); return o; };
  async function load() {
    let v = await tx('readonly', s => s.get(KEY)).catch(() => null);
    const legacy = localStorage.getItem(KEY);
    if (legacy) {
      try { v = Object.assign(JSON.parse(legacy) || {}, v || {}); await tx('readwrite', s => s.put(mapObj(v, compact), KEY)); localStorage.removeItem(KEY); } catch (e) {}
    }
    return mapObj(v || {}, hydrate);
  }
  async function save(obj) {
    await tx('readwrite', s => s.put(mapObj(obj, compact), KEY));
    try { chan && chan.postMessage('updated'); } catch (e) {}
  }
  function onChange(fn) {
    if (!chan) return () => {};
    const h = () => fn(); chan.addEventListener('message', h);
    return () => chan.removeEventListener('message', h);
  }
  // ── 월 계산 (YYYYMM 숫자) ──
  const nowYm = () => { const d = new Date(); return d.getFullYear() * 100 + d.getMonth() + 1; };
  const ymAdd = (ym, n) => { let y = Math.floor(ym / 100), m = ym % 100 + n; while (m < 1) { m += 12; y--; } while (m > 12) { m -= 12; y++; } return y * 100 + m; };
  function monthOf(e) {
    if (!e) return 0;
    if (e.ym) return +e.ym;
    const m = String(e.ship || '').match(/^(\d{1,2})\//); if (!m) return 0;
    const mm = +m[1], n = nowYm(); if (mm < 1 || mm > 12) return 0;
    return (mm > n % 100 ? Math.floor(n / 100) - 1 : Math.floor(n / 100)) * 100 + mm;
  }
  // 클레임에 연결된 송장 (모든 월의 클레임 리스트)
  function claimSet() {
    const set = new Set();
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i); if (!/^claims_v3_\d{6}$/.test(k || '')) continue;
      try { (JSON.parse(localStorage.getItem(k)) || []).forEach(r => String(r && r.waybill || '').split(/[,，]/).forEach(w => { w = w.replace(/[\s\-]/g, '').replace(/\.0+$/, ''); if (w) set.add(w); })); } catch (e) {}
    }
    return set;
  }
  const drops = () => { try { return JSON.parse(localStorage.getItem(DROP_KEY) || '[]') || []; } catch (e) { return []; } };
  const setDrops = a => { try { localStorage.setItem(DROP_KEY, JSON.stringify([...new Set(a)])); } catch (e) {} };
  const linked = (k, e, cs) => cs.has(k) || ((e && e.group) || []).some(w => cs.has(w));
  // 지울 대상: 보관 기간(6개월) 지남 또는 직접 지운 달 · 클레임 연결 송장은 제외
  function prunable(k, e, cs, dl) {
    if (linked(k, e, cs)) return false;
    const ym = monthOf(e); if (!ym) return false;
    return ym < ymAdd(nowYm(), -(KEEP - 1)) || (dl || drops()).includes(ym);
  }
  function prune(obj, cs) {
    cs = cs || claimSet(); const dl = drops(), gone = [];
    Object.keys(obj).forEach(k => { if (prunable(k, obj[k], cs, dl)) { delete obj[k]; gone.push(k); } });
    return gone;
  }
  // 대략적 용량(UTF-8): 한글 등 비ASCII는 3바이트로 계산
  const size = e => { const s = JSON.stringify(compact(e)) || ''; let n = s.length; for (let i = 0; i < s.length; i++) if (s.charCodeAt(i) > 127) n += 2; return n; };
  window.WbStore = {
    load, save, onChange, compact, hydrate, monthOf, claimSet, prunable, prune, linked, size, KEEP, nowYm, ymAdd,
    drops, dropMonth: ym => setDrops(drops().concat(+ym)), undrop: yms => setDrops(drops().filter(x => !yms.map(Number).includes(x))),
  };
})();
