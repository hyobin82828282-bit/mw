// 실시간 공유 (Firebase Realtime Database REST + 스트리밍). SDK 없이 주소만으로 동작.
(function () {
  const K_URL = "mw_sync_url", K_NAME = "mw_sync_name", K_DEV = "mw_sync_dev";
  const ALL = ["records", "returns", "items", "exp", "wb"];
  const enc = k => String(k).replace(/[%.#$\[\]\/]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0"));
  const dec = k => { try { return decodeURIComponent(k); } catch (e) { return k; } };
  let dev = localStorage.getItem(K_DEV);
  if (!dev) { dev = "d" + Math.random().toString(36).slice(2, 10); localStorage.setItem(K_DEV, dev); }
  let es = null, mirror = {}, ready = false, st = { state: "off", msg: "" };
  const dataL = new Set(), stL = new Set(), q = {};
  let qTimer = null, retryTimer = null;
  const base = () => (localStorage.getItem(K_URL) || "").trim().replace(/\/+$/, "");
  const name = () => localStorage.getItem(K_NAME) || "";
  const setSt = (state, msg) => { st = { state, msg: msg || "", at: Date.now() }; stL.forEach(f => { try { f(st); } catch (e) {} }); };
  function setAt(parts, data) {
    if (!parts.length) { mirror = (data && typeof data === "object") ? data : {}; return; }
    let o = mirror;
    for (let i = 0; i < parts.length - 1; i++) { if (!o[parts[i]] || typeof o[parts[i]] !== "object") o[parts[i]] = {}; o = o[parts[i]]; }
    const l = parts[parts.length - 1];
    if (data == null) delete o[l]; else o[l] = data;
  }
  const split = p => String(p || "").split("/").filter(Boolean);
  function onEvt(kind, raw) {
    let m; try { m = JSON.parse(raw); } catch (e) { return; }
    if (!m) return;
    const parts = split(m.path);
    let tops;
    if (kind === "put") {
      setAt(parts, m.data);
      if (!parts.length) Object.keys(q).forEach(k => setAt(split(k), q[k]));
      tops = parts.length ? [parts[0]] : ALL;
    } else {
      Object.keys(m.data || {}).forEach(k => setAt(parts.concat(split(k)), m.data[k]));
      tops = parts.length ? [parts[0]] : Object.keys(m.data || {}).map(k => split(k)[0]);
    }
    const initial = !ready; ready = true;
    if (initial && !mirror.owner) queue("owner", dev);
    if (st.state !== "on") setSt("on");
    const keys = initial ? ALL : Array.from(new Set(tops));
    dataL.forEach(f => { try { f(keys, initial); } catch (e) { console.error(e); } });
  }
  function stop() { if (es) { es.close(); es = null; } ready = false; }
  function start() {
    stop();
    const b = base();
    if (!b) { setSt("off"); return; }
    setSt("connecting", "연결 중…");
    try { es = new EventSource(b + "/mw.json"); } catch (e) { setSt("error", "주소가 올바르지 않습니다"); return; }
    es.addEventListener("put", e => onEvt("put", e.data));
    es.addEventListener("patch", e => onEvt("patch", e.data));
    es.addEventListener("cancel", () => setSt("error", "권한이 없습니다. 데이터베이스 규칙을 확인하세요"));
    es.onerror = () => { if (st.state !== "error") setSt("connecting", "재연결 중…"); };
    flush();
  }
  function queue(path, val) {
    setAt(split(path), val); q[path] = val;
    clearTimeout(qTimer); qTimer = setTimeout(flush, 150);
  }
  async function flush() {
    const b = base(), keys = Object.keys(q);
    if (!b || !keys.length) return;
    const body = {}; keys.forEach(k => { body[k] = q[k]; delete q[k]; });
    try {
      const r = await fetch(b + "/mw.json", { method: "PATCH", body: JSON.stringify(body) });
      if (!r.ok) throw new Error("HTTP " + r.status);
      if (st.state === "error" && ready) setSt("on");
    } catch (e) {
      keys.forEach(k => { if (!(k in q)) q[k] = body[k]; });
      setSt("error", "저장 실패, 5초 뒤 다시 시도합니다 (" + e.message + ")");
      clearTimeout(retryTimer); retryTimer = setTimeout(flush, 5000);
    }
  }
  const stamp = obj => Object.assign({}, obj, { _at: Date.now(), _by: name(), _dev: dev });
  function put(coll, obj) { if (obj && obj.id != null) queue(coll + "/" + enc(obj.id), { j: JSON.stringify(stamp(obj)) }); }
  function del(coll, id) { queue(coll + "/" + enc(id), { j: JSON.stringify({ id, _del: true, _at: Date.now(), _by: name(), _dev: dev }) }); }
  function all(coll) {
    const o = mirror[coll] || {};
    return Object.keys(o).map(k => { try { return JSON.parse(o[k].j); } catch (e) { return null; } }).filter(Boolean);
  }
  function list(coll) { return all(coll).filter(x => !x._del); }
  function tombs(coll) { return new Set(all(coll).filter(x => x._del).map(x => x.id)); }
  function putBlob(key, val) { const at = Date.now(); queue(key, { j: JSON.stringify(val), at, by: name(), dev }); return at; }
  function blob(key) {
    const o = mirror[key];
    if (!o || !o.j) return undefined;
    try { return { val: JSON.parse(o.j), at: o.at, by: o.by, mine: o.dev === dev }; } catch (e) { return undefined; }
  }
  function putMap(key, obj) { Object.keys(obj).forEach(k => queue(key + "/" + enc(k), obj[k] == null ? null : JSON.stringify(obj[k]))); }
  function map(key) {
    const o = mirror[key] || {}, out = {};
    Object.keys(o).forEach(k => { try { out[dec(k)] = JSON.parse(o[k]); } catch (e) {} });
    return out;
  }
  async function configure(url, nm) {
    url = String(url || "").trim().replace(/\/+$/, "");
    if (!/^https:\/\/[^\/]+\.(firebaseio\.com|firebasedatabase\.app)$/.test(url))
      return { ok: false, msg: "Firebase Realtime Database 주소(https://…firebaseio.com 또는 …firebasedatabase.app)를 넣어주세요" };
    try {
      const r = await fetch(url + "/mw.json?shallow=true");
      if (r.status === 401 || r.status === 403) return { ok: false, msg: "읽기 권한이 없습니다. 규칙(3번)을 게시했는지 확인하세요" };
      if (!r.ok) return { ok: false, msg: "연결 실패 (HTTP " + r.status + ")" };
    } catch (e) { return { ok: false, msg: "연결 실패: " + e.message }; }
    localStorage.setItem(K_URL, url);
    localStorage.setItem(K_NAME, String(nm || "").trim());
    start();
    return { ok: true };
  }
  function disconnect() { stop(); localStorage.removeItem(K_URL); setSt("off"); }
  function claimOwner() { if (mirror.owner) return false; queue("owner", dev); queue("ownerName", name()); dataL.forEach(f => { try { f([], false); } catch (e) {} }); return true; }
  async function sha(s) { const b = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("mw-owner:" + s)); return Array.from(new Uint8Array(b)).map(x => x.toString(16).padStart(2, "0")).join(""); }
  const isOwner = () => !mirror.owner || mirror.owner === dev;
  const notify = () => dataL.forEach(f => { try { f([], false); } catch (e) {} });
  async function setPin(pin) {
    if (!isOwner()) return { ok: false, msg: "관리자 컴퓨터에서만 설정할 수 있습니다" };
    if (!/^\d{4,8}$/.test(String(pin || ""))) return { ok: false, msg: "비밀번호는 숫자 4~8자리로 정해주세요" };
    if (!mirror.owner) queue("owner", dev);
    queue("ownerPin", await sha(pin)); queue("ownerName", name()); notify(); return { ok: true };
  }
  async function takeOwner(pin) {
    if (isOwner()) return { ok: true };
    if (!mirror.ownerPin) return { ok: false, msg: "관리자 비밀번호가 아직 없습니다. 지금 관리자 컴퓨터에서 먼저 정해주세요" };
    if ((await sha(pin)) !== mirror.ownerPin) return { ok: false, msg: "비밀번호가 맞지 않습니다" };
    queue("owner", dev); queue("ownerName", name()); notify(); return { ok: true };
  }
  window.MwSync = {
    start, configure, disconnect, claimOwner, setPin, takeOwner, put, del, list, tombs,
    hasPin: () => !!mirror.ownerPin, ownerName: () => mirror.ownerName || "", putBlob, blob, putMap, map,
    url: base, name, dev: () => dev, isOwner, ready: () => ready, status: () => st,
    joinKey: () => "mw_sync_joined:" + base(),
    onStatus: f => { stL.add(f); return () => stL.delete(f); },
    onData: f => { dataL.add(f); return () => dataL.delete(f); }
  };
})();
