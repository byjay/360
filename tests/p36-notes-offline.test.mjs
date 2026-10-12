/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p36-notes-offline.test.mjs)
 *
 * 결함: 오프라인 완전작업(핀/구역/주석)은 OpLog(32_Offline.js)로 큐잉→재연결 시 자동 replay 되지만,
 * 노트(이슈, 13_Notes.js)만 /api/notes 를 직접 fetch — 오프라인이면 그냥 실패해 흐름이 끊겼다.
 *
 * 수정(공유 지점 재사용 — 새 메커니즘 금지, §G-2-5):
 *  - 13_Notes.js: submit()/submitCompact()/updateStatus()/remove() 에 오프라인 분기 추가.
 *    OpLog.recordCurrent("note", "upsert"|"delete", id, data) — pin/zone/anno 와 동일한 호출 모양.
 *  - 32_Offline.js: App._flushOpLogs() 응답의 noteIdMap 을 Notes.applyIdMap()에 전달(새 flush 경로 아님).
 *  - src/index.tsx: /tables/deployments/:id/ops 에 entity:'note' 분기 추가 — pin_notes 테이블에
 *    직접 반영(배포본 JSON blob과 무관, version 불변). 임시id→실제id 매핑을 noteIdMap 으로 응답.
 *    멱등성은 기존 applied_ops(전역, op_id PK) 재사용 — note 전용 dedup 테이블 신설 안 함.
 *  - 20_App.js _updateSyncBadge(): SyncQueue.count() + OpLog.pending(depId).length 합산(노트 포함, SoT).
 *
 * 검증 항목:
 *  ① 오프라인에서 노트 작성 → OpLog 에 기록된다
 *  ② 오프라인 노트 수정·삭제도 기록된다
 *  ③ 재연결 시 기존 App._flushOpLogs() 경로로 전송된다(새 전송 경로 아님 — POST 대상 URL이 기존
 *     /tables/deployments/:id/ops 그대로)
 *  ④ 같은 op 를 두 번 replay(서버 실제 핸들러) 해도 노트가 1개만 생성된다(멱등, applied_ops 재사용)
 *  ⑤ 임시 id 가 서버 id 로 교체되고(noteIdMap) 화면 참조(Notes._list)가 유지된다
 *  ⑥ 전송 실패(비영구, 500) 시 큐가 보존된다
 *  ⑦ _updateSyncBadge() 대기 건수에 노트(OpLog pending)가 포함된다
 *
 * 실제 모듈 소스(13_Notes.js, 32_Offline.js, 20_App.js, src/index.tsx 의 ops 핸들러)를
 * 브레이스-밸런싱으로 발췌해 vm 에 그대로 평가한다(목 구현 아님 — 소스 그대로, p15 패턴 재사용).
 * 서버 핸들러는 TypeScript 라 esbuild(프로젝트 기존 의존성)로 transpile 후 실행한다.
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const notesSrc = rd("public/js/modules/13_Notes.js");
const offlineSrc = rd("public/js/modules/32_Offline.js");
const appSrc = rd("public/js/modules/20_App.js");
const serverSrc = rd("src/index.tsx");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── 브레이스-밸런싱 발췌 (p15 와 동일 패턴) ── */
function extractBalanced(src, needle) {
  const start = src.indexOf(needle);
  if (start < 0) throw new Error("needle not found: " + needle);
  const braceStart = src.indexOf("{", start);
  let depth = 0, i = braceStart;
  for (; i < src.length; i++) {
    if (src[i] === "{") depth++;
    else if (src[i] === "}") { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

/* ══════════════════════════════════════════════════════════════════
 * 서버 ops 핸들러 — 실 소스 추출 + esbuild transpile + vm 실행
 * ══════════════════════════════════════════════════════════════════ */
function makeFakeDB(state) {
  return {
    prepare(sql) {
      return {
        bind(...args) {
          return {
            async first() {
              if (sql.indexOf("SELECT * FROM deployments WHERE id = ? AND deleted = 0") >= 0) {
                const [id] = args;
                return state.deployments.find((d) => d.id === id && !d.deleted) || null;
              }
              if (sql.indexOf("SELECT op_id FROM applied_ops WHERE op_id = ?") >= 0) {
                const [opId] = args;
                return state.appliedOps.find((o) => o.op_id === opId) || null;
              }
              return null;
            },
            async all() { return { results: [] }; },
            async run() {
              if (sql.indexOf("INSERT OR IGNORE INTO applied_ops") >= 0) {
                const [opId, depId, appliedAt] = args;
                if (!state.appliedOps.find((o) => o.op_id === opId)) {
                  state.appliedOps.push({ op_id: opId, deployment_id: depId, applied_at: appliedAt });
                }
              } else if (sql.indexOf("INSERT INTO pin_notes") >= 0) {
                const [id, deployment_id, pin_id, pin_label, body, status, assignee, author, author_email, author_role, created_at, updated_at, resolved_at] = args;
                state.pinNotes.push({ id, deployment_id, pin_id, pin_label, body, status, assignee, author, author_email, author_role, created_at, updated_at, resolved_at, deleted: 0 });
              } else if (sql.indexOf("UPDATE pin_notes SET") >= 0) {
                // [2026-10-10] WHERE 절의 "col = ?" 를 전부 해석한다(종전: 마지막 인자 = id 가정).
                //   서버가 노트 쓰기를 URL 배포본 소속으로 한정(AND deployment_id = ?)하면서 인자 순서가 늘었다 — 가짜 DB 도 같은 조건으로 거른다.
                //   SET 의 리터럴(deleted = 1)과 자리표시자(col = ?)를 구분해 인자를 순서대로 소비한다.
                const setPart = sql.slice(sql.indexOf("SET") + 3, sql.indexOf("WHERE")).trim();
                const sets = setPart.split(",").map((s) => { const [k, v] = s.split("=").map((x) => x.trim()); return { k, v }; });
                let ai = 0;
                const assign = sets.map(({ k, v }) => ({ k, val: v === "?" ? args[ai++] : Number(v) }));
                const whereCols = Array.from(sql.slice(sql.indexOf("WHERE")).matchAll(/(\w+) = \?/g)).map((m) => m[1]);
                const whereArgs = args.slice(ai);
                const alive = sql.indexOf("deleted = 0") >= 0;
                const n = state.pinNotes.find((n) => whereCols.every((c, i) => n[c] === whereArgs[i]) && (!alive || !n.deleted));
                if (n) assign.forEach(({ k, val }) => { n[k] = val; });
              } else if (sql.indexOf("UPDATE deployments SET pins=") >= 0) {
                const [pins, zones, annotations, updated_at, version, id] = args;
                const d = state.deployments.find((d) => d.id === id);
                if (d) Object.assign(d, { pins, zones, annotations, updated_at, version });
              }
              return {};
            }
          };
        }
      };
    }
  };
}

function buildOpsHandler() {
  const genIdSrc = extractBalanced(serverSrc, "function genId(prefix: string): string {");
  const validStatusMatch = serverSrc.match(/const VALID_STATUS = \[[^\]]*\]/);
  if (!validStatusMatch) throw new Error("VALID_STATUS not found");
  const validStatusPatchMatch = serverSrc.match(/const VALID_STATUS_PATCH = \[[^\]]*\]/);
  if (!validStatusPatchMatch) throw new Error("VALID_STATUS_PATCH not found");
  const opsCallSrc = extractBalanced(serverSrc, "app.post('/tables/deployments/:id/ops', async (c) => {") + ")";

  const tsSrc = `
    ${genIdSrc}
    ${validStatusMatch[0]}
    ${validStatusPatchMatch[0]}
    const SEVERITY_LEVELS = ['상', '중', '하'];
    const DEFAULT_TENANT = 'tnt_default';
    async function requireDesigner(c) { return { email: 'designer@test.com' }; }
    async function deploymentWriteDenied(c, user, pid) { return null; }  // [WP3] 프로젝트 권한 가드 — 이 테스트 대상 아님(p93 B5 가 실 워커로 검증)
    async function tenantOf(c, user) { return null; }
    async function resolvePinHome(c, depId, row) { return null; }  // [WO 20261012-pinsync] 일반 배포본(별칭 아님) — 별칭 경로는 p151 이 실 워커로 검증
    // [WO 20261002-gap] '확인(verified)' 권한 게이트 — 이 테스트는 verified 전환을 다루지 않으므로 거부로 고정(p111/p117 가 별도 검증).
    async function canManageMembers(c, user, pid) { return false; }
    function mapDeployment(row) { return row; }
    const app = { post(path, handler) { globalThis.__opsHandler = handler; } };
    ${opsCallSrc}
  `;
  const { code } = esbuild.transformSync(tsSrc, { loader: "ts" });
  const sandbox = { console, globalThis: {}, Object, Array, String, Number, JSON, Date, Math, Map };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox);
  return sandbox.__opsHandler;
}

function makeC(dbState, depId, body) {
  return {
    req: { param: () => depId, json: async () => body },
    env: { DB: makeFakeDB(dbState) },
    json: (obj, status) => ({ status: status || 200, body: obj })
  };
}

const opsHandler = buildOpsHandler();

function freshDbState(depId) {
  return {
    deployments: [{ id: depId, pins: "[]", zones: "[]", annotations: "[]", version: 0, deleted: 0, tenant_id: null }],
    appliedOps: [],
    pinNotes: []
  };
}

console.log("\n[④ 서버 ops 핸들러 — 같은 opId 두 번 replay 해도 노트 1개만 생성(멱등)]");
{
  const depId = "dep1";
  const db = freshDbState(depId);
  const op = { opId: "op-note-1", entity: "note", action: "upsert", id: "tmp-note-abc", ts: Date.now(),
    data: { deployment_id: depId, pin_id: "pin1", pin_label: "P1", body: "누수 확인 필요", status: "open", assignee: "", author: "현장자", author_email: null, author_role: "guest" } };
  const r1 = await opsHandler(makeC(db, depId, { ops: [op] }));
  ok(r1.body.ok === true, "④ 1차 replay 성공 응답");
  ok(db.pinNotes.length === 1, "④ 1차 replay 후 노트 1건 생성: 실제 " + db.pinNotes.length);
  const newId = r1.body.noteIdMap["tmp-note-abc"];
  ok(!!newId && newId.indexOf("note_") === 0, "④ noteIdMap 에 실제 id 반환: " + newId);

  // 같은 opId 로 재전송(재연결 두 번 등 중복 replay 시나리오)
  const r2 = await opsHandler(makeC(db, depId, { ops: [op] }));
  ok(db.pinNotes.length === 1, "④ 같은 opId 재전송 후에도 노트 여전히 1건(멱등): 실제 " + db.pinNotes.length);
  ok(r2.body.applied.indexOf("op-note-1") >= 0, "④ 재전송 응답의 applied 목록에도 opId 포함(정상 처리로 보고)");
}

console.log("\n[⑤ 서버 ops 핸들러 — 임시id 생성 후 같은 배치 내 수정/삭제가 정상 반영]");
{
  const depId = "dep2";
  const db = freshDbState(depId);
  const tmp = "tmp-note-xyz";
  const createOp = { opId: "op-c1", entity: "note", action: "upsert", id: tmp, ts: 1000,
    data: { deployment_id: depId, pin_id: "pin1", pin_label: "P1", body: "초안", status: "open", assignee: "", author: "A", author_email: null, author_role: "guest" } };
  const editOp = { opId: "op-c2", entity: "note", action: "upsert", id: tmp, ts: 2000,
    data: { body: "수정됨", status: "progress" } };
  const r = await opsHandler(makeC(db, depId, { ops: [createOp, editOp] }));
  ok(db.pinNotes.length === 1, "⑤ 생성+수정 같은 배치 → 노트 1건 유지");
  ok(db.pinNotes[0].body === "수정됨" && db.pinNotes[0].status === "progress", "⑤ 수정 내용 반영: " + JSON.stringify(db.pinNotes[0].body) + "/" + db.pinNotes[0].status);
  ok(!!r.body.noteIdMap[tmp], "⑤ noteIdMap 반환됨");
}

/* ══════════════════════════════════════════════════════════════════
 * 클라이언트 13_Notes.js — 오프라인 분기(①②) + submitCompact
 * ══════════════════════════════════════════════════════════════════ */
function makeNotesSandbox() {
  const objSrc = notesSrc.slice(notesSrc.indexOf("const Notes = {"), notesSrc.indexOf("\n  };") + 5);
  const recordedOps = [];
  const OpLog = {
    async recordCurrent(entity, action, id, data) {
      recordedOps.push({ entity, action, id, data: data ? JSON.parse(JSON.stringify(data)) : null });
    }
  };
  const els = {};
  const mkEl = () => ({ value: "", textContent: "", classList: { add() {}, remove() {}, contains: () => false, toggle() {} } });
  ["pnp-input", "pnp-status-sel", "pnp-assignee", "pnp-author", "pnp-submit"].forEach((id) => { els[id] = mkEl(); });
  const document = {
    getElementById: (id) => els[id] || null,
    querySelectorAll: () => []
  };
  const State = { currentDeploymentId: "dep1" };
  const Auth = { user: { name: "현장자", email: "field@test.com" }, isDesigner: false };
  const UI = { escapeHtml: (s) => s };
  const sandbox = {
    console, document, State, Auth, OpLog, UI, JSON, Object, Array, Date, Math, String,
    navigator: { onLine: false }, fetch: async () => { throw new Error("네트워크 오류(테스트에서 호출되면 안 됨)"); },
    confirm: () => true, Prompt: { confirm: async () => true, toast: () => {} }
  };
  vm.createContext(sandbox);
  vm.runInContext(objSrc + ";globalThis.__Notes = Notes;", sandbox);
  return { Notes: sandbox.__Notes, recordedOps, els, setOnline: (v) => { sandbox.navigator.onLine = v; } };
}

console.log("\n[① 오프라인 노트 작성 → OpLog.recordCurrent('note','upsert',...) 기록]");
{
  const { Notes, recordedOps, els } = makeNotesSandbox();
  Notes._pin = { id: "pin1", label: "1층 배관실" };
  els["pnp-input"].value = "누수 발견, 확인 요청";
  await Notes.submit();
  const op = recordedOps.find((o) => o.entity === "note" && o.action === "upsert");
  ok(!!op, "① OpLog.recordCurrent('note','upsert', tmpId, data) 호출됨");
  ok(op && op.id.indexOf("tmp-note-") === 0, "① 임시 id 형식(tmp-note-*): " + (op && op.id));
  ok(Notes._list.length === 1 && Notes._list[0].body === "누수 발견, 확인 요청", "① 화면 목록(this._list)에 낙관적 반영");
}

console.log("\n[② 오프라인 노트 수정(updateStatus)·삭제(remove)도 OpLog 기록]");
{
  const { Notes, recordedOps } = makeNotesSandbox();
  Notes._pin = { id: "pin1", label: "1층" };
  Notes._list = [{ id: "tmp-note-1", deployment_id: "dep1", pin_id: "pin1", body: "이슈", status: "open" }];
  await Notes.updateStatus("tmp-note-1", "done");
  const editOp = recordedOps.find((o) => o.action === "upsert" && o.id === "tmp-note-1");
  ok(!!editOp && editOp.data.status === "done", "② 상태변경 → OpLog upsert 기록(status=done)");
  ok(Notes._list[0].status === "done", "② 로컬 목록도 즉시 반영");

  await Notes.remove("tmp-note-1");
  const delOp = recordedOps.find((o) => o.action === "delete" && o.id === "tmp-note-1");
  ok(!!delOp, "② 삭제 → OpLog delete 기록");
  ok(Notes._list.length === 0, "② 로컬 목록에서 제거됨");
}

console.log("\n[submitCompact 오프라인 분기]");
{
  const { Notes, recordedOps } = makeNotesSandbox();
  const ok2 = await Notes.submitCompact({ id: "pin2", label: "2층" }, "컴팩트 노트");
  ok(ok2 === true, "submitCompact 오프라인 → true 반환");
  const op = recordedOps.find((o) => o.entity === "note" && o.data && o.data.body === "컴팩트 노트");
  ok(!!op, "submitCompact → OpLog 기록됨");
}

/* ══════════════════════════════════════════════════════════════════
 * ③ 32_Offline.js App._flushOpLogs — 노트도 기존 /tables/deployments/:id/ops 로 전송
 *    (새 전송 경로가 아님) + noteIdMap → Notes.applyIdMap 호출
 * ══════════════════════════════════════════════════════════════════ */
// [주의] offlineSrc 는 자체 `const OpLog = {...}` 를 선언(진짜 구현) — 이 렉시컬 선언이
// sandbox 에 주입한 전역 OpLog 프로퍼티보다 우선한다. 따라서 OpLog 를 목(mock)하지 않고,
// 그 아래 저장계층(SyncQueue.loadDraft/saveDraft)만 인메모리로 제공해 실제 OpLog 로직을 그대로 태운다.
function makeMemorySyncQueue(seed) {
  const store = Object.assign({}, seed);
  return {
    async allDraftKeys() { return Object.keys(store); },
    async loadDraft(key) { return store[key]; },
    async saveDraft(key, data) { store[key] = data; },
    _emit() {},
    _store: store
  };
}
function makeFlushSandbox(seedOps) {
  const src = offlineSrc;
  const fetchCalls = [];
  let fetchImpl = async () => ({ ok: true, json: async () => ({ applied: [], noteIdMap: {} }) });
  const applyIdMapCalls = [];
  const Notes = { applyIdMap: (m) => applyIdMapCalls.push(m) };
  const SyncQueue = makeMemorySyncQueue({ "oplog:dep1": seedOps || [{ opId: "op-note-1", entity: "note", action: "upsert", id: "tmp-note-1", data: {}, ts: Date.now() }] });
  const State = { pins: [], zones: [], annotations: [] };
  const UI = { renderPinList() {}, renderPinsOnMap() {} };
  const App = {};
  const sandbox = {
    console, SyncQueue, Notes, State, UI, Auth: { headers: () => ({}) }, Projects: {}, App,
    navigator: { onLine: true }, window: {}, JSON, Object, Array, Promise, Date, Math, String, Set,
    fetch: (...args) => { fetchCalls.push(args); return fetchImpl(...args); },
    setTimeout: (fn) => fn() // 재시도 backoff 즉시 실행(테스트 속도)
  };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__App_flushOpLogs = App._flushOpLogs;", sandbox);
  return {
    flush: sandbox.__App_flushOpLogs, fetchCalls, applyIdMapCalls, store: SyncQueue._store,
    setFetch: (fn) => { fetchImpl = fn; }
  };
}

console.log("\n[③ App._flushOpLogs — 노트도 기존 /tables/deployments/:id/ops 경로로 전송 + noteIdMap 반영]");
{
  const { flush, fetchCalls, applyIdMapCalls, setFetch, store } = makeFlushSandbox();
  setFetch(async () => ({ ok: true, json: async () => ({ applied: ["op-note-1"], noteIdMap: { "tmp-note-1": "note_real1" } }) }));
  await flush();
  ok(fetchCalls.length === 1, "③ fetch 1회 호출");
  ok(fetchCalls[0][0].indexOf("/tables/deployments/dep1/ops") >= 0, "③ 기존 ops 엔드포인트 그대로 사용(새 경로 아님): " + fetchCalls[0][0]);
  ok(applyIdMapCalls.length === 1 && applyIdMapCalls[0]["tmp-note-1"] === "note_real1", "⑤ noteIdMap 이 Notes.applyIdMap 로 전달됨");
  ok(!(store["oplog:dep1"] || []).some((o) => o.opId === "op-note-1"), "③ 성공 후 실제 OpLog.clearApplied 로 큐에서 제거됨");
}

console.log("\n[⑥ App._flushOpLogs — 전송 실패(500) 시 OpLog 큐 보존(실제 OpLog.clearApplied 미호출)]");
{
  const seedOps = [{ opId: "op-note-2", entity: "note", action: "upsert", id: "tmp-note-2", data: {}, ts: Date.now() }];
  const { flush, setFetch, store } = makeFlushSandbox(seedOps);
  setFetch(async () => ({ ok: false, status: 500 }));
  await flush();
  ok((store["oplog:dep1"] || []).some((o) => o.opId === "op-note-2"), "⑥ 500 실패 시 큐(oplog draft)에 op 그대로 보존");
}

/* ══════════════════════════════════════════════════════════════════
 * ⑦ 20_App.js _updateSyncBadge — OpLog pending(노트 포함) 이 배지 카운트에 합산
 * ══════════════════════════════════════════════════════════════════ */
function makeBadgeSandbox() {
  const block = extractBalanced(appSrc, "_updateSyncBadge() {");
  const objSrc = "const __appTest = { " + block + " };\nglobalThis.__appTest = __appTest;";
  const els = {};
  const mkEl = () => ({ textContent: "", classList: { add() {}, remove() {}, contains: () => false } });
  ["sync-badge", "sync-dot", "sync-text"].forEach((id) => { els[id] = mkEl(); });
  const UI = { $: (id) => els[id] || null };
  let sqCount = 0, opCount = 0;
  const SyncQueue = { count: async () => sqCount };
  const OpLog = { pending: async () => new Array(opCount).fill(0) };
  const Offline = { curDepId: () => "dep1" };
  const sandbox = { console, UI, SyncQueue, OpLog, Offline, navigator: { onLine: true }, Promise, Array };
  vm.createContext(sandbox);
  vm.runInContext(objSrc, sandbox);
  return {
    run: () => sandbox.__appTest._updateSyncBadge(),
    els, setSq: (n) => { sqCount = n; }, setOp: (n) => { opCount = n; }
  };
}

console.log("\n[⑦ _updateSyncBadge — SyncQueue 0건 + OpLog(노트) 2건 → 대기 2건으로 표시]");
{
  const { run, els, setSq, setOp } = makeBadgeSandbox();
  setSq(0); setOp(2);
  await run();
  // Promise.then 은 마이크로태스크 — 한 틱 더 흘려보냄
  await new Promise((r) => setTimeout(r, 0));
  ok(els["sync-text"].textContent.indexOf("2") >= 0, "⑦ 노트만 있어도(OpLog 2건) 배지에 2건 표시: " + els["sync-text"].textContent);
}

/* ══════════════════════════════════════════════════════════════════
 * 뮤테이션 증명 3건
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션1] 13_Notes.js 오프라인 분기 제거 → ①이 실패해야 함");
{
  const needle = 'if (!navigator.onLine && typeof OpLog !== "undefined" && OpLog.recordCurrent) {\n        const now = Date.now();';
  if (notesSrc.indexOf(needle) < 0) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mutated = notesSrc.replace(needle, 'if (false) {\n        const now = Date.now();');
    const objSrc = mutated.slice(mutated.indexOf("const Notes = {"), mutated.indexOf("\n  };") + 5);
    const recordedOps = [];
    const OpLog = { async recordCurrent(entity, action, id, data) { recordedOps.push({ entity, action, id }); } };
    const els = {};
    const mkEl = () => ({ value: "", textContent: "", classList: { add() {}, remove() {}, contains: () => false, toggle() {} } });
    ["pnp-input", "pnp-status-sel", "pnp-assignee", "pnp-author", "pnp-submit"].forEach((id) => { els[id] = mkEl(); });
    const document = { getElementById: (id) => els[id] || null, querySelectorAll: () => [] };
    const State = { currentDeploymentId: "dep1" };
    const Auth = { user: { name: "A", email: "a@b.com" }, isDesigner: false };
    const UI = { escapeHtml: (s) => s };
    const sandbox = {
      console, document, State, Auth, OpLog, UI, JSON, Object, Array, Date, Math, String,
      navigator: { onLine: false }, fetch: async () => ({ ok: false }), confirm: () => true
    };
    vm.createContext(sandbox);
    vm.runInContext(objSrc + ";globalThis.__Notes = Notes;", sandbox);
    sandbox.__Notes._pin = { id: "pin1", label: "L" };
    els["pnp-input"].value = "테스트";
    await sandbox.__Notes.submit();
    const mutFailed = recordedOps.length !== 1;
    console.log((mutFailed ? "  PASS(예상대로 실패 재현) " : "  FAIL(뮤테이션에도 통과 — 테스트가 가짜) ") + "recordedOps=" + recordedOps.length);
    if (!mutFailed) failed++;
  }
}

console.log("\n[뮤테이션2] 서버 ops 핸들러의 applied_ops 멱등 dup 체크 제거 → ④가 실패해야 함");
{
  const needle = "if (dup) { applied.push(op.opId); continue }";
  if (serverSrc.indexOf(needle) < 0) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mutatedServerSrc = serverSrc.replace(needle, "if (false) { applied.push(op.opId); continue }");
    const genIdSrc = extractBalanced(mutatedServerSrc, "function genId(prefix: string): string {");
    const validStatusMatch = mutatedServerSrc.match(/const VALID_STATUS = \[[^\]]*\]/);
    const opsCallSrc = extractBalanced(mutatedServerSrc, "app.post('/tables/deployments/:id/ops', async (c) => {") + ")";
    const tsSrc = `
      ${genIdSrc}
      ${validStatusMatch[0]}
      const DEFAULT_TENANT = 'tnt_default';
      async function requireDesigner(c) { return { email: 'd@test.com' }; }
      async function deploymentWriteDenied(c, user, pid) { return null; }  // [WP3] p93 B5 가 검증
      async function tenantOf(c, user) { return null; }
      async function resolvePinHome(c, depId, row) { return null; }  // [WO 20261012-pinsync] 일반 배포본(별칭 아님) — 별칭 경로는 p151 이 실 워커로 검증
      function mapDeployment(row) { return row; }
      const app = { post(path, handler) { globalThis.__opsHandler = handler; } };
      ${opsCallSrc}
    `;
    const { code } = esbuild.transformSync(tsSrc, { loader: "ts" });
    const sandbox = { console, globalThis: {}, Object, Array, String, Number, JSON, Date, Math, Map };
    sandbox.globalThis = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox);
    const handler = sandbox.__opsHandler;
    const depId = "depM";
    const db = freshDbState(depId);
    const op = { opId: "op-dup", entity: "note", action: "upsert", id: "tmp-note-dup", ts: Date.now(),
      data: { deployment_id: depId, pin_id: "p1", body: "x", status: "open" } };
    await handler(makeC(db, depId, { ops: [op] }));
    await handler(makeC(db, depId, { ops: [op] })); // 재전송
    const mutFailed = db.pinNotes.length !== 1; // dup 체크 무력화 → 2건 생성되어 실패해야 정상
    console.log((mutFailed ? "  PASS(예상대로 실패 재현 — 중복생성 " + db.pinNotes.length + "건) " : "  FAIL(뮤테이션에도 1건만 생성 — 테스트가 가짜) ") + "pinNotes=" + db.pinNotes.length);
    if (!mutFailed) failed++;
  }
}

console.log("\n[뮤테이션3] 32_Offline.js 의 noteIdMap → Notes.applyIdMap 배선 제거 → ⑤가 실패해야 함");
{
  const needle = 'if (j.noteIdMap && typeof Notes !== "undefined" && Notes.applyIdMap) {';
  if (offlineSrc.indexOf(needle) < 0) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mutated = offlineSrc.replace(needle, 'if (false) {');
    const applyIdMapCalls = [];
    const Notes = { applyIdMap: (m) => applyIdMapCalls.push(m) };
    const SyncQueue = makeMemorySyncQueue({ "oplog:dep1": [{ opId: "op-note-1", entity: "note", action: "upsert", id: "tmp-note-1", data: {}, ts: Date.now() }] });
    const sandbox = {
      console, SyncQueue, Notes, State: { pins: [], zones: [], annotations: [] },
      UI: { renderPinList() {}, renderPinsOnMap() {} }, Auth: { headers: () => ({}) }, Projects: {}, App: {},
      navigator: { onLine: true }, window: {}, JSON, Object, Array, Promise, Date, Math, String, Set,
      fetch: async () => ({ ok: true, json: async () => ({ applied: ["op-note-1"], noteIdMap: { "tmp-note-1": "note_real1" } }) }),
      setTimeout: (fn) => fn()
    };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(mutated + "\n;globalThis.__App_flushOpLogs = App._flushOpLogs;", sandbox);
    await sandbox.__App_flushOpLogs();
    const mutFailed = applyIdMapCalls.length !== 1;
    console.log((mutFailed ? "  PASS(예상대로 실패 재현) " : "  FAIL(뮤테이션에도 통과 — 테스트가 가짜) ") + "applyIdMapCalls=" + applyIdMapCalls.length);
    if (!mutFailed) failed++;
  }
}

console.log(failed === 0 ? "\n전체 PASS" : `\n${failed}건 FAIL`);
process.exit(failed === 0 ? 0 : 1);
