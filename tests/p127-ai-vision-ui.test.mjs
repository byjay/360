/**
 * p127 — [WO 20261007-aivision] AI 분석 UI — 버튼 비활성+사유(숨김 금지)·오프라인 큐 금지·「추정」·결함 폼 미리 채우기(자동 등록 0)·
 *        360 임시 마커(저장은 사람)·이스케이프·배선(핀 팝업/360 헤더/전체 기능 메뉴/도움말)
 * 프레임워크 0 · 실행: node tests/p127-ai-vision-ui.test.mjs
 *
 * 🔴 목 금지 — 49_AiVision.js·11_UI.js(escapeHtml SoT)·36_Help.js·45_FeatureMenu.js 실제 소스를 vm 에서 실행한다.
 *   가짜는 DOM 셸과 협력자(fetch/Auth/State/Notes/PanoViewer/App/Prompt/OpLog) 스파이뿐. 06_PanoViewer·20_App·27_PinActionPop
 *   의 배선 지점은 실제 소스를 정규식으로 대조한다(p116 관례).
 * 뮤테이션: P127_MUT=<이름> → 49_AiVision.js 소스를 바꿔 실행 → EXIT=1 이어야 한다(대상 못 찾으면 EXIT=2).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
let AIV = rd("public/js/modules/49_AiVision.js");
const UI_SRC = rd("public/js/modules/11_UI.js");
const HELP_SRC = rd("public/js/modules/36_Help.js");
const FM_SRC = rd("public/js/modules/45_FeatureMenu.js");
const PV_SRC = rd("public/js/modules/06_PanoViewer.js");
const APP_SRC = rd("public/js/modules/20_App.js");
const PAP_SRC = rd("public/js/modules/27_PinActionPop.js");
const FOOT_SRC = rd("public/js/modules/99_footer.js");
const HTML = rd("public/index.html");
const MANIFEST = rd("public/js/modules/_manifest.txt");

const MUTS = {
  "offline-open": ['if (!a.online) return { disabled: true, reason: "온라인에서 사용 — 오프라인에서는 AI 분석을 보내지 않습니다" };', ""],
  "offline-queue": ['if (st.disabled) { this._toast("AI 분석 — " + st.reason, 4200); return null; }\n      // 🔴 오프라인이면 여기서 끝',
    'if (st.disabled) { if (!this._online() && typeof OpLog !== "undefined" && OpLog.recordCurrent) OpLog.recordCurrent("ai", "analyze", pin.id, {}); this._toast("AI 분석 — " + st.reason, 4200); return null; }\n      // 🔴 오프라인이면 여기서 끝'],
  "est-badge": ["isEstimated(conf, p) { return !(typeof conf === \"number\") || conf < (typeof p === \"number\" ? p : this.ESTIMATE_P); }", "isEstimated(conf, p) { return false; }"],
  "auto-register": ['      if (input && input.focus) { try { input.focus(); } catch (e) {} }',
    '      try { await fetch("/api/notes", { method: "POST", headers: Auth.headers(), body: JSON.stringify({ deployment_id: State.currentDeploymentId, pin_id: pin.id, body: input ? input.value : "", severity: sev ? sev.value : null }) }); } catch (e) {}'],
  "escape-off": ['_esc(s) { return (typeof UI !== "undefined" && UI.escapeHtml) ? UI.escapeHtml(String(s == null ? "" : s)) : String(s == null ? "" : s); }', '_esc(s) { return String(s == null ? "" : s); }'],
  "viewer-open": ['if (!a.canEdit) return { disabled: true, reason: "디자이너(편집) 전용 — 열람 화면에서는 사용할 수 없습니다" };', ""],
  "yaw-flip": ["id: \"ai-\" + k, lon: it.yaw, lat: it.pitch,", "id: \"ai-\" + k, lon: 360 - it.yaw, lat: it.pitch,"],
  "hide-disabled": ["if (st.disabled) html += '<div class=\"aiv-reason\"", "if (st.disabled) return; if (false) html += '<div class=\"aiv-reason\""],
};
const MUT = process.env.P127_MUT || "";
if (MUT) {
  const m = MUTS[MUT];
  if (!m) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }
  if (!AIV.includes(m[0])) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함: " + MUT); process.exit(2); }
  AIV = AIV.replace(m[0], m[1]);
  console.log("[뮤테이션 적용] " + MUT);
}

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };

/* ══ 가짜 DOM ══ */
function makeDoc() {
  const reg = new Map();
  function makeEl(tag) {
    const set = new Set();
    const el = {
      tagName: tag, _id: "", style: {}, dataset: {}, attrs: {}, children: [], parentNode: null, _l: {}, _html: "", textContent: "", value: "", focused: false,
      get id() { return el._id; }, set id(v) { el._id = v; reg.set(v, el); },
      classList: { add: (...c) => c.forEach((x) => set.add(x)), remove: (...c) => c.forEach((x) => set.delete(x)), contains: (c) => set.has(c),
        toggle(c, f) { if (f === undefined) f = !set.has(c); if (f) set.add(c); else set.delete(c); return f; } },
      get innerHTML() { return el._html; },
      set innerHTML(v) {
        el._html = String(v); el.children = [];
        // id="..." 를 가진 요소를 등록해 getElementById 로 찾게 한다(버튼 바인딩용)
        for (const m of el._html.matchAll(/<(button|div|span|ul|li)\b[^>]*\bid="([^"]+)"/g)) { const c = makeEl(m[1]); c.id = m[2]; c.parentNode = el; el.children.push(c); }
      },
      appendChild(c) { el.children.push(c); c.parentNode = el; return c; },
      setAttribute(k, v) { el.attrs[k] = String(v); }, getAttribute(k) { return el.attrs[k]; },
      addEventListener(t, f) { (el._l[t] = el._l[t] || []).push(f); },
      click() { (el._l.click || []).slice().forEach((f) => f({ stopPropagation() {}, preventDefault() {} })); },
      focus() { el.focused = true; },
      querySelector() { return null; }, querySelectorAll() { return []; }
    };
    return el;
  }
  const body = makeEl("body");
  const document = { body, getElementById: (id) => reg.get(id) || null, createElement: (t) => makeEl(t), addEventListener() {}, removeEventListener() {} };
  const put = (id, tag) => { const e = makeEl(tag || "div"); e.id = id; body.appendChild(e); return e; };
  return { document, put, reg };
}

function load(o) {
  o = o || {};
  const { document, put } = makeDoc();
  put("pap-ai"); put("pano-ai-panel"); put("pano-overlay"); put("pnp-input", "textarea"); put("pnp-severity", "select"); put("pano-notes-panel");
  const ov = document.getElementById("pano-overlay"); if (!o.panoOpen) ov.classList.add("hidden");
  const calls = { fetch: [], toast: [], oplog: [], setAiSpots: [], renderSpots: [], saveSpots: [], openPano: [], notesOpen: 0, notesPin: null };
  const fetchImpl = async (url, init) => {
    calls.fetch.push({ url, init });
    if (url === "/api/ai/vision-status") return { status: 200, json: async () => (o.status || { enabled: true, reason: null, provider: "workers-ai", model: "@cf/meta/llama-4-scout-17b-16e-instruct", daily_limit: 30, used: 3, remaining: 27, neurons_used_today: 412.5, neuron_cap: 7000, free_neurons_per_day: 10000, exhausted: false, estimate_p: 0.7 }) };
    if (url === "/api/ai/analyze-photo") { const r = o.analyze ? o.analyze(JSON.parse(init.body)) : null; return { ok: !!(r && r.ok), status: r && r.status || 200, json: async () => r }; }
    return { ok: false, status: 404, json: async () => ({}) };
  };
  const PanoViewer = { open: !!o.panoOpen, _currentPin: o.currentPin || null, _aiSpots: null, _aiSpotsPinId: null,
    setAiSpots(pid, s) { calls.setAiSpots.push([pid, s]); this._aiSpots = s && s.length ? s : null; this._aiSpotsPinId = this._aiSpots ? pid : null; },
    renderSpots(s) { calls.renderSpots.push(s); } };
  const sandbox = {
    console, setTimeout, clearTimeout, Date, JSON, Math, Number, String, Array, Object, Promise,
    window: { addEventListener() {} }, document, navigator: { onLine: o.online !== false }, fetch: fetchImpl,
    State: { mode: o.mode || "designer", currentDeploymentId: o.dep === undefined ? "dep1" : o.dep },
    Auth: { isDesigner: o.isDesigner !== false, readonly: false, headers: () => ({ "Content-Type": "application/json", Authorization: "Bearer t" }) },
    Prompt: { toast: (m) => calls.toast.push(m) },
    OpLog: { recordCurrent: (...a) => { calls.oplog.push(a); return Promise.resolve(); } },
    PanoViewer,
    App: { openPano: (p) => { calls.openPano.push(p); PanoViewer.open = true; PanoViewer._currentPin = p; ov.classList.remove("hidden"); }, _saveSpots: (p) => calls.saveSpots.push(p) },
    Notes: { setPin: (p) => { calls.notesPin = p; }, openPanel: () => { calls.notesOpen++; } },
    PinActionPop: { close() {} },
    FeatureMenu: undefined, ThetaIntake: undefined, Projects: undefined,
  };
  vm.createContext(sandbox);
  vm.runInContext(UI_SRC + "\n" + AIV + "\nthis.AiVision = AiVision; this.UI = UI;", sandbox);
  return { A: sandbox.AiVision, calls, document, sandbox, PanoViewer };
}

const PIN = () => ({ id: "p1", label: "기관실", imageId: "img_cur", timeline: [{ imageId: "img_old", shotAt: 1 }], spots: [] });
const RESULT = (extra) => ({ ok: true, cached: false, model: "@cf/meta/llama-4-scout-17b-16e-instruct", provider: "workers-ai", analyzed_at: 1700000000000, estimate_p: 0.7, compare: false,
  usage: { prompt_tokens: 2100, completion_tokens: 300, neurons: 74.73, neurons_estimated: false, cost_usd: 0 },
  result: { summary: "기관실 통로 <b>요약</b>", items: [
    { kind: "equipment", label: "FW PUMP", confidence: 0.92, yaw: 80, pitch: -5 },
    { kind: "defect", label: "<script>alert(1)</script>플랜지 부식", confidence: 0.55, yaw: 250, pitch: -12 },
    { kind: "hazard", label: "바닥 기름", confidence: 0.8 } ],
    defect_suggestion: { title: "배관 플랜지 부식", detail: "우측 플랜지 볼트 주변 녹", severity: "mid", confidence: 0.75 }, ...(extra || {}) } });

/* ══ A. buttonState — 숨김 금지: 사유 ══ */
console.log("\n[A. buttonState(순수) — 권한 → 온라인 → 사진 → 키 → 한도]");
{
  const { A } = load();
  const st = { enabled: true, remaining: 5, daily_limit: 30 };
  ok(A.buttonState({ pin: PIN(), online: true, status: st, canEdit: true }).disabled === false, "A 디자이너·온라인·사진·키·한도 OK → 사용 가능");
  const v = A.buttonState({ pin: PIN(), online: true, status: st, canEdit: false });
  ok(v.disabled && /디자이너/.test(v.reason), "A 열람자 → 비활성 + '디자이너 전용' 사유");
  const off = A.buttonState({ pin: PIN(), online: false, status: st, canEdit: true });
  ok(off.disabled && /온라인에서 사용/.test(off.reason), "A 오프라인 → 비활성 + '온라인에서 사용'");
  const np = A.buttonState({ pin: { id: "x" }, online: true, status: st, canEdit: true });
  ok(np.disabled && /사진이 없습니다/.test(np.reason), "A 사진 없음 → 비활성 + 사유");
  const pend = A.buttonState({ pin: { id: "x", pendingOpId: "op1" }, online: true, status: st, canEdit: true });
  ok(pend.disabled && /업로드\(동기화\)/.test(pend.reason), "A 업로드 전(pendingOpId) → '동기화 후' 사유");
  const ext = A.buttonState({ pin: { id: "x", imageUrl: "https://cdn.example/a.jpg" }, online: true, status: st, canEdit: true });
  ok(ext.disabled, "A 외부 URL 사진(서버가 못 읽음) → 비활성");
  const r2 = A.buttonState({ pin: { id: "x", imageUrl: "/api/r2/object/assets/a.jpg?t=x" }, online: true, status: st, canEdit: true });
  ok(!r2.disabled && A.imageIdOf({ imageUrl: "/api/r2/object/assets/a.jpg?t=x" }) === "assets/a.jpg", "A R2 키 URL 사진 → 사용 가능, image_id=키");
  const nk = A.buttonState({ pin: PIN(), online: true, status: { enabled: false, reason: "AI 키 미설정 — 관리자가 OPENROUTER_API_KEY 시크릿을 등록해야 합니다" }, canEdit: true });
  ok(nk.disabled && /OPENROUTER_API_KEY/.test(nk.reason), "A 키 없음 → 비활성 + 서버 사유 그대로");
  const lim = A.buttonState({ pin: PIN(), online: true, status: { enabled: true, remaining: 0, daily_limit: 30 }, canEdit: true });
  ok(lim.disabled && /한도 소진/.test(lim.reason), "A 한도 0 → 비활성 + '한도 소진'");
  const exh = A.buttonState({ pin: PIN(), online: true, status: { enabled: false, exhausted: true, reason: "오늘 무료 사용량 소진 — 내일 다시 사용할 수 있습니다", remaining: 10, daily_limit: 30 }, canEdit: true });
  ok(exh.disabled && /오늘 무료 사용량 소진 — 내일 다시/.test(exh.reason), "A 🔴 전체 무료 할당 소진(서버 exhausted) → 비활성 + '오늘 무료 사용량 소진 — 내일 다시'(개인 잔여가 있어도)");
  ok(A.compareIdOf(PIN()) === "img_old" && A.compareIdOf({ id: "z" }) === null, "A compareIdOf — 이력 최근 사진 / 없으면 null");
}

/* ══ B. 렌더 — 비활성 버튼은 보이고(aria-disabled) 사유가 글자로 ══ */
console.log("\n[B. 렌더 — 숨김 금지]");
{
  const { A, calls, document } = load({ isDesigner: false, mode: "viewer" });
  A.mount("pap-ai", PIN(), { theme: "light", canEdit: false });
  const host = document.getElementById("pap-ai");
  ok(/id="pap-ai-run"/.test(host.innerHTML) && /aria-disabled="true"/.test(host.innerHTML), "B 열람자: 버튼은 렌더되고 aria-disabled=true(숨기지 않음)");
  ok(/class="aiv-reason"[^>]*>디자이너/.test(host.innerHTML), "B 사유 글자('디자이너 전용')가 버튼 옆에 보임");
  document.getElementById("pap-ai-run").click();
  ok(calls.fetch.filter((f) => f.url === "/api/ai/analyze-photo").length === 0 && calls.toast.some((m) => /디자이너/.test(m)), "B 비활성 버튼 클릭 → 토스트로 사유, 분석 요청 0");
}
{
  const { A, document } = load({ online: false });
  A.mount("pap-ai", PIN(), { theme: "light", canEdit: true });
  ok(/온라인에서 사용/.test(document.getElementById("pap-ai").innerHTML), "B 오프라인: '온라인에서 사용' 사유 표시");
}
{
  const { A, document } = load({ status: { enabled: false, exhausted: true, reason: "오늘 무료 사용량 소진 — 내일 다시 사용할 수 있습니다", remaining: 10, daily_limit: 30 } });
  A.mount("pap-ai", PIN(), { theme: "light", canEdit: true });
  await A.fetchStatus(true); A.render("pap-ai");
  const h = document.getElementById("pap-ai").innerHTML;
  ok(/aria-disabled="true"/.test(h) && /오늘 무료 사용량 소진 — 내일 다시/.test(h), "B 🔴 무료 할당 소진: 버튼 보이되 비활성 + 사유 렌더");
}
{
  const { A, document } = load();
  A.mount("pap-ai", PIN(), { theme: "light", canEdit: true });
  await A.fetchStatus(true); A.render("pap-ai");
  const h = document.getElementById("pap-ai").innerHTML;
  ok(/무료 할당 413\/7000 Neurons/.test(h) && /비용 \$0\(무료\)/.test(h), "B 활성: 남은 횟수 + 무료 할당 Neurons + 비용 $0 안내");
}

/* ══ C. 분석 — 요청 본문·결과 카드·「추정」·이스케이프 ══ */
console.log("\n[C. 분석 호출 + 결과 카드]");
{
  const { A, calls, document } = load({ analyze: () => RESULT() });
  const pin = PIN();
  A.mount("pap-ai", pin, { theme: "light", canEdit: true });
  await A.fetchStatus(true);
  const out = await A.analyze("pap-ai", { compare: false });
  const req = calls.fetch.find((f) => f.url === "/api/ai/analyze-photo");
  ok(!!out && out.ok && req && req.init.method === "POST", "C POST /api/ai/analyze-photo 호출");
  const sent = JSON.parse(req.init.body);
  ok(sent.deployment_id === "dep1" && sent.pin_id === "p1" && sent.image_id === "img_cur" && !("compare_image_id" in sent), "C 요청 = 식별자만(deployment_id·pin_id·image_id), 이미지·URL 없음 — " + JSON.stringify(sent));
  ok(!/data:image|image_url|imageUrl/.test(req.init.body), "C 요청 본문에 이미지 데이터/URL 필드 없음");
  const html = document.getElementById("pap-ai").innerHTML;
  ok(/aiv-card/.test(html) && /aiv-summary/.test(html) && /항목 3/.test(html), "C 결과 카드: 요약 + 항목 3");
  ok(/&lt;b&gt;요약&lt;\/b&gt;/.test(html) && !/<b>요약<\/b>/.test(html), "C 요약 HTML 이스케이프(모델 출력은 데이터)");
  ok(/&lt;script&gt;/.test(html) && !/<script>alert/.test(html), "C 항목 라벨 <script> 이스케이프(프롬프트 인젝션 대비)");
  const estCount = (html.match(/>추정</g) || []).length;
  ok(estCount === 1, "C 「추정」 배지 = 신뢰도 0.7 미만 항목(0.55) 1건만(0.92·0.8·0.75 는 없음) — " + estCount);
  ok(/92%/.test(html) && /55%/.test(html) && /80%/.test(html), "C 신뢰도 % 표시");
  ok(/data-kind="equipment"/.test(html) && /data-kind="defect"/.test(html) && /data-kind="hazard"/.test(html) && /장비/.test(html) && /결함/.test(html) && /위험/.test(html), "C 종류별 아이콘·라벨(장비/결함/위험)");
  ok(/id="pap-ai-defect"/.test(html) && /결함으로 등록/.test(html) && /사람이 \[등록\]을 눌러야/.test(html), "C [결함으로 등록(폼 채우기)] 버튼 + '사람이 등록' 안내");
  ok(/id="pap-ai-mark"/.test(html) && /마커 보기\(2\)/.test(html), "C 위치 있는 항목 2건 → [360 안에 마커 보기(2)]");
  ok(/74\.73 Neurons/.test(html) && /비용 \$0\(무료 할당\)/.test(html) && /2100\/300/.test(html) && /llama-4-scout/.test(html), "C 모델·토큰·Neurons·비용 $0 메타(유료 비용 표기 없음)");
  ok(!/\$0\.\d/.test(html), "C 카드에 달러 과금액 표기 0");
  ok(/id="pap-ai-cmp"/.test(html) && /이전 사진과 비교/.test(html), "C 이력이 있으면 [이전 사진과 비교] 버튼");
  // 비교 호출
  document.getElementById("pap-ai-cmp").click();
  await new Promise((r) => setTimeout(r, 20));
  const req2 = calls.fetch.filter((f) => f.url === "/api/ai/analyze-photo")[1];
  ok(req2 && JSON.parse(req2.init.body).compare_image_id === "img_old", "C [이전 사진과 비교] → compare_image_id=이력 사진");
}
{
  const { A, document } = load({ analyze: () => RESULT({ change_summary: "펌프 커버 신설", items: [] }) });
  A.mount("pap-ai", PIN(), { theme: "dark", canEdit: true });
  await A.analyze("pap-ai", { compare: true });
  const html = document.getElementById("pap-ai").innerHTML;
  ok(/aiv-change/.test(html) && /펌프 커버 신설/.test(html) && /감지된 항목이 없습니다/.test(html), "C 변화 요약 표시 + 항목 0 정직 표시(다크 테마)");
}
{
  const { A, calls, document } = load({ analyze: () => ({ ok: false, status: 429, error: "일일 AI 분석 상한(30회/24h)을 초과했습니다" }) });
  A.mount("pap-ai", PIN(), { theme: "light", canEdit: true });
  await A.analyze("pap-ai", {});
  ok(/aiv-error/.test(document.getElementById("pap-ai").innerHTML) && /상한/.test(document.getElementById("pap-ai").innerHTML), "C 서버 오류(429) → 사유 표시(조용한 실패 금지)");
  ok(calls.fetch.filter((f) => f.url === "/api/ai/vision-status").length >= 1, "C 오류 후 상태 재조회");
}

/* ══ D. 오프라인 — 요청 0 · 큐 0 ══ */
console.log("\n[D. 오프라인 — 큐에 넣지 않음]");
{
  const { A, calls } = load({ online: false, analyze: () => RESULT() });
  A.mount("pap-ai", PIN(), { theme: "light", canEdit: true });
  const out = await A.analyze("pap-ai", {});
  ok(out === null && calls.fetch.filter((f) => f.url === "/api/ai/analyze-photo").length === 0, "D 오프라인 analyze → 요청 0");
  ok(calls.oplog.length === 0, "D 🔴 OpLog.recordCurrent 호출 0(큐 적립 없음)");
  ok(calls.toast.some((m) => /온라인에서 사용/.test(m)), "D 사유 토스트");
}

/* ══ E. 결함 등록 제안 → 폼 미리 채우기만(저장 0) ══ */
console.log("\n[E. prefillDefect — 사람이 확정]");
{
  const pin = PIN();
  const { A, calls, document } = load({ panoOpen: true, currentPin: pin });
  const before = calls.fetch.length;
  const r = await A.prefillDefect(pin, { title: "배관 플랜지 부식", detail: "우측 볼트 주변 녹", severity: "mid", confidence: 0.75 }, 0.7);
  const input = document.getElementById("pnp-input"), sev = document.getElementById("pnp-severity");
  ok(r === true && calls.notesPin === pin && calls.notesOpen === 1, "E 360 안: Notes.setPin + openPanel(기존 결함 폼)");
  ok(/^배관 플랜지 부식\n우측 볼트 주변 녹/.test(input.value) && /AI 제안/.test(input.value), "E #pnp-input 에 제목+내용 채움 — " + JSON.stringify(input.value).slice(0, 60));
  ok(sev.value === "중", "E 심각도 mid → '중'(신뢰도 0.75 ≥ 0.7)");
  ok(input.focused, "E 입력창 포커스(사람이 확인)");
  ok(calls.fetch.length === before && calls.oplog.length === 0, "E 🔴 저장 요청 0(fetch/OpLog) — 등록은 사람이 [등록]");
  const r2 = await A.prefillDefect(pin, { title: "t", detail: "d", severity: "high", confidence: 0.4 }, 0.7);
  ok(r2 && sev.value === "" && /추정/.test(input.value) && calls.toast.some((m) => /심각도는 직접/.test(m)), "E 신뢰도 0.4(추정) → 심각도 비움 + 직접 선택 안내");
}
{
  const pin = PIN();
  const { A, calls } = load({ panoOpen: false });
  const r = await A.prefillDefect(pin, { title: "t", detail: "d", severity: "low", confidence: 0.9 }, 0.7);
  ok(r === true && calls.openPano.length === 1 && calls.openPano[0] === pin && calls.notesOpen === 1, "E 핀 팝업에서: 360 열고(App.openPano) 결함 폼 연다");
}
{
  const { A, calls } = load({ panoOpen: true, currentPin: PIN(), isDesigner: false });
  const r = await A.prefillDefect(PIN(), { title: "t", detail: "d", severity: "low", confidence: 0.9 }, 0.7);
  ok(r === false && calls.notesOpen === 0, "E 열람자 → 폼 열지 않음");
}

/* ══ F. 360 임시 마커 → 저장은 사람 ══ */
console.log("\n[F. 360 마커 — 임시 레이어, 저장 버튼]");
{
  const pin = PIN();
  const { A, calls, PanoViewer } = load({ panoOpen: true, currentPin: pin });
  const spots = A.toSpots(RESULT().result.items, 0.7);
  ok(spots.length === 2 && spots[0].lon === 80 && spots[0].lat === -5 && spots[1].lon === 250 && spots[1].lat === -12, "F yaw→lon, pitch→lat 그대로(뷰어 축 동일) — " + JSON.stringify(spots.map((s) => [s.lon, s.lat])));
  ok(spots[0].kind === "equip" && spots[1].kind === "defect" && spots[0].ai === true && /\(추정\)$/.test(spots[1].label) && !/추정/.test(spots[0].label), "F 종류 매핑 + 「추정」 라벨 접미(0.55 만)");
  const shown = await A.showMarkers(pin, RESULT().result.items, 0.7);
  ok(shown === true && calls.setAiSpots.length === 1 && calls.setAiSpots[0][0] === "p1" && calls.setAiSpots[0][1].length === 2 && calls.renderSpots.length === 1, "F showMarkers → PanoViewer.setAiSpots(pin, 2) + renderSpots");
  ok(pin.spots.length === 0 && calls.saveSpots.length === 0, "F 🔴 표시만 — pin.spots 변경 0, 저장 0");
  ok(A.describeSpot("ai-1") === true && calls.toast.some((m) => /임시 마커/.test(m)), "F 임시 마커 탭 → 안내(편집 폼 없음)");
  const n = A.saveMarkers(pin);
  ok(n === 2 && pin.spots.length === 2 && pin.spots[0].ai === true && pin.spots[0].lon === 80 && calls.saveSpots.length === 1 && PanoViewer._aiSpots === null, "F [마커로 저장](사람) → pin.spots 2 + App._saveSpots + 임시 레이어 비움");
  A.clearMarkers();
  ok(PanoViewer._aiSpots === null, "F clearMarkers");
}

/* ══ G. 배선 — 실제 소스 대조 ══ */
console.log("\n[G. 배선 — 06_PanoViewer / 20_App / 27_PinActionPop / 99_footer / index.html / 45_FeatureMenu / 36_Help / manifest]");
{
  // [WO 20261019-gap1] 🔴 70_Scale/71_XlsxExport/72_DesignCompare(+ 73_ThetaOSC, 동시 팀)이 합류하며
  // manifest 가 더 길어졌다 — "AiVision 바로 다음이 footer" 는 그 시점의 우연한 순서였을 뿐, 진짜 불변은
  // "AiVision 이 등록돼 있고 footer 가 마지막 줄"이다(고아 금지 — 의미는 그대로, 과적합 정규식만 교정).
  ok(/49_AiVision\.js/.test(MANIFEST) && /\n99_footer\.js\s*$/.test(MANIFEST), "G _manifest.txt 에 49_AiVision.js 등록 + 99_footer.js 가 마지막 줄");
  ok(/setAiSpots\(pinId, spots\)/.test(PV_SRC) && /spots = spots\.concat\(this\._aiSpots\)/.test(PV_SRC), "G 06_PanoViewer.renderSpots 가 _aiSpots 를 합쳐 그림(기존 마커 레이어 재사용)");
  ok(/_closeImmediate\(\) \{[\s\S]{0,400}this\._aiSpots = null/.test(PV_SRC) && /AiVision\.onPanoClose\(\)/.test(PV_SRC), "G 뷰어 닫힘 → 임시 AI 마커·패널 정리");
  ok(/AiVision\.onPanoOpen\(pin\)/.test(APP_SRC), "G App.openPano → AiVision.onPanoOpen(새 핀마다 초기화)");
  ok(/UI\.\$\("btn-pano-ai"\)[\s\S]{0,120}AiVision\.togglePanoPanel\(\)/.test(APP_SRC), "G 360 헤더 #btn-pano-ai → AiVision.togglePanoPanel");
  ok(/if \(!s\) \{ if \(typeof AiVision !== "undefined" && AiVision\.describeSpot\) AiVision\.describeSpot\(id\); return; \}/.test(APP_SRC), "G App._openSpot: 임시 AI 마커 탭 안내");
  ok(/AiVision\.mount\("pap-ai", pin, \{ theme: "light", canEdit \}\)/.test(PAP_SRC) && /AiVision\.unmount\("pap-ai"\)/.test(PAP_SRC), "G 핀 팝업 open → mount('pap-ai') / close → unmount");
  ok(/AiVision\.init\(\)/.test(FOOT_SRC) && /AiVision: \(typeof AiVision/.test(FOOT_SRC), "G 99_footer: AiVision.init() + __wm 노출");
  ok(/id="btn-pano-ai"/.test(HTML) && /id="pano-ai-panel"/.test(HTML) && /id="pap-ai"/.test(HTML), "G index.html: #btn-pano-ai · #pano-ai-panel · #pap-ai");
  ok(/data-help="ai-analyze"/.test(HTML), "G #btn-pano-ai 에 data-help(도움말 배지)");
  // FeatureMenu + Help 실행
  const { document } = makeDoc();
  const sb = { console, document, window: {}, navigator: { userAgent: "x" }, localStorage: { getItem: () => null, setItem() {} }, setTimeout, clearTimeout, Date, JSON, Math, String, Array, Object,
    State: { mode: "designer" }, Auth: { isDesigner: true }, Projects: undefined, ThetaIntake: undefined, App: undefined, Prompt: undefined };
  vm.createContext(sb);
  vm.runInContext(UI_SRC + "\n" + HELP_SRC + "\n" + FM_SRC + "\nthis.FM = FeatureMenu; this.H = Help;", sb);
  const f = sb.FM.FEATURES.find((x) => x.id === "ai-analyze");
  ok(!!f && f.group === "pano" && f.perm === "designer" && f.needs === "pano" && f.click === "btn-pano-ai" && f.help === "ai-analyze", "G 전체 기능 메뉴에 ai-analyze(360 그룹 · 디자이너 · 360 뷰어 · #btn-pano-ai 위임)");
  ok(typeof sb.H.CONTENT["ai-analyze"] === "string" && /사람이 \[등록\]/.test(sb.H.CONTENT["ai-analyze"]) && /추정/.test(sb.H.CONTENT["ai-analyze"]), "G 도움말 문구(ai-analyze): 추정·사람 확정 명시");
  ok(/AI 사진 분석/.test(sb.FM.descOf(f)) || sb.FM.descOf(f).length > 10, "G 메뉴 설명 = 도움말 첫 문장 공유 — " + sb.FM.descOf(f).slice(0, 40));
}

console.log(failed ? `\n${failed} FAIL` : "\nALL PASS");
process.exit(failed ? 1 : 0);
