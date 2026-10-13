// 에어캡 · 세트 확인 → 일별 건수 파일(MMDD 시트, 홈쇼핑원본) 채우기
(function () {
  const AIR_FIND = ['뚝심 200g', '뚝심120g', '뚝심 340g', '치즈뚝심', '장조림', '고기 고추장', '목우촌참치', '골뱅이'];
  const AIR_COUNT = ['뚝심', '장조림', '고기 고추장', '목우촌참치'];
  const dec = new TextDecoder(), enc = new TextEncoder();
  const cp = (a, b) => a < b ? -1 : a > b ? 1 : 0;

  // ── zip 읽기 ──
  function entries(ab) {
    const u = new Uint8Array(ab), dv = new DataView(u.buffer, u.byteOffset, u.byteLength);
    let e = u.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
    if (e < 0) throw new Error('엑셀 파일이 아니에요');
    const n = dv.getUint16(e + 10, true); let off = dv.getUint32(e + 16, true); const out = new Map();
    for (let i = 0; i < n; i++) {
      const m = dv.getUint16(off + 10, true), crc = dv.getUint32(off + 16, true), cs = dv.getUint32(off + 20, true), us = dv.getUint32(off + 24, true), fl = dv.getUint16(off + 28, true), el = dv.getUint16(off + 30, true), cl = dv.getUint16(off + 32, true), lo = dv.getUint32(off + 42, true);
      const name = dec.decode(u.subarray(off + 46, off + 46 + fl));
      const p = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
      out.set(name, { name, m, crc, cs, us, data: u.subarray(p, p + cs) }); off += 46 + fl + el + cl;
    }
    return out;
  }
  async function text(z, name) {
    const f = z.get(name); if (!f) return '';
    if (f.m === 0) return dec.decode(f.data);
    return new Response(new Blob([f.data]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).text();
  }
  const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(+d)).replace(/&amp;/g, '&');
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  async function sharedStrings(z) {
    return [...(await text(z, 'xl/sharedStrings.xml')).matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => unesc(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '').replace(/<[^>]+>/g, '')));
  }
  async function sheetPaths(z) {
    const wb = await text(z, 'xl/workbook.xml'), rels = await text(z, 'xl/_rels/workbook.xml.rels'), map = new Map();
    for (const m of wb.matchAll(/<sheet [^>]*>/g)) {
      const nm = unesc((m[0].match(/name="([^"]*)"/) || [])[1] || ''), rid = (m[0].match(/r:id="([^"]*)"/) || [])[1];
      const r = [...rels.matchAll(/<Relationship [^>]*>/g)].map(x => x[0]).find(x => x.includes('Id="' + rid + '"'));
      const t = r && (r.match(/Target="([^"]+)"/) || [])[1];
      if (t) map.set(nm, t.startsWith('/') ? t.slice(1) : 'xl/' + t);
    }
    return map;
  }
  function parseRows(xml, ss) {
    const rows = [];
    for (const rm of xml.matchAll(/<row [^>]*?(?:\/>|>([\s\S]*?)<\/row>)/g)) {
      const o = {};
      for (const m of (rm[1] || '').matchAll(/<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const body = m[3] || '', v = body.match(/<v>([\s\S]*?)<\/v>/), is = body.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        const val = v ? (/t="s"/.test(m[2]) ? ss[+v[1]] : unesc(v[1])) : (is ? unesc(is[1]) : '');
        if (val !== '') o[m[1]] = val;
      }
      rows.push(o);
    }
    return rows;
  }
  async function readFirstSheet(ab) {
    const z = entries(ab), ss = await sharedStrings(z), paths = await sheetPaths(z);
    return parseRows(await text(z, [...paths.values()][0] || 'xl/worksheets/sheet1.xml'), ss);
  }
  async function open(ab, password) {
    if (window.ClosingImport && window.ClosingImport.isEncryptedOffice(ab)) ab = await window.ClosingImport.decryptOffice(ab, password);
    return ab;
  }

  // ── 출고 완료 상세 현황 ──
  async function readOutbound(ab, password) {
    const rows = await readFirstSheet(await open(ab, password));
    const head = rows[0] || {}, col = {}, heads = [];
    for (const [c, v] of Object.entries(head)) { col[String(v).trim()] = c; heads.push([c, v]); }
    const miss = ['송장번호', '품목명', '수량'].filter(k => !col[k]);
    if (miss.length) throw new Error('머리글에 ' + miss.join('·') + ' 칸이 없어요');
    const dayCol = col['출고확정일'] || col['출고요청일'];
    const lines = [];
    for (const r of rows.slice(1)) {
      const inv = String(r[col['송장번호']] || '').trim(), item = String(r[col['품목명']] || '').trim();
      if (!inv || !item) continue;
      lines.push({ day: String(r[dayCol] || '').slice(0, 10), inv, item, qty: Number(r[col['수량']]) || 0 });
    }
    return { lines, rows, col };
  }

  // 하루치 → 피벗(A열 형식: 품목 내림차순, 구분자 없음) + 에어캡(I열 형식: 오름차순 ';')
  function compute(lines) {
    const byInv = new Map();
    for (const l of lines) { let m = byInv.get(l.inv); if (!m) byInv.set(l.inv, m = new Map()); m.set(l.item, (m.get(l.item) || 0) + l.qty); }
    const combos = new Map();
    for (const m of byInv.values()) {
      const items = [...m.keys()];
      const a = items.slice().sort((x, y) => cp(y, x)).map(k => k + '*' + m.get(k)).join('');
      let c = combos.get(a);
      if (!c) combos.set(a, c = { combo: a, comboI: items.slice().sort(cp).map(k => k + '*' + m.get(k)).join(';'), n: 0 });
      c.n++;
    }
    const pivot = [...combos.values()].sort((x, y) => y.n - x.n || cp(x.combo, y.combo));
    for (const p of pivot) {
      p.cold = p.comboI.includes('냉동') || p.comboI.includes('냉장');
      p.qtys = []; p.per = 0;
      if (!p.cold && AIR_FIND.some(k => p.comboI.includes(k))) {
        for (const it of p.comboI.split(';')) if (AIR_COUNT.some(k => it.includes(k)) && it.includes('*')) p.qtys.push(parseFloat(it.slice(it.indexOf('*') + 1)) || 0);
        p.per = p.qtys.reduce((a, q) => a + Math.ceil(q / 5), 0);
      }
      p.total = p.per * p.n;
    }
    const invoices = byInv.size;
    // 목우촌 박스 건수 시트 수식과 같은 계산
    const big = pivot.filter(p => p.n >= 40), sum = (arr, f) => arr.filter(f).reduce((a, p) => a + p.n, 0);
    const pre = (p, k) => p.combo.startsWith(k) && p.combo.slice(k.length).includes('세트');
    const set = sum(big, () => true) - sum(big, p => p.combo.includes('세트')) + ['[M냉장]', '[M상온]', '[M냉동]', '[M상온펫]'].reduce((a, k) => a + sum(big, p => pre(p, k)), 0);
    const gift = sum(pivot, p => p.combo.includes('세트')) - ['[M냉장]', '[M상온]', '[M냉동]'].reduce((a, k) => a + sum(pivot, p => pre(p, k)), 0);
    return { invoices, lines: lines.length, pivot, airTotal: pivot.reduce((a, p) => a + p.total, 0), set, gift, set40: set + gift };
  }
  function byDay(lines) {
    const g = new Map();
    for (const l of lines) { const d = l.day || '날짜 없음'; if (!g.has(d)) g.set(d, []); g.get(d).push(l); }
    return [...g.keys()].sort().map(day => ({ day, ...compute(g.get(day)) }));
  }

  // 홈쇼핑 출고 완료 → 날짜별 합포장번호 수 (홈쇼핑원본 M열 수식과 같은 계산)
  async function readHomeshop(ab, password) {
    const rows = await readFirstSheet(await open(ab, password));
    const head = rows[0] || {}, col = {};
    for (const [c, v] of Object.entries(head)) col[String(v).trim()] = c;
    if (!col['합포장번호'] || !col['출고요청일']) throw new Error('홈쇼핑 파일 머리글에 합포장번호·출고요청일 칸이 없어요');
    const data = rows.slice(1).filter(r => Object.keys(r).length);
    const days = {};
    for (const r of data) { const d = String(r[col['출고요청일']] || '').slice(0, 10), c = r[col['합포장번호']]; if (!d || !c) continue; (days[d] = days[d] || new Set()).add(c); }
    return { head, rows: data, col, counts: Object.fromEntries(Object.entries(days).map(([d, s]) => [d, s.size])) };
  }

  // ── 시트 XML ──
  const cn = i => { let s = ''; i++; while (i) { const m = (i - 1) % 26; s = String.fromCharCode(65 + m) + s; i = (i - m - 1) / 26; } return s; };
  const ci = s => [...s].reduce((a, ch) => a * 26 + ch.charCodeAt(0) - 64, 0) - 1;
  const cell = (ref, v, s) => v === '' || v == null ? '' : typeof v === 'number'
    ? '<c r="' + ref + '"' + (s ? ' s="' + s + '"' : '') + '><v>' + v + '</v></c>'
    : '<c r="' + ref + '"' + (s ? ' s="' + s + '"' : '') + ' t="inlineStr"><is><t xml:space="preserve">' + esc(v) + '</t></is></c>';
  const rowsXml = grid => grid.map((r, ri) => { const cs = r.map((v, c) => v && typeof v === 'object' ? cell(cn(c) + (ri + 1), v.v, v.s) : cell(cn(c) + (ri + 1), v)).join(''); return cs ? '<row r="' + (ri + 1) + '">' + cs + '</row>' : ''; }).join('');

  // 일자 시트(1001 등)와 같은 배치: A~B 피벗, I~ 에어캡
  function dayGrid(d) {
    const nq = Math.max(0, ...d.pivot.map(p => p.qtys.length));
    const g = [['행 레이블', '합계 : 합계수량', '', '', '', '', '', '', '행 레이블', 'I 값', ...Array(nq).fill(''), '에어캡', '포장수량']];
    d.pivot.forEach(p => g.push([p.combo, p.n]));
    g.push(['총합계', d.invoices]);
    const air = d.pivot.filter(p => !p.cold);
    air.forEach((p, i) => { const r = g[i + 1]; while (r.length < 8) r.push(''); r.push(p.comboI, p.n, ...p.qtys, ...Array(nq - p.qtys.length).fill(''), p.per, p.total); });
    const t = g[air.length + 1] || (g[air.length + 1] = []); while (t.length < 8) t.push('');
    t.push('총합계', d.invoices, ...Array(nq).fill(''), 0, 0);
    return g;
  }
  const tsv = g => g.map(r => r.map(v => v == null ? '' : String(v)).join('\t')).join('\n');
  const serial = d => { const [y, m, dd] = d.split('-').map(Number); return Math.round((Date.UTC(y, m - 1, dd) - Date.UTC(1899, 11, 30)) / 864e5); };

  function replaceData(xml, grid, filterRef) {
    const body = '<sheetData>' + rowsXml(grid) + '</sheetData>';
    const w = Math.max(1, ...grid.map(r => r.length));
    xml = xml.replace(/<sheetData\/>|<sheetData>[\s\S]*?<\/sheetData>/, body).replace(/<dimension ref="[^"]*"\/>/, '<dimension ref="A1:' + cn(w - 1) + Math.max(1, grid.length) + '"/>');
    if (filterRef) xml = xml.replace(/<autoFilter ref="[^"]*"/, '<autoFilter ref="' + filterRef + '"');
    return xml;
  }

  // ── zip 쓰기 (바뀐 파일만 다시 압축) ──
  const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
  const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  async function deflate(u8) { return new Uint8Array(await new Response(new Blob([u8]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer()); }
  async function writeZip(list) {
    const parts = [], cen = []; let off = 0;
    for (const f of list) {
      const nb = enc.encode(f.name);
      const h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x800, true); h.setUint16(8, f.m, true); h.setUint32(14, f.crc, true); h.setUint32(18, f.data.length, true); h.setUint32(22, f.us, true); h.setUint16(26, nb.length, true);
      parts.push(new Uint8Array(h.buffer), nb, f.data);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x800, true); c.setUint16(10, f.m, true); c.setUint32(16, f.crc, true); c.setUint32(20, f.data.length, true); c.setUint32(24, f.us, true); c.setUint16(28, nb.length, true); c.setUint32(42, off, true);
      cen.push(new Uint8Array(c.buffer), nb); off += 30 + nb.length + f.data.length;
    }
    const cl = cen.reduce((a, b) => a + b.length, 0), e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, list.length, true); e.setUint16(10, list.length, true); e.setUint32(12, cl, true); e.setUint32(16, off, true);
    return new Blob([...parts, ...cen, new Uint8Array(e.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  // 일별 건수 파일에 넣기: days → MMDD 시트, homeshop → 홈쇼핑원본
  async function fillDaily(ab, days, homeshop, password) {
    ab = await open(ab, password);
    const z = entries(ab), paths = await sheetPaths(z), changed = new Map(), done = [], missing = [];
    for (const d of days) {
      const nm = d.day.slice(5, 7) + d.day.slice(8, 10), p = paths.get(nm);
      if (!p) { missing.push(nm); continue; }
      const grid = dayGrid(d);
      changed.set(p, replaceData(await text(z, p), grid, 'A1:B' + (d.pivot.length + 2)));
      done.push(nm);
    }
    let hsRows = 0;
    if (homeshop && homeshop.rows.length) {
      const p = paths.get('홈쇼핑원본');
      if (!p) missing.push('홈쇼핑원본');
      else {
        const ss = await sharedStrings(z), xml = await text(z, p), old = parseRows(xml, ss);
        const head = old[0] && Object.keys(old[0]).length ? old[0] : homeshop.head;
        const hcol = {}; for (const [c, v] of Object.entries(head)) hcol[String(v).trim()] = c;
        const bc = hcol['출고요청일'] || 'BC', newDays = new Set(Object.keys(homeshop.counts));
        const keep = old.slice(1).filter(r => Object.keys(r).length && !newDays.has(String(r[bc] || '').slice(0, 10)));
        // 새 파일 열을 마감 파일 머리글 순서로 맞춰요
        const srcBy = {}; for (const [c, v] of Object.entries(homeshop.head)) srcBy[String(v).trim()] = c;
        const order = Object.entries(head).sort((a, b) => ci(a[0]) - ci(b[0]));
        const toRow = r => { const out = []; for (const [c, v] of order) { const src = srcBy[String(v).trim()]; let val = src ? r[src] : ''; if (c === bc && val) val = { v: serial(String(val).slice(0, 10)), s: 2 }; else if (val !== '' && val != null && /^-?\d+(\.\d+)?$/.test(val) && String(val).length < 12 && !/^0\d/.test(val)) val = Number(val); out[ci(c)] = val ?? ''; } return out; };
        const keepRow = r => { const out = []; for (const [c, v] of Object.entries(r)) { let val = v; if (c === bc && /^\d+$/.test(v)) val = { v: +v, s: 2 }; else if (c === bc && /^\d{4}-\d{2}-\d{2}/.test(v)) val = { v: serial(v.slice(0, 10)), s: 2 }; out[ci(c)] = val; } return out; };
        const headRow = []; for (const [c, v] of order) headRow[ci(c)] = v;
        const grid = [headRow, ...keep.map(keepRow), ...homeshop.rows.map(toRow)].map(r => Array.from(r, v => v ?? ''));
        changed.set(p, replaceData(xml, grid));
        hsRows = homeshop.rows.length;
      }
    }
    // 열 때 다시 계산
    const wbx = (await text(z, 'xl/workbook.xml')).replace(/<calcPr([^>]*?)\/>/, (m, a) => '<calcPr' + a.replace(/\s*fullCalcOnLoad="[^"]*"/, '') + ' fullCalcOnLoad="1"/>');
    changed.set('xl/workbook.xml', wbx);
    const list = [];
    for (const f of z.values()) {
      if (changed.has(f.name)) { const raw = enc.encode(changed.get(f.name)); list.push({ name: f.name, m: 8, crc: crc32(raw), us: raw.length, data: await deflate(raw) }); }
      else list.push(f);
    }
    return { blob: await writeZip(list), done, missing, hsRows };
  }

  // ── 박스수량 시트 (B~L) ──
  const POLY_CAP = [["목우촌 행복가득 스페셜",5],["행복가득 1호",5],["행복가득 3호",5],["마음가득 K1호",3],["마음가득 K2호",4],["마음가득 K3호",4],["마음가득 K4호",5],["마음가득 K5호",3],["마음가득 K6호",5],["마음가득 K7호",4],["마음가득 K8호",4],["마음가득 K9호",5],["마음가득 N1호",3],["마음가득 N2호",3],["마음가득 N3호",4],["마음가득 N4호",4],["마음가득 N5호",5],["마음가득 N6호",4],["마음가득 N7호",5],["마음가득 N8호",4],["마음가득 N9호",5],["마음가득 N10호",5],["마음가득 N11호",5],["마음가득 N12호",4],["마음가득 N13호",5],["마음가득 N14호",5],["마음가득 N15호",6],["마음가득M1호",3],["마음가득M3호",3],["마음가득M5호",3],["마음가득M9호",4],["마음가득M12호",5],["마음가득M13호(슬리브형)",5],["마음가득M13호",5],["마음가득M15호",5],["마음가득S2호",4],["마음가득S3호",5],["밥심&뚝심세트",5],["마음가득S4호",5],["전통가득육포세트(9개입)",5],["생생육포세트(12개입)",4]];
  const BOX_COLS = [['O', '보냉세트', '1개'], ['P', '보냉세트', '2개'], ['Q', '보냉 6호', ''], ['R', '보냉 7호', ''], ['S', '간편냉동', ''], ['T', '폴리세트', '1개'], ['U', '폴리세트', '2개'], ['V', '조립폴리세트', ''], ['W', '송장부착세트', ''], ['X', '상온부직포', ''], ['Y', '냉장부직포', ''], ['Z', '냉동부직포', ''], ['AA', '냉동송부', ''], ['AB', '지함 박스', '1입·보냉팩+폴리'], ['AC', '지함 박스', '2입·15k'], ['AD', '지함 박스', '3입·20k'], ['AE', '부직포세트', ''], ['K', '폴리 미등록', '입수량 확인']];
  const lastNum = a => { const i = a.lastIndexOf('*'); if (i < 0) return 0; const t = a.slice(i + 1).trim(); return t !== '' && !isNaN(+t) ? +t : 0; };
  const count = (a, s) => a.split(s).length - 1;
  function boxCounts(pivot, rules) {
    const R = new Map((rules || POLY_CAP).map(([k, v]) => [String(k).trim().toLowerCase(), +v || 0]));
    const o = { B: 0, C: 0, D: 0, E: 0, F: 0, G: 0, H: 0, I: 0, J: 0, K: 0, L: 0, O: 0, P: 0, Q: 0, R: 0, S: 0, V: 0, X: 0, Y: 0, Z: 0, AA: 0 }, unreg = [];
    for (const { combo: a, n: b } of pivot) {
      if (a.includes('[M지함세트]')) { const p = a.indexOf('지함상자*'); if (p >= 0) { const s = a.substr(p + 5, 5), j = s.indexOf('*'), t = j < 0 ? s : s.slice(0, j); if (t.trim() !== '' && !isNaN(+t)) { const v = +t; if (v % 3 === 1) o.B += b; if (v % 3 === 2) o.C += b; o.D += Math.floor(v / 3) * b; } } }
      if (a.includes('보냉') && !a.includes('풍미')) { const k = count(a, '[M보냉세트]'), nn = k > 1 ? k : lastNum(a); if (nn === 1) o.E += b; if (nn === 2) o.F += b; if (nn >= 3) o.G += b; }
      if (a.includes('폴리')) {
        const k = count(a, '[M폴리세트]'), nn = k > 1 ? k : lastNum(a), li = a.lastIndexOf('*'), fb = a.indexOf(']');
        const nm = li >= 0 && fb >= 0 ? a.slice(0, li).slice(fb + 1, fb + 301).trim() : '';
        const cap = R.get(nm.toLowerCase()) || 0, cx = cap || 1, rm = nn % cx, reg = nn >= 3 && cap > 0;
        o.H += ((nn === 1) + (reg && rm === 1)) * b; o.I += ((nn === 2) + (reg && rm === 2)) * b;
        if (reg) o.J += (Math.floor(nn / cx) + (rm >= 3)) * b;
        if (nn >= 3 && cap === 0) { o.K += b; unreg.push({ name: nm, qty: nn, n: b }); }
      }
      if (a.includes('[M송부세트]')) o.J += b;
      if (a.includes('[M부직포세트]')) o.L += b;
      // 목우촌 박스 건수 O~AA
      const q = lastNum(a), semi = count(a, ';'), bn = a.startsWith('[M보냉세트]') && semi === 0;
      if (bn && q === 1) o.O += b;
      if (a.startsWith('[M보냉세트]') && (semi === 1 || (semi === 0 && q === 2 && !a.includes('흑돈 수제햄세트')))) o.P += b;
      if (bn && a.includes('비어적켄 세트') && (q === 4 || q === 5)) o.Q += b;
      if (bn && a.includes('품격가득 햄종합세트') && q === 3) o.Q += b;
      if (bn && q === 3) o.R += ((a.includes('품격가득 S1호') ? 1 : 0) + (a.includes('품격가득 S2호') ? 1 : 0)) * b;
      if (bn && a.includes('흑돈 수제햄세트') && q === 2) o.R += b;
      if (a.startsWith('★[M냉동세트]') || a.startsWith('[M냉동세트]')) o.S += b;
      if (a.startsWith('★[M조립폴리세트]')) o.V += b;
      if (a.includes('정성가득선물세트(부직포가방세트)') && !a.includes('[M부직포세트]')) {
        const r = a.includes('[M상온]'), c = a.includes('[M냉장]'), f = a.includes('[M냉동]');
        if (r && !c && !f) o.X += b; if (c && !r && !f) o.Y += b; if (f && !r && !c) o.Z += b;
      }
      if (a.includes('[M냉동송부세트]')) o.AA += b;
    }
    o.AB = o.B; o.AC = o.C; o.AD = o.D; o.AE = o.L; o.T = o.H; o.U = o.I; o.W = o.J;
    return { ...o, unreg };
  }
  async function readRules(ab, password) {
    ab = await open(ab, password);
    const z = entries(ab), p = (await sheetPaths(z)).get('분류규칙'); if (!p) return null;
    const rows = parseRows(await text(z, p), await sharedStrings(z)).slice(1).filter(r => r.H && r.I && !isNaN(+r.I));
    return rows.length ? rows.map(r => [r.H, +r.I]) : null;
  }

  window.Aircap = { readOutbound, readHomeshop, compute, byDay, dayGrid, tsv, fillDaily, boxCounts, readRules, BOX_COLS, POLY_CAP, AIR_FIND, AIR_COUNT };
})();
