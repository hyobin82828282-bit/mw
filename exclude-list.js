// 목우촌 임박이동.xlsx > "제외" 시트 (임박 대상 아님) — 파일이 바뀌지 않으므로 고정
export const EXCLUDE = [
  { code: "202008000059", type: "DN", name: "[M냉장] 무항)다리두배 닭볶음탕 1300" },
  { code: "201991000140", type: "DN", name: "[M냉장] 목우촌 무항생제 닭볶음탕용 800" },
  { code: "201991000122", type: "DN", name: "[M냉장]목우촌 정직한목장_갈매기살500g" },
  { code: "201991000121", type: "DN", name: "[M냉장]목우촌 정직한목장_목살1kg" },
  { code: "201991000098", type: "DN", name: "[M냉장]한돈팩(냉장 목살) 500g" },
  { code: "201991000091", type: "DN", name: "[M냉장]무항 통닭 11호(초록색) 1100g" },
  { code: "201991000089", type: "DN", name: "[M냉장]정직한 목장 삼겹살 1kg" },
  { code: "201991000088", type: "DN", name: "[M냉장]정직한 목장 ★등갈비★ 1kg" },
  { code: "201991000087", type: "DN", name: "[M냉장]정직한 목장 갈비(찜용)1kg" },
  { code: "201991000081", type: "DN", name: "[M냉장]무항생제 닭볶음탕용 600" },
  { code: "201991000062", type: "DN", name: "[M냉장]무항생제 아랫날개(윙)400×2" },
  { code: "201991000061", type: "DN", name: "[M냉장]무항생제 윗날개(봉)400×2" },
  { code: "201991000060", type: "DN", name: "[M냉장]무항생제 닭날개(윙+봉)500" },
  { code: "201991000059", type: "DN", name: "[M냉장]무항생제 통다리500g" },
  { code: "201991000049", type: "DN", name: "[M냉장]무항생제 닭가슴살 400g" },
  { code: "201991000048", type: "DN", name: "[M냉장]★번들★무항생제 닭안심 400gx2개" },
  { code: "201991000045", type: "DN", name: "[M냉장]★번들★무항생제 닭다리살(정육)400x2개" },
  { code: "201991000042", type: "DN", name: "[M냉장]무항생제 닭다리살(정육) 400g" },
  { code: "201990000270", type: "DN", name: "[M냉장]삼겹살_수육 1kg_정직한목장" },
  { code: "201990000267", type: "DN", name: "[M냉장]정직한목장 삼겹살 800g" },
  { code: "201988000015", type: "DN", name: "[M냉장]무항생제 순살 닭볶음탕용 600" },
  { code: "201987000265", type: "DN", name: "[M냉장] 목우촌 한돈 생구이 삼겹500g" },
  { code: "201987000264", type: "DN", name: "[M냉장] 목우촌 한돈 생구이 목살500g" },
  { code: "201987000242", type: "DN", name: "[M냉장] 목우촌 한돈 생대패 목살500g" },
  { code: "201987000241", type: "DN", name: "[M냉장] 목우촌 한돈 생대패 삼겹살500g" },
  { code: "201987000233", type: "DN", name: "[M냉장]정직한 목장 목살 600g" },
  { code: "201987000232", type: "DN", name: "[M냉장]정직한 목장 삼겹살 600g" },
  { code: "201987000227", type: "DN", name: "[M냉장]목우촌 프로포크 가브리살500g" },
  { code: "201987000226", type: "DN", name: "[M냉장]목우촌 프로포크 항정살500g" },
  { code: "201987000225", type: "DN", name: "[M냉장]목우촌 프로포크 목살500g" },
  { code: "201987000224", type: "DN", name: "[M냉장]목우촌 프로포크 삼겹살500g" },
  { code: "201987000143", type: "DN", name: "[M냉장] 다리두배 ★닭볶음탕 1200★ 파란색" },
  { code: "201987000142", type: "DN", name: "[M냉장]★번들★무항생제 닭가슴살400gx2" },
  { code: "201987000141", type: "DN", name: "[M냉장]★번들★무항생제 안심400gx2개" },
  { code: "201987000055", type: "DN", name: "[M냉장] 다리두배 ★닭볶음탕 1200★ 파란색" },
  { code: "201987000054", type: "DN", name: "[M냉장] 흰색트레이 소스동봉 춘천닭갈비400g(식육)" }
];

export const normName = s => String(s || "").replace(/[\s★*]/g, "").toLowerCase();
export const EXCLUDE_NAMES = new Set(EXCLUDE.map(x => normName(x.name)));
export const EXCLUDE_CODES = new Set(EXCLUDE.map(x => x.code));
