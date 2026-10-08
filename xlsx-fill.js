// 원본 xlsx 양식을 그대로 두고 셀 값만 채워 넣는 도구 (서식·이미지·인쇄설정 보존)
const enc = new TextEncoder(), dec = new TextDecoder();
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = CRC[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
const pipe = async (b, s) => new Uint8Array(await new Response(new Blob([b]).stream().pipeThrough(s)).arrayBuffer());

async function unzip(ab) {
  const u = new Uint8Array(ab), dv = new DataView(ab);
  let e = u.length - 22; while (e >= 0 && dv.getUint32(e, true) !== 0x06054b50) e--;
  let off = dv.getUint32(e + 16, true); const n = dv.getUint16(e + 10, true), files = [];
  for (let i = 0; i < n; i++) {
    const m = dv.getUint16(off + 10, true), cs = dv.getUint32(off + 20, true), nl = dv.getUint16(off + 28, true),
      el = dv.getUint16(off + 30, true), cl = dv.getUint16(off + 32, true), lo = dv.getUint32(off + 42, true);
    const name = dec.decode(u.slice(off + 46, off + 46 + nl));
    const ls = lo + 30 + dv.getUint16(lo + 26, true) + dv.getUint16(lo + 28, true);
    const raw = u.slice(ls, ls + cs);
    files.push({ name, data: m === 0 ? raw : await pipe(raw, new DecompressionStream("deflate-raw")) });
    off += 46 + nl + el + cl;
  }
  return files;
}

async function zip(files) {
  const parts = [], cen = []; let off = 0;
  for (const f of files) {
    const nm = enc.encode(f.name), crc = crc32(f.data), comp = await pipe(f.data, new CompressionStream("deflate-raw"));
    const h = new DataView(new ArrayBuffer(30));
    h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint16(6, 0x0800, true); h.setUint16(8, 8, true);
    h.setUint32(14, crc, true); h.setUint32(18, comp.length, true); h.setUint32(22, f.data.length, true); h.setUint16(26, nm.length, true);
    parts.push(new Uint8Array(h.buffer), nm, comp);
    const c = new DataView(new ArrayBuffer(46));
    c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true); c.setUint16(10, 8, true);
    c.setUint32(16, crc, true); c.setUint32(20, comp.length, true); c.setUint32(24, f.data.length, true); c.setUint16(28, nm.length, true); c.setUint32(42, off, true);
    cen.push(new Uint8Array(c.buffer), nm);
    off += 30 + nm.length + comp.length;
  }
  const cs = cen.reduce((a, b) => a + b.length, 0), end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true); end.setUint16(8, files.length, true); end.setUint16(10, files.length, true);
  end.setUint32(12, cs, true); end.setUint32(16, off, true);
  return new Blob([...parts, ...cen, new Uint8Array(end.buffer)], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
}

const colNum = s => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const colStr = n => { let s = ""; while (n > 0) { const m = (n - 1) % 26; s = String.fromCharCode(65 + m) + s; n = Math.floor((n - 1) / 26); } return s; };
const parseRef = r => { const m = /^([A-Z]+)(\d+)$/.exec(r); return { c: colNum(m[1]), r: +m[2] }; };
const esc = s => String(s).replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// 공유 수식(t="shared")을 각 셀의 일반 수식으로 풀어 둔다 → 기준 셀을 덮어써도 깨지지 않음
const CELL_RE = /<c r="([A-Z]+\d+)"([^>]*?)(\/>|>(.*?)<\/c>)/g;
function expandShared(xml) {
  const masters = {};
  for (const m of xml.matchAll(CELL_RE)) {
    const fm = m[4] && /<f t="shared" ref="[^"]+" si="(\d+)"[^>]*>([^<]*)<\/f>/.exec(m[4]);
    if (fm) masters[fm[1]] = { at: parseRef(m[1]), f: fm[2] };
  }
  if (!Object.keys(masters).length) return xml;
  const shift = (f, dc, dr) => f.replace(/("[^"]*")|(\$?)([A-Z]{1,3})(\$?)(\d+)(?![\d(A-Za-z_])/g, (m, str, ca, col, ra, row) => {
    if (str) return str;
    return ca + (ca ? col : colStr(colNum(col) + dc)) + ra + (ra ? row : String(+row + dr));
  });
  return xml.replace(CELL_RE, (m, ref, attrs, tail, inner) => {
    if (!inner || inner.indexOf('t="shared"') < 0) return m;
    const p = parseRef(ref);
    const ni = inner.replace(/<f t="shared"(?: ref="[^"]+")? si="(\d+)"[^>]*?(?:\/>|>[^<]*<\/f>)/, (fm, si) => {
      const ms = masters[si]; return ms ? "<f>" + shift(ms.f, p.c - ms.at.c, p.r - ms.at.r) + "</f>" : fm;
    });
    return '<c r="' + ref + '"' + attrs + ">" + ni + "</c>";
  });
}

function cellXml(ref, s, v) {
  const sa = s ? ' s="' + s + '"' : "";
  if (v === null || v === undefined || v === "") return '<c r="' + ref + '"' + sa + "/>";
  if (v instanceof Date) v = (v.getTime() - Date.UTC(1899, 11, 30)) / 86400000;
  if (typeof v === "number" && isFinite(v)) return '<c r="' + ref + '"' + sa + "><v>" + v + "</v></c>";
  return '<c r="' + ref + '"' + sa + ' t="inlineStr"><is><t xml:space="preserve">' + esc(v) + "</t></is></c>";
}

function fillRow(rn, open, body, items) {
  for (const it of items) {
    let done = false;
    body = body.replace(CELL_RE, (m, ref, attrs) => {
      if (ref !== it.ref) return m;
      done = true; return cellXml(ref, (attrs.match(/\ss="(\d+)"/) || [])[1], it.v);
    });
    if (!done) {
      const after = [...body.matchAll(/<c r="([A-Z]+)\d+"/g)].find(m => colNum(m[1]) > it.c);
      const x = cellXml(it.ref, null, it.v);
      body = after ? body.slice(0, after.index) + x + body.slice(after.index) : body + x;
    }
  }
  return open.replace(/\sspans="[^"]*"/, "") + body + "</row>";
}
function setCells(xml, cells) {
  const byRow = {};
  for (const [ref, v] of Object.entries(cells)) { const p = parseRef(ref); (byRow[p.r] = byRow[p.r] || []).push({ ref, c: p.c, v }); }
  xml = xml.replace(/<row r="(\d+)"([^>]*?)(\/>|>(.*?)<\/row>)/g, (m, rn, attrs, tail, body) => {
    const items = byRow[rn]; if (!items) return m;
    delete byRow[rn];
    return fillRow(rn, '<row r="' + rn + '"' + attrs + ">", body || "", items);
  });
  for (const rn of Object.keys(byRow).sort((a, b) => a - b)) {
    const nr = fillRow(rn, '<row r="' + rn + '">', "", byRow[rn]);
    const after = [...xml.matchAll(/<row r="(\d+)"/g)].find(m => +m[1] > +rn);
    xml = after ? xml.slice(0, after.index) + nr + xml.slice(after.index)
      : xml.includes("<sheetData/>") ? xml.replace("<sheetData/>", "<sheetData>" + nr + "</sheetData>") : xml.replace("</sheetData>", nr + "</sheetData>");
  }
  return xml;
}

export async function fillXlsx(ab, cells, opt = {}) {
  const files = await unzip(ab);
  const get = n => files.find(f => f.name === n), txt = n => dec.decode(get(n).data), put = (n, s) => { get(n).data = enc.encode(s); };
  const sheet = "xl/worksheets/sheet1.xml";
  put(sheet, setCells(expandShared(txt(sheet)), cells));
  // 계산 체인 제거 + 열 때 다시 계산
  const ci = files.findIndex(f => f.name === "xl/calcChain.xml");
  if (ci >= 0) {
    files.splice(ci, 1);
    put("[Content_Types].xml", txt("[Content_Types].xml").replace(/<Override[^>]*calcChain[^>]*\/>/g, ""));
    put("xl/_rels/workbook.xml.rels", txt("xl/_rels/workbook.xml.rels").replace(/<Relationship[^>]*calcChain[^>]*\/>/g, ""));
  }
  let wb = txt("xl/workbook.xml");
  wb = wb.replace(/<calcPr([^>]*?)\/>/, (m, a) => "<calcPr" + a.replace(/\sfullCalcOnLoad="[^"]*"/, "") + ' fullCalcOnLoad="1"/>');
  if (opt.sheetName) {
    const old = (wb.match(/<sheet name="([^"]*)"/) || [])[1];
    const nn = esc(opt.sheetName);
    if (old != null && old !== nn) {
      wb = wb.replace('<sheet name="' + old + '"', '<sheet name="' + nn + '"')
        .split("'" + old.replace(/'/g, "''") + "'!").join("'" + nn.replace(/'/g, "''") + "'!");
      const app = get("docProps/app.xml");
      if (app) put("docProps/app.xml", txt("docProps/app.xml").split(">" + old + "<").join(">" + nn + "<"));
    }
  }
  put("xl/workbook.xml", wb);
  return zip(files);
}
