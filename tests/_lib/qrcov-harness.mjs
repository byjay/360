/** WO 20261007-qrcov 공용 vm 하네스 — p128(QR 위치 태그)·p129(촬영 현황)가 같은 실제 소스 묶음을 같은 방식으로 띄운다.
 *  가짜 = 브라우저 셸(location/history/storage/window.open) + 진입 협력자 스파이(ProjectHub·App·PinActionPop)뿐. */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

export const DAY = 86400000;
export function readSources(ROOT) {
  const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
  const M = (f) => rd("public/js/modules/" + f);
  const opt = (f) => (fs.existsSync(path.join(ROOT, "public/js/modules", f)) ? M(f) : "");
  return {
    pinseries: M("01b_PinSeries.js"), timelapse: M("14_TimeLapse.js"), auth: M("22_Auth.js"), projects: M("31_Projects.js"),
    pinfo: M("43_ProjectInfo.js"), report: M("47_Report.js"), qr: M("50_QrLink.js"), cov: opt("51_Coverage.js"),
    footer: M("99_footer.js"), uiSrc: M("11_UI.js"), allpins: M("21_AllPins.js"), menu: M("45_FeatureMenu.js"), help: M("36_Help.js"),
    manifest: M("_manifest.txt"), vendor: rd("public/js/vendor/qrcode.js"), server: rd("src/index.tsx")
  };
}

export function makeCtx(search, extra) {
  const store = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
  const log = { toasts: [], urls: [], opened: [], focused: [], popped: [], access: [], hubOpen: 0, modes: [], printed: [], fetches: [] };
  const ctx = {
    console, URL, URLSearchParams, setTimeout, clearTimeout,
    location: { search, origin: "https://scan.example", href: "https://scan.example/" + search, pathname: "/", hash: "" },
    history: { state: null, replaceState: (s, t, u) => log.urls.push(u) },
    sessionStorage: store(), localStorage: store(),
    document: { querySelector: () => null, querySelectorAll: () => [], getElementById: () => null, createElement: () => ({ style: {} }), head: { appendChild() {} } },
    Prompt: { toast: (m) => log.toasts.push(m) },
    log
  };
  ctx.window = ctx;
  ctx.window.open = () => {
    const doc = { html: "", open() {}, write(h) { doc.html += h; }, close() {} };
    const w = { document: doc, close() {} };
    log.printed.push(w);
    return extra && extra.blockPopup ? null : w;
  };
  return ctx;
}

export function makeBoot(src) {
  return function boot(search, opts) {
    const o = opts || {};
    const ctx = makeCtx(search, o);
    vm.createContext(ctx);
    const S = ctx.State = { pins: [], mode: "designer", regMode: o.regMode || "photo", fileType: "pdf", currentDeploymentId: "dep1", pdfPage: 1, placing: false };
    const exportsExpr = "\n;({ PinSeries, TimeLapse, Auth, Projects, ProjectInfo, Report, DeepLink, QrPrint, Coverage: (typeof Coverage !== \"undefined\" ? Coverage : null) })";
    const code = [src.pinseries, src.timelapse, src.auth, src.projects, src.pinfo, src.report, src.qr, src.cov || ""].join("\n") + exportsExpr;
    const X = vm.runInContext(code, ctx);
    Object.assign(ctx, X);
    vm.runInContext(src.vendor, ctx);   // var qrcode → 전역(=window)
    X.Auth._applyUi = () => {};
    const L = ctx.log;
    const serverList = o.list || [{ id: "proj_1", name: "선박A", is_member: true, info_json: o.info || {} }];
    const decks = [{ id: "dck_A", name: "A구역", deployment_id: "dep1", page: 1, crop: { x: 0, y: 0, w: 50, h: 50 } }];
    const pinsAfterLoad = o.pins || [{ id: "pin_7", x: 10, y: 10, page: 1, label: "밸브실" }];
    ctx.App = {
      focusPin: async (pin) => { S.activePin = pin.id; L.focused.push(pin.id); },
      _setRegMode: (m) => { S.regMode = m; L.modes.push(m); setTimeout(() => { S.placing = true; }, 60); },   // 실제처럼 60ms 뒤 배치모드 자동 시작
      _togglePlacing: () => { S.placing = !S.placing; }
    };
    ctx.PinActionPop = { open: (id) => L.popped.push(id) };
    ctx.ProjectHub = {
      list: [], _loaded: false,
      async open() { L.hubOpen++; await this.load(); },
      async load() { this.list = serverList; this._loaded = true; },
      openAccessReq: (p) => L.access.push(p.id),
      // 실제 openProjectAtDeck: openProject → _enterAsDesigner → (디자이너 아니면) Auth.requireDesigner 게이트만, 로드 없음
      async openProjectAtDeck(p, deckId) {
        L.opened.push([p.id, deckId]);
        if (!X.Auth.isDesigner) { L.gate = (L.gate || 0) + 1; return; }
        X.Projects.currentProject = p; X.Projects.decks = decks;
        X.Projects.currentDeck = decks.find((d) => d.id === deckId) || null;
        S.pins = pinsAfterLoad;
      }
    };
    ctx.fetch = async (url) => { L.fetches.push(url); return { ok: true, status: 200, json: async () => (o.me || { authenticated: true, email: "d@x.com", name: "D", role: "designer" }) }; };
    X.DeepLink.PIN_WAIT_MS = 200;
    return { ctx, X, S, L };
  };
}

export const tick = (ms) => new Promise((r) => setTimeout(r, ms || 0));

/** 뮤테이션 실행기 — 각 [label, key, from, to] 를 적용해 suite 가 실패하는지(=잡는지) 본다. 반환 = 못 잡은 수. */
export async function runMutations(BASE, MUT, suite) {
  let bad = 0;
  for (const [label, key, from, to] of MUT) {
    if (!BASE[key].includes(from)) { console.log("  FAIL " + label + " — needle 소실(테스트 약화 위험)"); bad++; continue; }
    const src = Object.assign({}, BASE, { [key]: BASE[key].replace(from, to) });
    let f;
    try { f = await suite(src, true); } catch (e) { f = ["예외: " + e.message]; }
    const caught = f.length > 0;
    console.log((caught ? "  PASS " : "  FAIL ") + label + " → " + (caught ? "실패함(실효성 증명): " + f[0] : "잡지 못함"));
    if (!caught) bad++;
  }
  return bad;
}
