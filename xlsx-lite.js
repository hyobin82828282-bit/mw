// 브라우저에서 .xlsx를 직접 읽는 최소 파서 (외부 라이브러리 없음)
const dec = new TextDecoder();

async function unzip(arrayBuffer) {
  const buf = new Uint8Array(arrayBuffer);
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) { if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; } }
  if (eocd < 0) throw new Error("xlsx 형식이 아닙니다");
  const n = dv.getUint16(eocd + 10, true);
  let off = dv.getUint32(eocd + 16, true);
  const out = {};
  for (let k = 0; k < n; k++) {
    const method = dv.getUint16(off + 10, true);
    const csize = dv.getUint32(off + 20, true);
    const nameLen = dv.getUint16(off + 28, true), extraLen = dv.getUint16(off + 30, true), cmtLen = dv.getUint16(off + 32, true);
    const lho = dv.getUint32(off + 42, true);
    const name = dec.decode(buf.subarray(off + 46, off + 46 + nameLen));
    const lName = dv.getUint16(lho + 26, true), lExtra = dv.getUint16(lho + 28, true);
    const start = lho + 30 + lName + lExtra;
    const raw = buf.subarray(start, start + csize);
    let bytes;
    if (method === 0) bytes = raw;
    else bytes = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"))).arrayBuffer());
    out[name] = dec.decode(bytes);
    off += 46 + nameLen + extraLen + cmtLen;
  }
  return out;
}

const unesc = s => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&");

function sharedStrings(zip) {
  const xml = zip["xl/sharedStrings.xml"] || "";
  const out = [];
  const re = /<si>([\s\S]*?)<\/si>/g;
  let m;
  while ((m = re.exec(xml))) out.push(unesc([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map(a => a[1]).join("")));
  return out;
}

const colIdx = letters => { let n = 0; for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64); return n - 1; };

function sheetRows(xml, shared) {
  const map = {};
  const re = /<c r="([A-Z]+)(\d+)"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
  let m, maxCol = 0;
  while ((m = re.exec(xml))) {
    const ci = colIdx(m[1]), r = +m[2], attrs = m[3] || "", inner = m[4] || "";
    const t = (attrs.match(/t="([^"]+)"/) || [])[1];
    let v = "";
    if (t === "inlineStr") v = unesc((inner.match(/<t[^>]*>([\s\S]*?)<\/t>/) || [])[1] || "");
    else {
      const vm = inner.match(/<v>([\s\S]*?)<\/v>/);
      v = vm ? vm[1] : "";
      if (t === "s") v = shared[+v] ?? "";
      else v = unesc(String(v));
    }
    (map[r] = map[r] || [])[ci] = v;
    if (ci > maxCol) maxCol = ci;
  }
  return Object.keys(map).map(Number).sort((a, b) => a - b).map(r => {
    const row = map[r];
    for (let i = 0; i <= maxCol; i++) if (row[i] === undefined) row[i] = "";
    return row;
  });
}

export async function readXlsx(arrayBuffer) {
  const zip = await unzip(arrayBuffer);
  const shared = sharedStrings(zip);
  const rels = {};
  for (const m of (zip["xl/_rels/workbook.xml.rels"] || "").matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) rels[m[1]] = m[2].replace(/^\/?xl\//, "").replace(/^\//, "");
  const sheets = [];
  for (const m of (zip["xl/workbook.xml"] || "").matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"[^>]*\/>/g)) {
    const path = "xl/" + (rels[m[2]] || "");
    if (zip[path]) sheets.push({ name: unesc(m[1]), rows: sheetRows(zip[path], shared) });
  }
  if (!sheets.length) for (const k of Object.keys(zip)) if (/^xl\/worksheets\/sheet\d+\.xml$/.test(k)) sheets.push({ name: k, rows: sheetRows(zip[k], shared) });
  return sheets;
}

// 엑셀 날짜(시리얼 또는 문자열) → YYYY-MM-DD
export function toDate(v) {
  const s = String(v ?? "").trim();
  if (!s) return "";
  const iso = s.match(/^(\d{4})[-.\/](\d{1,2})[-.\/](\d{1,2})/);
  if (iso) return iso[1] + "-" + String(+iso[2]).padStart(2, "0") + "-" + String(+iso[3]).padStart(2, "0");
  const n = Number(s);
  if (!isNaN(n) && n > 20000 && n < 90000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Math.round(n) * 86400000);
    return d.toISOString().slice(0, 10);
  }
  return "";
}
