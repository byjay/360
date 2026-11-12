/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p197-photo-match.test.mjs)
 *
 * 대상: public/js/modules/35_PhotoBatch.js — PhotoMatch(번호 대응 매칭)·PhotoNaming.restoreLast·
 *   PhotoBatch._unlinkPin(기존 사진 일괄 해제, WO 20261106-photomatch 결정①②④).
 *
 * 마스터 재현 사례: 핀 401~460(60개) 중 408.JPG 가 없는 55장을 번호 대응으로 매칭하면
 *   408 핀만 "파일 없음"으로 남고 409 이후가 밀리지 않아야 한다(기존 _buildMatches 의 결함).
 *
 * 구성:
 *  ① parseName 표(헤더 주석과 동일 샘플) + 60_PhotoFolder.js 의 _fileFullNo/_fileFallbackNo/_filePrefix
 *     와 드리프트 없음(교차검증, 무작위 200건)
 *  ② 마스터 재현 — 401~460, 408.JPG 없음 → 밀림 0, 408만 pinsWithoutFile
 *  ③ 접두 다른 같은 번호(OD001/OF001) 구분 매칭
 *  ④ 중복 파일(같은 번호 파일 2장) → duplicates 분리, 자동 선택 금지
 *  ⑤ 속성 테스트 300건 — (i)단사 (ii)번호·접두 불일치 비매칭 (iii)밀림 없음 (iv)결정적
 *  ⑥ _unlinkPin → PhotoNaming.restoreLast 왕복 시 원래 필드 완전 복원(이미지 데이터 삭제 호출 0)
 *  ⑦ 뮤테이션 2종(되돌리면 실패해야 함): (a) 번호 조건 무력화(과거 방식으로 퇴행) (b) 해제가 이미지
 *     삭제 함수를 호출하게 됨
 *
 * 실제 모듈 소스(01b_PinSeries.js / 60_PhotoFolder.js / 35_PhotoBatch.js)를 그대로 vm 에 평가해 검사한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const seriesSrc = rd("public/js/modules/01b_PinSeries.js");
const folderSrc = rd("public/js/modules/60_PhotoFolder.js");
const pbSrc = rd("public/js/modules/35_PhotoBatch.js");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

function makeSandbox(extra) {
  const sandbox = Object.assign({ console, JSON, Map, Set, Date, Math, Array, Object, String, Number, RegExp }, extra || {});
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  return sandbox;
}
/** PB(PhotoBatch)·PM(PhotoMatch)·PN(PhotoNaming)·PS(PinSeries)·PF(PhotoFolder, 선택) 로드.
 *  @param {string} [pbSource] 뮤테이션 테스트가 변형 소스를 넣을 수 있게 분리. */
function loadAll(extraState, pbSource) {
  const State = Object.assign({ pins: [], pdfPage: 1 }, extraState);
  const AppMock = { _markDirty() {}, _keepLocal() {} };
  const sandbox = makeSandbox({ State, App: AppMock });
  vm.runInContext(
    seriesSrc + "\n" + folderSrc + "\n" + (pbSource || pbSrc) +
    "\n;globalThis.__PB = PhotoBatch; globalThis.__PM = PhotoMatch; globalThis.__PN = PhotoNaming; globalThis.__PS = PinSeries; globalThis.__PF = PhotoFolder;",
    sandbox
  );
  return { PB: sandbox.__PB, PM: sandbox.__PM, PN: sandbox.__PN, PS: sandbox.__PS, PF: sandbox.__PF, sandbox };
}

/* ══ ① parseName 표 + 60_PhotoFolder 와 드리프트 교차검증 ══════════════════════════ */
{
  const { PM, PF } = loadAll();
  const table = [
    ["401.JPG", 401, null, ""],
    ["OD001.jpg", 1, null, "OD"],
    ["ER_1001.JPG", 1001, 1, "ER"],
    ["402.1.JPG", 1, null, ""],
    ["4th.01.JPG", 1, null, ""],
    ["0f.070.JPG", 70, null, ""],
    ["@preview.jpg", null, null, ""]
  ];
  let allOk = true;
  table.forEach(([name, full, fallback, prefix]) => {
    const r = PM.parseName(name);
    const pass = r.full === full && r.fallback === fallback && r.prefix === prefix && r.hasDigits === (full !== null);
    if (!pass) allOk = false;
    console.log("    " + (pass ? "." : "X") + " " + name + " → " + JSON.stringify(r));
  });
  ok(allOk, "① parseName 표 샘플 7건 일치");

  // 교차검증: 200건 무작위 파일명 — PhotoMatch 와 PhotoFolder 가 같은 full/fallback/prefix 를 낸다(드리프트 0).
  let seed = 13;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const prefixes = ["", "OD", "OF", "ER", "A", "4th"];
  const exts = [".jpg", ".JPG", ".png"];
  let drift = 0;
  for (let i = 0; i < 200; i++) {
    const pfx = prefixes[Math.floor(rnd() * prefixes.length)];
    const sep = rnd() < 0.5 ? "" : (rnd() < 0.5 ? "_" : ".");
    const digits = String(Math.floor(rnd() * 20000)).padStart(Math.floor(rnd() * 6) + 1, "0");
    const name = pfx + sep + digits + exts[Math.floor(rnd() * exts.length)];
    const a = PM.parseName(name);
    const bFull = PF._fileFullNo(name);
    const bFallback = PF._fileFallbackNo(name);
    const bPrefix = PF._filePrefix(name);
    if (a.full !== bFull || a.fallback !== bFallback || a.prefix !== bPrefix) { drift++; if (drift <= 3) console.log("    드리프트: " + name + " PM=" + JSON.stringify(a) + " PF=" + JSON.stringify({ full: bFull, fallback: bFallback, prefix: bPrefix })); }
  }
  ok(drift === 0, "①b PhotoMatch.parseName 과 60_PhotoFolder 규칙 200건 드리프트 0 → drift=" + drift);
}

/* ══ ② 마스터 재현 — 401~460, 408.JPG 없음(55장) → 밀림 0 ══════════════════════════ */
{
  const pins = [];
  for (let n = 401; n <= 460; n++) pins.push({ id: "P" + n, page: 1, label: String(n) });
  const { PB, PM } = loadAll({ pins, pdfPage: 1 });
  const pinList = PB._pinList(pins, 1, "all");
  const rows = [];
  for (let n = 401; n <= 460; n++) { if (n === 408) continue; rows.push({ name: n + ".JPG", excluded: false }); } // 408.JPG 없음(55장)
  const result = PM.matchByNumber(pinList, { start: 401, end: 460 }, rows);
  ok(result.matched.length === 59, "②a 매칭 59건(60핀-408 하나 없음) → " + result.matched.length);
  ok(result.pinsWithoutFile.length === 1 && result.pinsWithoutFile[0].no === 408, "②b 408만 파일없는 핀 → " + JSON.stringify(result.pinsWithoutFile.map((e) => e.no)));
  const shifted = result.matched.filter((m) => m.no !== parseInt(m.row.name, 10));
  ok(shifted.length === 0, "②c 🔴 밀림 0건(마스터가 겪은 결함의 핵심 반례) → shifted=" + JSON.stringify(shifted.map((m) => m.no + "←" + m.row.name)));
  // 409 핀은 반드시 409.JPG와 매칭(410.JPG 가 아님 — 종전 위치기반이면 410으로 밀렸을 것)
  const m409 = result.matched.find((m) => m.no === 409);
  ok(!!m409 && m409.row.name === "409.JPG", "②d 409 핀 ← 409.JPG(410.JPG 아님) → " + (m409 && m409.row.name));
}

/* ══ ③ 접두 다른 같은 번호 구분 매칭(OD001 vs OF001) ══════════════════════════════ */
{
  const pins = [
    { id: "OD1", page: 1, label: "OD001" },
    { id: "OF1", page: 1, label: "OF001" }
  ];
  const { PB, PM } = loadAll({ pins, pdfPage: 1 });
  const pinList = PB._pinList(pins, 1, "all");
  const rows = [{ name: "OD001.jpg", excluded: false }, { name: "OF001.jpg", excluded: false }];
  const result = PM.matchByNumber(pinList, { start: 1, end: 1 }, rows);
  const byPin = new Map(result.matched.map((m) => [m.pin.id, m.row.name]));
  ok(byPin.get("OD1") === "OD001.jpg" && byPin.get("OF1") === "OF001.jpg",
    "③ 접두로 구분되어 각자 제 파일에 매칭 → " + JSON.stringify([...byPin]));
}

/* ══ ④ 중복 파일 — 같은 번호 파일 2장은 duplicates 로 분리(자동 선택 금지) ══════════════ */
{
  const pins = [{ id: "P1", page: 1, label: "5" }];
  const { PB, PM } = loadAll({ pins, pdfPage: 1 });
  const pinList = PB._pinList(pins, 1, "all");
  const rows = [{ name: "5.jpg", excluded: false }, { name: "005.jpg", excluded: false }];
  const result = PM.matchByNumber(pinList, { start: 5, end: 5 }, rows);
  ok(result.matched.length === 0 && result.duplicates.length === 1 && result.duplicates[0].rows.length === 2,
    "④ 중복 2장 → matched=0, duplicates=1(파일 2개) → matched=" + result.matched.length + " dup=" + result.duplicates.length);
}

/* ══ ⑤ 속성 테스트 300건 — (i)단사 (ii)번호/접두 불일치 비매칭 (iii)밀림 없음 (iv)결정적 ══════ */
{
  let seed = 777;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const PFX = ["", "OD", "OF"];
  let viol = { inj: 0, wrong: 0, shift: 0, nondet: 0 };
  const TRIALS = 300;
  for (let t = 0; t < TRIALS; t++) {
    const { PB, PM } = loadAll();
    const nPins = 3 + Math.floor(rnd() * 4); // 3..6
    const used = new Set();
    const pins = [];
    for (let i = 0; i < nPins; i++) {
      let no; do { no = 1 + Math.floor(rnd() * 50); } while (used.has(no));
      used.add(no);
      const pfx = PFX[Math.floor(rnd() * PFX.length)];
      pins.push({ id: "p" + i, page: 1, label: pfx + String(no).padStart(3, "0") });
    }
    const pinList = PB._pinList(pins, 1, "all");
    const rows = [];
    pinList.forEach((e) => {
      const r = rnd();
      if (r < 0.15) return; // 15% 확률로 파일 없음(마스터 사례처럼 구멍)
      const name = e.prefix + String(e.no).padStart(3, "0") + ".jpg";
      rows.push({ name, excluded: false });
      if (r > 0.92) rows.push({ name, excluded: false }); // 8% 확률로 중복 파일(같은 이름 2장)
    });
    // 노이즈 파일(범위 밖·번호 없음) 추가
    rows.push({ name: "9999_noise.jpg", excluded: false });
    rows.push({ name: "no_number_here.jpg", excluded: false });

    const range = { start: Math.min(...pinList.map((e) => e.no)), end: Math.max(...pinList.map((e) => e.no)) };
    const r1 = PM.matchByNumber(pinList, range, rows);

    // (i) 단사: matched 안에서 row 중복·pin 중복 없음
    const rowSet = new Set(r1.matched.map((m) => m.row));
    const pinSet = new Set(r1.matched.map((m) => m.pin.id));
    if (rowSet.size !== r1.matched.length || pinSet.size !== r1.matched.length) viol.inj++;

    // (ii) 매칭된 각 쌍이 실제로 번호·접두가 일치하는지
    r1.matched.forEach((m) => {
      const parsed = PM.parseName(m.row.name);
      if (parsed.full !== m.no) viol.wrong++;
    });

    // (iv) 결정적: 같은 입력 재호출 시 matched 쌍의 (pinId,rowName) 집합이 동일
    const r1b = PM.matchByNumber(pinList, range, rows);
    const sig = (res) => res.matched.map((m) => m.pin.id + ":" + m.row.name).sort().join(",");
    if (sig(r1) !== sig(r1b)) viol.nondet++;

    // (iii) 밀림 없음: active 파일 행 하나를 제거해도 "다른" 핀의 매칭이 바뀌지 않는다.
    const activeRows = rows.filter((r) => !r.excluded);
    if (activeRows.length > 1) {
      const dropIdx = Math.floor(rnd() * activeRows.length);
      const dropped = activeRows[dropIdx];
      const rows2 = rows.filter((r) => r !== dropped);
      const r2 = PM.matchByNumber(pinList, range, rows2);
      const before = new Map(r1.matched.map((m) => [m.pin.id, m.row.name]));
      const after = new Map(r2.matched.map((m) => [m.pin.id, m.row.name]));
      before.forEach((rowName, pinId) => {
        if (rowName === dropped.name) return; // 이 핀 자신은 영향 받는 게 정상
        const afterName = after.get(pinId);
        if (afterName !== rowName) viol.shift++;
      });
    }
  }
  ok(viol.inj === 0, "⑤-i 단사 위반 0/" + TRIALS + " → " + viol.inj);
  ok(viol.wrong === 0, "⑤-ii 번호 불일치 매칭 0/" + TRIALS + " → " + viol.wrong);
  ok(viol.shift === 0, "⑤-iii 밀림(다른 핀 매칭 변경) 0/" + TRIALS + " → " + viol.shift);
  ok(viol.nondet === 0, "⑤-iv 비결정적 결과 0/" + TRIALS + " → " + viol.nondet);
}

/* ══ ⑥ 해제→복원 왕복 — 필드 완전 복원, 이미지 데이터 삭제 호출 0 ══════════════════════ */
{
  const pin = { id: "U1", page: 1, label: "1", imageId: "img-abc", imageUrl: null, pendingOpId: null, pendingSync: false, imageName: "zoneA_20260101120000", origName: "402.1.JPG", shotAt: 1700000000000, shotSrc: "EXIF DateTimeOriginal", is360: true, isVideo: false, origKey: "orig/key.jpg", timeline: [] };
  const { PB, PN } = loadAll({ pins: [pin] });
  const before = JSON.stringify(pin);
  const entryId = PB._unlinkPin(pin, "일괄해제");
  ok(!!entryId, "⑥a 해제 후 복원용 entryId 반환 → " + entryId);
  ok(pin.imageId === null && pin.imageName === null && pin.origName === null && pin.is360 === false,
    "⑥b 해제 직후 필드가 비워짐(링크만) → imageId=" + pin.imageId + " imageName=" + pin.imageName);
  const restored = PN.restoreLast(pin, entryId);
  ok(restored === true, "⑥c restoreLast 성공");
  ok(JSON.stringify(pin) === before, "⑥d 왕복 후 필드 완전 복원(순서 무관 — JSON 동일) → " + JSON.stringify(pin));
}

/* ══ ⑦a 뮤테이션 — 번호 조건을 무력화(과거 "번호 무시" 방식으로 퇴행)하면 ②(마스터 반례)가 깨져야 함 ══ */
{
  console.log("\n[뮤테이션⑦a] isMatch 의 번호 일치 조건을 제거하면 밀림방지(②c)가 무력화돼야 함");
  const needle = `      if (parsed.full !== null && parsed.full === pn) return true;`;
  const mutated = pbSrc.replace(needle, `      if (parsed.full !== null) return true;`); // 번호가 있으면 아무 핀에나 매칭(= 번호 무시)
  if (mutated === pbSrc) { console.log("  FAIL 뮤테이션⑦a 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PB: PBm, PM: PMm } = loadAll(undefined, mutated);
    const pins = [];
    for (let n = 401; n <= 460; n++) pins.push({ id: "P" + n, page: 1, label: String(n) });
    const pinListM = PBm._pinList(pins, 1, "all");
    const rowsM = [];
    for (let n = 401; n <= 460; n++) { if (n === 408) continue; rowsM.push({ name: n + ".JPG", excluded: false }); }
    const resM = PMm.matchByNumber(pinListM, { start: 401, end: 460 }, rowsM);
    // 번호 무시 매칭이면 모든 핀이 모든 파일과 "동시 후보"가 돼 전부 duplicates 로 쏟아진다(정상 매칭 59건이 무너짐).
    ok(resM.matched.length !== 59 || resM.duplicates.length > 0,
      "뮤테이션⑦a 적용 시 정상 매칭(59건, 중복 0)이 깨짐(테스트 실효성 증명) → matched=" + resM.matched.length + " dup=" + resM.duplicates.length);
  }
}

/* ══ ⑦b 뮤테이션 — 해제(_unlinkPin)가 이미지 삭제 함수를 호출하게 되면 테스트가 잡아야 함 ══ */
{
  console.log("\n[뮤테이션⑦b] _unlinkPin 에 이미지 삭제 호출을 끼워 넣으면 '삭제 호출 0' 가정이 깨져야 함");
  const needle = `      pin.imageId = null; pin.imageUrl = null; pin.pendingOpId = null; pin.pendingSync = false;`;
  const mutated = pbSrc.replace(needle,
    `      if (typeof Cloud !== "undefined" && Cloud.deleteImage) Cloud.deleteImage(pin.imageId);\n` + needle);
  if (mutated === pbSrc) { console.log("  FAIL 뮤테이션⑦b 패치 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const pin = { id: "U2", page: 1, label: "1", imageId: "img-xyz" };
    const State = { pins: [pin], pdfPage: 1 };
    const sandbox = makeSandbox({ State, App: { _markDirty() {}, _keepLocal() {} } });
    let deleteCalls = [];
    sandbox.Cloud = { deleteImage(id) { deleteCalls.push(id); } };
    vm.runInContext(seriesSrc + "\n" + folderSrc + "\n" + mutated + "\n;globalThis.__PB = PhotoBatch;", sandbox);
    sandbox.__PB._unlinkPin(pin, "일괄해제");
    ok(deleteCalls.length === 1 && deleteCalls[0] === "img-xyz",
      "뮤테이션⑦b 적용 시 이미지 삭제 호출이 발생(테스트 실효성 증명 — 정상 코드는 이 호출이 0이어야 통과) → calls=" + JSON.stringify(deleteCalls));
  }
  // 수정 전(정상 소스) — 삭제 호출이 전혀 없어야 한다(§4b 핵심 보장).
  const pin2 = { id: "U3", page: 1, label: "1", imageId: "img-normal" };
  const { PB: PBn, sandbox: sbn } = loadAll({ pins: [pin2], pdfPage: 1 });
  let normalDeleteCalls = [];
  sbn.Cloud = { deleteImage(id) { normalDeleteCalls.push(id); } };
  PBn._unlinkPin(pin2, "일괄해제");
  ok(normalDeleteCalls.length === 0, "⑦b-정상 정상 소스는 해제 시 이미지 삭제 호출 0 → " + normalDeleteCalls.length);
}

console.log(failed === 0 ? "\n전체 PASS" : `\n${failed}건 FAIL`);
process.exit(failed === 0 ? 0 : 1);
