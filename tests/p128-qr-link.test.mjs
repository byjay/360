/**
 * p128 — WO 20261007-qrcov 요구 A: QR 위치 태그(딥링크 파서 · 권한 게이트 · QR 인쇄 칸)
 * (프레임워크 0 · 실행: node tests/p128-qr-link.test.mjs)
 *
 * [재현: 해당없음 — 신규 기능] 지휘자 R1·R2(2026-10-07, HEAD 869ba0e): QR 생성 0, 핀·구역 딥링크 파라미터 0.
 * 🔴 목 금지 — 50_QrLink.js 와 협력 SoT(22_Auth.refresh/_isViewLink · 31_Projects.pinsForDeck · 01b_PinSeries · 47_Report 인쇄 창 ·
 *   vendor/qrcode.js) 실제 소스를 vm 에서 실행(tests/_lib/qrcov-harness.mjs). 뮤테이션은 이 파일 안에서 소스를 바꿔 재실행.
 *   가짜 = 브라우저 셸 + 진입 협력자 스파이(ProjectHub.openProjectAtDeck = 실제처럼 "디자이너가 아니면 게이트만, 로드 0").
 */
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { readSources, makeBoot, runMutations, tick, DAY } from "./_lib/qrcov-harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = readSources(ROOT);

/** src: 소스 묶음(뮤테이션 시 일부 교체). 반환 = 실패 라벨 배열. quiet=true 면 PASS 출력 생략(뮤테이션 재실행). */
async function suite(src, quiet) {
  const fails = [];
  const ok = (cond, label) => { if (!quiet) console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) fails.push(label); };
  const boot = makeBoot(src);
  /* ── A1 딥링크 파서 ── */
  {
    const { X } = boot("");
    const D = X.DeepLink;
    const a = D.parse("?qp=proj_1&qk=dck_A&qpin=pin_7");
    ok(a && a.project === "proj_1" && a.deck === "dck_A" && a.pin === "pin_7", "A1 파서 — qp·qk·qpin 3종");
    const b = D.parse("?qp=proj_1");
    ok(b && b.deck === null && b.pin === null, "A1 파서 — 프로젝트만(구역·핀 생략)");
    ok(D.parse("?qk=dck_A&qpin=pin_7") === null, "A1 파서 — qp 없으면 딥링크 아님");
    ok(D.parse("?qp=a%3Cscript%3E") === null && D.parse("?qp=proj_1&qpin=x%22y") === null, "A1 파서 — ID 형식 밖(<, \") 거부");
    ok(D.parse("?d=dep9&qp=proj_1&qpin=pin_7") === null, "A1 🔴 d(열람 링크)와 함께면 무시 — 그 게이트가 정본");
    ok(D.parse("?invite=tok&qp=proj_1") === null, "A1 🔴 초대 토큰과 함께면 무시");
    const url = D.build("https://scan.example/", { project: "proj_1", deck: "dck_A", pin: "pin_7" });
    ok(url === "https://scan.example/?qp=proj_1&qk=dck_A&qpin=pin_7", "A1 build — " + url);
    const back = D.parse(new URL(url).search);
    ok(back && back.pin === "pin_7" && back.deck === "dck_A", "A1 build→parse 왕복");
    const EXIST = ["d", "akey", "shared", "invite", "mode", "demo360", "t"];
    ok(Object.values(D.PARAMS).every((k) => !EXIST.includes(k)), "A1 파라미터 이름이 기존(d·akey·shared·invite·mode·demo360·t)과 충돌 0");
  }

  /* ── A2 열람 자동입장 우회 0 — Auth._isViewLink 는 딥링크를 열람 링크로 보지 않는다 ── */
  {
    const { X } = boot("?qp=proj_1&qk=dck_A&qpin=pin_7");
    ok(X.Auth._isViewLink() === false, "A2 🔴 딥링크만으로는 열람 자동입장(_autoDesignerEntry) 조건이 아니다");
    const { X: X2 } = boot("?d=dep9");
    ok(X2.Auth._isViewLink() === true, "A2 대조 — ?d= 는 열람 링크(기존 동작 유지)");
    const f = src.footer;
    const iDep = f.indexOf("} else if (depId) {"), iShare = f.indexOf("if (shareTok) {"), iDl = f.indexOf("DeepLink.boot()");
    ok(iShare >= 0 && iDep > iShare && iDl > iDep, "A2 🔴 99_footer — 딥링크 분기는 공유 토큰·?d= 분기 **뒤**(else-if 사슬, 그 게이트를 못 건너뜀)");
  }

  /* ── A3 비로그인 → 로그인 게이트 → 로그인 후 원래 딥링크 복귀(Auth.refresh 단일 지점) ── */
  {
    const { X, S, L } = boot("?qp=proj_1&qk=dck_A&qpin=pin_7");
    const r = await X.DeepLink.boot();
    ok(r === true && L.hubOpen === 1, "A3 boot — 허브를 열고 딥링크 보류");
    ok(L.opened.length === 0 && L.popped.length === 0, "A3 🔴 비로그인 — 프로젝트 진입·팝업 0(게이트는 Auth.init 이 띄움)");
    ok(L.toasts.some((t) => /로그인/.test(t)), "A3 비로그인 안내 토스트");
    X.Auth.idToken = "tok";
    await X.Auth.refresh();                 // 로그인 완료(모든 로그인 경로가 거치는 단일 지점)
    await tick(5); for (let i = 0; i < 40 && !L.popped.length; i++) await tick(10);
    ok(L.opened.length === 1 && L.opened[0][0] === "proj_1" && L.opened[0][1] === "dck_A", "A3 로그인 후 기존 진입(openProjectAtDeck) — 프로젝트·구역 그대로");
    ok(L.focused[0] === "pin_7" && L.popped[0] === "pin_7" && S.activePin === "pin_7", "A3 핀 중앙(App.focusPin)·강조·팝업(PinActionPop.open)");
    ok(L.urls.length === 0, "A3 성공 시 주소 유지(SW 제어권 새로고침에도 같은 핀 — 실측 근거는 50_QrLink _cleanUrl 주석)");
    const again = await X.DeepLink.resumePending();
    ok(again === null && L.opened.length === 1, "A3 보류 1회용 — 다시 로그인 확인돼도 재실행 0");
  }

  /* ── A4 무권한 — 비멤버(잠금 카드) = 기존 접근 신청 / 목록에 없음 = 사유 안내 / 비디자이너 = 기존 게이트 ── */
  {
    const { X, L } = boot("?qp=proj_1&qpin=pin_7", { list: [{ id: "proj_1", name: "남의 배", is_member: false }] });
    X.Auth.role = "designer"; X.Auth.user = { email: "d@x.com" };
    const r = await X.DeepLink.run({ project: "proj_1", deck: null, pin: "pin_7" });
    ok(r === "locked" && L.access[0] === "proj_1" && L.opened.length === 0 && L.popped.length === 0, "A4 🔴 비멤버 → 기존 접근 신청 창, 진입 0 (" + r + ")");
    ok(L.urls.length === 1 && !/qp=/.test(L.urls[0]), "A4 열 수 없는 QR 은 주소에서 제거(새로고침마다 신청 창 반복 0)");
  }
  {
    const { X, L } = boot("", { list: [{ id: "proj_other", is_member: true }] });
    X.Auth.role = "designer"; X.Auth.user = { email: "d@x.com" };
    const r = await X.DeepLink.run({ project: "proj_1", deck: null, pin: "pin_7" });
    ok(r === "missing" && L.opened.length === 0 && L.toasts.some((t) => /권한/.test(t)), "A4 목록에 없음(403/삭제) → 진입 0 + 사유 토스트");
  }
  {
    const { X, L } = boot("", { me: { authenticated: true, email: "v@x.com", role: "viewer" } });
    X.Auth.role = "viewer"; X.Auth.user = { email: "v@x.com" };
    const r = await X.DeepLink.run({ project: "proj_1", deck: "dck_A", pin: "pin_7" });
    ok(r === "gated" && L.gate === 1 && L.popped.length === 0 && L.focused.length === 0, "A4 🔴 비디자이너 → 기존 requireDesigner 게이트, 핀·팝업 노출 0 (" + r + ")");
  }

  /* ── A5 [WO 20261015-numunify 계약 변경] 핀 계열 ≠ 활성 모드여도 모드 전환 없음(모드가 가시성을 잠그지 않는다) → 바로 팝업
         전·후 대조: 종전 L.modes[0]==="checkboard"(전환 후 팝업) → 새 L.modes.length===0(전환 0) / 없는 핀 = 정직 안내 ── */
  {
    const { X, S, L } = boot("", { pins: [{ id: "pin_c", x: 5, y: 5, page: 1, checkboard: true }] });
    X.Auth.role = "designer"; X.Auth.user = { email: "d@x.com" };
    const r = await X.DeepLink.run({ project: "proj_1", deck: "dck_A", pin: "pin_c" });
    await tick(80);
    ok(r === "opened" && L.modes.length === 0 && L.popped[0] === "pin_c", "A5 CHECKER 핀 → 모드 전환 없이 바로 팝업(전환 " + L.modes.length + "회)");
    ok(S.placing === false, "A5 스캔 직후 배치모드 꺼짐(지도 탭이 새 핀을 만들지 않음)");
    const r2 = await X.DeepLink.run({ project: "proj_1", deck: "dck_A", pin: "pin_gone" });
    ok(r2 === "pin-missing" && L.toasts.some((t) => /찾을 수 없/.test(t)), "A5 없는 핀 → 안내(지어내지 않음)");
  }

  /* ── Q1~Q4 QR 인쇄 ── */
  {
    const pins = Array.from({ length: 13 }, (_, i) => ({ id: "p" + i, x: 10 + i, y: 10, page: 1, label: "L" + i }));
    pins.push({ id: "out", x: 90, y: 90, page: 1, label: "크롭 밖" });
    const { X, S, ctx, L } = boot("", { pins });
    S.pins = pins;
    const deck = { id: "dck_A", name: "A구역", deployment_id: "dep1", page: 1, crop: { x: 0, y: 0, w: 50, h: 50 } };
    X.Projects.currentProject = { id: "proj_1", name: "선박A" }; X.Projects.currentDeck = deck;
    const Q = X.QrPrint;
    ok(Q.PER_PAGE === 12, "Q1 A4 한 장 = 3×4 = 12칸");
    ok(Q.pageCount(0) === 0 && Q.pageCount(12) === 1 && Q.pageCount(13) === 2 && Q.pageCount(25) === 3, "Q1 페이지 수 0/12/13/25 → 0/1/2/3");
    const dp = Q.deckPins(deck);
    ok(dp.length === 13 && !dp.some((p) => p.id === "out"), "Q2 구역 핀 = Projects.pinsForDeck(크롭 밖 제외) 13");
    const cells = Q.cells({ origin: "https://scan.example", project: X.Projects.currentProject, deck, pins: dp, includeDeck: true, numOf: (p) => Q._numOf(p) });
    ok(cells.length === 14 && cells[0].kind === "deck" && cells.slice(1).every((c) => c.kind === "pin"), "Q2 칸 수 = 구역 1 + 핀 13 = 14");
    const c5 = cells.find((c) => c.label === "L5");
    const pp = X.DeepLink.parse(new URL(c5.url).search);
    ok(pp && pp.project === "proj_1" && pp.deck === "dck_A" && pp.pin === "p5", "Q2 칸 URL = 그 핀 딥링크");
    ok(cells.every((c) => c.deckName === "A구역") && cells.slice(1).every((c) => c.no), "Q2 칸마다 번호·라벨·구역명");
    const svg = Q.svgFor(ctx.qrcode, cells[1].url);
    const vb = /viewBox="0 0 (\d+) (\d+)"/.exec(svg);
    const modules = vb ? (Number(vb[1]) - 16) / 4 : 0;   // cellSize 4, margin 8
    ok(/^<svg/.test(svg) && Number.isInteger(modules) && modules >= 21 && (modules - 17) % 4 === 0, "Q3 vendor qrcode — 유효 QR 모듈 수 " + modules + "(=4·버전+17)");
    const ok1 = await Q.printDeck(deck);
    const html = L.printed.length ? L.printed[L.printed.length - 1].document.html : "";
    ok(ok1 === true && (html.match(/class="qr-page"/g) || []).length === 2 && (html.match(/class="qr-cell"/g) || []).length === 14, "Q4 printDeck — A4 2장 · 14칸(Report 인쇄 창 재사용)");
    ok((html.match(/<svg/g) || []).length === 14 && /@page\{size:A4 portrait/.test(html), "Q4 칸마다 QR SVG · A4 세로");
    const other = { id: "dck_B", name: "B", deployment_id: "dep2" };
    ok(/먼저 여세요/.test(Q.deckReason(other)) && Q.deckReason(deck) === "", "Q4 미로드 구역 = 비활성 사유(0 날조 금지)");
    const okPin = await Q.printPin(dp[0]);
    const h1 = L.printed[L.printed.length - 1].document.html;
    ok(okPin === true && (h1.match(/class="qr-cell"/g) || []).length === 1, "Q4 핀 팝업 [QR] = 1칸");
  }
  {
    const { X, L } = boot("", { blockPopup: true });
    X.Projects.currentProject = { id: "proj_1" };
    const r = await X.QrPrint.printPin({ id: "p1", page: 1 });
    ok(r === false && L.toasts.some((t) => /팝업/.test(t)), "Q4 팝업 차단 → 안내(조용한 실패 0)");
  }

  /* ── W 배선(QR) — 렌더 고아 0 ── */
  {
    ok(/50_QrLink\.js/.test(src.manifest), "W manifest 에 50_QrLink");
    ok(/QrPrint\.printDeck\(deck\)/.test(src.uiSrc), "W 11_UI — 구역 ⋯ [이 구역 QR 일괄 인쇄]");
    ok(/id: "qr-deck"/.test(src.menu), "W 45_FeatureMenu — QR 일괄 인쇄 등록");
    ok(/"qr-tag":/.test(src.help), "W 36_Help — qr-tag 문구");
    ok(/DeepLink\.resumePending/.test(src.auth) && /QrPrint\.init\(\)/.test(src.footer), "W Auth.refresh 복귀 훅 · 핀 팝업 [QR] 주입");
  }
  return fails;
}

const MUT = [
  ["M1 파서의 d/invite 양보 제거", "qr", "for (const k of this.YIELD_TO) { if (q.get(k)) return null; }", ""],
  ["M2 비멤버 잠금 판정 제거", "qr", 'if (p.is_member === false) return { kind: "locked", project: p };', ""],
  ["M3 비디자이너 gated 중단 제거", "qr", 'if (!(typeof Auth !== "undefined" && Auth.isDesigner)) return "gated";', ""],
  ["M4 Auth.refresh 복귀 훅 제거", "auth", "if (typeof DeepLink !== \"undefined\" && DeepLink.resumePending) setTimeout(", "if (false) setTimeout("],
  ["M5 구역 QR 칸 제외", "qr", "if (o.includeDeck && deck && deck.id) {", "if (false) {"],
  ["M9 딥링크 분기를 ?d= 앞으로", "footer", "    if (shareTok) {", "    if (false) { DeepLink.boot(); } else if (shareTok) {"],
  // [WO 20261015-numunify] 옛 "계열 모드로 전환" 복구 → A5(전환 0) 가 실패해야 한다
  ["M10 QR 핀 계열 모드 전환 복구", "qr", "      await App.focusPin(pin, false);", "      if (App._setRegMode) App._setRegMode(\"checkboard\");\n      await App.focusPin(pin, false);"]
];
const fails = await suite(BASE, false);
const mutBad = await runMutations(BASE, MUT, suite);
const total = fails.length + mutBad;
console.log(total ? "\n" + total + " FAIL" : "\nALL PASS");
process.exit(total ? 1 : 0);
