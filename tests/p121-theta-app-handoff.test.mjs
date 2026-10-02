/**
 * p121 — WO 20261002-allmenu §7 (RICOH THETA 앱 바로 열기) + §8 (THETA → SEASTAR "어디에 등록?" → 포인트 탭 → 등록)
 * (프레임워크 0 · 실행: node tests/p121-theta-app-handoff.test.mjs)
 *
 * [재현] 지휘자 R3/R4: `git grep -n -E "com\.theta360|intent://|id1023254741" HEAD -- public | wc -l` → 0 (앱 열기 진입점 없음) → FAIL.
 * [재현] 지휘자 R5: sw.js 공유 POST → 항상 `Response.redirect('./?shared=1')`(실행 중 창 검사 없음), ThetaIntake.handleShared 는
 *   자동 인입만("어디에 등록 → 포인트 탭 → 등록" 없음) → FAIL.
 *
 * 🔴 목 금지 — 33_ThetaIntake.js · public/sw.js 실제 소스를 vm 에 실행. 가짜는 브라우저 경계(navigator/localStorage/
 *   caches/clients/DOM 셸)와 협력자(App._placeCheckboardPin · PhotoBatch._uploadOneRow 스파이)뿐.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const tiSrc = rd("public/js/modules/33_ThetaIntake.js");
const swSrc = rd("public/sw.js");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };
const tick = async (n = 8) => { for (let i = 0; i < n; i++) await new Promise((r) => setTimeout(r, 0)); };

function makeEl(tag) {
  const set = new Set();
  const el = {
    tagName: tag, id: "", style: {}, dataset: {}, attrs: {}, children: [], parentNode: null, _l: {}, textContent: "", innerHTML: "",
    classList: { add: (...c) => c.forEach((x) => set.add(x)), remove: (...c) => c.forEach((x) => set.delete(x)), contains: (c) => set.has(c),
      toggle(c, f) { if (f === undefined) f = !set.has(c); if (f) set.add(c); else set.delete(c); return f; } },
    get className() { return Array.from(set).join(" "); }, set className(v) { set.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => set.add(c)); },
    appendChild(c) { el.children.push(c); c.parentNode = el; return c; },
    insertBefore(n, ref) { const i = el.children.indexOf(ref); if (i >= 0) el.children.splice(i, 0, n); else el.children.push(n); n.parentNode = el; return n; },
    removeChild(c) { const i = el.children.indexOf(c); if (i >= 0) el.children.splice(i, 1); c.parentNode = null; return c; },
    remove() { if (el.parentNode) el.parentNode.removeChild(el); },
    get nextSibling() { if (!el.parentNode) return null; const a = el.parentNode.children; return a[a.indexOf(el) + 1] || null; },
    setAttribute(k, v) { el.attrs[k] = String(v); }, getAttribute(k) { return el.attrs[k]; },
    addEventListener(t, f) { (el._l[t] = el._l[t] || []).push(f); }, removeEventListener(t, f) { const a = el._l[t] || []; const i = a.indexOf(f); if (i >= 0) a.splice(i, 1); },
    fire(t, ev) { (el._l[t] || []).slice().forEach((f) => f(ev || {})); },
    click() { el.fire("click", { stopPropagation() {}, preventDefault() {} }); },
    closest() { return null; }, querySelector() { return null; }, querySelectorAll() { return []; }
  };
  return el;
}

function loadTI({ ua = "", platform = "", touch = 0, live = true, pins = [], decks = [] } = {}) {
  const reg = new Map();
  const body = makeEl("body");
  const bar = makeEl("div"); const more = makeEl("button"); more.id = "mdock-more-toggle"; reg.set(more.id, more); bar.appendChild(more);
  const hintParent = makeEl("div"); const hint = makeEl("div"); hint.id = "pap-reg-mobile-hint"; reg.set(hint.id, hint); hintParent.appendChild(hint);
  const vp = makeEl("div"); vp.id = "map-viewport"; reg.set(vp.id, vp);
  const store = new Map();
  const docL = {};
  const document = {
    body, visibilityState: "visible",
    getElementById: (id) => reg.get(id) || findById(body, id) || null,
    createElement: (t) => { const e = makeEl(t); return new Proxy(e, { set(o, k, v) { o[k] = v; if (k === "id") reg.set(v, e); return true; } }); },
    querySelector: (s) => (s === "#mobile-dock .mdock-bar" ? bar : null),
    addEventListener(t, f) { (docL[t] = docL[t] || []).push(f); }, removeEventListener() {},
    fire(t) { (docL[t] || []).forEach((f) => f({})); }
  };
  function findById(n, id) { for (const c of n.children || []) { if (c.id === id) return c; const f = findById(c, id); if (f) return f; } return null; }
  const calls = { go: [], toast: [], upload: [], placed: [], auto: [], setMode: [], persist: 0 };
  const State = { mode: live ? "designer" : "viewer", regMode: "photo", fileType: live ? "pdf" : null, pins: pins.slice() };
  const sandbox = {
    console, document, setTimeout, clearTimeout, URLSearchParams, Date, JSON, Math, Number, String, Array, Object, Promise, Set, Map,
    location: { search: "", href: "http://x/", pathname: "/" }, history: { replaceState() {} },
    navigator: { userAgent: ua, platform, maxTouchPoints: touch, onLine: true },
    localStorage: { getItem: (k) => (store.has(k) ? store.get(k) : null), setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) },
    URL: { createObjectURL: () => "blob:x", revokeObjectURL() {} },
    window: {}, State,
    Projects: live ? { currentProject: { id: "p" }, currentDeck: { id: "d1", name: "기관실" }, decks, selectDeck: async (d) => { sandbox.Projects.currentDeck = d; } } : { currentProject: null, decks: [] },
    Prompt: { toast: (m) => calls.toast.push(m) },
    UI: { renderPinList() {}, renderPinsOnMap() {}, escapeHtml: (s) => s },
    MapCtrl: { viewportToPercent: (x, y) => ({ x: x / 10, y: y / 10 }) },
    App: {
      _setRegMode: (m) => { calls.setMode.push(m); State.regMode = m; },
      _placeCheckboardPin: (pct) => { const p = { id: 900 + calls.placed.length, x: pct.x, y: pct.y, page: 1, label: "P" + (calls.placed.length + 1) }; calls.placed.push(p); State.pins.push(p); return p; }
    },
    PhotoBatch: {
      buildAutoRows: async (files) => files.map((f, i) => ({ file: f, name: f.name, is360: true, sortKey: f._t || i, timeLabel: "2026-10-02 10:0" + i })),
      recentFirst360: (rows) => rows.slice().sort((a, b) => b.sortKey - a.sortKey),
      _usedPhotoNames: () => new Set(),
      _uploadOneRow: async (pin, row, overwrite, used, src) => { calls.upload.push({ pinId: pin.id, name: row.name, overwrite, src }); return { status: "done", offline: false }; },
      _markUnsaved() {},
      autoConnectPin: (pin) => calls.auto.push(pin.id)
    },
    SyncQueue: { saveDraft: async () => { calls.persist++; }, loadDraft: async () => null },
    FileReader: class { readAsDataURL(f) { this.result = "data:image/jpeg;base64,QUJD"; setTimeout(() => this.onload && this.onload(), 0); } },
    File: class { constructor(parts, name, o) { this.name = name; this.type = (o && o.type) || "image/jpeg"; } },
    atob: (s) => Buffer.from(s, "base64").toString("binary"), Uint8Array
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(tiSrc + "\n;globalThis.__TI = ThetaIntake;", sandbox);
  const TI = sandbox.__TI;
  TI._is360 = async () => true;       // 2:1 판정은 이미지 디코더(브라우저 경계) — 여기선 통과로 고정
  TI._go = (u) => calls.go.push(u);
  return { TI, State, calls, document, body, bar, hintParent, vp, store, sandbox };
}

/* ══ §7 RICOH THETA 앱 바로 열기 ══ */
console.log("\n[§7 THETA 앱 열기 — URL SoT · 플랫폼별]");
{
  const A = loadTI({ ua: "Mozilla/5.0 (Linux; Android 14; SM-S918N) Chrome/129 Mobile" });
  const url = A.TI.appUrl(A.TI.platformOf(A.sandbox.navigator));
  ok(/^intent:\/\/#Intent;/.test(url) && /package=com\.theta360;/.test(url), "§7-1 Android UA → intent URL(package=com.theta360) → " + url);
  ok(url.indexOf("S.browser_fallback_url=" + encodeURIComponent("https://play.google.com/store/apps/details?id=com.theta360")) >= 0 && /;end$/.test(url), "§7-2 미설치 폴백 = Play 스토어(인코딩) + ;end");
  A.TI.openApp({ pinId: 7 });
  ok(A.calls.go[0] === url, "§7-3 openApp → 그 URL 로 이동");
  const w = JSON.parse(A.store.get("theta_app_wait_v1"));
  ok(w && Number.isFinite(w.at) && w.pinId === 7, "§7-4 대기 플래그(시각 + 대상 핀) 저장");
  const I = loadTI({ ua: "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) Safari/604.1" });
  ok(I.TI.appUrl(I.TI.platformOf(I.sandbox.navigator)) === "https://apps.apple.com/app/ricoh-theta/id1023254741", "§7-5 iPhone UA → App Store URL(id1023254741, 스킴 추측 없음)");
  const iPad = loadTI({ ua: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Safari/605", platform: "MacIntel", touch: 5 });
  ok(iPad.TI.platformOf(iPad.sandbox.navigator) === "ios", "§7-6 iPadOS(MacIntel+터치) → iOS 취급");
  const D = loadTI({ ua: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/129" });
  ok(D.TI.appDisabledReason(D.sandbox.navigator) === "휴대폰에서 사용" && D.TI.openApp() === false && D.calls.go.length === 0, "§7-7 데스크톱 → 비활성 사유 '휴대폰에서 사용', 이동 0");
  // 버튼: 도크(360 모드) + 핀 사진 시트 — 숨김 금지(데스크톱은 비활성 + 사유)
  A.TI.mountAppButtons();
  const chip = A.bar.children.find((c) => c.id === "mdock-theta-app");
  ok(!!chip && A.bar.children.indexOf(chip) < A.bar.children.indexOf(A.document.getElementById("mdock-more-toggle")) && !chip.classList.contains("hidden"), "§7-8 360 모드 모바일 도크에 [RICOH THETA 앱 열기] 칩(더보기 앞, 보임)");
  ok(/RICOH THETA 앱 열기/.test(chip.innerHTML) && /THETA 앱에서 촬영 → 돌아와 사진 선택/.test(chip.innerHTML), "§7-9 문구: RICOH THETA 앱 열기 + 'THETA 앱에서 촬영 → 돌아와 사진 선택'");
  const pap = A.hintParent.children.find((c) => c.id === "pap-theta-app");
  ok(!!pap, "§7-10 핀 사진 선택 시트(#pap-reg-mobile-hint 아래)에도 같은 버튼");
  D.TI.mountAppButtons();
  const dchip = D.bar.children.find((c) => c.id === "mdock-theta-app");
  ok(dchip && dchip.attrs["aria-disabled"] === "true" && /휴대폰에서 사용/.test(dchip.innerHTML), "§7-11 데스크톱: 버튼은 남고 비활성 + 사유");
}

/* ══ §7·§8② 앱에서 돌아옴 — visible + 유효 플래그 → 복귀 시트 / 만료 → 없음 ══ */
console.log("\n[§8② 복귀 — 대기 플래그 10분]");
{
  const A = loadTI({ ua: "Android", pins: [{ id: 7, label: "12" }] });
  A.TI.openApp({ pinId: 7 });
  A.document.fire("visibilitychange");      // init 안 했으므로 직접 호출 경로도 확인
  A.TI.onVisibility();
  const sheet = A.document.getElementById("theta-return-sheet") || A.body.children.find((c) => c.id === "theta-return-sheet");
  ok(!!sheet, "§8-1 복귀(visible) + 유효 플래그 → 복귀 시트 표시");
  ok(!A.store.has("theta_app_wait_v1"), "§8-2 플래그는 1회성(꺼낼 때 삭제)");
  const pickBtn = sheet.children.find((c) => c.textContent === "사진 선택");
  pickBtn.click();
  ok(A.calls.auto[0] === 7, "§8-3 핀 시트에서 열었으면 [사진 선택] = 기존 최근 360 추천(PhotoBatch.autoConnectPin) 그대로");
  const B = loadTI({ ua: "Android" });
  B.store.set("theta_app_wait_v1", JSON.stringify({ at: Date.now() - 11 * 60 * 1000, pinId: null }));
  B.TI.onVisibility();
  ok(!B.body.children.some((c) => c.id === "theta-return-sheet"), "§8-4 대기 플래그 만료(11분) 후 복귀 → 시트 없음");
  const C = loadTI({ ua: "Android" });
  C.TI.onVisibility();
  ok(!C.body.children.some((c) => c.id === "theta-return-sheet"), "§8-5 THETA 를 열지 않았으면 → 시트 없음");
}

/* ══ §8 공통 흐름 — 두 앱 실행 중일 때만 / 기존 핀 = 이력 추가 / 빈 곳 = 360 핀 생성 ══ */
console.log("\n[§8 어디에 등록 → 포인트 탭 → 등록]");
const F = (name, t) => { const f = { name, type: "image/jpeg", _t: t }; return f; };
{
  const N = loadTI({ ua: "Android", live: false });
  const r = await N.TI.receive([F("R0010001.JPG", 1)], { source: "share" });
  ok(r.started === false && r.stored === 1 && N.TI._pending.length === 1, "§8-6 도면 미개방(실행 중 아님) → 자동 흐름 미시작 + 트레이 보관");
  ok(N.calls.toast.some((t) => /도면을 연 뒤 \[받은 사진 등록\]/.test(t)) && !N.body.children.some((c) => c.id === "theta-where-sheet"), "§8-7 안내 토스트, '어디에 등록' 시트 없음");
}
{
  const pinOld = { id: 5, x: 30, y: 30, page: 1, label: "3", imageId: "img-old" };
  const L = loadTI({ ua: "Android", pins: [pinOld], decks: [{ id: "d1", name: "기관실" }, { id: "d2", name: "갑판" }] });
  L.State.regMode = "checkboard";
  const r = await L.TI.receive([F("old.JPG", 100), F("new.JPG", 200)], { source: "share" });
  ok(r.started === true, "§8-8 편집 화면 + 열린 도면 → 자동 흐름 시작");
  let where = L.body.children.find((c) => c.id === "theta-where-sheet");
  ok(!!where && /남은 2장/.test(where.children[0].textContent) && /new\.JPG/.test(where.children.find((c) => c.className === "theta-sheet-body").textContent), "§8-9 '어디에 등록할까요?(남은 2장)' — 최신(new.JPG) 먼저, 촬영시각 표시");
  ok(where.children.some((c) => /^현재 구역·영역에 등록 — 기관실/.test(c.textContent)) && where.children.some((c) => c.textContent === "다른 구역 선택") && where.children.some((c) => c.textContent === "취소"), "§8-10 선택지: 현재 구역·영역(기본) / 다른 구역 / 취소");
  where.children.find((c) => /^현재 구역/.test(c.textContent)).click();
  ok(L.calls.setMode[0] === "photo", "§8-11 360 모드로 전환(SoT App._setRegMode)");
  const banner = L.body.children.find((c) => c.id === "theta-tap-banner");
  ok(!!banner && /등록할 포인트를 탭하세요/.test(banner.innerHTML) && banner.children.some((c) => c.textContent === "취소"), "§8-12 '등록할 포인트를 탭하세요' 배너 + [취소]");
  // 기존 핀 탭 → 그 핀에 등록(overwrite → 이력 적립 경로)
  const marker = { dataset: { id: "5" }, getAttribute: () => "5" };
  L.vp.fire("click", { target: { closest: () => marker }, clientX: 0, clientY: 0, stopPropagation() {}, preventDefault() {} });
  await tick();
  ok(L.calls.upload[0] && L.calls.upload[0].pinId === 5 && L.calls.upload[0].overwrite === true && L.calls.upload[0].name === "new.JPG", "§8-13 기존 핀 탭 → 그 핀에 등록(overwrite=true → PhotoNaming.pushHistory 이력 적립 경로)");
  ok(L.calls.placed.length === 0, "§8-14 기존 핀 탭은 새 핀을 만들지 않는다");
  ok(!L.body.children.some((c) => c.id === "theta-tap-banner"), "§8-15 등록 후 배너 해제");
  where = L.body.children.find((c) => c.id === "theta-where-sheet");
  ok(!!where && /old\.JPG/.test(where.children.find((c) => c.className === "theta-sheet-body").textContent), "§8-16 여러 장 → 다음 사진(old.JPG)으로 같은 흐름 반복");
  where.children.find((c) => /^현재 구역/.test(c.textContent)).click();
  L.vp.fire("click", { target: { closest: () => null }, clientX: 420, clientY: 610, stopPropagation() {}, preventDefault() {} });
  await tick();
  ok(L.calls.placed.length === 1 && L.calls.placed[0].x === 42 && L.calls.placed[0].y === 61, "§8-17 빈 곳 탭 → 그 위치(%)에 360 핀 생성(App._placeCheckboardPin — 대역 번호 규칙)");
  ok(L.calls.upload[1] && L.calls.upload[1].pinId === L.calls.placed[0].id && L.calls.upload[1].name === "old.JPG", "§8-18 새 핀에 사진 바로 등록");
  ok(L.TI._pending.length === 0, "§8-19 등록 끝난 사진은 트레이에서 제거(유실 없이 소비)");
  ok(L.calls.toast.filter((t) => /등록$|등록 \(/.test(t)).length >= 2, "§8-20 완료 토스트");
}
{
  const X = loadTI({ ua: "Android" });
  await X.TI.receive([F("a.JPG", 1)], {});
  X.body.children.find((c) => c.id === "theta-where-sheet").children.find((c) => c.textContent === "취소").click();
  ok(X.TI._pending.length === 1 && X.calls.toast.some((t) => /트레이에 남아/.test(t)), "§8-21 취소 → 사진은 트레이에 남는다(조용히 버리지 않음)");
}

/* ══ §8① SW 공유 — 실행 중 창 있으면 postMessage(리로드 없음), 없으면 ?shared=1 로 열기 ══ */
console.log("\n[§8① sw.js 공유 핸드오프 — 실제 sw.js]");
function loadSW() {
  const sb = {
    self: { addEventListener() {}, clients: null, skipWaiting() {} }, caches: { open: async () => ({}) }, console,
    Response: class { constructor(body, init) { this.body = body; this.status = (init && init.status) || 200; this.headers = (init && init.headers) || {}; } static redirect(u, s) { const r = new sb.Response(null, { status: s }); r.redirectTo = u; return r; } },
    Request: class {}, URL, Date, JSON, Promise, Array, Object
  };
  vm.createContext(sb);
  vm.runInContext(swSrc + "\n;globalThis.__H = shareHandoffResponse;", sb);
  return sb;
}
{
  const sb = loadSW();
  const posted = [], focused = [];
  const win = (id, f) => ({ id, focused: f, postMessage: (m) => posted.push([id, m]), focus: async () => focused.push(id) });
  const res = await sb.__H({ resultingClientId: "new" }, { matchAll: async () => [win("a", false), win("b", true), win("new", false)] });
  ok(res.status === 200 && !res.redirectTo, "§8-22 실행 중 창 있음 → 리다이렉트(앱 새로 열기/리로드) 없음");
  ok(posted.length === 1 && posted[0][0] === "b" && posted[0][1].type === "theta-shared" && focused[0] === "b", "§8-23 최근 포커스 창 1개에만 postMessage + focus(새로 생기는 창 제외)");
  ok(/열려 있는 SEASTAR 창으로 보냈습니다/.test(res.body), "§8-24 새 창에는 안내 페이지만");
  const res2 = await sb.__H({ resultingClientId: "new" }, { matchAll: async () => [win("new", false)] });
  ok(res2.redirectTo === "./?shared=1" && res2.status === 303, "§8-25 다른 창 없음 → 종전대로 ./?shared=1 로 연다(부팅 직후는 도면 미개방 → 보관+안내)");
}
ok(swSrc.indexOf("return shareHandoffResponse(e, self.clients);") > 0, "§8-26 공유 POST 처리부가 handoff 함수를 실제로 호출(렌더 고아 아님)");

console.log(failed ? `\nFAIL ${failed}` : "\nALL PASS");
process.exit(failed ? 1 : 0);
