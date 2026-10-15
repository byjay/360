/**
 * p154 — [삭제 기록] 화면(WO 20261015-bulkdel-undo, 53_PinPurge.openHistory/_renderHistory/_historyRow)
 * (프레임워크 0 · 실행: node tests/p154-pinpurge-history.test.mjs)
 *
 * 마스터(음성) "삭제했던 걸 다시 되돌리고 싶을 때 되돌릴 수 있게끔." 하단 바([되돌리기])가 닫힌 뒤에도
 * 되돌릴 수 있는 화면 — 프로젝트 전체·구역·선택 공통 목록. 실 53_PinPurge.js 소스를 vm 에 그대로 올리고
 * document/fetch/Auth/Prompt/Projects 만 최소 스텁(목은 DOM·네트워크 경계만).
 *
 *  A 권한 없음(historyReason 비어있지 않음) → 토스트만, fetch 0회
 *  B 권한 있음 → GET .../pins/purge/history 호출 → 행 N개 렌더(날짜·누가·범위·핀수·상태)
 *  C 상태별 [되돌리기] 버튼 유무 — available/partial = 있음, restored = 없음
 *  D [되돌리기] 클릭 → confirm(1회) → POST .../<batch>/undo → 성공 토스트 + 목록 새로고침(GET 2번째 호출)
 *  E confirm 취소 → POST 호출 안 함
 *  F 오프라인 → [되돌리기] 비활성(disabled, aria-disabled)
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
let failed = 0;
const ok = (cond, label, d) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (!cond && d !== undefined ? " :: " + JSON.stringify(d).slice(0, 300) : "")); if (!cond) failed++; };

/* ── 최소 DOM(appendChild/style/textContent/addEventListener/querySelector 만) ── */
function makeClassList() {
  const set = new Set();
  return { add: (...c) => c.forEach((x) => x && set.add(x)), remove: (...c) => c.forEach((x) => set.delete(x)), contains: (c) => set.has(c), _set: set };
}
function makeEl(tag) {
  const el = {
    tagName: tag || "div", style: {}, dataset: {}, disabled: false, title: "", _text: "", _attrs: {}, _children: [], _handlers: {},
    appendChild(c) { this._children.push(c); return c; },
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return this._attrs[k]; },
    addEventListener(t, f) { (this._handlers[t] = this._handlers[t] || []).push(f); },
    querySelector(sel) { return (this._children.find((c) => sel.includes(c.className)) || null); },
    remove() { if (this.parentNode) this.parentNode._children = this.parentNode._children.filter((c) => c !== this); },
  };
  Object.defineProperty(el, "textContent", { get() { return this._text; }, set(v) { this._text = v == null ? "" : String(v); } });
  el.classList = makeClassList();
  return el;
}
function makeDocument() {
  const body = makeEl("body");
  const keyHandlers = [];
  return {
    body,
    createElement: (t) => { const e = makeEl(t); return e; },
    addEventListener(type, fn) { if (type === "keydown") keyHandlers.push(fn); },
    _fireKey(e) { keyHandlers.forEach((f) => f(e)); },
  };
}
const click = async (el) => { for (const f of (el._handlers.click || [])) await f({ stopPropagation() {} }); };

function makeSandbox({ reason = "", historyReason = "", online = true, fetchImpl }) {
  const document = makeDocument();
  const calls = { toast: [], confirm: [], fetch: [] };
  const sandbox = {
    console, document, navigator: { onLine: online },
    Projects: { currentProject: { id: "prjH", name: "P154" } },
    Auth: { headers: (e) => (e || {}), isSuper: false, readonly: false, reauthHeader: () => ({}), clearReauth() {}, ensureReauth: async () => true },
    Prompt: { toast(m) { calls.toast.push(m); }, confirm: async (t, m) => { calls.confirm.push({ t, m }); return calls._confirmAns !== false; } },
    State: { autoSaveDepId: null, depVersion: 0 },
    App: {},
    UI: { renderTree() {} },
    fetch: async (url, opt) => { calls.fetch.push({ url, opt }); return fetchImpl(url, opt); },
    JSON, Object, Array, Map, Set, Number, String, Date, Promise, setInterval, clearInterval, setTimeout, clearTimeout,
  };
  vm.createContext(sandbox);
  vm.runInContext(rd("public/js/modules/53_PinPurge.js") + "\n;globalThis.__PP = PinPurge;", sandbox);
  const PinPurge = sandbox.__PP;
  // reason()/historyReason() 은 Auth.isSuper 등 실 판정을 타므로, 이 단위 테스트에선 바로 오버라이드한다(스코프 밖).
  PinPurge.reason = () => reason;
  PinPurge.historyReason = () => historyReason;
  return { PinPurge, document, calls, sandbox };
}
const res = (status, j) => ({ status, ok: status >= 200 && status < 300, json: async () => j });

console.log("\n[A. 권한 없음 — 토스트만, fetch 0회]");
{
  const { PinPurge, calls } = makeSandbox({ historyReason: "소유자·관리자 전용", fetchImpl: async () => res(200, { ready: true, batches: [] }) });
  await PinPurge.openHistory();
  ok(calls.fetch.length === 0, "A fetch 호출 없음");
  ok(/소유자·관리자 전용/.test(calls.toast[0] || ""), "A 토스트에 사유 — " + JSON.stringify(calls.toast[0]));
}

console.log("\n[B. 권한 있음 — 목록 렌더]");
const ROWS = [
  { batch: "b1", actor: "o@test", created_at: 1760000000000, scope: "zone", scope_label: "구역 'Zone-1'", pin_count: 2, status: "available" },
  { batch: "b2", actor: "o@test", created_at: 1760000100000, scope: "selection", scope_label: null, pin_count: 1, status: "partial" },
  { batch: "b3", actor: "o@test", created_at: 1760000200000, scope: "project", scope_label: null, pin_count: 8, status: "restored" },
];
let lastHist;
{
  const fetchImpl = async (url) => {
    if (/\/pins\/purge\/history$/.test(url)) return res(200, { ready: true, undo_window_ms: 2592000000, batches: ROWS });
    return res(200, { ok: true, restored: 2, failed: 0, results: [] });
  };
  const { PinPurge, document, calls } = makeSandbox({ historyReason: "", fetchImpl });
  await PinPurge.openHistory();
  lastHist = { PinPurge, document, calls };
  ok(calls.fetch.length === 1 && /\/api\/projects\/prjH\/pins\/purge\/history$/.test(calls.fetch[0].url), "B GET .../pins/purge/history 호출 — " + (calls.fetch[0] && calls.fetch[0].url));
  const panel = document.body._children[document.body._children.length - 1]._children[0];
  ok(!!panel, "B 모달이 body 에 추가됨");
  const rows = panel._children[1]._children; // head, body
  ok(rows.length === 3, "B 행 3개 렌더 — " + rows.length);
  ok(/구역 'Zone-1'/.test(rows[0]._children[0].textContent) && /핀 2개/.test(rows[0]._children[0].textContent), "B 행1 = 구역 라벨·핀 2개 — " + rows[0]._children[0].textContent);
  ok(/선택/.test(rows[1]._children[0].textContent) && /핀 1개/.test(rows[1]._children[0].textContent), "B 행2 = 선택(scope_label 없음 폴백)·핀 1개 — " + rows[1]._children[0].textContent);
  ok(/프로젝트 전체/.test(rows[2]._children[0].textContent), "B 행3 = 프로젝트 전체 — " + rows[2]._children[0].textContent);
  ok(rows[0]._children[1].textContent === "가능" && rows[1]._children[1].textContent === "일부 복원" && rows[2]._children[1].textContent === "복원됨",
    "B 상태 배지 — 가능/일부 복원/복원됨 — " + [rows[0]._children[1].textContent, rows[1]._children[1].textContent, rows[2]._children[1].textContent].join(","));
}

console.log("\n[C. 상태별 되돌리기 버튼 유무]");
{
  const { document } = lastHist;
  const panel = document.body._children[document.body._children.length - 1]._children[0];
  const rows = panel._children[1]._children;
  ok(rows[0]._children.length === 3 && rows[0]._children[2].textContent === "되돌리기", "C available → 되돌리기 버튼 있음");
  ok(rows[1]._children.length === 3 && rows[1]._children[2].textContent === "되돌리기", "C partial → 되돌리기 버튼 있음");
  ok(rows[2]._children.length === 2, "C restored → 되돌리기 버튼 없음(이미 복원됨)");
}

console.log("\n[D. 되돌리기 클릭 → confirm → POST undo → 재조회]");
{
  const { PinPurge, document, calls } = lastHist;
  const panel = document.body._children[document.body._children.length - 1]._children[0];
  const rows = panel._children[1]._children;
  const undoBtn = rows[0]._children[2];
  await click(undoBtn);
  ok(calls.confirm.length === 1, "D confirm 1회 호출");
  const postCall = calls.fetch.find((f) => /\/pins\/purge\/b1\/undo$/.test(f.url));
  ok(!!postCall && postCall.opt.method === "POST", "D POST .../b1/undo 호출됨");
  ok(/핀 2개 복원/.test(calls.toast[calls.toast.length - 1] || ""), "D 성공 토스트 — " + JSON.stringify(calls.toast[calls.toast.length - 1]));
  const getCalls = calls.fetch.filter((f) => /\/pins\/purge\/history$/.test(f.url));
  ok(getCalls.length === 2, "D 되돌리기 후 목록 재조회(두 번째 GET) — " + getCalls.length);
  ok(typeof PinPurge._afterServerChange === "function", "D _afterServerChange 존재(App._mergeConflict 없으면 조용히 생략)");
}

console.log("\n[E. confirm 취소 → POST 안 함]");
{
  const fetchImpl = async (url) => {
    if (/\/pins\/purge\/history$/.test(url)) return res(200, { ready: true, batches: [ROWS[0]] });
    return res(200, {});
  };
  const { PinPurge, document, calls } = makeSandbox({ historyReason: "", fetchImpl });
  calls._confirmAns = false;
  await PinPurge.openHistory();
  const panel = document.body._children[document.body._children.length - 1]._children[0];
  const row = panel._children[1]._children[0];
  await click(row._children[2]);
  ok(calls.confirm.length === 1, "E confirm 1회 호출");
  ok(!calls.fetch.some((f) => /\/undo$/.test(f.url)), "E confirm 취소 → POST undo 호출 없음");
}

console.log("\n[F. 오프라인 → 되돌리기 비활성]");
{
  const fetchImpl = async (url) => (/\/pins\/purge\/history$/.test(url) ? res(200, { ready: true, batches: [ROWS[0]] }) : res(200, {}));
  const { PinPurge, document } = makeSandbox({ historyReason: "", online: false, fetchImpl });
  await PinPurge.openHistory();
  const panel = document.body._children[document.body._children.length - 1]._children[0];
  const row = panel._children[1]._children[0];
  const btn = row._children[2];
  ok(btn.disabled === true, "F 오프라인 → 되돌리기 disabled=true");
  ok(btn._attrs["aria-disabled"] === "true" && /온라인/.test(btn.title), "F aria-disabled·title 사유 — " + JSON.stringify({ attr: btn._attrs, title: btn.title }));
}

console.log(failed ? `\n${failed} FAIL` : "\nALL PASS");
process.exit(failed ? 1 : 0);
