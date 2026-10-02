/**
 * p122 — WO 20261002-allmenu §1·§3: 전체 기능 메뉴(단일 SoT · 숨김 금지 · 모드 자동 전환 · 도움말 문구 공유)
 * (프레임워크 0 · 실행: node tests/p122-feature-menu.test.mjs)
 *
 * [재현] 지휘자 R2(WO §0): 모바일 [더보기]·데스크톱 좌측 도구·상단바·트리·허브 카드에 기능이 흩어져 있고 오늘 추가된
 *   기능(리더선 정렬·번호 대역·보고서·요청함·프로젝트 정보·원본 지정·구역 합치기·일괄삭제·360 도형·사진 이력…)이
 *   한곳에 모여 있지 않다 → FAIL. `git grep -n "FeatureMenu" HEAD -- public/js/modules | wc -l` → 0.
 *
 * 🔴 목 금지 — 11_UI.js(permCheck SoT)·36_Help.js(문구 SoT)·45_FeatureMenu.js 실제 소스를 vm 에서 실행하고,
 *   진입점 전수는 실제 public/index.html 을 파싱한다. 가짜는 DOM 셸과 협력자(App/Projects/Auth) 스파이뿐.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const SRC = ["11_UI.js", "36_Help.js", "45_FeatureMenu.js"].map((f) => rd("public/js/modules/" + f)).join("\n");
const html = rd("public/index.html");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };

function makeEl(tag, reg) {
  const set = new Set();
  const el = {
    tagName: tag, _id: "", style: {}, dataset: {}, attrs: {}, children: [], parentNode: null, _l: {}, _html: "", textContent: "", value: "", type: "",
    get id() { return el._id; }, set id(v) { el._id = v; reg.set(v, el); },
    classList: { add: (...c) => c.forEach((x) => set.add(x)), remove: (...c) => c.forEach((x) => set.delete(x)), contains: (c) => set.has(c),
      toggle(c, f) { if (f === undefined) f = !set.has(c); if (f) set.add(c); else set.delete(c); return f; } },
    get className() { return Array.from(set).join(" "); }, set className(v) { set.clear(); String(v).split(/\s+/).filter(Boolean).forEach((c) => set.add(c)); },
    get innerHTML() { return el._html; }, set innerHTML(v) { el._html = String(v); el.children = []; },
    appendChild(c) { el.children.push(c); c.parentNode = el; return c; },
    insertBefore(n, ref) { const i = el.children.indexOf(ref); if (i >= 0) el.children.splice(i, 0, n); else el.children.push(n); n.parentNode = el; return n; },
    setAttribute(k, v) { el.attrs[k] = String(v); }, getAttribute(k) { return el.attrs[k]; },
    addEventListener(t, f) { (el._l[t] = el._l[t] || []).push(f); },
    click() { (el._l.click || []).slice().forEach((f) => f({ stopPropagation() {}, preventDefault() {} })); },
    focus() {},
    querySelector(sel) { const cls = sel.replace(/^\./, ""); const walk = (n) => { for (const c of n.children) { if (c.classList.contains(cls)) return c; const r = walk(c); if (r) return r; } return null; }; return walk(el); },
    querySelectorAll() { return []; }
  };
  return el;
}

function load({ mode = "designer", regMode = "checkboard", isDesigner = true, owner = false, isAdmin = false, isSuper = false, fileType = "pdf", ua = "desktop", pano = false, deck = true } = {}) {
  const reg = new Map();
  const body = makeEl("body", reg);
  const document = {
    body, getElementById: (id) => reg.get(id) || null, createElement: (t) => makeEl(t, reg), createElementNS: (n, t) => makeEl(t, reg),
    querySelector: () => null, querySelectorAll: () => [], addEventListener() {}, removeEventListener() {}
  };
  const put = (id, parent) => { const e = makeEl("button", reg); e.id = id; (parent || body).appendChild(e); return e; };
  const topbar = makeEl("header", reg); topbar.id = "topbar"; body.appendChild(topbar);
  put("btn-back", topbar); put("btn-settings", topbar);
  const sheet = makeEl("div", reg); sheet.id = "mdock-more-sheet"; body.appendChild(sheet);
  put("mdock-more-toggle");
  const ov = makeEl("div", reg); ov.id = "pano-overlay"; if (!pano) ov.classList.add("hidden"); body.appendChild(ov);
  // 위임 대상 버튼(실 index.html 에 있는 id 들) — 클릭 기록
  const clicks = [];
  for (const m of html.matchAll(/<(?:button|input|a)\b[^>]*\bid="([^"]+)"/g)) { if (!reg.has(m[1])) { const b = put(m[1]); b.addEventListener("click", () => clicks.push(m[1])); } }
  ["chk-deck-outline"].forEach((id) => { const b = put(id); b.addEventListener("click", () => clicks.push(id)); });
  const calls = { setMode: [], align: [], toast: [], members: 0 };
  const State = { mode, regMode, fileType, pins: [], zones: [], pdfPage: 1 };
  const sandbox = {
    console, document, setTimeout, clearTimeout, Date, JSON, Math, Number, String, Array, Object, Set, Map, Promise,
    window: {}, navigator: { userAgent: ua === "android" ? "Linux; Android 14" : "Windows NT 10.0", platform: "", maxTouchPoints: 0 },
    location: { search: "" }, localStorage: { getItem: () => null, setItem() {} },
    State,
    Auth: { isDesigner, readonly: false, isAdmin: isAdmin || isSuper, isSuper, role: isSuper ? "super" : isDesigner ? "designer" : "viewer", user: {} },
    Projects: { currentProject: { id: "p", can_manage_members: owner }, currentDeck: deck ? { id: "d1", name: "기관실" } : null, decks: [], renameProject() {}, openOriginal() {} },
    App: { _setRegMode: (m) => { calls.setMode.push(m); State.regMode = m; }, registerDrawingFor() {} },
    Prompt: { toast: (m) => calls.toast.push(m) },
    ThetaIntake: { appDisabledReason: () => (ua === "android" ? "" : "휴대폰에서 사용"), openApp() {}, startFromPending() {} },
    ProjectHub: { openMembers: () => { calls.members++; } }, ProjectInfo: { open() {} },
    RegionMerge: { open() {} }, NumBand: { open() {} }, AllPins: { toggle() {} }, Requests: { openInbox() {}, openViewer() {} }, Install: { showBanner() {} }
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(SRC + "\n;globalThis.__FM = FeatureMenu; globalThis.__UI = UI; globalThis.__H = Help;", sandbox);
  const UI = sandbox.__UI;
  UI._startAlign = (ax) => calls.align.push(ax);
  return { FM: sandbox.__FM, UI, Help: sandbox.__H, State, calls, clicks, reg, sheet, topbar, body };
}
const items = (host) => { const out = []; const walk = (n) => n.children.forEach((c) => { if (c.classList.contains("fm-item")) out.push(c); walk(c); }); walk(host); return out; };

/* ══ A. 진입점 전수 — index.html 의 모든 <button id> 는 기능(covers/click) 이거나 비기능(사유 명시) ══ */
console.log("\n[A. 진입점 전수 — 실제 index.html]");
{
  const { FM } = load();
  const ids = Array.from(new Set(Array.from(html.matchAll(/<button\b[^>]*\bid="([^"]+)"/g)).map((m) => m[1])));
  const covered = new Set();
  FM.FEATURES.forEach((f) => { (f.covers || []).forEach((c) => covered.add(c)); if (f.click) covered.add(f.click); });
  const nonFeat = (id) => FM.NON_FEATURE.find((n) => new RegExp(n.re).test(id) && n.why);
  const entries = ids.filter((id) => !nonFeat(id));
  const missing = entries.filter((id) => !covered.has(id));
  ok(missing.length === 0, "A1 기능 진입점 " + entries.length + "개 전부 메뉴에 등록(빠짐 0) — 빠진 것: " + JSON.stringify(missing));
  ok(FM.NON_FEATURE.every((n) => n.why && n.why.length > 3), "A2 비기능으로 뺀 버튼은 전부 사유가 적혀 있다");
  const dead = FM.FEATURES.filter((f) => f.click && !ids.includes(f.click) && !/^(chk-|btn-pano-orig)/.test(f.click) && !html.includes('id="' + f.click + '"'));
  ok(dead.length === 0, "A3 위임 대상 id 가 실제로 존재(고아 위임 0) — " + JSON.stringify(dead.map((f) => f.id)));
  const ROLL = ["align-v", "align-h", "num-band", "renumber", "report-print", "requests-inbox", "project-info", "project-rename", "origin-set",
    "region-merge", "pin-bulk-delete", "pano-shape-rect", "pano-shape-circle", "photo-history", "photo-original", "offline-download", "defect-severity",
    "theta-app", "theta-received", "deck-drawing", "main-replace", "deck-outline"];
  const lack = ROLL.filter((id) => !FM._f(id));
  ok(lack.length === 0, "A4 WO 가 나열한 오늘 추가 기능(JS 생성 진입점 포함) " + ROLL.length + "건 전부 등록 — 빠진 것: " + JSON.stringify(lack));
  const uniq = new Set(FM.FEATURES.map((f) => f.id));
  ok(uniq.size === FM.FEATURES.length, "A5 기능 id 중복 0 (" + FM.FEATURES.length + "개)");
  ok(FM.FEATURES.every((f) => FM.GROUPS.some((g) => g.id === f.group)) && FM.GROUPS.length === 10, "A6 10개 그룹(프로젝트·도면/구역·CHECKER·360·협업·보고·오프라인·설정·관리자·도움말)에 전부 소속");
  ok(FM.FEATURES.length >= ROLL.length && FM.FEATURES.every((f) => f.run || f.click), "A7 모든 항목에 실행 경로(run 또는 기존 버튼 위임)");
}

/* ══ B. 숨김 금지 — 열람자·비소유자·데스크톱에서도 항목은 그대로, 비활성 + 사유 ══ */
console.log("\n[B. 숨김 금지 — 비활성 + 사유]");
{
  const V = load({ mode: "viewer", isDesigner: false });
  const host = V.body.appendChild(makeEl("div", new Map()));
  const n = V.FM.renderInto(host, "");
  const its = items(host);
  ok(n === V.FM.FEATURES.length && its.length === V.FM.FEATURES.length, "B1 열람자 화면 — 목록에서 빠진 항목 0 (" + its.length + "/" + V.FM.FEATURES.length + ")");
  const edit = its.find((b) => b.dataset.feature === "align-v");
  ok(edit && edit.attrs["aria-disabled"] === "true" && /디자이너\(편집\) 전용/.test(edit.innerHTML), "B2 열람자: 편집 기능(정렬) = 비활성 + '디자이너(편집) 전용'");
  const D = load({ owner: false });
  const h2 = D.body.appendChild(makeEl("div", new Map()));
  D.FM.renderInto(h2, "");
  const main = items(h2).find((b) => b.dataset.feature === "main-replace");
  ok(main && /소유자·관리자 전용/.test(main.innerHTML) && main.attrs["aria-disabled"] === "true", "B3 비소유 디자이너: [메인 도면 교체] = 비활성 + '소유자·관리자 전용'");
  const theta = items(h2).find((b) => b.dataset.feature === "theta-app");
  ok(theta && /휴대폰에서 사용/.test(theta.innerHTML), "B4 데스크톱: [RICOH THETA 앱 열기] = 비활성 + '휴대폰에서 사용'");
  const pano = items(h2).find((b) => b.dataset.feature === "pano-shape-rect");
  ok(pano && /360 뷰어에서 사용/.test(pano.innerHTML), "B5 360 닫힘: [360 도형] = 비활성 + '360 뷰어에서 사용'");
  const adm = items(h2).find((b) => b.dataset.feature === "admin-features");
  ok(adm && /슈퍼관리자 전용/.test(adm.innerHTML), "B6 관리자 기능도 목록에 있고 사유 표시");
  D.calls.toast.length = 0;
  main.click();
  ok(D.calls.toast.some((t) => /소유자·관리자 전용/.test(t)) && D.clicks.length === 0, "B7 비활성 항목 탭 → 실행 0 + 사유 토스트");
  const O = load({ owner: true });
  const h3 = O.body.appendChild(makeEl("div", new Map()));
  O.FM.renderInto(h3, "");
  const m3 = items(h3).find((b) => b.dataset.feature === "main-replace");
  ok(m3 && m3.attrs["aria-disabled"] === undefined, "B8 소유자: [메인 도면 교체] 활성");
}

/* ══ C. 모드 자동 전환 — 모드만 다르면 비활성이 아니라 전환 후 실행 ══ */
console.log("\n[C. 모드 자동 전환]");
{
  const M = load({ regMode: "photo" });
  const host = M.body.appendChild(makeEl("div", new Map()));
  M.FM.renderInto(host, "");
  const al = items(host).find((b) => b.dataset.feature === "align-v");
  ok(al && al.attrs["aria-disabled"] === undefined && /CHECKER 모드로 전환 후 실행/.test(al.innerHTML), "C1 360 모드에서 [정렬 ↕] = 활성 + 'CHECKER 모드로 전환 후 실행'");
  al.click();
  ok(M.calls.setMode[0] === "checkboard", "C2 탭 → App._setRegMode('checkboard')(상단 세그먼트와 같은 SoT)");
  await new Promise((r) => setTimeout(r, 200));
  ok(M.calls.align[0] === "v", "C3 전환 후 정렬 실행(UI._startAlign('v'))");
  const S = load({ regMode: "checkboard" });
  S.FM.run("align-h");
  ok(S.calls.setMode.length === 0 && S.calls.align[0] === "h", "C4 이미 같은 모드면 전환 없이 즉시 실행");
  S.FM.run("zoom-fit");
  ok(S.clicks.includes("tb-fit"), "C5 위임 실행 = 기존 버튼(.click()) 그대로 — 새 로직 0");
}

/* ══ D. 진입점 마운트 — 데스크톱 [☰ 전체 기능](설정 앞) · 모바일 [더보기] 시트(검색 포함) ══ */
console.log("\n[D. 데스크톱 상단바 · 모바일 더보기]");
{
  const E = load();
  E.FM.mount();
  const btn = E.reg.get("btn-feature-menu");
  ok(!!btn && E.topbar.children.indexOf(btn) === E.topbar.children.indexOf(E.reg.get("btn-settings")) - 1 && /전체 기능/.test(btn.innerHTML), "D1 상단바 [☰ 전체 기능] = 설정 바로 앞");
  btn.click();
  const panel = E.reg.get("feature-menu");
  ok(panel && !panel.classList.contains("hidden") && items(panel).length === E.FM.FEATURES.length, "D2 클릭 → 패널 열림, 전 항목 표시");
  const inline = E.reg.get("mdock-feature-menu");
  ok(inline && inline.parentNode === E.sheet && items(inline).length === E.FM.FEATURES.length, "D3 모바일 [더보기] 시트 안 = 같은 정의 전체");
  const search = inline.querySelector(".fm-search");
  search.value = "정렬";
  (search._l.input || []).forEach((f) => f({}));
  const got = items(inline).map((b) => b.dataset.feature);
  ok(got.length >= 2 && got.every((id) => /align|renumber/.test(id) || /정렬/.test(E.FM._f(id).label + E.FM.descOf(E.FM._f(id)))), "D4 검색 '정렬' → 정렬 관련만 → " + JSON.stringify(got));
  E.FM.mount();
  ok(E.topbar.children.filter((c) => c.id === "btn-feature-menu").length === 1, "D5 재마운트 중복 0");
}

/* ══ E. 문구 SoT — 도움말(36_Help)과 공유 ══ */
console.log("\n[E. 도움말 문구 공유]");
{
  const { FM, Help } = load();
  const d = FM.descOf(FM._f("region-extract"));
  ok(d.length > 10 && Help.CONTENT["region-extract"].indexOf(d) >= 0, "E1 help 키가 있는 항목의 설명 = 36_Help.CONTENT 원문 일부 → " + d);
  const g = Help.get("align-v");
  ok(typeof g === "string" && g.indexOf(FM._f("align-v").desc) >= 0, "E2 Help.get(기능 id) = 메뉴 정의의 설명(역방향 공유)");
  ok(Help.get("no-such-key") === undefined, "E3 없는 키는 지어내지 않음(undefined)");
}

console.log(failed ? `\nFAIL ${failed}` : "\nALL PASS");
process.exit(failed ? 1 : 0);
