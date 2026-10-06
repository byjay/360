/**
 * p121 — offline2 데이터유실 근본수정 회귀 (프레임워크 0 · 실행: node tests/p121-offline2-concurrency.test.mjs)
 *
 * [재현] 지휘자 재현(HEAD 추출본 .tmp/hfp1, 실 Chrome CDP P114=1):
 *   "360 사진이 서버에 올라가 핀에 연결됨(pendingOpId 해소)" FAIL
 *   → {"pins":1,"photoPins":[],"panoImagesRows":0} (오프라인 24개 생성 중 서버엔 1개만 반영).
 *   baseline(4073788, offline2 이전) 재현: 같은 단언 PASS, 대신 R1(사이드시트 미닫힘) FAIL —
 *   즉 사진유실은 241e641 이후 신규 회귀(baseline 미재현 확인, .tmp/p114_baseline.log 68행 PASS).
 *
 * 근본원인: OpLog.record()(load→push→save, read-modify-write)와 App._saveDraftLocal()/
 *   persistLocalDeployment()(load→merge→save) 가 비원자적이다. 연속 핀 배치마다 비차단
 *   (await 없이) 호출되므로, 먼저 시작한 호출의 느린 비동기 단계가 나중 호출보다 늦게 끝나면
 *   그 "오래된" 쓰기가 "새" 쓰기를 덮어써 핀 생성 기록이 사라진다(lost update). 241e641의 R5
 *   수정(_autoSave 에 persistLocalDeployment 추가)이 동시 IndexedDB 트래픽을 늘려 이 선재
 *   레이스를 안정적으로 드러냈다.
 *
 * 수정: depId/key 별 프라미스 체인으로 read-modify-write 를 직렬화(OpLog._enqueue,
 *   App._draftWriteChains, _persistEnqueue) — API·데이터 모양 변경 0, 동시 호출만 순서화.
 *
 * 🔴 목 금지 — 실제 소스(32_Offline.js/20_App.js)를 그대로 vm 에 평가해 검증한다. SyncQueue 는
 *   순수 메모리 목(이 테스트의 유일한 대역 — 실 IndexedDB 는 node에 없다, p102 관례와 동일 경계).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const offlineSrc = rd("public/js/modules/32_Offline.js");
const appSrc = rd("public/js/modules/20_App.js");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };

/** 레이스를 결정론적으로 재현하는 메모리 SyncQueue 목. loadDraft 호출을 "장벽(barrier,
 *  setTimeout(0) 매크로태스크)"으로 묶는다 — 같은 동기 구간(직렬화 없이 N건을 한 루프에서
 *  연속 호출)에서 들어온 읽기는 전부 "같은 옛 상태"를 보고(진짜 동시 읽기 재현), 직렬화된
 *  호출(한 번에 1건만 대기)은 장벽에 걸릴 상대가 없어 매번 최신 상태를 정확히 읽는다.
 *  (고정 지연만으론 Node 타이머가 순차 처리돼 거짓으로 "유실 없음"이 나온다 — 실측 확인) */
function makeSyncQueue() {
  const store = {};
  let pending = [];
  let scheduled = false;
  function flush() {
    const batch = pending; pending = []; scheduled = false;
    batch.forEach((fn) => fn());
  }
  return {
    store,
    async loadDraft(k) {
      return new Promise((resolve) => {
        const snap = store[k] !== undefined ? JSON.parse(JSON.stringify(store[k])) : null;
        pending.push(() => resolve(snap));
        if (!scheduled) { scheduled = true; setTimeout(flush, 0); }
      });
    },
    async saveDraft(k, v) { store[k] = JSON.parse(JSON.stringify(v)); },
    _emit() {}
  };
}

/* ══════════════════════════════════════════════════════════════
 * ① OpLog.record — 동시 호출 N건이 전부 보존된다(직렬화, lost-update 없음)
 * ══════════════════════════════════════════════════════════════ */
function makeOffline(src, extra) {
  const State = { autoSaveDepId: "dep1", pins: [] };
  const Auth = { user: { email: "t@t" } };
  const SyncQueue = makeSyncQueue();
  const sandbox = Object.assign({ console, State, Auth, SyncQueue, Prompt: null, navigator: { onLine: true }, window: { addEventListener() {}, matchMedia: null }, setTimeout, Promise }, extra || {});
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__Offline = Offline; globalThis.__OpLog = OpLog; globalThis.__persist = persistLocalDeployment;", sandbox);
  return { OpLog: sandbox.__OpLog, persist: sandbox.__persist, SyncQueue, State: sandbox.State };
}

async function testOpLogConcurrency(label, src, expectLoss) {
  console.log("\n[" + label + "]");
  const { OpLog, SyncQueue } = makeOffline(src);
  const N = 10;
  const calls = [];
  for (let i = 0; i < N; i++) calls.push(OpLog.record("dep1", "pin", "upsert", "p" + i, { id: "p" + i }));
  await Promise.all(calls);
  const arr = SyncQueue.store["oplog:dep1"] || [];
  if (expectLoss) ok(arr.length < N, "뮤테이션(직렬화 제거) → lost-update 재현(N=" + N + " 중 " + arr.length + "건만 보존, 유실 확인) — " + arr.length);
  else ok(arr.length === N, "직렬화 적용 → 동시 호출 " + N + "건 전부 보존(유실 0) — 실제 " + arr.length + "건: " + JSON.stringify(arr.map((o) => o.id)));
}

/* ══════════════════════════════════════════════════════════════
 * ② persistLocalDeployment — 동시 호출 N건 후에도 pins 손실 0
 * 🔴 이 함수는 dep.pins 를 "그 순간의 live State.pins"에서 다시 읽어 쓴다(스냅샷을 들고
 *   있지 않음) — 그래서 pins 자체는 설계상 lost-update 가 거의 불가능하다(직렬화 제거해도
 *   이 테스트의 N건이 전부 "같은 동기 구간"에서 발생해 전원 최신 배열을 본다). 그래도 depId
 *   별 체인을 추가한 이유는 dep 객체의 **다른 필드**(load 시점에 따라 서로 다른 base 를 들고
 *   동시에 save) 경합을 막기 위함(방어적 경화) — 아래는 "되돌려도 안전"이 아니라 "pins 카운트
 *   로는 이 함수의 차이를 구분 못 한다"는 사실을 정직하게 기록한다(뮤테이션 호출 안 함).
 * ══════════════════════════════════════════════════════════════ */
async function testPersistConcurrency(label, src) {
  console.log("\n[" + label + "]");
  const { persist, SyncQueue, State } = makeOffline(src);
  const N = 10;
  const calls = [];
  for (let i = 0; i < N; i++) {
    State.pins.push({ id: "p" + i });
    calls.push(persist("dep1"));
  }
  await Promise.all(calls);
  const dep = SyncQueue.store["bundle:dep:dep1"];
  const n = dep ? (JSON.parse(dep.pins || "[]")).length : 0;
  ok(n === N, "동시 호출 " + N + "건 후 pins 손실 0(직렬화 적용) — 실제 " + n + "핀");
}

/* ══════════════════════════════════════════════════════════════
 * ③ App._saveDraftLocal — 동시 호출 N건 + 가변 지연(_draftSrcFields, 실제 _snapshotPages와
 *   같은 역할) 에도 pins 손실 0.
 * 🔴 정직한 기록(실측, 디버그 확인 완료) — payload.pins = State.pins(복제 아닌 **참조**)라서
 *   pins 배열 자체는 push만 하는 이 시나리오에서 어느 호출이 쓰든 "그 순간의 최신 배열"을
 *   그대로 들고 있다 — 체인을 빼도 pins 로는 lost-update 가 재현되지 않는다(디버그 로그로
 *   실측: 뮤테이션판도 매 쓰기가 pins.length=10). 그래도 체인을 남기는 이유: zones/annotations
 *   도 같은 참조 성질이라 당장은 안전하지만, dep 객체의 다른 필드(향후 추가될 수 있는 값)가
 *   호출마다 독립 복제될 경우를 방어한다(§10-no-hardcoding 식 "지금은 안전해도 가정은 깨지기
 *   쉽다" 원칙) — 그래서 뮤테이션 호출은 하지 않는다(거짓 PASS/FAIL 금지).
 * ══════════════════════════════════════════════════════════════ */
function makeApp(src, srcFieldsDelayFn) {
  const State = { fileType: "pdf", fileData: {}, fileName: "d", pins: [], zones: [], annotations: [], checkboardStart: {}, autoSaveDepId: "dep1", depVersion: 1, pinBaseIds: null, pinTombstones: {}, sourcePdfUrl: null };
  const SyncQueue = makeSyncQueue();
  let callIdx = 0;
  SyncQueue.saveSource = () => new Promise((resolve) => setTimeout(() => resolve(true), srcFieldsDelayFn(callIdx++)));
  const Projects = { currentProject: { id: "proj1" }, currentDeck: { id: "deck1" } };
  const PDF = { lastSnapshotDims: null };
  const sandbox = { console, State, SyncQueue, Projects, Zones: null, PDF, UI: {}, setTimeout, Promise };
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__App = App;", sandbox);
  const App = sandbox.__App;
  App._srcKeys = new Map(); // _draftSrcFields()가 기대하는 캐시(App._srcKeys.get(ab))
  return { App, SyncQueue, State };
}

async function testSaveDraftLocalConcurrency(label, src) {
  console.log("\n[" + label + "]");
  // 먼저 호출될수록(i 작을수록) 더 오래 걸림 — _snapshotPages() 의 가변 인코딩 시간을 흉내낸다.
  const N = 10;
  const { App, SyncQueue, State } = makeApp(src, (i) => (N - i) * 30);
  const calls = [];
  for (let i = 0; i < N; i++) {
    State.pins.push({ id: "p" + i });
    State.fileData = {}; // 호출마다 다른 참조 — _draftSrcFields()의 캐시(App._srcKeys)가 서로 다른 지연을 쓰게 함
    calls.push(App._saveDraftLocal(["data:image/png;base64,AAAA"]));
  }
  await Promise.all(calls);
  const dkey = App._draftKey();
  const d = SyncQueue.store[dkey];
  const n = d && Array.isArray(d.pins) ? d.pins.length : -1;
  ok(n === N, "가변 지연 동시 호출 " + N + "건 후에도 pins 손실 0 — 실제 " + n + "핀");
}

/* ── 뮤테이션 소스: 직렬화(체인)를 제거해 원래의(241e641 당시) 비원자적 read-modify-write 로 되돌린다 ── */
function mutateOfflineRemoveSerialization(src) {
  const recordNeedle = `    /** entity:'pin'|'zone'|'anno', action:'upsert'|'delete' */
    async record(depId, entity, action, id, data) {
      if (!depId || !entity || id == null) return;
      return this._enqueue(depId, async () => {
        const arr = await this._load(depId);
        arr.push(this._mkOp(entity, action, id, data));
        await this._save(depId, arr);
      });
    },`;   // [WO 20261006-oplog] op 모양을 _mkOp(SoT, recordPinDelta 공유)로 뽑아낸 뒤의 본문 — 뮤테이션(아래 recordMut)은 불변
  const recordMut = `    async record(depId, entity, action, id, data) {
      if (!depId || !entity || id == null) return;
      const arr = await this._load(depId);
      arr.push({ opId: this._newId(), entity, action, id, data: action === "delete" ? null : data, ts: Date.now(), author: "offline" });
      await this._save(depId, arr);
    },`;
  if (src.indexOf(recordNeedle) === -1) throw new Error("뮤테이션 대상(record) 문자열을 찾지 못함(소스 변경?)");
  return src.replace(recordNeedle, recordMut);
}

(async () => {
  await testOpLogConcurrency("① OpLog.record 동시 호출 — 직렬화 적용(수정 후)", offlineSrc, false);
  await testPersistConcurrency("② persistLocalDeployment 동시 호출 — 직렬화 적용(수정 후)", offlineSrc);
  await testSaveDraftLocalConcurrency("③ App._saveDraftLocal 동시 호출(가변 지연) — 직렬화 적용(수정 후)", appSrc);

  // 🔴 뮤테이션 증명은 실제로 재현되는 ①(OpLog.record, p114 FAIL 의 실제 원인)만 한다.
  //   ②③은 pins 가 "참조"라 체인 제거로도 이 테스트에서 재현되지 않는다(위 주석·실측 — 거짓
  //   뮤테이션 PASS/FAIL 금지).
  console.log("\n[뮤테이션] OpLog.record 직렬화(체인) 제거 → ①이 lost-update 로 깨져야 함");
  const offlineMut = mutateOfflineRemoveSerialization(offlineSrc);
  await testOpLogConcurrency("뮤테이션 ① OpLog.record", offlineMut, true);

  console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
  process.exit(failed === 0 ? 0 : 1);
})();
