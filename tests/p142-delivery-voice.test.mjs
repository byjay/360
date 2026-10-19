/**
 * p142 — WO 20261010-delivery: 납품 보고서(56_Delivery) · zip(55_ZipStore) · 음성 메모(57_Voice)
 * (프레임워크 0 · 실행: node tests/p142-delivery-voice.test.mjs)
 *
 * [재현: 해당없음 — 기능 고도화] 지휘자 발주서(HEAD 73fd6a9):
 *   R1 47_Report.js = 17열 CSV + 단순 인쇄창뿐(표지·위치도·결함 요약·묶음 없음)
 *   R2 `git grep -c SpeechRecognition HEAD -- public/js/modules` → 0
 *
 * 🔴 목 금지 — 실제 모듈 소스(PinSeries·TimeLapse·Coverage·Requests·Projects·ProjectInfo·Report·ZipStore·Delivery·Voice)를
 *   한 vm 에 그대로 평가해 순수 함수를 검증한다. zip 은 node:zlib.crc32(독립 구현)와 자체 파서로 바이트를 대조한다.
 * 뮤테이션: 각 절 끝에서 소스 문자열을 바꿔 새 vm 에 올리고 같은 검사가 실패하는지 확인(실패해야 PASS).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import zlib from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const NAMES = ["01b_PinSeries", "14_TimeLapse", "51_Coverage", "42_Requests", "31_Projects", "43_ProjectInfo", "47_Report", "55_ZipStore", "56_Delivery", "57_Voice"];
const SRC = Object.fromEntries(NAMES.map((n) => [n, rd("public/js/modules/" + n + ".js")]));

let failed = 0;
const ok = (cond, label, d) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (!cond && d !== undefined ? " :: " + JSON.stringify(d).slice(0, 300) : "")); if (!cond) failed++; };

function load(over) {
  const src = Object.assign({}, SRC, over || {});
  const sb = { console, TextEncoder, Blob: class { constructor(p, o) { this.parts = p; this.type = o && o.type; } } };
  vm.createContext(sb);
  vm.runInContext(NAMES.map((n) => src[n]).join("\n") + "\n;globalThis.__M={PinSeries,TimeLapse,Coverage,Requests,Projects,ProjectInfo,Report,ZipStore,Delivery,Voice};", sb);
  return sb.__M;
}
const mutate = (name, needle, repl) => {
  const s = SRC[name];
  if (s.indexOf(needle) < 0) { console.log("  FAIL 뮤테이션 대상 없음: " + name + " :: " + needle.slice(0, 60)); failed++; return null; }
  return { [name]: s.replace(needle, repl) };
};
/** 뮤테이션 검증: check(M) 가 원본에선 true, 변형에선 false 여야 한다 */
function mutationProof(label, over, check) {
  if (!over) return;
  let mutantPass;
  try { mutantPass = !!check(load(over)); } catch (e) { mutantPass = false; }
  ok(!mutantPass, "뮤테이션 — " + label + " → 검사가 잡아냄");
}

/* ── 독립 zip 파서(APPNOTE: EOCD → 중앙 디렉터리 → 로컬 헤더) ── */
function parseZip(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let eo = -1;
  for (let i = u8.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { eo = i; break; }
  if (eo < 0) throw new Error("EOCD 없음");
  const n = dv.getUint16(eo + 10, true), cdSize = dv.getUint32(eo + 12, true), cdOff = dv.getUint32(eo + 16, true);
  const out = [];
  let p = cdOff;
  for (let i = 0; i < n; i++) {
    if (dv.getUint32(p, true) !== 0x02014b50) throw new Error("CD 시그니처 불일치 @" + p);
    const flag = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true);
    const csz = dv.getUint32(p + 20, true), usz = dv.getUint32(p + 24, true), nl = dv.getUint16(p + 28, true), el = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    const lho = dv.getUint32(p + 42, true);
    const name = Buffer.from(u8.subarray(p + 46, p + 46 + nl)).toString("utf8");
    if (dv.getUint32(lho, true) !== 0x04034b50) throw new Error("로컬 헤더 시그니처 불일치 @" + lho);
    const lnl = dv.getUint16(lho + 26, true), lel = dv.getUint16(lho + 28, true);
    const lname = Buffer.from(u8.subarray(lho + 30, lho + 30 + lnl)).toString("utf8");
    const data = u8.subarray(lho + 30 + lnl + lel, lho + 30 + lnl + lel + csz);
    out.push({ name, lname, flag, lflag: dv.getUint16(lho + 6, true), method, lmethod: dv.getUint16(lho + 8, true), crc, lcrc: dv.getUint32(lho + 14, true), csz, usz, data });
    p += 46 + nl + el + cl;
  }
  return { n, cdSize, cdOff, cdEnd: p, eo, entries: out };
}

/* ══ ① ZipStore — 로컬 헤더·중앙 디렉터리·EOCD·CRC32(zlib 대조)·UTF-8 이름 ══ */
function zipCheck(M) {
  const files = [
    { name: "report.html", data: "<!doctype html><p>안녕 보고서</p>" },
    { name: "photos/s0-0-after.jpg", data: new Uint8Array(Array.from({ length: 5000 }, (_, i) => (i * 31 + 7) & 255)) },
    { name: "한글/빈파일.txt", data: new Uint8Array(0) }
  ];
  const z = M.ZipStore.build(files, new Date(2026, 9, 10, 13, 45, 30));
  const pz = parseZip(z);
  const res = { pz, files };
  res.ok = pz.n === 3 && pz.cdEnd === pz.eo && pz.entries.every((e, i) => {
    const src = typeof files[i].data === "string" ? Buffer.from(files[i].data, "utf8") : Buffer.from(files[i].data);
    return e.name === files[i].name && e.lname === e.name && e.method === 0 && e.lmethod === 0 && (e.flag & 0x0800) && (e.lflag & 0x0800) &&
      e.crc === zlib.crc32(src) && e.lcrc === e.crc && e.csz === src.length && e.usz === src.length && Buffer.from(e.data).equals(src);
  });
  return res;
}
function testZip() {
  console.log("\n[① ZipStore — STORE zip 바이트 구조]");
  const M = load();
  const r = zipCheck(M);
  ok(r.pz.n === 3, "EOCD 항목 수 = 3", r.pz.n);
  ok(r.pz.cdEnd === r.pz.eo, "중앙 디렉터리 끝 = EOCD 시작(크기·오프셋 정합)", [r.pz.cdEnd, r.pz.eo]);
  ok(r.ok, "항목별 시그니처·STORE(0)·UTF-8 플래그·CRC32(zlib)·크기·데이터 일치", r.pz.entries.map((e) => [e.name, e.crc, e.csz]));
  ok(M.ZipStore.crc32(new TextEncoder().encode("123456789")) === 0xCBF43926, "CRC32 표준 검사값(\"123456789\" → CBF43926)");
  let threw = 0;
  try { M.ZipStore.build([{ name: "a.txt", data: "1" }, { name: "a.txt", data: "2" }]); } catch (e) { threw++; }
  try { M.ZipStore.build([{ name: "../evil.txt", data: "1" }]); } catch (e) { threw++; }
  ok(threw === 2, "중복 이름·경로 탈출(..) 거부");
  mutationProof("CRC 다항식 변경(0xEDB88320→0x04C11DB7)", mutate("55_ZipStore", "0xEDB88320", "0x04C11DB7"), (X) => zipCheck(X).ok);
  mutationProof("중앙 디렉터리 로컬 헤더 오프셋 0 고정", mutate("55_ZipStore", "dv.setUint32(p + 42, e.offset, true);", "dv.setUint32(p + 42, 0, true);"), (X) => zipCheck(X).ok);
}

/* ══ 공통 픽스처 — seed-local 과 같은 모양(A구역·A-1영역 = 같은 배포본, B구역 = crop 창) ══ */
const NOW = new Date(2026, 9, 10, 12, 0, 0).getTime();
const DAY = 86400000;
function fixture() {
  const decks = [
    { id: "dkA", name: "A구역", deployment_id: "dep1", page: 1, crop: null, parent_id: null },
    { id: "dkA1", name: "A구역-1영역", deployment_id: "dep1", page: 1, crop: null, parent_id: "dkA" },
    { id: "dkB", name: "B구역(메인 크롭)", deployment_id: "dep1", page: 1, crop: { x: 50, y: 50, w: 40, h: 40 }, parent_id: null }
  ];
  const pins = [
    { id: 1, x: 10, y: 10, page: 1, label: "1", checkboard: true, author: "kim@seastar.test" },
    { id: 2, x: 20, y: 20, page: 1, label: "2", checkboard: true },
    { id: 3, x: 60, y: 60, page: 1, label: "3", checkboard: true },                                   // B crop 안
    { id: 11, x: 70, y: 70, page: 1, label: "1", imageId: "img_new", shotAt: NOW - 1 * DAY, shotSrc: "EXIF DateTimeOriginal",
      timeline: [{ id: "tl1", imageId: "img_old", shotAt: NOW - 30 * DAY, label: "이전 촬영" }], gps: { lat: 35.1, lng: 129.04, acc: 8 } },   // B 안, 전후 2장
    { id: 12, x: 30, y: 40, page: 1, label: "2", imageId: "img_stale", shotAt: NOW - 40 * DAY },          // A, 오래됨
    { id: 13, x: 35, y: 45, page: 1, label: "3" },                                                        // A, 미촬영
    { id: 14, x: 36, y: 46, page: 1, label: "4", _deleted: true, imageId: "x" }                           // 삭제 — 제외
  ];
  const notes = [
    { id: "n1", kind: "note", pin_id: 11, deployment_id: "dep1", body: "도장 벗겨짐 <script>alert(1)</script>", status: "open", severity: "상", due_at: NOW - 2 * DAY, assignee: "park@seastar.test", author: "lee@seastar.test" },
    { id: "n2", kind: "note", pin_id: 11, deployment_id: "dep1", body: "용접 확인", status: "done", due_at: NOW - 5 * DAY },        // 완료 = 지남 아님
    { id: "n3", kind: "note", pin_id: 12, deployment_id: "dep1", body: "누수", status: "progress", due_at: NOW + 3 * DAY },
    { id: "n4", kind: "request", pin_id: 1, deployment_id: "dep1", body: "사진 추가 요청", status: "open", due_at: NOW - 1 * DAY, author: "viewer@x.test" },
    { id: "n5", kind: "reply", pin_id: 11, deployment_id: "dep1", parent_id: "n1", body: "답변" },                                // 답변 제외
    { id: "n6", kind: "note", pin_id: 11, deployment_id: "dep_other", body: "다른 배포본", status: "open" },                     // 다른 배포본 제외
    { id: "n7", kind: "note", pin_id: 3, deployment_id: "dep1", body: "확인됨", status: "verified" }
  ];
  const deps = { dep1: { pins, zones: [], title: "원본" } };
  return { decks, pins, notes, deps };
}

/* ══ ② sections — 핀 1개 = 구역 1곳(crop 창 우선), 영역 이름, 삭제 제외 ══ */
function sectionsCheck(M) {
  const f = fixture();
  const secs = M.Delivery.sections(f.decks, f.deps, f.decks);
  const ids = (s) => s ? s.items.map((it) => it.pin.id).sort((a, b) => a - b) : null;
  const A = secs.find((s) => s.deck && s.deck.id === "dkA"), B = secs.find((s) => s.deck && s.deck.id === "dkB");
  return { secs, A, B, aIds: ids(A), bIds: ids(B), total: secs.reduce((a, s) => a + s.items.length, 0), areaA: A && A.items.map((it) => it.area) };
}
function testSections() {
  console.log("\n[② Delivery.sections — 구역 귀속(Projects.pinsForDeck SoT)]");
  const r = sectionsCheck(load());
  ok(r.secs.length === 2, "구역 2개(A·B) — 영역(A-1)은 구역이 아니라 이름으로만", r.secs.map((s) => s.title));
  ok(JSON.stringify(r.bIds) === "[3,11]", "B(crop 창) = 창 안 핀(3, 11)만", r.bIds);
  ok(JSON.stringify(r.aIds) === "[1,2,12,13]", "A = 나머지(1,2,12,13), 삭제 핀(14) 제외", r.aIds);
  ok(r.total === 6, "핀 중복 0 — 합계 6 = 살아있는 핀 수", r.total);
  ok(r.areaA.every((a) => a === "A구역-1영역"), "A 핀의 영역 = 같은 배포본 하위 구역 이름", r.areaA);
  ok(r.B.crop && r.B.cropPage === 1 && r.A.crop === null, "B 는 crop·쪽 보유(위치도 잘라 그림), A 는 전체");
  mutationProof("crop 좁은 구역 우선 정렬 제거", mutate("56_Delivery", "const owners = byArea(ds.filter((d) => !isChild(d)));", "const owners = ds.filter((d) => !isChild(d));"),
    (X) => JSON.stringify(sectionsCheck(X).bIds) === "[3,11]");
}

/* ══ ③ buildModel — 번호·촬영현황·결함·기한·사진 전후·GPS·마스킹 ══ */
function modelOf(M, role, info) {
  const f = fixture();
  const secs = M.Delivery.sections(f.decks, f.deps, f.decks);
  return M.Delivery.buildModel({ project: { id: "p", name: "테스트 <프로젝트>" }, info: info || { vessel: "SEASTAR PIONEER", hull: "H.2451", schedule: [] },
    scope: "project", scopeLabel: "프로젝트 전체", author: "작성자", role, now: NOW, staleDays: 14, sections: secs, notes: f.notes, skipped: [{ name: "C구역", reason: "읽기 권한 없음" }] });
}
function testModel() {
  console.log("\n[③ Delivery.buildModel — 요약 수치·마스킹·범위]");
  const M = load();
  const m = modelOf(M, "designer");
  const expectNos = M.PinSeries.numbers(fixture().pins.filter((p) => !p._deleted), 1);
  ok(m.pins.length === 6, "핀 6개(삭제 제외)", m.pins.length);
  const p11 = m.pins.find((p) => p.series === "content" && p.photos.length === 2);
  ok(!!p11 && p11.noText === M.PinSeries.formatNo(expectNos.get(11).no, "content"), "번호 = PinSeries.numbers/formatNo(도면 표시와 동일)", p11 && p11.noText);
  // 🔴 [WO 20261019-unifymode] series = 사진 유무("checkboard" = 사진 없음 · 이름만 호환). 전: 체커 메타 핀 1,2,3 / 후: 사진 없는 핀 1,2,3,13(메타 무관)
  ok(m.pins.filter((p) => p.series === "checkboard").map((p) => p.noText).sort().join(",") === "1,2,3,3", "사진 없음(번호만) = 1,2,3 + 13(번호 3) — 접두 없음·메타 무관", m.pins.map((p) => p.series + ":" + p.noText));
  ok(m.pins.filter((p) => p.series === "content").length === 2 && m.cover.content === 2 && m.cover.checker === 4, "표지 구성 = 사진 있음 2 · 사진 없음 4", m.cover);
  ok(p11 && p11.photos[0].role === "before" && p11.photos[0].imageId === "img_old" && p11.photos[1].role === "after" && p11.photos[1].imageId === "img_new", "사진 이력 → 전(img_old)·후(img_new) 2장(시각순)", p11 && p11.photos);
  ok(p11 && p11.gps && p11.gps.lat === 35.1 && p11.gps.acc === 8, "GPS 포함(값 그대로)");
  ok(p11 && p11.notes.length === 2 && p11.notes.every((n) => n.kind !== "reply"), "핀 노트 = 답변·다른 배포본 제외(2건)", p11 && p11.notes.map((n) => n.body));
  const c = m.summary.cov;
  // 🔴 [WO 20261019-unifymode] 촬영 현황 대상 = 모든 핀(전: 360 계열 3개 → 후: 6개 — 번호만 찍은 1·2·3·13 = 미촬영 4)
  ok(c.total === 6 && c.fresh === 1 && c.stale === 1 && c.none === 4, "촬영 현황(모든 핀) fresh1·stale1·none4 = Coverage.classify", c);
  const d = m.summary.defects;
  ok(d.open === 1 && d.progress === 1 && d.done === 1 && d.verified === 1, "결함 상태 4단계 개수(note 만)", d);
  ok(m.summary.requestsOpen === 1, "요청·질문 미처리 1");
  ok(m.summary.overdue.length === 2 && m.summary.overdue[0].body === "도장 벗겨짐 <script>alert(1)</script>" && m.summary.overdue.every((x) => x.statusLabel !== "완료"),
    "기한 지남 = 미완 + 과거 기한만(완료 제외), 오래된 기한 먼저", m.summary.overdue.map((x) => [x.body, x.due]));
  const secB = m.sections.find((s) => s.title.startsWith("B"));
  ok(secB && secB.counts.total === 2 && secB.pages.length === 1 && secB.pages[0].marks.length === 2, "B 구역 위치도 1장·표식 2개", secB && secB.counts);
  ok(m.cover.vessel === "SEASTAR PIONEER" && m.cover.hull === "H.2451" && m.cover.skipped.length === 1 && m.cover.pinCount === 6, "표지 선명·호선·제외 구역·포인트 수");
  ok(p11.notes[0].assignee === "park@seastar.test", "디자이너 보고서 = 이메일 그대로");
  const v = modelOf(M, "viewer");
  const vn = v.pins.find((p) => p.photos.length === 2).notes[0];
  ok(vn.assignee === "p***" && vn.author === "l***" && v.cover.masked, "열람자 보고서 = 담당·작성 이메일 마스킹(서버 maskEmailsIn 규칙)", [vn.assignee, vn.author]);
  const vhtml = M.Delivery.html(v, () => null, { mode: "bundle" });
  ok(!/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(vhtml), "열람자 HTML 에 이메일 0건");
  ok(M.Requests._isOverdue({ due_at: NOW - 1000, status: "open", kind: "note" }, NOW) && !M.Requests._isOverdue({ due_at: NOW + 1000, status: "open", kind: "note" }, NOW),
    "Requests._isOverdue(n, now) — 기준 시각 인자 반영");
  mutationProof("열람자 마스킹 제거", mutate("56_Delivery", "const viewer = I.role === \"viewer\";", "const viewer = false;"),
    (X) => modelOf(X, "viewer").pins.find((p) => p.photos.length === 2).notes[0].assignee === "p***");
  mutationProof("기한 지남 판정이 now 인자 무시", mutate("42_Requests", "(Number.isFinite(now) ? now : Date.now())", "Date.now()"),
    (X) => !X.Requests._isOverdue({ due_at: 2000, status: "open", kind: "note" }, 1000));   // 기준 시각(1000) 이전 기한 아님 — Date.now() 를 쓰면 지남으로 뒤집힌다
  mutationProof("전후 사진 선택 제거(최신 1장만)", mutate("56_Delivery", "const pick = shots.length >= 2 ?", "const pick = false ?"),
    (X) => modelOf(X, "designer").pins.some((p) => p.photos.length === 2));
}

/* ══ ④ visitOf · html · placeLabels ══ */
function testHtmlAndMisc() {
  console.log("\n[④ 방선 회차 · HTML(A4·쪽번호·이스케이프) · 번호표 겹침 재배치]");
  const M = load();
  const D = M.Delivery;
  const sch = [{ date: "2026-09-01", kind: "방선" }, { date: "2026-10-01", kind: "방선", content: "2차 점검" }, { date: "2026-11-01", kind: "방선" }, { date: "2026-10-05", kind: "회의" }];
  const v = D.visitOf(sch, "2026-10-10");
  ok(v && v.no === 2 && v.total === 3 && v.date === "2026-10-01" && !v.upcoming, "방선 회차 = 오늘까지 지난 방선 수(2/3)", v);
  const v0 = D.visitOf([{ date: "2026-12-01", kind: "방선" }], "2026-10-10");
  ok(v0 && v0.upcoming && v0.no === 1, "지난 방선 없음 → 예정 1회차");
  ok(D.visitOf([{ date: "2026-10-01", kind: "회의" }], "2026-10-10") === null, "방선 일정 없음 → null(지어내지 않음)");
  const m = modelOf(M, "designer", { vessel: "V</style><script>x</script>", hull: "", schedule: sch });
  const html = D.html(m, (k) => (k.indexOf("after") >= 0 ? "photos/" + k + ".jpg" : null), { mode: "bundle" });
  ok(/@page\{size:A4 portrait;margin:/.test(html) && html.indexOf("counter(page)") > 0 && html.indexOf("counter(pages)") > 0, "@page A4 + 쪽번호(counter(page)/counter(pages))");
  ok((html.match(/<\/style>/g) || []).length === 1 && html.indexOf("<script>") < 0, "</style>·<script> 탈출 0(이름·노트 본문 이스케이프)");
  ok(html.indexOf('src="photos/') > 0 && html.indexOf("사진을 불러오지 못했습니다") > 0, "있는 사진 = 상대경로, 없는 사진 = 정직한 빈칸 문구");
  ok(m.pins.every((p) => html.indexOf('data-no="' + p.noText + '"') > 0), "모든 핀 칸 존재(data-no)");
  ok(html.indexOf("2회차 / 총 3회") > 0 && html.indexOf("미입력") > 0, "표지 방선 회차 · 빈 호선 = 미입력");
  ok(html.indexOf("break-inside:avoid") > 0 && html.indexOf(".sec{break-before:page") >= 0, "블록 쪽 나눔 방지 · 절 단위 새 쪽");
  const r = 12;
  const pos = D.placeLabels([{ x: 100, y: 100 }, { x: 102, y: 101 }, { x: 104, y: 99 }, { x: 400, y: 300 }], r, 800, 600);
  let minD = Infinity;
  for (let i = 0; i < pos.length; i++) for (let j = i + 1; j < pos.length; j++) minD = Math.min(minD, Math.hypot(pos[i].x - pos[j].x, pos[i].y - pos[j].y));
  ok(minD >= r * 2.1 - 1e-6 && !pos[0].moved && pos[1].moved && !pos[3].moved, "겹친 번호표만 밀림(최소 간격 ≥ 2.1r)", { minD, pos });
  mutationProof("번호표 재배치 제거", mutate("56_Delivery", "if (hit(best.x, best.y)) {", "if (false) {"),
    (X) => { const p = X.Delivery.placeLabels([{ x: 100, y: 100 }, { x: 102, y: 101 }], 12, 800, 600); return Math.hypot(p[0].x - p[1].x, p[0].y - p[1].y) >= 25; });
  mutationProof("CSS 문자열 꺾쇠 이스케이프 제거", mutate("56_Delivery", '.replace(/</g, "\\\\3c ")', ""),
    (X) => X.Delivery._cssStr("</style>").indexOf("<") < 0);
}

/* ══ ⑤ Report 인쇄 사진 칸 — imageId 를 주소로 쓰던 결함 ══ */
function testReportPhoto() {
  console.log("\n[⑤ Report._printHtml — 사진 주소 = photoSrc(정본 경로), imageId 직접 사용 금지]");
  const M = load();
  const pins = [{ id: "p1", imageId: "img_abc", label: "1" }, { id: "p2", label: "2" }];
  const rows = M.Report._rows(pins, [], [], "designer");
  const h = M.Report._printHtml(rows, pins, "t", (p) => (p.imageId ? "blob:thumb-1" : null));
  ok(h.indexOf('src="blob:thumb-1"') > 0 && h.indexOf('src="img_abc"') < 0, "사진 칸 = photoSrc 결과(blob 축소본), pano id 직접 src 0");
  const h0 = M.Report._printHtml(rows, pins, "t");
  ok(h0.indexOf("<img") < 0, "photoSrc 없으면 깨진 <img> 대신 빈칸");
  mutationProof("photoSrc 무시하고 imageId 를 src 로", mutate("47_Report", 'const photoUrl = (pin && typeof photoSrc === "function") ? photoSrc(pin) : null;', "const photoUrl = pin && pin.imageId;"),
    (X) => { const hh = X.Report._printHtml(rows, pins, "t", () => "blob:thumb-1"); return hh.indexOf('src="img_abc"') < 0; });
}

/* ══ ⑥ ProjectInfo 선명·호선 정규화 ══ */
function testProjectInfo() {
  console.log("\n[⑥ ProjectInfo._normalize — 선명·호선]");
  const M = load();
  const n = M.ProjectInfo._normalize({ note: "m", vessel: "SEASTAR", hull: "H1", schedule: [] });
  ok(n.vessel === "SEASTAR" && n.hull === "H1", "선명·호선 보존");
  const z = M.ProjectInfo._normalize({ vessel: 3 });
  ok(z.vessel === "" && z.hull === "", "문자열 아니면 빈값(지어내지 않음)");
}

/* ══ ⑦ Voice — 상태 판정(숨김 금지·사유)·이어 붙이기(자동 저장 0) ══ */
function voiceCheck(M) {
  const V = M.Voice;
  const u = V.stateOf({ hasApi: false, secure: true, online: true });
  const s = V.stateOf({ hasApi: true, secure: false, online: true });
  const o = V.stateOf({ hasApi: true, secure: true, online: false });
  const l = V.stateOf({ hasApi: true, secure: true, online: true, listening: true });
  const r = V.stateOf({ hasApi: true, secure: true, online: true });
  return { u, s, o, l, r, ok: u.state === "unsupported" && !u.enabled && /지원하지 않습니다/.test(u.reason) &&
    s.state === "insecure" && !s.enabled && /HTTPS/.test(s.reason) &&
    o.state === "offline" && o.enabled && /오프라인/.test(o.reason) &&
    l.state === "listening" && l.enabled && r.state === "ready" && r.enabled && r.reason === "" };
}
function testVoice() {
  console.log("\n[⑦ Voice.stateOf / merge]");
  const M = load();
  const r = voiceCheck(M);
  ok(r.ok, "미지원=비활성+사유 · 비보안=비활성+사유 · 오프라인=활성+경고 · 듣는중 · 준비", r);
  ok(M.Voice.merge("", " 도장 벗겨짐 ") === "도장 벗겨짐" && M.Voice.merge("기존 메모  ", "추가") === "기존 메모 추가" && M.Voice.merge("유지", "  ") === "유지",
    "인식 결과 = 기존 글 뒤에 이어 붙임(덮어쓰기 0)");
  ok(SRC["57_Voice"].indexOf(".submit(") < 0 && SRC["57_Voice"].indexOf("requestSubmit") < 0 && SRC["57_Voice"].indexOf("fetch(") < 0, "음성 모듈에 제출·저장·네트워크 호출 0(채우기만)");
  ok(/rec\.lang = this\.LANG/.test(SRC["57_Voice"]) && /LANG: "ko-KR"/.test(SRC["57_Voice"]), "인식 언어 ko-KR");
  mutationProof("미지원인데 활성", mutate("57_Voice", 'return { state: "unsupported", enabled: false', 'return { state: "unsupported", enabled: true'), (X) => voiceCheck(X).ok);
  mutationProof("merge 가 덮어쓰기", mutate("57_Voice", 'return p.replace(/\\s+$/, "") + " " + t;', "return t;"), (X) => X.Voice.merge("기존 메모", "추가") === "기존 메모 추가");
}

/* ══ ⑧ 배선 — 매니페스트·진입점·음성 대상 ══ */
function testWiring() {
  console.log("\n[⑧ 배선 — 매니페스트 · 진입점 · 음성 대상]");
  const man = rd("public/js/modules/_manifest.txt").split("\n").map((s) => s.trim()).filter(Boolean);
  ok(["55_ZipStore.js", "56_Delivery.js", "57_Voice.js"].every((f) => man.indexOf(f) >= 0 && man.indexOf(f) < man.indexOf("99_footer.js")), "매니페스트에 3모듈(footer 앞)");
  const foot = rd("public/js/modules/99_footer.js"), fm = rd("public/js/modules/45_FeatureMenu.js"), rep = SRC["47_Report"], req = SRC["42_Requests"];
  ok(/Voice\.init\(\)/.test(foot), "footer 에서 Voice.init()");
  ok(/id: "report-delivery"[\s\S]*?Delivery\.open/.test(fm) && /id: "report-bundle"[\s\S]*?Delivery\.bundle/.test(fm), "전체 기능 메뉴 — 납품 보고서·묶음 항목");
  ok(/rpt-delivery-btn/.test(rep) && /rpt-bundle-btn/.test(rep), "보고서 버튼 줄에 납품·묶음 버튼 주입");
  ok((req.match(/Voice\.attach\(ta\)/g) || []).length === 2, "요청·질문/답변 입력칸에 음성 버튼(2곳)");
  ok(/TARGETS: \["input-pin-note", "pnp-input"\]/.test(SRC["57_Voice"]), "노트(#input-pin-note)·결함(#pnp-input) 대상");
  const html = rd("public/index.html");
  ok(html.indexOf('id="input-pin-note"') > 0 && html.indexOf('id="pnp-input"') > 0, "대상 입력칸이 index.html 에 존재");
}

testZip();
testSections();
testModel();
testHtmlAndMisc();
testReportPhoto();
testProjectInfo();
testVoice();
testWiring();
console.log("\n" + (failed ? "FAIL " + failed + "건" : "ALL PASS"));
process.exit(failed ? 1 : 0);
