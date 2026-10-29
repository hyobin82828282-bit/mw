// 백데이터 가져오기 (반품 · 클레임 · 차량출고 · 폐기 · 제주도서) — GitHub hyo@closing-web-app app/src/lib 이식
// window.ClosingImport 로 등록. ClosingEngine 필요.
(function () {
  const E = () => window.ClosingEngine;
  let ITEM_DB = [];
  const CODE_BY_NAME = new Map(); let ITEM_W = {};
  const noSpace = s => String(s).replace(/\s+/g, '');
  const nameKey = n => noSpace(n).replace(/^\[[^\]]*\]/, '').replace(/[*★]+$/g, '');
  const ready = import((window.__resources && window.__resources.itemsDb) || './items-db.js').then(m => {
    ITEM_DB = m.ITEM_DB || [];
    for (const d of ITEM_DB) { if (!CODE_BY_NAME.has(noSpace(d.n))) CODE_BY_NAME.set(noSpace(d.n), d.c); const k = nameKey(d.n); if (!CODE_BY_NAME.has(k)) CODE_BY_NAME.set(k, d.c); }
    ITEM_W = Object.fromEntries(ITEM_DB.filter(d => d.w > 0).map(d => [d.c, Math.round(d.w * 1000)]));
  }).catch(() => {});

  const num = v => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/,/g, '')); return isNaN(n) ? 0 : n; };
  const str = v => (v === null || v === undefined ? '' : String(v).trim());

  function closingMonth(period) { const m = String(period || '').match(/(\d{4})년\s*(\d{1,2})월/); return m ? m[1] + m[2].padStart(2, '0') : null; }
  function decodeText(buf) {
    try { return new TextDecoder('utf-8', { fatal: true }).decode(buf).replace(/^\uFEFF/, ''); }
    catch (e) { return new TextDecoder('euc-kr').decode(buf); }
  }
  function parseCsv(text) {
    const out = []; let row = [], cell = '', q = false;
    for (let i = 0; i < text.length; i++) {
      const ch = text[i];
      if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; }
      else if (ch === '"') q = true;
      else if (ch === ',') { row.push(cell); cell = ''; }
      else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); out.push(row); row = []; cell = ''; }
      else cell += ch;
    }
    if (cell !== '' || row.length) { row.push(cell); out.push(row); }
    return out.filter(r => r.some(c => c.trim() !== ''));
  }

  // ── 반품 ──
  const RETURN_KINDS = ['고객사요청', '고객반품', '쿠팡회송', '주소오류반송'];
  const RETURNS_COLS = { waybill: '원송장번호', name: '고객명', code: '품목코드', product: '품명', kind: '구분', amount: '금액' };
  const codeFor = product => { const n = product.split(' / ')[0]; return CODE_BY_NAME.get(noSpace(n)) || CODE_BY_NAME.get(nameKey(n)) || ''; };
  function returnGroups(lines, ym) {
    return lines.map((l, i) => {
      const k = noSpace(l.kind), flags = [];
      if (!k) flags.push('구분 없음'); else if (!RETURN_KINDS.includes(k)) flags.push('청구 대상 아닌 구분');
      if (k === '쿠팡회송') flags.push('우리 작업 잘못이면 제외 · 롯데택배 송장 금액 확인');
      const dm = l.date.match(/^(\d{4})-(\d{2})/);
      const otherMonth = !!(ym && dm && dm[1] + dm[2] !== ym);
      if (otherMonth) flags.push(`다른 달 (${dm[2]}월)`);
      return {
        key: 'r' + i, include: RETURN_KINDS.includes(k) && !otherMonth, flags,
        rows: [{ waybill: l.waybill, name: l.name, code: l.code, product: l.product, kind: l.kind, amount: l.amount }],
        summary: { title: `${l.waybill} · ${l.product}`, sub: [l.kind || '구분 없음', l.date].filter(Boolean).join(' · '), amount: l.amount }
      };
    });
  }
  function returnsFromCsv(text, ym) {
    const rows = parseCsv(text);
    if (rows.length < 2) throw new Error('CSV에 데이터가 없어요');
    const h = rows[0].map(x => noSpace(x));
    const col = (...names) => { for (const n of names) { const i = h.indexOf(n); if (i >= 0) return i; } return -1; };
    const iW = col('원송장번호', '송장번호'), iN = col('고객명'), iC = col('품목코드'), iP = col('품목명', '품명'), iK = col('구분'), iA = col('금액'),
      iFee = col('택배비'), iRet = col('반품택배비'), iD = col('회수요청일', '반품확인일', '접수일');
    if (iW < 0 || iK < 0) throw new Error('반품이력 CSV 형식이 아니에요 (원송장번호·구분 열이 없어요)');
    return returnGroups(rows.slice(1).map(r => {
      const product = str(r[iP]);
      return {
        waybill: str(r[iW]), name: str(r[iN]), code: iC >= 0 && str(r[iC]) ? str(r[iC]) : codeFor(product), product, kind: str(r[iK]),
        amount: iA >= 0 && str(r[iA]) !== '' ? num(r[iA]) : num(r[iFee]) + num(r[iRet]),
        date: iD >= 0 ? str(r[iD]) : ''
      };
    }), ym);
  }

  // ── 클레임 ──
  const CLAIMS_COLS = {
    company: '업체명', recv: '접수일', ship: '출고일', waybill: '송장번호', name: '성함', type: '분류', reason: '클레임 사유',
    missingCode: '품목코드#1', missing: '누락제품', misQty: '수량#1', accidentCode: '품목코드#2', accident: '오포장/사고제품', accQty: '수량#2',
    reship: '재출고/환불', price: '제품금액', delivery: '배송비', material: '부자재'
  };
  const CLAIMS_MERGE_COLS = ['제품금액', '배송비', '부자재', '총 변상액'];
  async function claimsFromXlsx(ab, ym) {
    const wb = await E().Workbook.load(ab);
    const target = ym ? parseInt(ym.slice(4)) + '월 클레임' : '';
    const sh = wb.byName[target] || wb.sheets.find(s => s.name.includes('클레임')) || wb.sheets[0];
    const v = (r, c) => wb.value(sh, E().colName(c + 1) + r);
    const date = x => {
      if (typeof x === 'number') { const d = new Date(Math.round((x - 25569) * 864e5)); return String(d.getUTCMonth() + 1).padStart(2, '0') + '/' + String(d.getUTCDate()).padStart(2, '0'); }
      return str(x);
    };
    const n = x => (x === null || x === '' ? '' : num(x));
    const ACCIDENT = ['파손반송', '파손수령', '배송지연', '송장흐름없음', '분실', '오배송'];
    const out = [];
    for (let r = 2; r <= sh.maxR; r++) {
      if (str(v(r, 0)) === '' && str(v(r, 1)) === '' && str(v(r, 4)) === '') continue;
      const reason = str(v(r, 7)), code = str(v(r, 8));
      out.push({
        days: n(v(r, 0)), mall: str(v(r, 1)), recv: date(v(r, 2)), ship: date(v(r, 3)), waybill: str(v(r, 4)), name: str(v(r, 5)),
        type: str(v(r, 6)), reason,
        missingCode: reason === '누락' ? code : str(v(r, 11)), missing: str(v(r, 12)), misQty: n(v(r, 13)),
        accidentCode: ACCIDENT.includes(reason) ? code : str(v(r, 14)), accident: str(v(r, 15)), accQty: n(v(r, 16)),
        reship: str(v(r, 17)), price: n(v(r, 22)), delivery: n(v(r, 25)), material: n(v(r, 26))
      });
    }
    return out;
  }
  const mmdd = s => { const m = s.match(/(\d{1,2})\s*[/.월-]\s*(\d{1,2})/); return m ? `${m[1].padStart(2, '0')}월 ${m[2].padStart(2, '0')}일` : s; };
  function claimGroups(recs, ym, opts) {
    const groups = [];
    for (const r of recs) { const last = groups[groups.length - 1]; if (last && r.waybill && last[0].waybill === r.waybill) last.push(r); else groups.push([r]); }
    const out = groups.map((g, gi) => {
      const f = g[0], flags = [];
      if (typeof f.days === 'number' && f.days > 14) flags.push(`접수기간 초과 (${f.days}일)`);
      if (!f.type) flags.push('분류 없음');
      const rm = f.recv.match(/^(\d{1,2})/);
      const otherMonth = !!(ym && rm && rm[1].padStart(2, '0') !== ym.slice(4));
      if (otherMonth) flags.push(`다른 달 접수 (${rm[1]}월) · 소급이면 포함`);
      let price = 0, missingDropped = 0;
      for (const r of g) { if (opts.excludeMissingPrice && r.reason === '누락') missingDropped += num(r.price); else price += num(r.price); }
      if (missingDropped) flags.push(`누락 제품가 ${missingDropped.toLocaleString()}원 제외`);
      const delivery = g.reduce((a, r) => a + num(r.delivery), 0), material = g.reduce((a, r) => a + num(r.material), 0);
      const rows = g.map((r, i) => ({
        company: '목우촌', recv: mmdd(r.recv), ship: mmdd(r.ship), waybill: r.waybill, name: r.name, type: r.type, reason: r.reason,
        missingCode: r.missing ? r.missingCode : '', missing: r.missing, misQty: r.missing ? r.misQty : '',
        accidentCode: r.accident ? r.accidentCode : '', accident: r.accident, accQty: r.accident ? r.accQty : '',
        reship: r.reship,
        price: i === 0 && price ? price : '', delivery: i === 0 && delivery ? delivery : '', material: i === 0 && material ? material : ''
      }));
      const products = g.map(r => r.missing || r.accident).filter(Boolean);
      return {
        key: 'c' + gi + ':' + f.waybill, include: flags.every(x => x.startsWith('누락 제품가')), flags, rows,
        summary: {
          title: `${f.waybill} · ${products[0] || ''}${products.length > 1 ? ` 외 ${products.length - 1}종` : ''}`,
          sub: [f.type, f.reason, f.recv && `${f.recv} 접수`].filter(Boolean).join(' · '),
          amount: price + delivery + material
        }
      };
    });
    const k = g => [String(g.rows[0].type), String(g.rows[0].reason)];
    return out.map((g, i) => ({ g, i })).sort((a, b) => {
      const [ta, ra] = k(a.g), [tb, rb] = k(b.g);
      return ta.localeCompare(tb, 'ko') || ra.localeCompare(rb, 'ko') || a.i - b.i;
    }).map(x => x.g);
  }

  // ── 시트에 쓰기 ──
  function applyTable(wb, sheetName, cols, groups, opts) {
    const En = E(), sh = wb.byName[sheetName];
    if (!sh) throw new Error(`'${sheetName}' 시트가 없어요`);
    let hr = 0;
    for (let r = 1; r <= 10 && !hr; r++) for (let c = 1; c <= sh.maxC; c++) if (noSpace(wb.display(sh, En.colName(c) + r)) === noSpace(opts.anchor)) { hr = r; break; }
    if (!hr) throw new Error(`'${sheetName}' 시트에서 '${opts.anchor}' 머리글을 찾지 못했어요`);
    const colOf = {}, seen = {};
    for (let c = 1; c <= sh.maxC; c++) {
      const h = noSpace(wb.display(sh, En.colName(c) + hr)); if (!h) continue;
      seen[h] = (seen[h] || 0) + 1; colOf[h + '#' + seen[h]] = c; if (seen[h] === 1) colOf[h] = c;
    }
    const colFor = header => colOf[noSpace(header)];
    let tr = 0;
    const totalRe = opts.total || /^\s*합\s*계/; // 제주도서는 '제주추가운임비 합계 금액 …'
    for (let r = hr + 1; r <= sh.maxR && !tr; r++) if (totalRe.test(wb.display(sh, 'A' + r)) || totalRe.test(wb.display(sh, 'B' + r))) tr = r; // A (반품·클레임…) or B (재고실사)
    if (!tr) throw new Error(`'${sheetName}' 시트에서 합계 행을 찾지 못했어요`);
    const first = hr + 1, last = tr - 1, slots = last - first + 1;
    const rows = groups.filter(g => g.include).flatMap(g => g.rows);
    if (rows.length > slots) throw new Error(`'${sheetName}' 시트의 입력 행은 ${slots}개인데 ${rows.length}행이 필요해요. 엑셀에서 합계 행 위에 행을 추가한 파일을 열어 주세요.`);
    const targets = Object.entries(cols).map(([id, header]) => ({ id, c: colFor(header), force: !!(opts.overwrite && opts.overwrite.includes(id)) })).filter(t => t.c);
    const set = (ref, v, force) => {
      const cell = sh.cells[ref];
      if (cell && cell.f && !cell.fAdded && !force) return;
      if (!cell && v === '') return;
      if (cell && !cell.f && (cell.v ?? '') === v) return;
      if (cell && cell.f && typeof v === 'string' && v === '=' + cell.f) return;
      wb.setCell(sheetName, ref, typeof v === 'number' ? v : String(v), force);
    };
    for (let r = first; r <= last; r++) {
      const row = rows[r - first];
      for (const t of targets) { const fill = opts.fill && opts.fill[t.id]; set(En.colName(t.c) + r, row ? row[t.id] ?? '' : fill ?? '', t.force); }
    }
    const written = new Set(targets.filter(t => t.force).map(t => t.c));
    for (let c = 1; c <= sh.maxC; c++) {
      if (written.has(c)) continue;
      const col = En.colName(c), count = {};
      for (let r = first; r <= last; r++) { const cl = sh.cells[col + r]; const f = cl && cl.f; if (f) { const k = En.shiftFormula(f, 0, first - r); count[k] = (count[k] || 0) + 1; } }
      const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
      if (!best || best[1] < slots / 2) continue;
      for (let r = first; r <= last; r++) {
        const cell = sh.cells[col + r], want = En.shiftFormula(best[0], 0, r - first);
        if (cell && cell.f === want) continue;
        if (cell && !cell.f && cell.v !== undefined && cell.v !== '') continue;
        wb.setCell(sheetName, col + r, '=' + want, true);
      }
    }
    const merges = sh.merges.filter(m => m.r2 < first || m.r1 > last);
    if (opts.mergeCols) {
      const mc = opts.mergeCols.map(colFor).filter(Boolean);
      let r = first;
      for (const g of groups.filter(x => x.include)) {
        if (g.rows.length > 1) for (const c of mc) merges.push({ c1: c, r1: r, c2: c, r2: r + g.rows.length - 1 });
        r += g.rows.length;
      }
    }
    if (merges.length !== sh.merges.length || opts.mergeCols) wb.setMerges(sheetName, merges);
    return { rows: rows.length, slots, merges };
  }

  // ── 차량출고 ──
  const P = { wrap: 1650, plt_fee: 2750, box_fee: 165, palletize: 165, mov_slip: 3300 };
  const vnum = v => { const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[,원\s]/g, '')); return isNaN(n) ? 0 : n; };
  function vehicleFromCsv(buf) {
    const rows = parseCsv(decodeText(buf));
    const h = rows[0].map(x => x.replace(/\s+/g, ''));
    const at = (...n) => { for (const x of n) { const i = h.indexOf(x); if (i >= 0) return i; } return -1; };
    const ix = { info: at('출고정보'), name: at('품명'), qty: at('수량'), box: at('BOX', 'BOX수량'), plt: at('PLT'), box_total: at('박스비'), ice_total: at('냉매제'), other_total: at('기타부자재'), work_all: at('작업비합계', '작업비'), mov_total: at('파렛트이동'), total: at('총합계'), closed: at('마감'), car: at('차량', '차량비'), note: at('비고'), pal: at('파렛타이징') };
    if (ix.info < 0 || ix.name < 0) throw new Error('차량출고목록 CSV가 아니에요 (출고정보·품명 열이 없어요)');
    const c = (r, i) => (i >= 0 ? String(r[i] ?? '').trim() : '');
    return rows.slice(1).map(r => ({
      info: c(r, ix.info), name: c(r, ix.name), qty: vnum(c(r, ix.qty)), box: vnum(c(r, ix.box)), plt: vnum(c(r, ix.plt)),
      box_total: vnum(c(r, ix.box_total)), ice_total: vnum(c(r, ix.ice_total)), other_total: vnum(c(r, ix.other_total)),
      work_all: vnum(c(r, ix.work_all)), mov_total: vnum(c(r, ix.mov_total)), total: vnum(c(r, ix.total)),
      car: ix.car >= 0 && c(r, ix.car) !== '' ? vnum(c(r, ix.car)) : undefined, closed: c(r, ix.closed) === '반영', note: c(r, ix.note), pal: c(r, ix.pal) === '포함'
    })).filter(x => x.info || x.name);
  }
  const VEHICLE_COLS = {
    info: '출고정보', name: '품명', qty: '수량', box: 'BOX', plt: 'P/T', boxcar: '박스상차',
    iceM: '아이스팩(중)', iceL: '아이스팩(대)', dry: '드라이', pcm: 'PCM',
    boxUnit: '박스 단가', iceMUnit: '아이스팩(중) 단가', iceLUnit: '아이스팩(대) 단가', dryUnit: '드라이아이스 단가', pcmUnit: 'pcm 단가', otherUnit: '기타부자재 단가',
    wrap: '래핑비용', ship: '출고비', palletize: '파렛타이징', work: '작업비', movUnit: '파렛트 이동전표 단가',
    boxTotal: '박스비 합계', iceTotal: '냉매제 합계', otherTotal: '기타부자재 합계', workTotal: '작업비 합계', movTotal: '파렛트 이동합계', car: '차량', note: '비고'
  };
  const VEHICLE_OVERWRITE = ['iceTotal', 'workTotal', 'movTotal'];
  const monthOf = info => { const m = info.match(/^\s*(\d{1,2})\s*\/\s*(\d{1,2})/); return m ? { m: +m[1], d: +m[2] } : null; };
  const itemName = r => { const names = r.items && r.items.length ? r.items.map(i => i.name).filter(Boolean) : r.name.split(' / '); return names.length > 1 ? `${names[0]} 외 ${names.length - 1}종` : names[0] || r.name; };
  function vehicleGroups(recs, ym) {
    const month = ym ? parseInt(ym.slice(4)) : null;
    return recs.map((r, i) => ({ r, i, md: monthOf(r.info) }))
      .sort((a, b) => (((a.md && a.md.m) ?? 99) - ((b.md && b.md.m) ?? 99)) || (((a.md && a.md.d) ?? 99) - ((b.md && b.md.d) ?? 99)) || a.i - b.i)
      .map(({ r, i, md }) => {
        const plt = r.plt || 0, box = r.box || 0;
        const fixed = plt ? plt * (P.plt_fee + P.wrap) + (r.pal ? box * P.palletize : 0) : box * (P.box_fee + P.palletize);
        const workUnit = box ? Math.round(((r.work_all - fixed) / box) * 100) / 100 : 0;
        const car = r.car ?? Math.max(0, r.total - (r.box_total + r.ice_total + r.other_total + r.work_all + r.mov_total));
        const sheetWork = plt ? plt * (P.wrap + P.plt_fee) + box * (P.palletize + workUnit) : box * (P.box_fee + P.palletize + workUnit);
        const sheetTotal = r.box_total + r.ice_total + r.other_total + sheetWork + (plt ? plt * P.mov_slip : 0) + car;
        const flags = [];
        const otherMonth = !!(month && md && md.m !== month);
        if (otherMonth) flags.push(`다른 달 (${md.m}월)`);
        if (!md) flags.push('출고정보에 날짜 없음');
        if (workUnit < 0) flags.push('작업비를 나눌 수 없어요 · 시트에서 확인');
        if (Math.abs(sheetTotal - r.total) >= 1) flags.push(`행사쓰 ${r.total.toLocaleString()}원 → 마감 시트 ${Math.round(sheetTotal).toLocaleString()}원${plt && box && !r.pal ? ' (수정 전 행사쓰 계산 · PLT 파렛타이징 165원×박스 추가)' : ''}`);
        const e = v => (v ? v : '');
        return {
          key: 'v' + i, include: !otherMonth && !!md && workUnit >= 0, flags,
          rows: [{
            info: r.info, name: itemName(r), qty: e(r.qty), box: e(box), plt: e(plt), boxcar: plt ? '' : e(box),
            iceM: '', iceL: '', dry: '', pcm: '', boxUnit: '', iceMUnit: '', iceLUnit: '', dryUnit: '', pcmUnit: '', otherUnit: '',
            wrap: plt ? P.wrap : '', ship: plt ? P.plt_fee : P.box_fee, palletize: P.palletize, work: workUnit > 0 ? workUnit : '', movUnit: plt ? P.mov_slip : '',
            boxTotal: e(r.box_total), iceTotal: e(r.ice_total), otherTotal: e(r.other_total), car: e(car), note: r.note, workTotal: '', movTotal: ''
          }],
          summary: { title: r.info, sub: `${itemName(r)} · ${plt ? `${plt}PLT · ` : ''}${box.toLocaleString()}박스${r.closed ? ' · 행사쓰 마감반영' : ''}`, amount: Math.round(sheetTotal) }
        };
      });
  }
  function withRowFormulas(groups, firstRow) {
    let r = firstRow;
    return groups.map(g => {
      if (!g.include) return g;
      const row = Object.assign({}, g.rows[0]), n = r++;
      if (typeof row.workTotal === 'number') return g;
      row.workTotal = row.plt ? `=R${n}*F${n}+S${n}*F${n}+T${n}*E${n}+U${n}*E${n}` : `=S${n}*E${n}+T${n}*E${n}+U${n}*E${n}`;
      row.movTotal = row.plt ? `=V${n}*F${n}` : '';
      return Object.assign({}, g, { rows: [row] });
    });
  }
  const XLSX_COLS = [
    ['info', '출고정보'], ['name', '품명'], ['qty', '수량'], ['box', 'BOX'], ['plt', 'P/T'], ['boxcar', '박스상차'],
    ['iceM', '아이스팩(중)'], ['iceL', '아이스팩(대)'], ['dry', '드라이'], ['pcm', 'PCM'],
    ['boxUnit', '박스단가'], ['iceMUnit', '아이스팩(중)단가'], ['iceLUnit', '아이스팩(대)단가'], ['dryUnit', '드라이아이스단가'], ['pcmUnit', 'pcm단가'], ['otherUnit', '기타부자재단가'],
    ['wrap', '래핑비용'], ['ship', '출고비'], ['palletize', '파렛타이징'], ['work', '작업비(단가)'], ['movUnit', '파렛트이동전표단가'],
    ['boxTotal', '박스비합계'], ['iceTotal', '냉매제합계'], ['otherTotal', '기타부자재합계'], ['workTotal', '작업비합계'], ['movTotal', '파렛트이동합계'],
    ['car', '차량'], ['note', '비고'], ['closed', '마감반영']
  ];
  async function vehicleGroupsFromXlsx(buf, ym) {
    const En = E(), wb = await En.Workbook.load(buf);
    const sh = wb.byName['차량출고'] || wb.sheets.find(s => s.name.includes('차량출고'));
    if (!sh) throw new Error("엑셀에 '차량출고' 시트가 없어요");
    const ns = v => String(v ?? '').replace(/\s+/g, '');
    let hr = 0;
    for (let r = 1; r <= 6 && !hr; r++) for (let c = 1; c <= sh.maxC; c++) if (ns(wb.value(sh, En.colName(c) + r)) === '출고정보') { hr = r; break; }
    if (!hr) throw new Error("차량출고 시트에서 '출고정보' 머리글을 찾지 못했어요");
    const heads = []; for (let c = 1; c <= sh.maxC; c++) heads[c] = ns(wb.value(sh, En.colName(c) + hr));
    const col = {};
    for (const [id, h] of XLSX_COLS) { const want = h.replace(/\s+/g, ''); const ex = heads.findIndex(x => x === want); const c = ex > 0 ? ex : heads.findIndex(x => !!x && x.startsWith(want)); if (c > 0) col[id] = c; }
    const month = ym ? parseInt(ym.slice(4)) : null;
    const out = [];
    for (let r = hr + 1; r <= sh.maxR; r++) {
      const get = id => (col[id] ? wb.value(sh, En.colName(col[id]) + r) : null);
      const info = String(get('info') ?? '').trim(); if (!info) continue;
      const md = monthOf(info), row = {};
      for (const [id] of XLSX_COLS) {
        if (id === 'closed') continue;
        const v = get(id);
        row[id] = typeof v === 'number' ? (v === 0 ? '' : v) : v && typeof v === 'object' ? '' : String(v ?? '').trim();
      }
      const n = id => (typeof row[id] === 'number' ? row[id] : 0);
      const amount = n('boxTotal') + n('iceTotal') + n('otherTotal') + n('workTotal') + n('movTotal') + n('car');
      const otherMonth = !!(month && md && md.m !== month);
      const flags = [];
      if (otherMonth) flags.push(`다른 달 (${md.m}월)`);
      if (!md) flags.push('출고정보에 날짜 없음');
      const closed = get('closed');
      out.push({
        key: 'x' + r, include: !otherMonth && !!md, flags, rows: [row],
        summary: { title: info, sub: `${row.name} · ${n('plt') ? `${n('plt')}PLT · ` : ''}${n('box').toLocaleString()}박스${closed === true || closed === 'TRUE' ? ' · 마감반영' : ''}`, amount: Math.round(amount) }
      });
    }
    return out;
  }

  // ── 폐기 ──
  const DISPOSAL_STATES = ['불용(임박)', '불용(불량)'];
  const DISPOSAL_COLS = { month: '청구일', center: '센터', company: '업체명', name: '품목명', weight: '개별중량(g)', qty: '폐기수량', price: '단가(원/kg)' };
  function weightFromName(name) {
    let tot = 0, found = false;
    for (const m of name.matchAll(/(\d+(?:\.\d+)?)\s*(kg|g)(?:\s*[x*×]\s*(\d+))?/gi)) { tot += parseFloat(m[1]) * (m[2].toLowerCase() === 'kg' ? 1000 : 1) * (m[3] ? parseInt(m[3]) : 1); found = true; }
    return found ? Math.round(tot) : null;
  }
  const W_KEY = 'closing.v1.disposalWeights';
  function loadWeights() { try { return JSON.parse(localStorage.getItem(W_KEY) || '{}'); } catch (e) { return {}; } }
  function saveWeights(w) { try { localStorage.setItem(W_KEY, JSON.stringify(w)); } catch (e) {} }
  function fromGrid(get, maxR, maxC) {
    for (let hr = 1; hr <= 5; hr++) {
      const idx = {};
      for (let c = 1; c <= maxC; c++) {
        const h = noSpace(String(get(hr, c) ?? ''));
        if (h === '품목코드' && !idx.code) idx.code = c;
        if (h === '품목명' && !idx.name) idx.name = c;
        if (h === '재고상태' && !idx.state) idx.state = c;
        if (h === '재고수량' && !idx.qty) idx.qty = c;
      }
      if (!(idx.name && idx.state && idx.qty)) continue;
      const out = [];
      for (let r = hr + 1; r <= maxR; r++) {
        const name = String(get(r, idx.name) ?? '').trim(); if (!name) continue;
        const q = get(r, idx.qty);
        out.push({ code: idx.code ? String(get(r, idx.code) ?? '').trim() : '', name, state: noSpace(String(get(r, idx.state) ?? '')), qty: typeof q === 'number' ? q : parseFloat(String(q ?? '').replace(/,/g, '')) || 0 });
      }
      return out;
    }
    return null;
  }
  async function readDisposal(buf, fileName) {
    if (/\.csv$/i.test(fileName)) {
      const rows = parseCsv(decodeText(buf));
      const got = fromGrid((r, c) => (rows[r - 1] && rows[r - 1][c - 1]) ?? '', rows.length, Math.max(...rows.map(x => x.length)));
      if (got) return got;
    } else {
      const En = E(), wb = await En.Workbook.load(buf);
      const order = [...wb.sheets].sort((a, b) => (b.name === '폐기대상' ? 1 : 0) - (a.name === '폐기대상' ? 1 : 0));
      for (const sh of order) { const got = fromGrid((r, c) => wb.value(sh, En.colName(c) + r), sh.maxR, sh.maxC); if (got && got.length) return got; }
    }
    throw new Error('파일에서 품목명·재고상태·재고수량 머리글을 찾지 못했어요 (재고실사 파일의 폐기대상 시트)');
  }
  function disposalItems(lines, userW) {
    const by = new Map();
    for (const l of lines) {
      const k = (l.code || l.name) + '|' + l.state, e = by.get(k);
      if (e) { e.qty += l.qty; continue; }
      const fromName = weightFromName(l.name), fromItems = ITEM_W[l.code], user = userW[l.code || l.name];
      by.set(k, {
        key: k, code: l.code, name: l.name, state: l.state, qty: l.qty, include: DISPOSAL_STATES.includes(l.state),
        weight: user ?? fromName ?? fromItems ?? null, weightFrom: user ? 'user' : fromName != null ? 'name' : fromItems ? 'items' : null
      });
    }
    return [...by.values()].sort((a, b) => Number(b.include) - Number(a.include));
  }
  function disposalGroups(wb, items, ym) {
    const sh = wb.byName['폐기'], pv = sh ? wb.value(sh, 'J2') : null, price = typeof pv === 'number' ? pv : 350;
    const month = ym ? `${parseInt(ym.slice(4))}월` : '';
    return items.map(it => ({
      key: it.key, include: it.include && it.weight != null, flags: [],
      rows: [{ month, center: '오산센터', company: '목우촌', name: it.name, weight: it.weight ?? '', qty: it.qty, price }],
      summary: { title: it.name, sub: it.state, amount: it.weight ? Math.ceil((it.qty * it.weight) / 1000) * price : 0 }
    }));
  }

  // ── 누적 ──
  const sk = fileName => 'closing.v1.imports.' + fileName;
  function load(fileName) { try { return Object.assign({ tables: {}, ship: {} }, JSON.parse(localStorage.getItem(sk(fileName)) || '{}')); } catch (e) { return { tables: {}, ship: {} }; } }
  function save(fileName, s) { try { localStorage.setItem(sk(fileName), JSON.stringify(s)); } catch (e) {} }
  const s = v => String(v ?? '').replace(/\s+/g, '');
  const RECORD_KEY = {
    반품: g => `${s(g.rows[0].waybill)}|${s(g.rows[0].product)}`,
    클레임: g => `${s(g.rows[0].waybill)}|${s(g.rows[0].type)}|${s(g.rows[0].reason)}|${g.rows.map(r => s(r.missing || r.accident)).join('+')}`,
    차량출고: g => `${s(g.rows[0].info)}|${s(g.rows[0].name)}`,
    폐기: g => `${s(g.rows[0].name)}`,
    재고실사: g => `${s(g.rows[0].code)}`,
    제주도서: g => `${s(g.rows[0].waybill)}`
  };
  function keyed(sheet, groups) {
    const seen = {};
    return groups.map(g => { const k = RECORD_KEY[sheet](g); const n = (seen[k] = (seen[k] || 0) + 1); return Object.assign({}, g, { key: n > 1 ? `${k}#${n}` : k }); });
  }
  function planTable(fileName, sheet, ym, groups) {
    const prev = load(fileName).tables[sheet], next = keyed(sheet, groups);
    if (!prev || prev.ym !== (ym || '')) return { merged: next, kept: 0, replaced: 0, added: next.length, fresh: true };
    const nextKeys = new Set(next.map(g => g.key));
    const kept = prev.groups.filter(g => !nextKeys.has(g.key));
    const prevKeys = new Set(prev.groups.map(g => g.key));
    const replaced = next.filter(g => prevKeys.has(g.key)).length;
    return { merged: [...kept, ...next], kept: kept.length, replaced, added: next.length - replaced, fresh: false };
  }
  function saveTable(fileName, sheet, ym, merged) { const st = load(fileName); st.tables[sheet] = { ym: ym || '', groups: merged }; save(fileName, st); }
  function clearSheet(fileName, sheet) { const st = load(fileName); delete st.tables[sheet]; delete st.ship[sheet]; save(fileName, st); }

  // ── 비밀번호 걸린 엑셀 ──
  const isEncryptedOffice = buf => { const b = new Uint8Array(buf, 0, Math.min(8, buf.byteLength)); return b.length === 8 && b[0] === 0xd0 && b[1] === 0xcf && b[2] === 0x11 && b[3] === 0xe0 && b[4] === 0xa1 && b[5] === 0xb1 && b[6] === 0x1a && b[7] === 0xe1; };
  class WrongPasswordError extends Error { constructor() { super('비밀번호가 맞지 않아요'); this.wrongPassword = true; } }
  function readCfb(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    const secSize = 1 << dv.getUint16(30, true), miniSize = 1 << dv.getUint16(32, true);
    const nFat = dv.getUint32(44, true), dirStart = dv.getUint32(48, true), miniCutoff = dv.getUint32(56, true);
    const miniFatStart = dv.getUint32(60, true), difStart = dv.getUint32(68, true), nDif = dv.getUint32(72, true);
    const secOff = s => (s + 1) * secSize;
    const fatSecs = [];
    for (let i = 0; i < 109 && fatSecs.length < nFat; i++) fatSecs.push(dv.getUint32(76 + i * 4, true));
    for (let d = difStart, k = 0; k < nDif && d < 0xfffffffa; k++) {
      const per = secSize / 4 - 1;
      for (let i = 0; i < per && fatSecs.length < nFat; i++) fatSecs.push(dv.getUint32(secOff(d) + i * 4, true));
      d = dv.getUint32(secOff(d) + per * 4, true);
    }
    const fat = [];
    for (const s of fatSecs) for (let i = 0; i < secSize / 4; i++) fat.push(dv.getUint32(secOff(s) + i * 4, true));
    const chain = (start, next) => { const out = []; for (let s = start; s < 0xfffffffa && out.length <= next.length; s = next[s]) out.push(s); return out; };
    const readChain = start => { const secs = chain(start, fat); const out = new Uint8Array(secs.length * secSize); secs.forEach((s, i) => out.set(u8.subarray(secOff(s), secOff(s) + secSize), i * secSize)); return out; };
    const dir = readChain(dirStart), ddv = new DataView(dir.buffer);
    const entries = [];
    for (let o = 0; o + 128 <= dir.length; o += 128) {
      const nl = ddv.getUint16(o + 64, true);
      const name = nl > 2 ? new TextDecoder('utf-16le').decode(dir.subarray(o, o + nl - 2)) : '';
      entries.push({ name, type: dir[o + 66], start: ddv.getUint32(o + 116, true), size: ddv.getUint32(o + 120, true) });
    }
    const miniStream = readChain(entries[0].start);
    const miniFat = [];
    if (miniFatStart < 0xfffffffa) { const m = readChain(miniFatStart), mdv = new DataView(m.buffer); for (let i = 0; i < m.length / 4; i++) miniFat.push(mdv.getUint32(i * 4, true)); }
    const out = new Map();
    for (const e of entries) {
      if (e.type !== 2) continue;
      if (e.size < miniCutoff) {
        const secs = chain(e.start, miniFat), data = new Uint8Array(secs.length * miniSize);
        secs.forEach((s, i) => data.set(miniStream.subarray(s * miniSize, (s + 1) * miniSize), i * miniSize));
        out.set(e.name, data.subarray(0, e.size));
      } else out.set(e.name, readChain(e.start).subarray(0, e.size));
    }
    return out;
  }
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const cat = (...a) => { const o = new Uint8Array(a.reduce((n, x) => n + x.length, 0)); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
  const le32 = n => { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, n, true); return b; };
  const HASH = { SHA512: 'SHA-512', SHA384: 'SHA-384', SHA256: 'SHA-256', SHA1: 'SHA-1' };
  async function hash(alg, data) { return new Uint8Array(await crypto.subtle.digest(alg, data)); }
  const fit = (b, n, pad) => (b.length >= n ? b.subarray(0, n) : cat(b, new Uint8Array(n - b.length).fill(pad)));
  async function aesCbcRaw(key, iv, data) {
    const k = await crypto.subtle.importKey('raw', key, 'AES-CBC', false, ['encrypt', 'decrypt']);
    const last = data.subarray(data.length - 16);
    const padBlock = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-CBC', iv: last }, k, new Uint8Array(16).fill(16))).subarray(0, 16);
    return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, k, cat(data, padBlock)));
  }
  async function decryptOffice(buf, password) {
    const streams = readCfb(buf);
    const info = streams.get('EncryptionInfo'), pkg = streams.get('EncryptedPackage');
    if (!info || !pkg) throw new Error('암호화된 엑셀 파일 형식이 아니에요');
    const ver = new DataView(info.buffer, info.byteOffset).getUint16(0, true);
    if (ver !== 4) throw new Error('지원하지 않는 암호화 방식이에요 (엑셀에서 비밀번호를 풀어 다시 저장해 주세요)');
    const xml = new TextDecoder().decode(info.subarray(8));
    const tag = re => { const m = xml.match(re); if (!m) throw new Error('암호화 정보를 읽지 못했어요'); const at = {}; for (const x of m[0].matchAll(/(\w+)="([^"]*)"/g)) at[x[1]] = x[2]; return n => at[n] ?? null; };
    const kd = tag(/<keyData\b[^>]*>/);
    const pk = tag(/<(?:\w+:)?encryptedKey\b[^>]*spinCount[^>]*>/);
    const pkHash = HASH[pk('hashAlgorithm')], kdHash = HASH[kd('hashAlgorithm')];
    const keyBytes = +pk('keyBits') / 8, blockSize = +kd('blockSize');
    let h = await hash(pkHash, cat(b64(pk('saltValue')), new Uint8Array(new Uint16Array([...password].map(c => c.charCodeAt(0))).buffer)));
    const spin = +pk('spinCount');
    for (let i = 0; i < spin; i++) h = await hash(pkHash, cat(le32(i), h));
    const blockKey = new Uint8Array([0x14, 0x6e, 0x0b, 0xe7, 0xab, 0xac, 0xd0, 0xd6]);
    const pwKey = fit(await hash(pkHash, cat(h, blockKey)), keyBytes, 0x36);
    const secret = (await aesCbcRaw(pwKey, fit(b64(pk('saltValue')), 16, 0x36), b64(pk('encryptedKeyValue')))).subarray(0, +kd('keyBits') / 8);
    const size = Number(new DataView(pkg.buffer, pkg.byteOffset).getBigUint64(0, true));
    const body = pkg.subarray(8), salt = b64(kd('saltValue')), out = new Uint8Array(Math.ceil(body.length / 16) * 16);
    for (let seg = 0, off = 0; off < body.length; seg++, off += 4096) {
      let chunk = body.subarray(off, Math.min(off + 4096, body.length));
      if (chunk.length % 16) chunk = cat(chunk, new Uint8Array(16 - (chunk.length % 16)));
      const iv = fit(await hash(kdHash, cat(salt, le32(seg))), blockSize, 0x36);
      out.set(await aesCbcRaw(secret, iv, chunk), off);
    }
    const plain = out.subarray(0, size);
    if (!(plain[0] === 0x50 && plain[1] === 0x4b)) throw new WrongPasswordError();
    return plain.slice().buffer;
  }

  // ── 쿠팡택배 박스 ──
  const COUPANG_COLS = [['B', '쿠팡 샘플 (극소)'], ['C', '쿠팡 샘플'], ['D', '쿠팡_450g'], ['E', '쿠팡_육포 30~35g'], ['F', '쿠팡_캔햄 1.8kg'], ['G', '쿠팡_육포100g'], ['H', '쿠팡_뚝심'], ['I', '쿠팡_선물세트'], ['J', '쿠팡_700g·850g·펫사료'], ['K', '로켓그로스_사료']];
  const CP_MAP_KEY = 'closing.v1.coupangMap';
  function loadCoupangMap() { try { return JSON.parse(localStorage.getItem(CP_MAP_KEY) || '{}'); } catch (e) { return {}; } }
  function saveCoupangMap(m) { try { localStorage.setItem(CP_MAP_KEY, JSON.stringify(m)); } catch (e) {} }
  let IPSU = null;
  const ipsuOf = code => { if (!IPSU) { IPSU = new Map(); for (const d of ITEM_DB) if (d.i) IPSU.set(String(d.c), d.i); } return IPSU.get(String(code)) || 0; };
  function coupangCol(name, mall) {
    const n = noSpace(name);
    if (/로켓그로스/.test(mall)) return 'K';
    if (/세트/.test(n)) return 'I';
    if (/캔햄/.test(n)) return 'F';
    if (/뚝심/.test(n)) return 'H';
    if (/육포/.test(n) && /100g/.test(n)) return 'G';
    if (/육포/.test(n) && /(30|35)g/.test(n)) return 'E';
    if (/(700|850)g|펫|사료/.test(n)) return 'J';
    if (/450g|주부9단/.test(n)) return 'D';
    return '';
  }
  async function coupangLines(ab) {
    const wb = await E().Workbook.load(ab), sh = wb.sheets[0];
    const v = (r, c) => wb.value(sh, E().colName(c) + r);
    const h = []; for (let c = 1; c <= sh.maxC; c++) h[c] = noSpace(str(v(1, c)));
    const col = (...ns) => { for (const n of ns) { const i = h.indexOf(n); if (i > 0) return i; } return -1; };
    const iD = col('출고처리일', '출고확정일', '출고요청일'), iQ = col('수량'), iC = col('품목코드'), iN = col('품목명'), iM = col('쇼핑몰명');
    if (iD < 0 || iQ < 0 || iC < 0) throw new Error('WMS 출고현황 형식이 아니에요 (출고처리일·수량·품목코드 열이 없어요)');
    const out = [];
    for (let r = 2; r <= sh.maxR; r++) {
      const code = str(v(r, iC)); if (!code) continue;
      const d = str(v(r, iD)).slice(0, 10), q = num(v(r, iQ));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d) || !q) continue;
      out.push({ date: d, qty: q, code, name: str(v(r, iN)).replace(/[\r\n]+/g, ' ').trim(), mall: iM > 0 ? str(v(r, iM)) : '' });
    }
    return out;
  }
  // 한 줄 = 송장 1개. 박스 = 수량 ÷ 입수, 남는 수량은 쿠팡 샘플(C) 1박스
  function coupangBoxes(lines, ym, map) {
    const days = {}, unassigned = {}, matched = {}, add = (d, c, n) => { (days[d] = days[d] || {})[c] = (days[d][c] || 0) + n; };
    let other = 0, sample = 0, sets = 0; const sampleList = {}, perDay = {};
    for (const l of lines) {
      if (ym && l.date.slice(0, 4) + l.date.slice(5, 7) !== ym) { other++; continue; }
      const m = map[l.code] || {}, c = m.col || coupangCol(l.name, l.mall), ip = +m.ipsu || ipsuOf(l.code);
      if (!c || !ip) { const u = unassigned[l.code] = unassigned[l.code] || { code: l.code, name: l.name, qty: 0, lines: 0, days: new Set(), col: c, ipsu: ip || '' }; u.qty += l.qty; u.lines++; u.days.add(+l.date.slice(8)); continue; }
      const mt = matched[l.code] = matched[l.code] || { code: l.code, name: l.name, qty: 0, lines: 0, days: new Set(), col: c, ipsu: ip, custom: !!map[l.code] }; mt.qty += l.qty; mt.lines++; mt.days.add(+l.date.slice(8));
      // 같은 날 같은 품목이 할당으로 나뉘어 들어오면 합친 뒤 입수로 나눔
      const k = l.date + '|' + l.code + '|' + c;
      (perDay[k] = perDay[k] || { date: l.date, code: l.code, name: l.name, col: c, ip, qty: 0, n: 0 }).qty += l.qty; perDay[k].n++;
    }
    for (const p of Object.values(perDay)) {
      const b = Math.floor(p.qty / p.ip), rem = p.qty % p.ip;
      if (b) add(p.date, p.col, b);
      if (rem) { add(p.date, 'C', 1); sample++; (sampleList[p.code] = sampleList[p.code] || { code: p.code, name: p.name, ipsu: p.ip, hits: [] }).hits.push(`${+p.date.slice(5, 7)}/${+p.date.slice(8)} ${p.qty}개${p.n > 1 ? `(${p.n}줄 합산)` : ''} · 나머지 ${rem}`); }
      if (p.col === 'I') sets++;
    }
    const fix = u => Object.assign(u, { days: [...u.days].sort((a, b) => a - b) });
    return { days, unassigned: Object.values(unassigned).map(fix), matched: Object.values(matched).map(fix).sort((a, b) => a.col.localeCompare(b.col) || b.qty - a.qty), other, sample, sets, sampleList: Object.values(sampleList) };
  }
  const serialDay = s => { const d = new Date(Math.round((s - 25569) * 864e5)); return d.toISOString().slice(0, 10); };
  function applyCoupang(wb, days) {
    const En = E(), sh = wb.byName['쿠팡택배']; if (!sh) throw new Error("'쿠팡택배' 시트가 없어요");
    let rows = 0, filled = 0;
    for (let r = 4; r <= sh.maxR; r++) {
      const a = wb.value(sh, 'A' + r); if (typeof a !== 'number') { if (rows) break; continue; }
      rows++; const has = !!days[serialDay(a)]; if (!has) continue; const d = days[serialDay(a)]; filled++;
      for (const [c] of COUPANG_COLS) {
        const want = d[c] || '', cell = sh.cells[c + r]; if (cell && cell.f) continue;
        if ((cell ? cell.v ?? '' : '') === want) continue;
        wb.setCell('쿠팡택배', c + r, want);
      }
    }
    if (!rows) throw new Error("'쿠팡택배' 시트에서 날짜 행을 찾지 못했어요");
    return { rows, filled };
  }
  const ck = (fileName, ym) => 'closing.v1.coupang.' + fileName + '.' + (ym || '');
  function loadCoupangDays(fileName, ym) { try { return JSON.parse(localStorage.getItem(ck(fileName, ym)) || 'null'); } catch (e) { return null; } }
  function saveCoupangDays(fileName, ym, days) { try { if (days) localStorage.setItem(ck(fileName, ym), JSON.stringify(days)); else localStorage.removeItem(ck(fileName, ym)); } catch (e) {} }

  // ── 홈쇼핑 출고 박스 (GitHub app/src/lib/shipments.ts · shipMaps.ts 이식) ──
  // 수령인 수를 (출고처리일, 쇼핑몰명, 품목코드)별로 세고, 품목코드 + 쇼핑몰명(포함)으로 열을 찾아 날짜 행에 채워요
  const HOMESHOP_MAP = [
    { code: '201991000083', name: '[M냉장]생생우슬삼계탕_냉장 1000g', mall: '', col: 'V' },
    { code: '201991000168', name: '[M상온]목우촌생생쇠고기육포35g', mall: '', col: 'W' },
    { code: '201978000064', name: '[M상온]쇠고기육포 35g', mall: '', col: 'W' },
    { code: '201978000079', name: '[M냉장]생생삼계탕  1kg**', mall: 'CJ', col: 'B' },
    { code: '201991000052', name: '[M냉동]주부9단 바삭(파랑) 치킨텐더 600g(사조)', mall: 'CJ', col: 'E' },
    { code: '202008000064', name: '[M냉동]주부9단 바삭치킨까스 360g', mall: 'CJ', col: 'C' },
    { code: '201991000039', name: '[M냉동]주부9단 팝콘치킨 420g', mall: 'CJ', col: 'C' },
    { code: '201978000081', name: '[M냉장]생생황기닭백숙1000g**', mall: 'CJ', col: 'D' },
    { code: '201991000055', name: '[M상온]생생육포오리지널30g', mall: 'CJ', col: 'P' },
    { code: '202008000006', name: '*공영홈쇼핑[M냉장]생생황기닭백숙1000g** (3EA)', mall: 'NS', col: 'W' },
    { code: '201978000108', name: '[M냉동]교자만두 1kg*', mall: 'NS', col: 'AI' },
    { code: '201978000111', name: '[M냉동]왕만두 910g*', mall: 'NS', col: 'AI' },
    { code: '201978000080', name: '[M냉장]생생녹두삼계탕 1kg**', mall: 'NS', col: 'AD' },
    { code: '201978000079', name: '[M냉장]생생삼계탕  1kg**', mall: 'NS', col: 'AD' },
    { code: '201978000081', name: '[M냉장]생생황기닭백숙1000g**', mall: 'NS', col: 'AD' },
    { code: '201978000041', name: '[M냉장]주부9단 살코기햄 1kg**', mall: 'NS', col: 'AA' },
    { code: '201978000126', name: '[M상온]주부9단 한우 사골곰탕 450g(리뉴얼)', mall: 'NS', col: 'AQ' },
    { code: '201978000133', name: '[M상온]주부9단 한우도가니탕 450g(리뉴얼)', mall: 'NS', col: 'AP' }
  ];
  const SHIP_HEAD = { day: '출고처리일', code: '품목코드', name: '품목명', qty: '수량', mall: '쇼핑몰명', recipient: '수령인', inv: '송장번호', pack: '합포장번호' };
  function toDay(v) {
    if (typeof v === 'number' && v > 1000) return new Date(Math.round((Math.floor(v) - 25569) * 864e5)).toISOString().slice(0, 10);
    const m = String(v ?? '').match(/(\d{4})[-./](\d{1,2})[-./](\d{1,2})/);
    return m ? `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}` : '';
  }
  function shipFromGrid(get, maxR, maxC) {
    for (let hr = 1; hr <= 5; hr++) {
      const idx = {};
      for (let c = 1; c <= maxC; c++) { const h = noSpace(str(get(hr, c))); for (const [k, name] of Object.entries(SHIP_HEAD)) if (h === name && !(k in idx)) idx[k] = c; }
      if (!('day' in idx && 'code' in idx && 'qty' in idx)) continue;
      const out = [];
      for (let r = hr + 1; r <= maxR; r++) {
        const code = str(get(r, idx.code)); if (!code) continue;
        out.push({ day: toDay(get(r, idx.day)), code, name: idx.name ? str(get(r, idx.name)) : '', qty: num(get(r, idx.qty)), mall: idx.mall ? str(get(r, idx.mall)) : '', recipient: idx.recipient ? str(get(r, idx.recipient)) : '', inv: idx.inv ? str(get(r, idx.inv)) : '', pack: idx.pack ? str(get(r, idx.pack)) : '' });
      }
      return out;
    }
    return null;
  }
  async function homeshopLines(buf, fileName) {
    if (/\.csv$/i.test(fileName || '')) {
      const rows = parseCsv(decodeText(buf));
      const got = shipFromGrid((r, c) => (rows[r - 1] || [])[c - 1] ?? '', rows.length, Math.max(0, ...rows.map(x => x.length)));
      if (got) return got;
    } else {
      const En = E(), wb = await En.Workbook.load(buf);
      const order = [...wb.sheets].sort((a, b) => (b.name === '홈쇼핑' ? 1 : 0) - (a.name === '홈쇼핑' ? 1 : 0));
      for (const sh of order) { const got = shipFromGrid((r, c) => wb.value(sh, En.colName(c) + r), sh.maxR, sh.maxC); if (got && got.length) return got; }
    }
    throw new Error('출고현황 파일에서 출고처리일·품목코드·수량 머리글을 찾지 못했어요');
  }
  const HS_RULES_KEY = 'closing.v1.shipRules';
  function loadShipRules() { try { return JSON.parse(localStorage.getItem(HS_RULES_KEY) || '[]'); } catch (e) { return []; } }
  function saveShipRules(r) { try { localStorage.setItem(HS_RULES_KEY, JSON.stringify(r)); } catch (e) {} }
  function homeshopBoxes(lines, ym, rules) {
    const inMonth = lines.filter(l => !ym || l.day.replace(/-/g, '').slice(0, 6) === ym);
    const res = { cells: {}, unmapped: [], days: [...new Set(inMonth.map(l => l.day))].sort(), otherMonth: lines.length - inMonth.length, lines: inMonth.length,
      otherMonths: [...new Set(lines.filter(l => !inMonth.includes(l)).map(l => (l.day ? parseInt(l.day.slice(5, 7)) + '월' : '날짜 없음')))], noRecipient: 0 };
    const add = (d, col, n) => { const x = (res.cells[d] = res.cells[d] || {}); x[col] = (x[col] || 0) + n; };
    res.matched = new Map();
    const um = new Map(), mine = rules.filter(r => r.channel === 'homeshop'), cnt = new Map();
    // 합포장번호(없으면 송장번호 → 수령인)가 같은 줄 = 한 박스. 같은 품목은 수량 합치고, 다른 품목이 섞이면 한 조합(합포장)으로
    const pkgs = new Map();
    for (const l of inMonth) {
      const id = l.pack || l.inv || (l.recipient ? '수령인:' + l.recipient : '');
      if (!id) { res.noRecipient++; continue; }
      const pk = l.day + '|' + l.mall + '|' + id, p = pkgs.get(pk) || { day: l.day, mall: l.mall, items: new Map() };
      const it = p.items.get(l.code); if (it) it.qty += l.qty; else p.items.set(l.code, { code: l.code, name: l.name, qty: l.qty });
      pkgs.set(pk, p);
    }
    const one = (code, qty, mall) => mine.find(r => !r.combo && r.code === code && r.mall === mall && r.qty != null && +r.qty === +qty) || mine.find(r => !r.combo && r.code === code && r.mall === mall && r.qty == null) || HOMESHOP_MAP.find(r => r.code === code && (r.mall ? mall.toLowerCase().includes(r.mall.toLowerCase()) : !mall));
    for (const p of pkgs.values()) {
      const items = [...p.items.values()].sort((a, b) => a.code.localeCompare(b.code));
      const combo = items.length > 1 ? items.map(i => i.code + '*' + i.qty).join('+') : null;
      const l = combo
        ? { day: p.day, mall: p.mall, combo, code: items.map(i => i.code).join('+'), qty: items.reduce((a, i) => a + i.qty, 0), name: items.map(i => `${i.name} ${i.qty}개`).join(' + ') }
        : { day: p.day, mall: p.mall, combo: null, code: items[0].code, qty: items[0].qty, name: items[0].name };
      const k = l.day + '|' + l.mall + '|' + (combo || l.code + '*' + l.qty), e = cnt.get(k); if (e) e.n++; else cnt.set(k, { l, n: 1 });
    }
    for (const { l, n } of cnt.values()) {
      // 단품: 송장당 수량별 지정 → 품목 전체 지정 → 기본표 / 합포장: 조합 지정 → (들어간 품목이 모두 같은 열이면) 그 열
      let m;
      if (l.combo) {
        m = mine.find(r => r.combo === l.combo && r.mall === l.mall);
        if (!m) { const cols = l.combo.split('+').map(s => { const [c, q] = s.split('*'); const x = one(c, q, l.mall); return x ? x.col : null; }); if (cols.every(c => c && c === cols[0])) m = { col: cols[0] }; }
      } else m = one(l.code, l.qty, l.mall);
      const label = l.combo ? `${l.name} · 합포장 총 ${l.qty}개` : `${l.name} · 송장당 ${l.qty}개`;
      const key = l.mall + '|' + (l.combo || l.code + '*' + l.qty);
      if (m) {
        add(l.day, m.col, n);
        const mt = res.matched.get(key) || { code: l.code, name: l.name, label, combo: l.combo, mall: l.mall, qty: l.qty, boxes: 0, days: [], col: m.col, custom: !!m.channel };
        mt.boxes += n; if (!mt.days.includes(l.day)) mt.days.push(l.day); res.matched.set(key, mt); continue;
      }
      const u = um.get(key) || { code: l.code, name: l.name, label, combo: l.combo, mall: l.mall, qty: l.qty, boxes: 0, days: [] };
      u.boxes += n; if (!u.days.includes(l.day)) u.days.push(l.day); um.set(key, u);
    }
    res.unmapped = [...um.values()].sort((a, b) => a.code.localeCompare(b.code) || a.mall.localeCompare(b.mall) || a.qty - b.qty);
    res.matched = [...res.matched.values()].sort((a, b) => a.col.localeCompare(b.col) || a.code.localeCompare(b.code) || a.qty - b.qty);
    return res;
  }
  function boxColumns(wb, sheetName) {
    const En = E(), sh = wb.byName[sheetName]; if (!sh) throw new Error(`'${sheetName}' 시트가 없어요`);
    const dateRows = {};
    for (let r = 1; r <= Math.min(sh.maxR, 60); r++) {
      const v = wb.value(sh, 'A' + r), cell = sh.cells['A' + r], fmt = cell ? ((wb.xf[cell.s] || {}).fmt || '') : '';
      if (typeof v === 'number' && v > 30000 && /[yd]/i.test(fmt.replace(/"[^"]*"/g, ''))) dateRows[toDay(v)] = r;
    }
    const first = Object.values(dateRows).sort((a, b) => a - b)[0];
    if (!first) throw new Error(`'${sheetName}' 시트에서 날짜 행을 찾지 못했어요`);
    const set = new Set();
    for (let c = 1; c <= sh.maxC; c++) {
      const cell = sh.cells[En.colName(c) + first], m = cell && cell.f && cell.f.match(/^SUM\(([A-Z]+)\d+:([A-Z]+)\d+\)$/);
      const head = [1, 2, 3].map(r => noSpace(wb.display(sh, En.colName(c) + r))).join('');
      if (m && head.includes('총수량')) for (let x = En.colNum(m[1]); x <= En.colNum(m[2]); x++) set.add(x);
    }
    let group = ''; const labels = {};
    for (let c = 1; c <= sh.maxC; c++) { const g = wb.display(sh, En.colName(c) + 1).trim(); if (g) group = g; labels[c] = [group, wb.display(sh, En.colName(c) + 2).replace(/\s+/g, ' ').trim()].filter(Boolean).join(' · '); }
    return { cols: [...set].sort((a, b) => a - b).map(c => ({ col: En.colName(c), label: labels[c] })), dateRows };
  }
  function applyShip(wb, name, cells, ym, onlyDays) {
    const sh = wb.byName[name];
    let { cols, dateRows } = boxColumns(wb, name), datesMoved = false;
    if (ym && !Object.keys(dateRows).some(d => d.replace(/-/g, '').startsWith(ym))) {
      const first = Math.min(...Object.values(dateRows)), cell = sh.cells['A' + first];
      if (cell && !cell.f) { wb.setCell(name, 'A' + first, Date.UTC(+ym.slice(0, 4), +ym.slice(4) - 1, 1) / 864e5 + 25569); ({ cols, dateRows } = boxColumns(wb, name)); datesMoved = true; }
    }
    const colSet = new Set(cols.map(c => c.col));
    // 날짜를 새 달로 바꿨거나(지난달 양식) 비우기일 때만 전체 지움 · 그 외엔 이 파일에 있는 날짜 줄만 지우고 다시 채움
    const clearDays = onlyDays && !datesMoved ? new Set(onlyDays) : null;
    for (const [d, r] of Object.entries(dateRows)) { if (clearDays && !clearDays.has(d)) continue; for (const { col } of cols) { const cell = sh.cells[col + r]; if (cell && !cell.f && cell.v !== undefined && cell.v !== '') wb.setCell(name, col + r, ''); } }
    let n = 0, boxes = 0; const missingDays = [];
    for (const [day, byCol] of Object.entries(cells)) {
      const r = dateRows[day]; if (!r) { missingDays.push(day); continue; }
      for (const [col, v] of Object.entries(byCol)) { if (!colSet.has(col) && sh.cells[col + r] && sh.cells[col + r].f) continue; wb.setCell(name, col + r, Math.round(v * 1e6) / 1e6); n++; boxes += v; }
    }
    return { cells: n, boxes, missingDays, datesMoved };
  }
  function planShip(fileName, sheet, ym, cells, fileDays) {
    const prev = load(fileName).ship[sheet];
    if (!prev || prev.ym !== (ym || '')) return { merged: cells, kept: 0, replaced: 0, added: fileDays.length, fresh: true };
    const days = new Set(fileDays), merged = {}; let kept = 0, replaced = 0;
    for (const [d, v] of Object.entries(prev.cells)) { if (days.has(d)) replaced++; else { merged[d] = v; kept++; } }
    Object.assign(merged, cells);
    return { merged, kept, replaced, added: fileDays.length - replaced, fresh: false };
  }
  function saveShip(fileName, sheet, ym, cells) { const st = load(fileName); st.ship[sheet] = { ym: ym || '', cells }; save(fileName, st); }

  // ── 재고실사 (GitHub app/src/lib/stockcount.ts 이식) ──
  // 전체실사요약 A~E → 재고실사 C~G · 월 누계 출고수량(J)은 재고흐름표 "종료일자기준(총계) → 출고"를 품목코드로 찾기 · 매입원가(K)는 비움
  const STOCKCOUNT_COLS = { code: '품목코드', vendor: '업체품목코드', name: '아워박스제품명', avail: '전산재고', actual: '실사재고', out: '월누계출고수량', price: '매입원가' };
  async function readCountSummary(buf) {
    const En = E(), wb = await En.Workbook.load(buf);
    const sh = wb.byName['전체실사요약'] || wb.sheets.find(x => x.name.includes('전체실사요약'));
    if (!sh) throw new Error("'전체실사요약' 시트가 없어요 (재고실사 콘솔 2단계 결과 파일을 열어 주세요)");
    const v = (r, c) => wb.value(sh, En.colName(c) + r);
    let hr = 0;
    for (let r = 1; r <= 10 && !hr; r++) if (noSpace(str(v(r, 1))) === '품목코드') hr = r;
    if (!hr) throw new Error("전체실사요약 시트에서 '품목코드' 머리글을 찾지 못했어요");
    const out = [];
    for (let r = hr + 1; r <= sh.maxR; r++) {
      const code = str(v(r, 1));
      if (!code || /합계/.test(code)) continue;
      out.push({ code, vendor: str(v(r, 2)), name: str(v(r, 3)), avail: num(v(r, 4)), actual: num(v(r, 5)) });
    }
    return out;
  }
  async function readFlowOut(buf) {
    const En = E(), wb = await En.Workbook.load(buf);
    for (const sh of wb.sheets) {
      const v = (r, c) => wb.value(sh, En.colName(c) + r);
      let codeCol = 0, totalCol = 0;
      for (let c = 1; c <= sh.maxC; c++) { const h = noSpace(str(v(1, c))); if (h === '품목코드' && !codeCol) codeCol = c; if (h.startsWith('종료일자기준')) totalCol = c; }
      if (!codeCol || !totalCol) continue;
      let outCol = 0;
      for (let c = totalCol; c <= Math.min(totalCol + 3, sh.maxC); c++) if (noSpace(str(v(2, c))) === '출고') { outCol = c; break; }
      if (!outCol) continue;
      const map = new Map();
      for (let r = 3; r <= sh.maxR; r++) { const code = str(v(r, codeCol)); if (code) map.set(code, (map.get(code) || 0) + num(v(r, outCol))); }
      const dates = []; for (let c = 1; c < totalCol; c++) { const h = str(v(1, c)); if (/^\d{4}\.\d{2}\.\d{2}$/.test(h)) dates.push(h); }
      return { map, period: dates.length ? `${dates[0]} ~ ${dates[dates.length - 1]} · ${En.colName(outCol)}열` : `${En.colName(outCol)}열` };
    }
    throw new Error("재고흐름표에서 '품목코드'와 '종료일자기준(총계) → 출고' 열을 찾지 못했어요");
  }
  function stockCountGroups(rows, flow) {
    return rows.map(r => {
      const out = flow ? flow.get(r.code) : undefined, flags = [];
      if (flow && out === undefined) flags.push('재고흐름표에 없음 → 출고 0');
      if (r.actual !== r.avail) flags.push(`차이 ${r.actual - r.avail > 0 ? '+' : ''}${r.actual - r.avail}`);
      return {
        key: r.code, include: true, flags,
        rows: [{ code: r.code, vendor: r.vendor, name: r.name, avail: r.avail, actual: r.actual, out: flow ? out ?? 0 : '', price: '' }],
        summary: { title: `${r.code} · ${r.name}`, sub: `전산 ${r.avail.toLocaleString()} · 실사 ${r.actual.toLocaleString()}${flow ? ` · 월 출고 ${(out ?? 0).toLocaleString()}` : ''}`, amount: r.actual }
      };
    });
  }
  const countTotals = rows => ({ avail: rows.reduce((a, r) => a + r.avail, 0), actual: rows.reduce((a, r) => a + r.actual, 0) });

  // ── 제주도서: 대한통운 출고내역서(일반·도착보장·택배사변경 …) 원본 시트 → 제주도서 시트 (값 붙여넣기) ──
  //   B 고객사 = 목우촌만 · AQ 구분 = 제주/도서산간만
  //   C 운송장번호 · D 접수일자 → 출고일 · G 받는분 · J 주소 · AD 품명 · AP 추가운임 → 금액
  // 파일이 커서(시트 XML 250MB) 엔진으로 열지 않고, 필요한 zip 항목만 스트리밍으로 읽어요.
  const JEJU_COLS = { waybill: '운송장번호', name: '받는분', addr: '주소', date: '출고일', product: '품명', kind: '구분', amount: '금액' };
  const JEJU_TOTAL = /합\s*계\s*금\s*액/;
  const JEJU_KINDS = ['제주', '도서산간'];
  const JEJU_SRC = { company: ['B', '고객사'], waybill: ['C', '운송장번호'], date: ['D', '접수일자'], name: ['G', '받는분'], addr: ['J', '주소'], product: ['AD', '품명'], amount: ['AP', '추가운임'], kind: ['AQ', '구분'] };

  const zu16 = (b, o) => b[o] | (b[o + 1] << 8);
  const zu32 = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  function zipEntries(buf) {
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) if (zu32(buf, i) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) throw new Error('엑셀 파일이 아니에요 (zip 구조를 찾지 못했어요)');
    const n = zu16(buf, eocd + 10), out = new Map(), dec = new TextDecoder(); let p = zu32(buf, eocd + 16);
    for (let i = 0; i < n; i++) {
      if (zu32(buf, p) !== 0x02014b50) break;
      const nlen = zu16(buf, p + 28), name = dec.decode(buf.subarray(p + 46, p + 46 + nlen));
      out.set(name, { method: zu16(buf, p + 10), csize: zu32(buf, p + 20), offset: zu32(buf, p + 42) });
      p += 46 + nlen + zu16(buf, p + 30) + zu16(buf, p + 32);
    }
    return out;
  }
  function zipStream(buf, e) {
    const start = e.offset + 30 + zu16(buf, e.offset + 26) + zu16(buf, e.offset + 28);
    const raw = new Blob([buf.subarray(start, start + e.csize)]).stream();
    return (e.method === 0 ? raw : raw.pipeThrough(new DecompressionStream('deflate-raw'))).pipeThrough(new TextDecoderStream());
  }
  async function zipText(buf, e) { let s = ''; const rd = zipStream(buf, e).getReader(); for (;;) { const { done, value } = await rd.read(); if (done) break; s += value; } return s; }
  const xunesc = s => s.replace(/&(lt|gt|amp|quot|apos|#x?[0-9a-fA-F]+);/g, (_, k) => k === 'lt' ? '<' : k === 'gt' ? '>' : k === 'amp' ? '&' : k === 'quot' ? '"' : k === 'apos' ? "'" : String.fromCodePoint(k[1] === 'x' ? parseInt(k.slice(2), 16) : parseInt(k.slice(1), 10)));

  /** 큰 엑셀의 한 시트를 줄 단위로 읽어요. pre(xml, ss)로 셀을 풀기 전에 걸러낼 수 있어요. */
  async function streamSheetRows(ab, sheetName, onRow, pre) {
    const buf = new Uint8Array(ab), zip = zipEntries(buf);
    const wbx = zip.get('xl/workbook.xml'), rels = zip.get('xl/_rels/workbook.xml.rels');
    if (!wbx || !rels) throw new Error('엑셀 통합 문서 구조를 찾지 못했어요');
    const sheets = [...(await zipText(buf, wbx)).matchAll(/<sheet\b[^>]*?name="([^"]*)"[^>]*?r:id="([^"]*)"/g)].map(m => ({ name: xunesc(m[1]), rid: m[2] }));
    const target = sheets.find(x => x.name === sheetName) || sheets.find(x => x.name.includes(sheetName));
    if (!target) throw new Error(`'${sheetName}' 시트가 없어요 (시트: ${sheets.map(x => x.name).join(', ')})`);
    const rel = [...(await zipText(buf, rels)).matchAll(/<Relationship\b[^>]*>/g)].map(m => m[0]).find(t => t.includes(`Id="${target.rid}"`));
    const tgt = rel && (rel.match(/Target="([^"]*)"/) || [])[1];
    const ent = tgt && zip.get(tgt.startsWith('/') ? tgt.slice(1) : 'xl/' + tgt.replace(/^\.\//, ''));
    if (!ent) throw new Error(`'${target.name}' 시트 파일을 찾지 못했어요`);
    const sse = zip.get('xl/sharedStrings.xml');
    const ss = sse ? [...(await zipText(buf, sse)).matchAll(/<si>([\s\S]*?)<\/si>/g)].map(m => xunesc([...m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '').matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map(x => x[1]).join(''))) : [];
    const cellRe = /<c r="([A-Z]+)\d+"([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;
    const parse = xml => {
      const cells = {};
      for (const m of xml.matchAll(cellRe)) {
        const t = (m[2].match(/\bt="([^"]+)"/) || [])[1], body = m[3] || ''; let v = null;
        if (t === 'inlineStr') v = xunesc([...body.matchAll(/<t(?:\s[^>]*)?>([^<]*)<\/t>/g)].map(x => x[1]).join(''));
        else { const raw = (body.match(/<v>([^<]*)<\/v>/) || [])[1]; if (raw !== undefined) v = t === 's' ? (ss[+raw] ?? '') : t === 'str' || t === 'e' ? xunesc(raw) : t === 'b' ? raw : Number(raw); }
        cells[m[1]] = v;
      }
      return { get: c => cells[c] ?? null };
    };
    const rd = zipStream(buf, ent).getReader(); let rest = '';
    for (;;) {
      const { done, value } = await rd.read(); if (value) rest += value;
      let from = 0;
      for (;;) {
        const st = rest.indexOf('<row ', from); if (st < 0) { from = Math.max(from, rest.length - 5); break; }
        const gt = rest.indexOf('>', st); if (gt < 0) break;
        if (rest[gt - 1] === '/') { from = gt + 1; continue; }
        const en = rest.indexOf('</row>', gt); if (en < 0) break;
        const xml = rest.slice(st, en); from = en + 6;
        if (!pre || pre(xml, ss)) onRow(parse(xml));
      }
      rest = rest.slice(from); if (done) break;
    }
  }
  /** 셀을 풀지 않고 줄 XML에서 한 칸 값만 꺼내요 (걸러내기용). */
  function rawCell(xml, col, ss) {
    let i = -1, from = 0;
    for (;;) { i = xml.indexOf(`<c r="${col}`, from); if (i < 0) return null; const ch = xml.charCodeAt(i + 6 + col.length); if (ch >= 48 && ch <= 57) break; from = i + 1; }
    const close = xml.indexOf('>', i); if (xml[close - 1] === '/') return null;
    const head = xml.slice(i, close), body = xml.slice(close + 1, xml.indexOf('</c>', i));
    const v = (body.match(/<v>([^<]*)<\/v>/) || body.match(/<t(?:\s[^>]*)?>([^<]*)<\/t>/) || [])[1];
    if (v === undefined) return null;
    return /\bt="s"/.test(head) ? (ss[+v] ?? '') : xunesc(v);
  }
  const colLetter = c => { let x = ''; for (; c > 0; c = Math.floor((c - 1) / 26)) x = String.fromCharCode(65 + ((c - 1) % 26)) + x; return x; };
  const digits = v => (typeof v === 'number' ? v : /^\d+$/.test(str(v)) ? Number(str(v)) : str(v));

  /** 출고내역서 하나 → 목우촌 제주·도서산간 줄 */
  async function readJejuFile(ab, fileName) {
    const col = Object.fromEntries(Object.entries(JEJU_SRC).map(([k, [c]]) => [k, c]));
    let checked = false, rows = 0; const lines = [], kinds = {};
    await streamSheetRows(ab, '원본', row => {
      if (!checked) { // 머리글: 약속한 열 그대로, 열이 옮겨졌으면 머리글을 따라가요
        checked = true; const heads = {};
        for (let c = 1; c <= 60; c++) { const L = colLetter(c), h = noSpace(row.get(L) ?? ''); if (h && !heads[h]) heads[h] = L; }
        for (const [k, [c, h]] of Object.entries(JEJU_SRC)) {
          if (noSpace(row.get(c) ?? '') === h) continue;
          if (heads[h]) col[k] = heads[h]; else throw new Error(`${fileName}: 원본 시트 ${c}열이 '${h}'가 아니에요 (출고내역서 원본 시트인지 확인해 주세요)`);
        }
        return;
      }
      rows++; const kind = str(row.get(col.kind));
      lines.push({ waybill: digits(row.get(col.waybill)), date: digits(row.get(col.date)), name: str(row.get(col.name)), addr: str(row.get(col.addr)), product: str(row.get(col.product)), amount: num(row.get(col.amount)), kind, file: fileName });
      kinds[kind] = (kinds[kind] || 0) + 1;
    }, (xml, ss) => !checked || (noSpace(rawCell(xml, col.company, ss) ?? '') === '목우촌' && JEJU_KINDS.includes(noSpace(rawCell(xml, col.kind, ss) ?? ''))));
    return { name: fileName, lines, rows, kinds };
  }
  /** 송장 하나 = 한 줄 · 출고일 → 운송장 순 · 다른 달 · 다른 파일과 겹친 송장은 체크 해제 */
  function jejuGroups(files, ym) {
    const seen = new Map();
    const all = files.flatMap(f => f.lines).sort((a, b) => String(a.date).localeCompare(String(b.date)) || String(a.waybill).localeCompare(String(b.waybill)));
    return all.map(l => {
      const key = String(l.waybill), dup = (seen.get(key) || 0) + 1; seen.set(key, dup);
      const m = String(l.date).match(/^(\d{4})-?(\d{2})/), lm = m ? m[1] + m[2] : null, other = !!(ym && lm && lm !== ym);
      const flags = [];
      if (other) flags.push(`다른 달 (${parseInt(lm.slice(4))}월)`);
      if (dup > 1) flags.push('같은 운송장이 다른 파일에도 있음');
      if (!l.amount) flags.push('추가운임 0원');
      return {
        key: dup > 1 ? `${key}#${dup}` : key, include: !other && dup === 1, flags,
        rows: [{ waybill: l.waybill, name: l.name, addr: l.addr, date: l.date, product: l.product, kind: l.kind, amount: l.amount }],
        summary: { title: `${l.waybill} · ${l.name}`, sub: [l.kind, String(l.date), l.product, l.file.replace(/\.xls[xm]$/i, '')].join(' · '), amount: l.amount }
      };
    });
  }
  function jejuTotals(groups) {
    const t = {}; for (const g of groups.filter(x => x.include)) { const k = String(g.rows[0].kind); (t[k] = t[k] || { n: 0, amount: 0 }); t[k].n++; t[k].amount += g.summary.amount; }
    return t;
  }

  window.ClosingImport = {
    STOCKCOUNT_COLS, readCountSummary, readFlowOut, stockCountGroups, countTotals,
    homeshopLines, homeshopBoxes, boxColumns, applyShip, planShip, saveShip, loadShipRules, saveShipRules,
    COUPANG_COLS, coupangLines, coupangBoxes, applyCoupang, loadCoupangDays, saveCoupangDays, loadCoupangMap, saveCoupangMap,
    ready, closingMonth, decodeText, parseCsv,
    RETURNS_COLS, returnsFromCsv,
    CLAIMS_COLS, CLAIMS_MERGE_COLS, claimsFromXlsx, claimGroups,
    applyTable,
    VEHICLE_COLS, VEHICLE_OVERWRITE, vehicleFromCsv, vehicleGroups, vehicleGroupsFromXlsx, withRowFormulas,
    DISPOSAL_STATES, DISPOSAL_COLS, readDisposal, disposalItems, disposalGroups, loadWeights, saveWeights,
    JEJU_COLS, JEJU_TOTAL, JEJU_KINDS, readJejuFile, jejuGroups, jejuTotals,
    planTable, saveTable, clearSheet,
    isEncryptedOffice, decryptOffice
  };
})();
