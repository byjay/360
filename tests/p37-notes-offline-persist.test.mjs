/**
 * 회귀 테스트 (프레임워크 0 · 실행: node tests/p37-notes-offline-persist.test.mjs)
 *
 * 결함(직전 커밋 ea0f397 자기신고): 오프라인 중 작성한 노트 목록(Notes._list)은 별도 SQL 테이블이라
 * bundle:dep:* 같은 로컬 스냅샷이 없어 새로고침/앱 재시작 시 화면에서 사라진다.
 * OpLog(pin/zone/anno 와 동일 경로)에는 op 이 남아 있어도, 화면 목록이 비면 사용자는 유실로 인식하고
 * 같은 노트를 다시 적어 중복이 생긴다.
 *
 * 수정(공유 지점 재사용 — 새 저장소 신설 안 함, §5 사다리):
 *  - 13_Notes.js: SyncQueue.DRAFT_STORE(IndexedDB, 05_SyncQueue.js) 에 "notes:<depId>:<pinId>" 키로
 *    { list, ts } 스냅샷을 얹는다(32_Offline.js 의 "bundle:dep:*" 와 같은 스토어, 다른 네임스페이스).
 *    - submit()/updateStatus()/remove()/submitCompact() 오프라인 분기에서 즉시 _saveSnapshot().
 *    - loadForPin(): 오프라인이면 fetch 를 시도하지 않고 스냅샷으로 즉시 복원.
 *      온라인 성공 시엔 서버 응답으로 스냅샷을 최신화(서버가 SoT).
 *    - applyIdMap(): tmp id → 서버 id 치환 후 스냅샷도 함께 갱신.
 *    - _saveSnapshot(list, ts): 기존 스냅샷의 ts 보다 오래된 저장 시도는 거부(④ 덮어쓰기 가드).
 *    - 저장 실패(SyncQueue.saveDraft === false) 시 05_SyncQueue.js:132 와 동일한 안내 문구로 Prompt.toast.
 *
 * 검증 항목:
 *  ① 오프라인 노트 작성 후 모듈 상태를 버리고(새 Notes 인스턴스) 재로드해도 목록이 복원된다
 *  ② 복원 후에도 OpLog 대기열은 그대로이며, 그 op 를 서버(실 ops 핸들러)에 두 번 replay 해도 노트는 1개만 생성된다
 *  ③ 온라인 loadForPin() 성공 후 로컬 스냅샷이 서버 데이터로 갱신된다
 *  ④ 옛(더 오래된 ts) 스냅샷 저장 시도가 최신 스냅샷을 덮어쓰지 않는다
 *  ⑤ 저장 실패 시 사용자에게 토스트로 알린다(조용한 실패 없음)
 *  ⑥ 노트 삭제도 재시작(새 인스턴스) 후 유지된다
 *
 * 실제 13_Notes.js 소스를 vm 에 그대로 평가한다(목 구현 아님, p36 패턴 재사용).
 * 서버 ops 핸들러는 src/index.tsx 에서 실 소스를 발췌해 esbuild 로 transpile 후 실행(p36 과 동일).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

const notesSrc = rd("public/js/modules/13_Notes.js");
const serverSrc = rd("src/index.tsx");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};

/* ── 브레이스-밸런싱 발췌 (p15/p36 과 동일 패턴) ── */
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
 * 서버 ops 핸들러 (p36 과 동일 발췌·transpile 방식)
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
              } else if (sql.indexOf("UPDATE pin_notes SET deleted = 1") >= 0) {
                const [updated_at, id] = args;
                const n = state.pinNotes.find((n) => n.id === id);
                if (n) { n.deleted = 1; n.updated_at = updated_at; }
              } else if (sql.indexOf("UPDATE pin_notes SET") >= 0) {
                const setPart = sql.slice(sql.indexOf("SET") + 3, sql.indexOf("WHERE")).trim();
                const cols = setPart.split(",").map((s) => s.trim().split("=")[0].trim());
                const id = args[args.length - 1];
                const n = state.pinNotes.find((n) => n.id === id && !n.deleted);
                if (n) cols.forEach((col, i) => { n[col] = args[i]; });
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

function buildOpsHandler(srcOverride) {
  const src = srcOverride || serverSrc;
  const genIdSrc = extractBalanced(src, "function genId(prefix: string): string {");
  const validStatusMatch = src.match(/const VALID_STATUS = \[[^\]]*\]/);
  if (!validStatusMatch) throw new Error("VALID_STATUS not found");
  const opsCallSrc = extractBalanced(src, "app.post('/tables/deployments/:id/ops', async (c) => {") + ")";

  const tsSrc = `
    ${genIdSrc}
    ${validStatusMatch[0]}
    const DEFAULT_TENANT = 'tnt_default';
    async function requireDesigner(c) { return { email: 'designer@test.com' }; }
    async function deploymentWriteDenied(c, user, pid) { return null; }  // [WP3] 프로젝트 권한 가드 — 이 테스트 대상 아님(p93 B5 가 실 워커로 검증)
    async function tenantOf(c, user) { return null; }
    async function resolvePinHome(c, depId, row) { return null; }  // [WO 20261012-pinsync] 일반 배포본(별칭 아님) — 별칭 경로는 p151 이 실 워커로 검증
    async function routesReady(c) { return false; }   // [360 동선] migration 0047 미적용 가정 — SQL 자리수(6 args) 불변
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

function freshDbState(depId) {
  return {
    deployments: [{ id: depId, pins: "[]", zones: "[]", annotations: "[]", version: 0, deleted: 0, tenant_id: null }],
    appliedOps: [],
    pinNotes: []
  };
}

/* ══════════════════════════════════════════════════════════════════
 * 클라이언트 13_Notes.js — 인메모리 IndexedDB(SyncQueue) 대역
 * ══════════════════════════════════════════════════════════════════ */
function makeSyncQueue(store) {
  return {
    async saveDraft(key, data) {
      if (store.__failNext) { store.__failNext = false; return false; }
      store[key] = JSON.parse(JSON.stringify(data));
      return true;
    },
    async loadDraft(key) { return Object.prototype.hasOwnProperty.call(store, key) ? JSON.parse(JSON.stringify(store[key])) : null; },
    async allDraftKeys() { return Object.keys(store).filter((k) => k !== "__failNext"); }
  };
}
function makeOpLog(sq, dep) {
  return {
    async recordCurrent(entity, action, id, data) {
      const key = "oplog:" + dep;
      const arr = (await sq.loadDraft(key)) || [];
      arr.push({ opId: "op-" + Math.random().toString(36).slice(2, 10), entity, action, id, data: data ? JSON.parse(JSON.stringify(data)) : null, ts: Date.now() });
      await sq.saveDraft(key, arr);
    },
    async pending(depId) { return (await sq.loadDraft("oplog:" + depId)) || []; }
  };
}

function makeNotesSandbox(sq, dep, opts, srcOverride) {
  opts = opts || {};
  const src = srcOverride || notesSrc;
  const objSrc = src.slice(src.indexOf("const Notes = {"), src.indexOf("\n  };") + 5);
  const toasts = [];
  const Prompt = { toast: (m) => toasts.push(m), confirm: async () => (opts.confirmValue !== undefined ? opts.confirmValue : true) };
  const State = { currentDeploymentId: dep };
  const Auth = { user: { name: "현장자", email: "field@test.com" }, isDesigner: false, headers: () => ({}) };
  const UI = { escapeHtml: (s) => s };
  const els = {};
  const mkEl = () => ({ value: "", textContent: "", innerHTML: "", classList: { add() {}, remove() {}, contains: () => false, toggle() {} }, querySelectorAll: () => [] });
  ["pnp-input", "pnp-status-sel", "pnp-assignee", "pnp-author", "pnp-submit", "pnp-list", "pnp-empty", "pnp-pin-label", "pano-notes-count"].forEach((id) => { els[id] = mkEl(); });
  const document = {
    getElementById: (id) => { if (!els[id]) els[id] = mkEl(); return els[id]; },
    querySelectorAll: () => []
  };
  const fetchImpl = opts.fetchImpl || (async () => { throw new Error("네트워크 호출 금지 — 이 경로에서 fetch 가 호출되면 안 됨"); });
  const sandbox = {
    console, document, State, Auth, UI, Prompt, JSON, Object, Array, Date, Math, String,
    SyncQueue: sq, OpLog: opts.opLog || { recordCurrent: async () => {} },
    navigator: { onLine: !!opts.online },
    fetch: fetchImpl,
    confirm: () => true
  };
  vm.createContext(sandbox);
  vm.runInContext(objSrc + ";globalThis.__Notes = Notes;", sandbox);
  return { Notes: sandbox.__Notes, els, toasts };
}

/* ══════════════════════════════════════════════════════════════════
 * ① 오프라인 노트 작성 후 모듈 상태를 버리고 재로드해도 목록 복원
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[① 오프라인 노트 작성 → 새 Notes 인스턴스(재로드 시뮬레이션)에서 복원]");
{
  const store = {};
  const sq = makeSyncQueue(store);
  const dep = "dep1", pin = { id: "pin1", label: "1층 배관실" };
  const opLog = makeOpLog(sq, dep);

  const s1 = makeNotesSandbox(sq, dep, { opLog, online: false });
  s1.Notes._pin = pin;
  s1.els["pnp-input"].value = "누수 발견, 확인 요청";
  await s1.Notes.submit();
  ok(s1.Notes._list.length === 1, "① 작성 직후 화면 목록 1건");

  const s2 = makeNotesSandbox(sq, dep, { opLog, online: false }); // "재시작" = 완전히 새 인스턴스, 같은 store
  s2.Notes._pin = pin;
  ok(s2.Notes._list.length === 0, "① 새 인스턴스는 아직 빈 상태(재시작 직후)");
  await s2.Notes.loadForPin();
  ok(s2.Notes._list.length === 1 && s2.Notes._list[0].body === "누수 발견, 확인 요청",
    "① loadForPin() 이 로컬 스냅샷으로 복원함: " + JSON.stringify(s2.Notes._list.map((n) => n.body)));
}

/* ══════════════════════════════════════════════════════════════════
 * ② 복원 + OpLog replay 로 서버에 1개만 생성(중복 0)
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[② 복원된 노트 + OpLog 대기 op 를 서버에 두 번 replay 해도 노트는 1개만 생성]");
{
  const store = {};
  const sq = makeSyncQueue(store);
  const dep = "dep2", pin = { id: "pinA", label: "2층" };
  const opLog = makeOpLog(sq, dep);

  const s1 = makeNotesSandbox(sq, dep, { opLog, online: false });
  s1.Notes._pin = pin;
  s1.els["pnp-input"].value = "결함 A";
  await s1.Notes.submit();

  const s2 = makeNotesSandbox(sq, dep, { opLog, online: false }); // 재시작
  s2.Notes._pin = pin;
  await s2.Notes.loadForPin();
  ok(s2.Notes._list.length === 1, "② 재시작 후 화면 목록 1건으로 복원");

  const pending = await opLog.pending(dep);
  ok(pending.length === 1, "② OpLog 대기열도 그대로 1건(복원이 큐를 건드리지 않음): " + pending.length);

  const opsHandler = buildOpsHandler();
  const dbState = freshDbState(dep);
  const r1 = await opsHandler(makeC(dbState, dep, { ops: pending }));
  ok(r1.body.ok === true && dbState.pinNotes.length === 1, "② 1차 replay 후 서버에 노트 1건: " + dbState.pinNotes.length);
  const r2 = await opsHandler(makeC(dbState, dep, { ops: pending })); // 재연결 중복 replay 시나리오
  ok(dbState.pinNotes.length === 1, "② 같은 op 2차 replay 에도 여전히 1건(멱등, 중복 0): " + dbState.pinNotes.length);
}

/* ══════════════════════════════════════════════════════════════════
 * ③ 온라인 동기화 완료 후 스냅샷이 서버 데이터로 갱신
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[③ 온라인 loadForPin() 성공 후 로컬 스냅샷이 서버 데이터로 갱신]");
{
  const store = {};
  const sq = makeSyncQueue(store);
  const dep = "dep3", pin = { id: "pinB", label: "3층" };
  await sq.saveDraft("notes:" + dep + ":" + pin.id, { list: [{ id: "old1", body: "구버전 캐시", status: "open" }], ts: 1000 });

  const serverList = [{ id: "note_real1", body: "서버 최신", status: "progress" }];
  const s = makeNotesSandbox(sq, dep, { online: true, fetchImpl: async () => ({ ok: true, json: async () => ({ data: serverList }) }) });
  s.Notes._pin = pin;
  await s.Notes.loadForPin();
  ok(s.Notes._list.length === 1 && s.Notes._list[0].id === "note_real1", "③ 화면 목록이 서버 데이터로 교체됨");

  const snap = await sq.loadDraft("notes:" + dep + ":" + pin.id);
  ok(!!snap && snap.list.length === 1 && snap.list[0].id === "note_real1", "③ 로컬 스냅샷도 서버 데이터로 갱신됨: " + JSON.stringify(snap));
}

/* ══════════════════════════════════════════════════════════════════
 * ④ 옛 스냅샷이 새 서버 데이터를 덮어쓰지 않음
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[④ 더 오래된(ts 작은) 스냅샷 저장 시도가 최신 스냅샷을 덮어쓰지 않음]");
{
  const store = {};
  const sq = makeSyncQueue(store);
  const dep = "dep4", pin = { id: "pinC", label: "4층" };
  const s = makeNotesSandbox(sq, dep, { online: false });
  s.Notes._pin = pin;

  const savedNew = await s.Notes._saveSnapshot([{ id: "n2", body: "서버 최신" }], 5000);
  ok(savedNew === true, "④ 최신(ts=5000) 스냅샷 저장 성공");

  const savedOld = await s.Notes._saveSnapshot([{ id: "n1", body: "옛 오프라인 캐시" }], 3000); // 늦게 끝난 오프라인 저장(더 오래된 ts)
  ok(savedOld === false, "④ 더 오래된(ts=3000) 스냅샷 저장 시도는 거부됨");

  const snap = await sq.loadDraft("notes:" + dep + ":" + pin.id);
  ok(snap.list.length === 1 && snap.list[0].id === "n2", "④ 저장소엔 여전히 최신 스냅샷만 남음: " + JSON.stringify(snap));
}

/* ══════════════════════════════════════════════════════════════════
 * ⑤ 저장 실패 시 사용자에게 알림(조용한 실패 없음)
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[⑤ 스냅샷 저장 실패 시 저장공간 부족 토스트 노출]");
{
  const store = { __failNext: true };
  const sq = makeSyncQueue(store);
  const dep = "dep5", pin = { id: "pinD", label: "5층" };
  const s = makeNotesSandbox(sq, dep, { online: false });
  s.Notes._pin = pin;
  const result = await s.Notes._saveSnapshot([{ id: "n1", body: "x" }], Date.now());
  ok(result === false, "⑤ 저장 실패 시 false 반환");
  ok(s.toasts.some((m) => m.indexOf("저장공간 부족") >= 0), "⑤ '저장공간 부족' 토스트 노출(05_SyncQueue.js:132 문구 재사용): " + JSON.stringify(s.toasts));
}

/* ══════════════════════════════════════════════════════════════════
 * ⑥ 노트 삭제도 재시작 후 유지
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[⑥ 오프라인 노트 삭제 → 재시작(새 인스턴스) 후에도 유지]");
{
  const store = {};
  const sq = makeSyncQueue(store);
  const dep = "dep6", pin = { id: "pinE", label: "6층" };
  const opLog = makeOpLog(sq, dep);

  const s1 = makeNotesSandbox(sq, dep, { opLog, online: false });
  s1.Notes._pin = pin;
  s1.Notes._list = [{ id: "note-x", body: "삭제될 노트", status: "open" }];
  await s1.Notes._saveSnapshot(s1.Notes._list, Date.now()); // 삭제 전 상태 사전 스냅샷
  await s1.Notes.remove("note-x");
  ok(s1.Notes._list.length === 0, "⑥ 삭제 직후 화면 목록에서 제거됨");

  const s2 = makeNotesSandbox(sq, dep, { opLog, online: false }); // 재시작
  s2.Notes._pin = pin;
  await s2.Notes.loadForPin();
  ok(s2.Notes._list.length === 0, "⑥ 재시작 후에도 삭제 상태 유지(부활하지 않음): " + JSON.stringify(s2.Notes._list));
}

/* ══════════════════════════════════════════════════════════════════
 * 뮤테이션 증명 4건
 * ══════════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션ⓐ] submit() 의 오프라인 스냅샷 저장 제거 → ①이 실패해야 함");
{
  const needle = 'await this._saveSnapshot(this._list, now); // [오프라인 노트 영속화] 즉시 로컬 스냅샷(재시작 유실 방지)';
  if (notesSrc.indexOf(needle) < 0) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mutated = notesSrc.replace(needle, "");
    const store = {};
    const sq = makeSyncQueue(store);
    const dep = "depM1", pin = { id: "pinM1", label: "M" };
    const opLog = makeOpLog(sq, dep);
    const s1 = makeNotesSandbox(sq, dep, { opLog, online: false }, mutated);
    s1.Notes._pin = pin;
    s1.els["pnp-input"].value = "뮤테이션 테스트";
    await s1.Notes.submit();
    const s2 = makeNotesSandbox(sq, dep, { opLog, online: false }, mutated);
    s2.Notes._pin = pin;
    await s2.Notes.loadForPin();
    const mutFailed = s2.Notes._list.length !== 1;
    console.log((mutFailed ? "  PASS(예상대로 실패 재현) " : "  FAIL(뮤테이션에도 통과 — 테스트가 가짜) ") + "복원된 목록=" + s2.Notes._list.length);
    if (!mutFailed) failed++;
  }
}

console.log("\n[뮤테이션ⓑ] 서버 ops 핸들러의 applied_ops 멱등(dup) 체크 제거 → ②가 실패해야 함");
{
  const needle = "if (dup) { applied.push(op.opId); continue }";
  if (serverSrc.indexOf(needle) < 0) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mutatedServerSrc = serverSrc.replace(needle, "if (false) { applied.push(op.opId); continue }");
    const handler = buildOpsHandler(mutatedServerSrc);
    const dep = "depM2";
    const dbState = freshDbState(dep);
    const op = { opId: "op-dup", entity: "note", action: "upsert", id: "tmp-note-dup", ts: Date.now(),
      data: { deployment_id: dep, pin_id: "p1", body: "x", status: "open" } };
    await handler(makeC(dbState, dep, { ops: [op] }));
    await handler(makeC(dbState, dep, { ops: [op] })); // 재연결 중복 replay
    const mutFailed = dbState.pinNotes.length !== 1;
    console.log((mutFailed ? "  PASS(예상대로 실패 재현 — 중복생성 " + dbState.pinNotes.length + "건) " : "  FAIL(뮤테이션에도 1건만 생성 — 테스트가 가짜) ") + "pinNotes=" + dbState.pinNotes.length);
    if (!mutFailed) failed++;
  }
}

console.log("\n[뮤테이션ⓒ] loadForPin() 온라인 성공 후 스냅샷 갱신 제거 → ③이 실패해야 함");
{
  const needle = "await this._saveSnapshot(this._list, Date.now()); // 서버가 SoT — 로컬 스냅샷을 최신으로 갱신";
  if (notesSrc.indexOf(needle) < 0) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mutated = notesSrc.replace(needle, "");
    const store = {};
    const sq = makeSyncQueue(store);
    const dep = "depM3", pin = { id: "pinM3", label: "M3" };
    await sq.saveDraft("notes:" + dep + ":" + pin.id, { list: [{ id: "old1", body: "구버전 캐시" }], ts: 1000 });
    const serverList = [{ id: "note_real1", body: "서버 최신" }];
    const s = makeNotesSandbox(sq, dep, { online: true, fetchImpl: async () => ({ ok: true, json: async () => ({ data: serverList }) }) }, mutated);
    s.Notes._pin = pin;
    await s.Notes.loadForPin();
    const snap = await sq.loadDraft("notes:" + dep + ":" + pin.id);
    const mutFailed = !(snap && snap.list[0].id === "note_real1"); // 갱신 안 됐으면 여전히 old1
    console.log((mutFailed ? "  PASS(예상대로 실패 재현 — 스냅샷=" + JSON.stringify(snap) + ") " : "  FAIL(뮤테이션에도 갱신됨 — 테스트가 가짜) "));
    if (!mutFailed) failed++;
  }
}

console.log("\n[뮤테이션ⓓ] _saveSnapshot 의 덮어쓰기 가드 제거 → ④가 실패해야 함");
{
  const needle = 'if (existing && typeof existing.ts === "number" && ts < existing.ts) return false; // 스냅샷 덮어쓰기 가드';
  if (notesSrc.indexOf(needle) < 0) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const mutated = notesSrc.replace(needle, "");
    const store = {};
    const sq = makeSyncQueue(store);
    const dep = "depM4", pin = { id: "pinM4", label: "M4" };
    const s = makeNotesSandbox(sq, dep, { online: false }, mutated);
    s.Notes._pin = pin;
    await s.Notes._saveSnapshot([{ id: "n2", body: "서버 최신" }], 5000);
    await s.Notes._saveSnapshot([{ id: "n1", body: "옛 오프라인 캐시" }], 3000);
    const snap = await sq.loadDraft("notes:" + dep + ":" + pin.id);
    const mutFailed = snap.list[0].id !== "n2"; // 가드 없으면 옛 데이터(n1)로 덮어써짐
    console.log((mutFailed ? "  PASS(예상대로 실패 재현 — 스냅샷=" + JSON.stringify(snap) + ") " : "  FAIL(뮤테이션에도 가드 유지 — 테스트가 가짜) "));
    if (!mutFailed) failed++;
  }
}

console.log(failed === 0 ? "\n전체 PASS" : `\n${failed}건 FAIL`);
process.exit(failed === 0 ? 0 : 1);
