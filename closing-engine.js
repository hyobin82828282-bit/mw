// 마감 워크북 엔진: xlsx 읽기 · 수식 계산 · 원본 서식 유지 내보내기
// (디자인 번들 원본 + setMerges: 가져오기로 병합 범위를 바꿀 때 내보내기에 반영)
(function () {
  const dec = new TextDecoder(), enc = new TextEncoder();

  async function unzip(ab) {
    const buf = new Uint8Array(ab), dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    let e = -1; for (let i = buf.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { e = i; break; }
    if (e < 0) throw new Error('xlsx 형식이 아닙니다');
    const n = dv.getUint16(e + 10, true); let off = dv.getUint32(e + 16, true); const out = {}, order = [];
    for (let k = 0; k < n; k++) {
      const m = dv.getUint16(off + 10, true), cs = dv.getUint32(off + 20, true), nl = dv.getUint16(off + 28, true), el = dv.getUint16(off + 30, true), cl = dv.getUint16(off + 32, true), lo = dv.getUint32(off + 42, true);
      const name = dec.decode(buf.subarray(off + 46, off + 46 + nl));
      const st = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
      const raw = buf.subarray(st, st + cs);
      out[name] = m === 0 ? raw.slice() : new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('deflate-raw'))).arrayBuffer());
      order.push(name); off += 46 + nl + el + cl;
    }
    return { files: out, order };
  }
  const CRC = (() => { const t = new Uint32Array(256); for (let i = 0; i < 256; i++) { let c = i; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[i] = c >>> 0; } return t; })();
  const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
  async function zip(files, order) {
    const parts = [], cen = []; let off = 0;
    for (const name of order) {
      const data = files[name], nb = enc.encode(name);
      const comp = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
      const crc = crc32(data), h = new DataView(new ArrayBuffer(30));
      h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 8, true);
      h.setUint32(14, crc, true); h.setUint32(18, comp.length, true); h.setUint32(22, data.length, true); h.setUint16(26, nb.length, true);
      parts.push(new Uint8Array(h.buffer), nb, comp);
      const c = new DataView(new ArrayBuffer(46));
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 8, true);
      c.setUint32(16, crc, true); c.setUint32(20, comp.length, true); c.setUint32(24, data.length, true); c.setUint16(28, nb.length, true); c.setUint32(42, off, true);
      cen.push(new Uint8Array(c.buffer), nb); off += 30 + nb.length + comp.length;
    }
    const cs = cen.reduce((a, b) => a + b.length, 0), e = new DataView(new ArrayBuffer(22));
    e.setUint32(0, 0x06054b50, true); e.setUint16(8, order.length, true); e.setUint16(10, order.length, true); e.setUint32(12, cs, true); e.setUint32(16, off, true);
    return new Blob([...parts, ...cen, new Uint8Array(e.buffer)], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
  }

  const unesc = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n)).replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCharCode(parseInt(n, 16))).replace(/&amp;/g, '&');
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const attr = (s, n) => { const m = s.match(new RegExp('\\b' + n + '="([^"]*)"')); return m ? unesc(m[1]) : null; };
  const colNum = s => { let n = 0; for (const ch of s) n = n * 26 + ch.charCodeAt(0) - 64; return n; };
  const colName = n => { let s = ''; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = (n - m - 1) / 26; } return s; };
  const splitRef = r => { const m = r.match(/^([A-Z]+)(\d+)$/); return [colNum(m[1]), +m[2]]; };

  // ── formula tokenizer / ref shifting ──
  const REF_RE = /^(?:('(?:[^']|'')+'|[^\s!'"(),+\-*\/^&=<>:;{}%]+)!)?(\$?[A-Z]{1,3}\$?\d+(?::\$?[A-Z]{1,3}\$?\d+)?|\$?[A-Z]{1,3}:\$?[A-Z]{1,3}|\$?\d+:\$?\d+)(?![A-Za-z0-9_(])/;
  function tokenize(f) {
    const t = []; let i = 0;
    while (i < f.length) {
      const ch = f[i], rest = f.slice(i);
      if (/\s/.test(ch)) { i++; continue; }
      if (ch === '"') { let j = i + 1, s = ''; while (j < f.length) { if (f[j] === '"') { if (f[j + 1] === '"') { s += '"'; j += 2; continue; } break; } s += f[j++]; } t.push({ k: 'str', v: s, raw: f.slice(i, j + 1) }); i = j + 1; continue; }
      let m;
      if ((m = rest.match(/^#(?:REF!|DIV\/0!|VALUE!|NAME\?|N\/A|NUM!|NULL!)/))) { t.push({ k: 'err', v: m[0], raw: m[0] }); i += m[0].length; continue; }
      if ((m = rest.match(REF_RE)) && !/^[A-Z]+\d*\(/.test(rest) ) {
        const prev = t[t.length - 1];
        if (!(prev && prev.k === 'num')) { t.push({ k: 'ref', sheet: m[1] ? m[1].replace(/^'|'$/g, '').replace(/''/g, "'") : null, sheetRaw: m[1] || null, a: m[2], raw: m[0] }); i += m[0].length; continue; }
      }
      if ((m = rest.match(/^(\d+\.?\d*(?:[eE][+-]?\d+)?|\.\d+(?:[eE][+-]?\d+)?)/))) { t.push({ k: 'num', v: parseFloat(m[0]), raw: m[0] }); i += m[0].length; continue; }
      if ((m = rest.match(/^(TRUE|FALSE)(?![A-Za-z0-9_(.])/i))) { t.push({ k: 'bool', v: m[0].toUpperCase() === 'TRUE', raw: m[0] }); i += m[0].length; continue; }
      if ((m = rest.match(/^([A-Za-z_][A-Za-z0-9_.]*)\(/))) { t.push({ k: 'fn', v: m[1].toUpperCase().replace(/^_XLFN\./, ''), raw: m[1] }); i += m[1].length; continue; }
      if ((m = rest.match(/^(<=|>=|<>)/))) { t.push({ k: 'op', v: m[0], raw: m[0] }); i += 2; continue; }
      if ('+-*/^&=<>%(),:;{}'.includes(ch)) { t.push({ k: ch === '(' || ch === ')' || ch === ',' || ch === ';' ? ch : 'op', v: ch, raw: ch }); i++; continue; }
      if ((m = rest.match(/^[^\s()+\-*\/^&=<>,"]+/))) { t.push({ k: 'name', v: m[0], raw: m[0] }); i += m[0].length; continue; }
      throw new Error('토큰 오류: ' + rest.slice(0, 20));
    }
    return t;
  }
  function shiftA1(a, dc, dr) {
    return a.replace(/(\$?)([A-Z]{1,3})(\$?)(\d+)/g, (_, cd, c, rd, r) => (cd ? '$' + c : colName(colNum(c) + dc)) + (rd ? '$' + r : String(+r + dr)));
  }
  function shiftFormula(f, dc, dr) {
    if (!dc && !dr) return f;
    return tokenize(f).map(t => t.k === 'ref' ? (t.sheetRaw ? t.sheetRaw + '!' : '') + (/^\$?[A-Z]+:\$?[A-Z]+$/.test(t.a) || /^\$?\d+:\$?\d+$/.test(t.a) ? t.a : shiftA1(t.a, dc, dr)) : t.raw).join('');
  }

  // ── parser ──
  function parse(f) {
    const t = tokenize(f); let p = 0;
    const peek = () => t[p], eat = () => t[p++];
    const isOp = (...o) => t[p] && t[p].k === 'op' && o.includes(t[p].v);
    function cmp() { let l = cat(); while (isOp('=', '<>', '<', '>', '<=', '>=')) { const o = eat().v; l = { o, l, r: cat() }; } return l; }
    function cat() { let l = add(); while (isOp('&')) { eat(); l = { o: '&', l, r: add() }; } return l; }
    function add() { let l = mul(); while (isOp('+', '-')) { const o = eat().v; l = { o, l, r: mul() }; } return l; }
    function mul() { let l = pow(); while (isOp('*', '/')) { const o = eat().v; l = { o, l, r: pow() }; } return l; }
    function pow() { let l = una(); while (isOp('^')) { eat(); l = { o: '^', l, r: una() }; } return l; }
    function una() { if (isOp('-')) { eat(); return { o: 'neg', x: una() }; } if (isOp('+')) { eat(); return una(); } let x = prim(); while (isOp('%')) { eat(); x = { o: '%', x }; } return x; }
    function prim() {
      const k = eat(); if (!k) throw new Error('수식 끝');
      if (k.k === 'num') return { c: k.v }; if (k.k === 'str') return { c: k.v }; if (k.k === 'bool') return { c: k.v }; if (k.k === 'err') return { c: { err: k.v } };
      if (k.k === 'ref') return { ref: k };
      if (k.k === '(') { const e = cmp(); eat(); return e; }
      if (k.k === 'fn') { eat(); const args = []; if (peek() && peek().k === ')') { eat(); return { fn: k.v, args }; } while (true) { if (peek() && (peek().k === ',' || peek().k === ')')) args.push({ c: null }); else args.push(cmp()); const s = eat(); if (!s || s.k === ')') break; } return { fn: k.v, args }; }
      if (k.k === 'name') return { c: { err: '#NAME?' } };
      throw new Error('구문 오류 ' + k.raw);
    }
    const ast = cmp(); if (p < t.length) throw new Error('구문 오류'); return ast;
  }

  // ── workbook ──
  class Workbook {
    static async load(ab) {
      const z = await unzip(ab); const wb = new Workbook(); wb.z = z; await wb._parse(); return wb;
    }
    _txt(n) { return this.z.files[n] ? dec.decode(this.z.files[n]) : ''; }
    async _parse() {
      const wbx = this._txt('xl/workbook.xml'), rels = this._txt('xl/_rels/workbook.xml.rels');
      const relMap = {}; for (const m of rels.matchAll(/<Relationship\b[^>]*>/g)) relMap[attr(m[0], 'Id')] = attr(m[0], 'Target');
      this.date1904 = /date1904="(1|true)"/.test(wbx);
      this.ss = [...this._txt('xl/sharedStrings.xml').matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => unesc([...m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map(x => x[1]).join('')));
      this._styles();
      this.sheets = []; this.byName = {};
      for (const m of wbx.matchAll(/<sheet\b[^>]*\/?>/g)) {
        const name = attr(m[0], 'name'), rid = attr(m[0], 'r:id'), state = attr(m[0], 'state');
        let path = relMap[rid]; path = path.startsWith('/') ? path.slice(1) : 'xl/' + path;
        const sh = { name, path, hidden: !!state && state !== 'visible', cells: {}, merges: [], cols: {}, rows: {}, maxR: 0, maxC: 0, dirty: false };
        this._sheet(sh); this.sheets.push(sh); this.byName[name] = sh;
      }
      this.edits = {}; this.memo = new Map();
    }
    _styles() {
      const x = this._txt('xl/styles.xml'), th = this._txt('xl/theme/theme1.xml');
      const theme = [];
      const cs = (th.match(/<a:clrScheme[\s\S]*?<\/a:clrScheme>/) || [''])[0];
      for (const n of ['dk1', 'lt1', 'dk2', 'lt2', 'accent1', 'accent2', 'accent3', 'accent4', 'accent5', 'accent6']) { const m = cs.match(new RegExp('<a:' + n + '>[\\s\\S]*?(?:srgbClr val="([0-9A-F]{6})"|lastClr="([0-9A-F]{6})")', 'i')); theme.push(m ? (m[1] || m[2]) : '000000'); }
      const tmap = [theme[1], theme[0], theme[3], theme[2], ...theme.slice(4)];
      const color = s => {
        if (!s) return null; const rgb = attr(s, 'rgb'), t = attr(s, 'theme'), tint = +(attr(s, 'tint') || 0), idx = attr(s, 'indexed');
        let hex = rgb ? rgb.slice(-6) : t != null ? tmap[+t] : idx != null ? ({ 8: '000000', 9: 'FFFFFF', 10: 'FF0000', 12: '0000FF', 13: 'FFFF00', 22: 'C0C0C0', 64: null })[+idx] : null;
        if (!hex) return null;
        if (tint) { hex = [0, 2, 4].map(i => { let v = parseInt(hex.substr(i, 2), 16); v = tint < 0 ? v * (1 + tint) : v + (255 - v) * tint; return Math.round(v).toString(16).padStart(2, '0'); }).join(''); }
        return '#' + hex;
      };
      const fmts = {}; for (const m of x.matchAll(/<numFmt\b[^>]*\/>/g)) fmts[attr(m[0], 'numFmtId')] = attr(m[0], 'formatCode');
      const sec = n => (x.match(new RegExp('<' + n + '\\b[^>]*>([\\s\\S]*?)<\\/' + n + '>')) || ['', ''])[1];
      const fonts = [...sec('fonts').matchAll(/<font\b[^>]*>([\s\S]*?)<\/font>|<font\s*\/>/g)].map(m => { const b = m[1] || ''; return { b: /<b\/>|<b val="1"/.test(b), i: /<i\/>/.test(b), sz: +(attr((b.match(/<sz[^>]*>/) || [''])[0], 'val') || 11), color: color((b.match(/<color[^>]*>/) || [null])[0]) }; });
      const fills = [...sec('fills').matchAll(/<fill>([\s\S]*?)<\/fill>|<fill\/>/g)].map(m => { const b = m[1] || ''; if (!/patternType="solid"/.test(b)) return null; return color((b.match(/<fgColor[^>]*>/) || [null])[0]); });
      const borders = [...sec('borders').matchAll(/<border\b[^>]*>([\s\S]*?)<\/border>|<border\s*\/>/g)].map(m => { const b = m[1] || ''; const g = s => { const mm = b.match(new RegExp('<' + s + ' style="(\\w+)"')); return mm ? mm[1] : null; }; return { l: g('left'), r: g('right'), t: g('top'), b: g('bottom') }; });
      this.xf = [...sec('cellXfs').matchAll(/<xf\b([^>]*?)(?:\/>|>([\s\S]*?)<\/xf>)/g)].map(m => {
        const a = m[1], al = ((m[2] || '').match(/<alignment[^>]*>/) || [''])[0], id = attr(a, 'numFmtId') || '0';
        return { fmt: fmts[id] || BUILTIN[id] || 'General', fmtId: +id, font: fonts[+(attr(a, 'fontId') || 0)] || {}, fill: fills[+(attr(a, 'fillId') || 0)], border: borders[+(attr(a, 'borderId') || 0)] || {}, h: attr(al, 'horizontal'), v: attr(al, 'vertical'), wrap: attr(al, 'wrapText') === '1' };
      });
    }
    _sheet(sh) {
      const x = this._txt(sh.path);
      for (const m of x.matchAll(/<col\b[^>]*\/>/g)) { const mn = +attr(m[0], 'min'), mx = +attr(m[0], 'max'), w = +attr(m[0], 'width'), hd = attr(m[0], 'hidden') === '1'; for (let c = mn; c <= Math.min(mx, 200); c++) sh.cols[c] = { w, hidden: hd }; }
      for (const m of x.matchAll(/<mergeCell ref="([^"]+)"/g)) { const [a, b] = m[1].split(':'); const [c1, r1] = splitRef(a), [c2, r2] = splitRef(b || a); sh.merges.push({ c1, r1, c2, r2 }); }
      const shared = {}; const pend = [];
      const sd = (x.match(/<sheetData[\s\S]*<\/sheetData>|<sheetData\/>/) || [''])[0];
      for (const rm of sd.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/g)) {
        const r = +attr(rm[1], 'r'), ht = attr(rm[1], 'ht'); sh.rows[r] = { h: ht ? +ht : null, hidden: attr(rm[1], 'hidden') === '1' };
        for (const cm of (rm[2] || '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
          const ref = attr(cm[1], 'r'), t = attr(cm[1], 't'), s = +(attr(cm[1], 's') || 0), inner = cm[2] || '';
          const [c, rr] = splitRef(ref); const cell = { s };
          const fm = inner.match(/<f\b([^>]*?)(?:\/>|>([^<]*)<\/f>)/);
          const vm = inner.match(/<v>([^<]*)<\/v>/);
          if (vm) { const v = unesc(vm[1]); cell.v = t === 's' ? this.ss[+v] : t === 'str' || t === 'inlineStr' ? v : t === 'b' ? v === '1' : t === 'e' ? { err: v } : +v; }
          else if (t === 'inlineStr') cell.v = unesc([...inner.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map(q => q[1]).join(''));
          if (fm) {
            const fa = fm[1], ftxt = fm[2] != null ? unesc(fm[2]) : '', ft = attr(fa, 't'), si = attr(fa, 'si');
            if (ft === 'shared' && ftxt) { shared[si] = { f: ftxt, c, r: rr }; cell.f = ftxt; }
            else if (ft === 'shared') pend.push([cell, si, c, rr]);
            else if (ftxt) cell.f = ftxt;
            if (cell.f || ft === 'shared') cell.cached = cell.v;
          }
          if (cell.v !== undefined || cell.f || pend.length && pend[pend.length - 1][0] === cell || s) { sh.cells[ref] = cell; if (cell.v !== undefined || cell.f || (pend.length && pend[pend.length - 1][0] === cell)) { sh.maxR = Math.max(sh.maxR, rr); sh.maxC = Math.max(sh.maxC, c); } }
        }
      }
      for (const [cell, si, c, r] of pend) { const m = shared[si]; if (m) { cell.f = shiftFormula(m.f, c - m.c, r - m.r); cell.cached = cell.v; } }
      for (const mg of sh.merges) { sh.maxR = Math.max(sh.maxR, mg.r1); sh.maxC = Math.max(sh.maxC, mg.c1); }
    }
    // ── evaluation ──
    reset() { this.memo = new Map(); this.stack = new Set(); }
    value(sheet, ref) {
      const sh = typeof sheet === 'string' ? this.byName[sheet] : sheet; if (!sh) return { err: '#REF!' };
      const cell = sh.cells[ref]; if (!cell) return null;
      if (!cell.f) return cell.v === undefined ? null : cell.v;
      const key = sh.name + '!' + ref; if (this.memo.has(key)) return this.memo.get(key);
      if (!this.stack) this.stack = new Set();
      if (this.stack.has(key)) return 0;
      this.stack.add(key);
      let v; try { if (!cell.ast) cell.ast = parse(cell.f); v = this.ev(cell.ast, sh); if (Array.isArray(v)) v = v[0] ? v[0][0] : null; if (v && v.range) v = this.rangeVals(v)[0][0]; } catch (e) { v = { err: '#NAME?', msg: e.message }; }
      this.stack.delete(key);
      if (v === null || v === undefined) v = 0;
      this.memo.set(key, v); return v;
    }
    resolveRef(r, sh) {
      const target = r.sheet ? this.byName[r.sheet] : sh; if (!target) return { err: '#REF!' };
      let a = r.a.replace(/\$/g, ''); let c1, r1, c2, r2;
      if (/^[A-Z]+:[A-Z]+$/.test(a)) { const [x, y] = a.split(':'); c1 = colNum(x); c2 = colNum(y); r1 = 1; r2 = target.maxR; }
      else if (/^\d+:\d+$/.test(a)) { const [x, y] = a.split(':'); r1 = +x; r2 = +y; c1 = 1; c2 = target.maxC; }
      else { const [x, y] = a.split(':'); [c1, r1] = splitRef(x); [c2, r2] = y ? splitRef(y) : [c1, r1]; }
      if (c1 > c2) [c1, c2] = [c2, c1]; if (r1 > r2) [r1, r2] = [r2, r1];
      return { range: true, sh: target, c1, r1, c2, r2 };
    }
    rangeVals(g) { const out = []; for (let r = g.r1; r <= g.r2; r++) { const row = []; for (let c = g.c1; c <= g.c2; c++) row.push(this.value(g.sh, colName(c) + r)); out.push(row); } return out; }
    ev(n, sh) {
      if ('c' in n) return n.c;
      if (n.ref) { const g = this.resolveRef(n.ref, sh); if (g.err) return g; if (g.c1 === g.c2 && g.r1 === g.r2) return this.value(g.sh, colName(g.c1) + g.r1); return g; }
      if (n.fn) return this.call(n.fn, n.args, sh);
      const sc = x => { if (x && x.range) { return this.rangeVals(x)[0][0]; } return x; };
      if (n.o === 'neg') { const v = num(sc(this.ev(n.x, sh))); return isErr(v) ? v : -v; }
      if (n.o === '%') { const v = num(sc(this.ev(n.x, sh))); return isErr(v) ? v : v / 100; }
      const L = sc(this.ev(n.l, sh)), R = sc(this.ev(n.r, sh));
      if (isErr(L)) return L; if (isErr(R)) return R;
      if (n.o === '&') return str(L) + str(R);
      if (['=', '<>', '<', '>', '<=', '>='].includes(n.o)) { const c = cmpv(L, R); return { '=': c === 0, '<>': c !== 0, '<': c < 0, '>': c > 0, '<=': c <= 0, '>=': c >= 0 }[n.o]; }
      const a = num(L), b = num(R); if (isErr(a)) return a; if (isErr(b)) return b;
      switch (n.o) { case '+': return a + b; case '-': return a - b; case '*': return a * b; case '/': return b === 0 ? { err: '#DIV/0!' } : a / b; case '^': return Math.pow(a, b); }
      return { err: '#VALUE!' };
    }
    flat(args, sh, keepText) {
      const out = [];
      for (const a of args) { const v = this.ev(a, sh); if (v && v.range) { for (const row of this.rangeVals(v)) for (const x of row) out.push({ v: x, ref: true }); } else out.push({ v, ref: !!a.ref }); }
      return out;
    }
    call(fn, args, sh) {
      const E = a => { const v = this.ev(a, sh); return v && v.range ? this.rangeVals(v)[0][0] : v; };
      const nums = () => { const r = []; for (const x of this.flat(args, sh)) { if (isErr(x.v)) return x.v; if (typeof x.v === 'number') r.push(x.v); else if (!x.ref && x.v != null && x.v !== '') { const n = num(x.v); if (isErr(n)) return n; r.push(n); } } return r; };
      const rnd = (mode) => { const x = num(E(args[0])), d = args[1] ? num(E(args[1])) : 0; if (isErr(x)) return x; if (isErr(d)) return d; return xround(x, d, mode); };
      const crit = (rngNode, cNode) => { const g = this.ev(rngNode, sh); const vals = g && g.range ? this.rangeVals(g).flat() : [g]; const test = mkCrit(E(cNode)); return vals.map(test); };
      switch (fn) {
        case 'SUM': { const r = nums(); return isErr(r) ? r : r.reduce((a, b) => a + b, 0); }
        case 'AVERAGE': { const r = nums(); if (isErr(r)) return r; return r.length ? r.reduce((a, b) => a + b, 0) / r.length : { err: '#DIV/0!' }; }
        case 'MIN': { const r = nums(); return isErr(r) ? r : r.length ? Math.min(...r) : 0; }
        case 'MAX': { const r = nums(); return isErr(r) ? r : r.length ? Math.max(...r) : 0; }
        case 'COUNT': return this.flat(args, sh).filter(x => typeof x.v === 'number').length;
        case 'COUNTA': return this.flat(args, sh).filter(x => x.v !== null && x.v !== '').length;
        case 'ROUND': return rnd(0); case 'ROUNDUP': return rnd(1); case 'ROUNDDOWN': return rnd(-1);
        case 'N': { const v = E(args[0]); return isErr(v) ? v : typeof v === 'number' ? v : v === true ? 1 : 0; }
        case 'INT': { const x = num(E(args[0])); return isErr(x) ? x : Math.floor(x); }
        case 'ABS': { const x = num(E(args[0])); return isErr(x) ? x : Math.abs(x); }
        case 'IF': { const c = E(args[0]); if (isErr(c)) return c; const t = typeof c === 'string' ? c !== '' : !!(typeof c === 'number' ? c : c); return t ? (args[1] ? E(args[1]) : true) : (args[2] ? E(args[2]) : false); }
        case 'IFERROR': { const v = E(args[0]); return isErr(v) ? E(args[1]) : v; }
        case 'AND': return this.flat(args, sh).every(x => !!x.v); case 'OR': return this.flat(args, sh).some(x => !!x.v);
        case 'COUNTIF': return crit(args[0], args[1]).filter(Boolean).length;
        case 'COUNTIFS': { let m = null; for (let i = 0; i < args.length; i += 2) { const t = crit(args[i], args[i + 1]); m = m ? m.map((x, j) => x && t[j]) : t; } return m.filter(Boolean).length; }
        case 'SUMIF': { const t = crit(args[0], args[1]); const g = this.ev(args[2] || args[0], sh); const v = g && g.range ? this.rangeVals(g).flat() : [g]; return t.reduce((a, ok, j) => a + (ok && typeof v[j] === 'number' ? v[j] : 0), 0); }
        case 'SUMIFS': { const g = this.ev(args[0], sh); const v = g && g.range ? this.rangeVals(g).flat() : [g]; let m = v.map(() => true); for (let i = 1; i < args.length; i += 2) { const t = crit(args[i], args[i + 1]); m = m.map((x, j) => x && t[j]); } return v.reduce((a, x, j) => a + (m[j] && typeof x === 'number' ? x : 0), 0); }
        case 'SUMPRODUCT': { const arrs = args.map(a => { const g = this.ev(a, sh); return g && g.range ? this.rangeVals(g).flat() : [g]; }); return arrs[0].reduce((s, _, j) => s + arrs.reduce((p, a) => p * (typeof a[j] === 'number' ? a[j] : 0), 1), 0); }
        case 'VLOOKUP': { const key = E(args[0]); const g = this.ev(args[1], sh); const col = num(E(args[2])); const exact = args[3] ? !E(args[3]) : false; const rows = this.rangeVals(g); for (const row of rows) if (exact ? cmpv(row[0], key) === 0 : cmpv(row[0], key) === 0) return row[col - 1]; return { err: '#N/A' }; }
      }
      return { err: '#NAME?' };
    }
    // ── editing ──
    // force: allow replacing an original formula (importer normalising row formulas; re-applying saved edits)
    setCell(sheetName, ref, raw, force) {
      const sh = this.byName[sheetName]; let cell = sh.cells[ref];
      if (!cell) { cell = sh.cells[ref] = { s: 0 }; const [c, r] = splitRef(ref); sh.maxR = Math.max(sh.maxR, r); sh.maxC = Math.max(sh.maxC, c); }
      if (cell.f && !cell.fAdded && !force) return false;
      // "=..." adds a formula to an input cell (kept in edits as text, exported as a real formula)
      if (typeof raw === 'string' && /^=./.test(raw.trim())) { cell.f = raw.trim().slice(1); cell.fAdded = true; delete cell.ast; delete cell.v; (this.edits[sheetName] = this.edits[sheetName] || {})[ref] = raw.trim(); this.reset(); return true; }
      if (cell.f && (cell.fAdded || force)) { delete cell.f; delete cell.fAdded; delete cell.ast; delete cell.cached; }
      let v = raw; if (typeof raw === 'string') { const t = raw.trim(); const asText = (this.xf[cell.s] || {}).fmt === '@'; if (t === '') v = undefined; else if (asText) v = t; else if (/^-?[\d,]*\.?\d+$/.test(t.replace(/,/g, '')) && /^-?[\d,]*\.?\d*$/.test(t)) v = +t.replace(/,/g, ''); }
      cell.v = v; (this.edits[sheetName] = this.edits[sheetName] || {})[ref] = v === undefined ? null : v; this.reset(); return true;
    }
    // Replace a sheet's merged ranges (used when imported rows regroup merged cells); written out on export.
    setMerges(sheetName, merges) { const sh = this.byName[sheetName]; if (!sh) return; sh.merges = merges.map(m => ({ c1: m.c1, r1: m.r1, c2: m.c2, r2: m.r2 })); sh.mergesEdited = true; }
    applyEdits(ed) { for (const s in ed) if (this.byName[s]) for (const r in ed[s]) this.setCell(s, r, ed[s][r] === null ? '' : ed[s][r], true); this.edits = JSON.parse(JSON.stringify(ed)); }
    verify() {
      this.reset(); let total = 0, ok = 0; const bad = [];
      for (const sh of this.sheets) for (const ref in sh.cells) { const c = sh.cells[ref]; if (!c.f || c.cached === undefined) continue; total++; const v = this.value(sh, ref); if (same(v, c.cached)) ok++; else if (bad.length < 50) bad.push({ sheet: sh.name, ref, f: c.f, got: v, want: c.cached }); }
      return { total, ok, bad };
    }
    display(sh, ref) {
      const cell = sh.cells[ref]; if (!cell) return '';
      const v = cell.f ? this.value(sh, ref) : cell.v; const xf = this.xf[cell.s] || {};
      return fmtVal(v, xf, this.date1904);
    }
    async exportBlob() {
      this.reset(); const files = Object.assign({}, this.z.files);
      for (const sh of this.sheets) {
        let x = dec.decode(files[sh.path]); const ed = this.edits[sh.name] || {}; const seen = new Set();
        const cellXml = (ref, s, cell) => {
          const sAttr = s ? ` s="${s}"` : '';
          if (cell.f) { const v = this.value(sh, ref); const f = `<f>${esc(cell.f)}</f>`; if (isErr(v)) return `<c r="${ref}"${sAttr} t="e">${f}<v>${esc(v.err)}</v></c>`; if (typeof v === 'string') return `<c r="${ref}"${sAttr} t="str">${f}<v>${esc(v)}</v></c>`; if (typeof v === 'boolean') return `<c r="${ref}"${sAttr} t="b">${f}<v>${v ? 1 : 0}</v></c>`; return `<c r="${ref}"${sAttr}>${f}<v>${v}</v></c>`; }
          const v = cell.v; if (v === undefined || v === null || v === '') return `<c r="${ref}"${sAttr}/>`;
          if (typeof v === 'number') return `<c r="${ref}"${sAttr}><v>${v}</v></c>`;
          if (typeof v === 'boolean') return `<c r="${ref}"${sAttr} t="b"><v>${v ? 1 : 0}</v></c>`;
          return `<c r="${ref}"${sAttr} t="inlineStr"><is><t xml:space="preserve">${esc(v)}</t></is></c>`;
        };
        x = x.replace(/<c r="([A-Z]+\d+)"([^>]*?)(\/>|>([\s\S]*?)<\/c>)/g, (whole, ref, at, _e, inner) => {
          const cell = sh.cells[ref]; seen.add(ref);
          if (!cell) return whole;
          if (ref in ed) return cellXml(ref, cell.s, cell);
          if (cell.f) { const s = +(attr(at, 's') || 0); const fm = (inner || '').match(/<f\b[^>]*?(?:\/>|>[^<]*<\/f>)/); const v = this.value(sh, ref); const fx = fm ? fm[0] : `<f>${esc(cell.f)}</f>`; const sA = s ? ` s="${s}"` : ''; if (isErr(v)) return `<c r="${ref}"${sA} t="e">${fx}<v>${esc(v.err)}</v></c>`; if (typeof v === 'string') return `<c r="${ref}"${sA} t="str">${fx}<v>${esc(v)}</v></c>`; if (typeof v === 'boolean') return `<c r="${ref}"${sA} t="b">${fx}<v>${v ? 1 : 0}</v></c>`; return `<c r="${ref}"${sA}>${fx}<v>${v}</v></c>`; }
          return whole;
        });
        const missing = Object.keys(ed).filter(r => !seen.has(r) && ed[r] !== null);
        if (missing.length) {
          const byRow = {}; for (const r of missing) { const [c, rr] = splitRef(r); (byRow[rr] = byRow[rr] || []).push([c, r]); }
          x = x.replace(/<row r="(\d+)"([^>]*?)(\/>|>([\s\S]*?)<\/row>)/g, (whole, rn, at, _e, inner) => {
            const add = byRow[rn]; if (!add) return whole; delete byRow[rn];
            const cells = [...(inner || '').matchAll(/<c r="([A-Z]+)\d+"[\s\S]*?(?:\/>|<\/c>)/g)].map(m => [colNum(m[1]), m[0]]);
            for (const [c, r] of add) cells.push([c, cellXml(r, 0, sh.cells[r])]);
            cells.sort((a, b) => a[0] - b[0]);
            return `<row r="${rn}"${at.replace(/\s*spans="[^"]*"/, '')}>${cells.map(q => q[1]).join('')}</row>`;
          });
          const rest = Object.keys(byRow).map(Number).sort((a, b) => a - b);
          if (rest.length) {
            x = x.replace('<sheetData/>', '<sheetData></sheetData>');
            const rowsXml = rest.map(rn => `<row r="${rn}">${byRow[rn].sort((a, b) => a[0] - b[0]).map(([c, r]) => cellXml(r, 0, sh.cells[r])).join('')}</row>`);
            x = x.replace(/<sheetData>([\s\S]*?)<\/sheetData>/, (_, body) => {
              const rows = [...body.matchAll(/<row r="(\d+)"[\s\S]*?(?:<\/row>|\/>)/g)].map(m => [+m[1], m[0]]);
              rest.forEach((rn, i) => rows.push([rn, rowsXml[i]])); rows.sort((a, b) => a[0] - b[0]);
              return '<sheetData>' + rows.map(r => r[1]).join('') + '</sheetData>';
            });
          }
        }
        if (sh.mergesEdited) {
          const mx = sh.merges.length ? `<mergeCells count="${sh.merges.length}">${sh.merges.map(m => `<mergeCell ref="${colName(m.c1)}${m.r1}:${colName(m.c2)}${m.r2}"/>`).join('')}</mergeCells>` : '';
          if (/<mergeCells\b[\s\S]*?<\/mergeCells>/.test(x)) x = x.replace(/<mergeCells\b[\s\S]*?<\/mergeCells>/, mx);
          else if (mx) x = x.replace(/(<\/sheetData>(?:\s*<sheetCalcPr\b[^>]*\/>)?(?:\s*<sheetProtection\b[^>]*\/>)?(?:\s*<protectedRanges>[\s\S]*?<\/protectedRanges>)?(?:\s*<scenarios\b[\s\S]*?<\/scenarios>)?(?:\s*<autoFilter\b[\s\S]*?(?:<\/autoFilter>|\/>))?(?:\s*<sortState\b[\s\S]*?(?:<\/sortState>|\/>))?(?:\s*<dataConsolidate\b[^>]*\/>)?(?:\s*<customSheetViews>[\s\S]*?<\/customSheetViews>)?)/, '$1' + mx);
        }
        files[sh.path] = enc.encode(x);
      }
      let wbx = dec.decode(files['xl/workbook.xml']);
      wbx = /<calcPr\b/.test(wbx) ? wbx.replace(/<calcPr\b([^>]*?)\/>/, (m, a) => `<calcPr${a.replace(/\s*fullCalcOnLoad="[^"]*"/, '')} fullCalcOnLoad="1"/>`) : wbx.replace('</workbook>', '<calcPr fullCalcOnLoad="1"/></workbook>');
      files['xl/workbook.xml'] = enc.encode(wbx);
      return zip(files, this.z.order);
    }
  }

  const BUILTIN = { 0: 'General', 1: '0', 2: '0.00', 3: '#,##0', 4: '#,##0.00', 9: '0%', 10: '0.00%', 14: 'yyyy-mm-dd', 15: 'd-mmm-yy', 16: 'd-mmm', 17: 'mmm-yy', 22: 'yyyy-mm-dd h:mm', 37: '#,##0 ;(#,##0)', 38: '#,##0 ;[Red](#,##0)', 41: '_-* #,##0_-;-* #,##0_-;_-* "-"_-;_-@_-', 43: '_-* #,##0.00_-;-* #,##0.00_-;_-* "-"??_-;_-@_-', 49: '@' };
  const isErr = v => !!(v && typeof v === 'object' && v.err);
  function num(v) { if (v === null || v === undefined || v === '') return 0; if (typeof v === 'number') return v; if (typeof v === 'boolean') return v ? 1 : 0; if (isErr(v)) return v; const n = Number(String(v).replace(/,/g, '').trim()); return isNaN(n) ? { err: '#VALUE!' } : n; }
  function str(v) { if (v === null || v === undefined) return ''; if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE'; if (typeof v === 'number') return String(+v.toPrecision(15)); return String(v); }
  function cmpv(a, b) { if (a === null || a === undefined) a = typeof b === 'string' ? '' : 0; if (b === null || b === undefined) b = typeof a === 'string' ? '' : 0; if (typeof a === 'number' && typeof b === 'number') return a - b; if (typeof a === 'string' && typeof b === 'string') { const x = a.toLowerCase(), y = b.toLowerCase(); return x < y ? -1 : x > y ? 1 : 0; } if (typeof a === 'boolean' && typeof b === 'boolean') return (a ? 1 : 0) - (b ? 1 : 0); const rank = v => typeof v === 'number' ? 0 : typeof v === 'string' ? 1 : 2; return rank(a) - rank(b); }
  function xround(x, d, mode) { const p = Math.pow(10, d), s = x < 0 ? -1 : 1; const a = +(Math.abs(x) * p).toPrecision(15); const r = mode === 0 ? Math.round(a) : mode === 1 ? Math.ceil(a) : Math.floor(a); return s * r / p; }
  function mkCrit(c) {
    if (typeof c === 'number' || typeof c === 'boolean') return v => cmpv(v, c) === 0 && v !== null;
    const s = c == null ? '' : String(c); const m = s.match(/^(<=|>=|<>|<|>|=)?([\s\S]*)$/); const op = m[1] || '=', rhs = m[2];
    const rn = rhs !== '' && !isNaN(Number(rhs)) ? Number(rhs) : null;
    const wild = /[*?]/.test(rhs) ? new RegExp('^' + rhs.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i') : null;
    return v => {
      if (op === '=' || op === '<>') { let eq; if (rhs === '') eq = v === null || v === ''; else if (rn !== null) eq = typeof v === 'number' ? v === rn : typeof v === 'string' && v.trim() !== '' && Number(v) === rn; else if (wild) eq = typeof v === 'string' && wild.test(v); else eq = typeof v === 'string' && v.toLowerCase() === rhs.toLowerCase(); return op === '=' ? eq : !eq; }
      if (rn !== null) { if (typeof v !== 'number') return false; return { '<': v < rn, '>': v > rn, '<=': v <= rn, '>=': v >= rn }[op]; }
      if (typeof v !== 'string') return false; const c2 = cmpv(v, rhs); return { '<': c2 < 0, '>': c2 > 0, '<=': c2 <= 0, '>=': c2 >= 0 }[op];
    };
  }
  function same(a, b) { if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)); if (isErr(a) && isErr(b)) return a.err === b.err; if ((a === 0 || a === '' || a === null) && (b === '' || b === null || b === 0)) return true; return String(a) === String(b); }
  function fmtVal(v, xf, d1904) {
    if (v === null || v === undefined) return ''; if (isErr(v)) return v.err; if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
    if (typeof v === 'string') return v;
    const f = xf.fmt || 'General'; const secs = f.split(';');
    if (/[yd]|mm?m|h:/i.test(secs[0].replace(/"[^"]*"|\[[^\]]*\]/g, '')) && !/#|0\.0/.test(secs[0])) {
      const ms = Math.round((v - (d1904 ? -1462 : 25569)) * 864e5); const d = new Date(ms); if (isNaN(d)) return String(v);
      const p = n => String(n).padStart(2, '0'); const Y = d.getUTCFullYear(), M = d.getUTCMonth() + 1, D = d.getUTCDate();
      if (/h/i.test(secs[0])) return `${Y}-${p(M)}-${p(D)} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
      if (!/y/i.test(secs[0])) return `${M}/${D}`; return `${Y}-${p(M)}-${p(D)}`;
    }
    let sec = secs[0]; if (v < 0 && secs[1]) sec = secs[1]; if (v === 0 && secs[2]) sec = secs[2];
    const clean = sec.replace(/"[^"]*"|\[[^\]]*\]|_.|\\./g, m => m[0] === '"' ? m : '');
    if (v === 0 && secs[2] && /"-"|-/.test(secs[2]) && !/0/.test(secs[2].replace(/"[^"]*"/g, ''))) return '-';
    if (f === 'General' || f === '@') { const r = +v.toPrecision(11); return Math.abs(r) >= 1e11 ? r.toExponential(5) : String(r); }
    const pct = /%/.test(clean); const dm = clean.match(/\.([0#?]+)/); const dp = dm ? dm[1].replace(/[#?]/g, '').length : 0; const maxdp = dm ? dm[1].length : 0;
    let x = pct ? v * 100 : v; const neg = x < 0 && (v >= 0 || !secs[1]); x = Math.abs(x);
    let s = x.toLocaleString('en-US', { minimumFractionDigits: dp, maximumFractionDigits: maxdp, useGrouping: /,/.test(clean) });
    const paren = v < 0 && secs[1] && /\(/.test(secs[1]);
    const lit = (clean.match(/"([^"]*)"/g) || []).map(q => q.slice(1, -1)).filter(q => q !== '-').join('');
    s = (neg ? '-' : '') + (paren ? '(' + s + ')' : s) + (pct ? '%' : '') + (lit && !/^\s*$/.test(lit) ? lit : '');
    return (v < 0 && secs[1] && !paren && /-/.test(secs[1].replace(/"[^"]*"/g, '')) ? '-' : '') + s;
  }

  window.ClosingEngine = { Workbook, colName, colNum, splitRef, parse, tokenize, shiftFormula };
})();
