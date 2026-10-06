/**
 * p125 — 오프라인 핀 생성·수정·사진 연결 → oplog 기록 단일 지점 + 온라인 복귀 유실 0
 *   (프레임워크 0 · 실행: node tests/p125-offline-oplog-entrypoints.test.mjs · 뮤테이션: P125_MUT=<이름>)
 *
 * [재현] 실 Chrome CDP(p114 EXPLORE = tests/p125-offline-oplog-cdp.mjs) · HEAD 19daa4a 추출본 .tmp/hfO1 · 실 D1/R2:
 *   R1 오프라인 CHECKER 4탭 → oplog 0건 (pins 5)                        → FAIL
 *   R2 오프라인 PhotoBatch._uploadOneRow + _markUnsaved → 그 핀 oplog 0건  → FAIL
 *   R4 온라인 복귀 시 도면 draft PATCH 가 실패(약전파)하고 /ops 만 성공 →
 *      화면 5핀 → 1핀(_flushOpLogs 가 State.pins 를 서버본으로 덮어씀) → 이어서 온라인 핀 1개 추가·[동기화]
 *      → 최종 서버 2핀 / 기대 6핀 — 오프라인 CHECKER 4핀 영구 유실.  (draft PATCH 정상이면 유실 0 — 대조군)
 *
 * 근본원인 2개:
 *   ① oplog 기록이 진입점마다 손으로 박혀 있어 CHECKER 배치·사진 연결(PhotoBatch/ThetaIntake)·핀 이동 등이 0건.
 *   ② _flushOpLogs 가 서버본으로 State.pins 를 **덮어썼다**(병합 SoT _mergeConflict 미사용).
 * 수정: ① persistLocalDeployment(모든 편집이 지나는 로컬 스냅샷 갱신)에서 OpLog.recordPinDelta 1곳 기록
 *          + PhotoBatch._markUnsaved 가 같은 지점을 지나게 함  ② _flushOpLogs → App._mergeConflict.
 *
 * 🔴 목 금지 원칙 — 실제 소스(01b_PinSeries / 20_App / 32_Offline / 33_ThetaIntake / 35_PhotoBatch)를 한 vm 에
 *   그대로 평가한다. 대역은 node 에 없는 플랫폼(IndexedDB → 메모리 SyncQueue 저장소, canvas → resizeImage,
 *   네트워크 → 서버 /ops 규칙을 그대로 옮긴 메모리 서버)과 DOM 렌더 함수뿐(p102·p121·p124 와 같은 경계).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const SRC = {
  series: rd("public/js/modules/01b_PinSeries.js"),
  app: rd("public/js/modules/20_App.js"),
  offline: rd("public/js/modules/32_Offline.js"),
  theta: rd("public/js/modules/33_ThetaIntake.js"),
  photo: rd("public/js/modules/35_PhotoBatch.js"),
  pap: rd("public/js/modules/27_PinActionPop.js"),
  anno: rd("public/js/modules/26_PdfAnno.js"),
};

let failed = 0;
const ok = (cond, label, detail) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label + (!cond && detail !== undefined ? " :: " + JSON.stringify(detail) : ""));
  if (!cond) failed++;
};

/* ── 뮤테이션(고친 부분을 되돌림) — 대상 문자열이 없으면 EXIT=2 ── */
const MUTS = {
  // ① 공유 지점 기록 제거 → 진입점 oplog 단언 + 복귀 후 서버=로컬 단언이 FAIL 해야 한다
  nodelta: ["offline", "if (Array.isArray(prev)) { try { await OpLog.recordPinDelta(depId, prev, JSON.parse(nextJ)); } catch (e) {} }", "/* 뮤테이션: 기록 제거 */"],
  // 스냅샷을 기록 뒤 최신 State 로 찍기(종전 방식) → "기록 도중 들어온 핀도 기록" 단언이 FAIL 해야 한다
  latesnap: ["offline", "dep.pins = nextJ;", "dep.pins = JSON.stringify(State.pins || []);"],
  // ① 사진 연결 경로가 공유 지점을 안 지나게 → PhotoBatch/ThetaIntake 단언이 FAIL 해야 한다
  nophoto: ["photo", "try { if (App._keepLocal) App._keepLocal(); } catch (e) {}", "/* 뮤테이션: 스냅샷 갱신 제거 */"],
  // 중복 방지 제거 → "기존 진입점 기록 + 공유 지점 = op 1건" 단언이 FAIL 해야 한다
  nodedupe: ["offline", "if (last.get(String(c.id)) === c.j) return;", "/* 뮤테이션: 중복 방지 제거 */"],
  // ② 덮어쓰기 복원 → "oplog 없는 내 핀도 복귀 후 화면에 남는다" 단언이 FAIL 해야 한다
  overwrite: ["offline", "App._mergeConflict(j.current);", "State.pins = App._pinsSeen(App._live(JSON.parse(j.current.pins || \"[]\"))); State.depVersion = Number(j.current.version) || 0;"],
  // [oplog2] PinActionPop 라벨 저장을 종전처럼 _markDirty 만 → E8 이 FAIL 해야 한다
  papdirty: ["pap", "      pin.label = v;\n      PinActionPop._commitLocal();", "      pin.label = v;\n      if (typeof App !== \"undefined\" && App._markDirty) App._markDirty();"],
  // [oplog2] 주석을 종전처럼 서버본으로 덮어쓰기 → E9 가 FAIL 해야 한다
  annooverwrite: ["app", "if (Array.isArray(srvAnnos)) State.annotations = this._mergeAnnos(srvAnnos, State.annotations || [], Object.keys(this._annoTombstones()));", "if (Array.isArray(srvAnnos)) State.annotations = this._live(srvAnnos);"],
  // [annodel] 주석 delete op 기록 제거 → E10/E11 이 FAIL 해야 한다
  noannodel: ["offline", "if (Array.isArray(prevA)) { try { await OpLog.recordDelta(\"anno\", depId, prevA, JSON.parse(annoJ), tombA); } catch (e) {} }", "/* 뮤테이션: 주석 기록 제거 */"],
  // [annodel] 삭제 공유 지점이 tombstone 을 안 남김 → E10/E11/E12 가 FAIL 해야 한다
  notomb: ["anno", "if (tomb) want.forEach(id => { tomb[id] = now; });", "/* 뮤테이션: tombstone 제거 */"],
  // [annodel] 병합이 내 tombstone 을 무시 → E12(라이브폴·409) 가 FAIL 해야 한다
  // [annodel] 서버 tombstone 항목 재삭제 방지 제거 → E13 이 FAIL 해야 한다
  redel: ["offline", "if (p && p.id != null && !p._deleted && !nextIds.has(", "if (p && p.id != null && !nextIds.has("],
  mergeignoretomb: ["app", "        .concat((tombIds || []).map(String)));", "        );"],
};
const MUT = process.env.P125_MUT || "";
if (MUT && !MUTS[MUT]) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }
if (MUT) {
  const [k, from, to] = MUTS[MUT];
  if (SRC[k].indexOf(from) < 0) { console.log("FAIL 뮤테이션 대상 문자열 없음: " + MUT); process.exit(2); }
  SRC[k] = SRC[k].replace(from, to);
  console.log("[뮤테이션] " + MUT + " — 해당 단언이 FAIL 해야 정상");
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const clone = (o) => JSON.parse(JSON.stringify(o));

/** 서버 /tables/deployments/:id/ops 의 적용 규칙(src/index.tsx)을 그대로 옮긴 메모리 서버. */
function makeServer(pins) {
  const srv = { pins: new Map(), annos: new Map(), version: 1, opsPosts: 0 };
  pins.forEach((p) => srv.pins.set(String(p.id), clone(p)));
  srv.applyOps = (ops) => {
    const applied = [];
    for (const op of ops) {
      if (!op || !op.opId || (op.entity !== "pin" && op.entity !== "anno") || op.id == null) { if (op && op.opId) applied.push(op.opId); continue; }
      const M = op.entity === "anno" ? srv.annos : srv.pins;
      const cur = M.get(String(op.id)); const ts = Number(op.ts || Date.now());
      if (op.action === "delete") { if (!cur || ts >= Number(cur.ts || 0)) M.set(String(op.id), { id: op.id, _deleted: true, ts }); }
      else if (cur && !cur._deleted) M.set(String(op.id), Object.assign({}, cur, op.data, { id: op.id, ts: Math.max(ts, Number(cur.ts || 0)) }));
      else if (cur && cur._deleted && ts < Number(cur.ts || 0)) { /* 최신 삭제 유지 */ }
      else M.set(String(op.id), Object.assign({}, op.data, { id: op.id, ts }));
      applied.push(op.opId);
    }
    srv.version++;
    return applied;
  };
  srv.live = () => Array.from(srv.pins.values()).filter((p) => !p._deleted);
  return srv;
}

/** 실제 소스 5개를 한 컨텍스트에 평가. */
function boot(opts) {
  const store = {};
  let opSeq = 0;
  const SyncQueue = {
    async allDraftKeys() { return Object.keys(store); },
    async loadDraft(k) { return store[k] !== undefined ? clone(store[k]) : null; },
    async saveDraft(k, v) { store[k] = clone(v); if (opts.onSave) await opts.onSave(k); return true; },
    async enqueue() { return "op" + (++opSeq); },
    async count() { return 0; },
    keepOriginal() {}, _emit() {}, onChange() {}
  };
  const State = {
    mode: "designer", pins: clone(opts.pins || []), zones: [], annotations: clone(opts.annos || []), pdfPage: 1, regMode: "checkboard",
    autoSaveDepId: "dep1", pinTombstones: {}, pinBaseIds: opts.baseIds || null, depVersion: 1
  };
  const server = makeServer(opts.serverPins || []);
  (opts.serverAnnos || []).forEach((a) => server.annos.set(String(a.id), clone(a)));
  const nav = { onLine: false };
  const fetchImpl = async (url, init) => {
    const u = String(url);
    if (/\/tables\/deployments\/[^/]+\/ops$/.test(u) && init && init.method === "POST") {
      server.opsPosts++;
      const body = JSON.parse(init.body);
      const applied = server.applyOps(body.ops || []);
      const current = { id: "dep1", pins: JSON.stringify(Array.from(server.pins.values())), zones: "[]", annotations: JSON.stringify(Array.from(server.annos.values())), version: server.version };
      return { ok: true, status: 200, json: async () => ({ ok: true, applied, version: server.version, current }) };
    }
    return { ok: false, status: 503, json: async () => ({}) };
  };
  const mem = new Map();
  const sandbox = {
    console, State, SyncQueue, navigator: nav,
    Auth: { headers: () => ({ "Content-Type": "application/json" }), user: { email: "field@seastar.test" } },
    Projects: { currentProject: { id: "prj1" }, currentDeck: { id: "deck1", deployment_id: "dep1" } },
    Cloud: { _cache: {}, async resizeImage() { return { dataURL: "data:image/jpeg;base64,AAA", width: 2, height: 1 }; } },
    UI: { renderPinList() {}, renderPinsOnMap() {}, $: () => null, text() {}, show() {} },
    Prompt: { toast() {}, async confirm() { return true; } },
    localStorage: { getItem: (k) => (mem.has(k) ? mem.get(k) : null), setItem: (k, v) => mem.set(k, String(v)), removeItem: (k) => mem.delete(k) },
    window: { addEventListener() {} }, document: { getElementById: (id) => (opts.dom && opts.dom[id]) || null, addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] },
    fetch: fetchImpl, setTimeout, clearTimeout, setInterval: () => 0, Promise, JSON, Date, Math
  };
  vm.createContext(sandbox);
  vm.runInContext([SRC.series, SRC.app, SRC.offline, SRC.photo, SRC.theta, SRC.pap, SRC.anno].join("\n;\n")
    + "\n;globalThis.__X = { App, OpLog, PhotoBatch, ThetaIntake, PinActionPop, PdfAnno, persistLocalDeployment };", sandbox);
  const X = sandbox.__X;
  // DOM 렌더 전용 함수만 무력화(이 테스트의 관심사가 아니다)
  X.App._updateCheckboardQuickStatus = () => {};
  const calls = { draft: 0 };
  X.App._saveDraftLocal = async () => { calls.draft++; return true; };           // canvas 스냅샷(_snapshotPages) — 도면 draft 는 p121/p124 가 지킨다
  X.ThetaIntake._flowNext = () => null;
  if (opts.bundle !== false) store["bundle:dep:dep1"] = { id: "dep1", pins: JSON.stringify(opts.pins || []), zones: "[]", annotations: JSON.stringify(opts.annos || []), version: 1 };
  X.PdfAnno._render = () => {};   // DOM(SVG) 렌더 전용
  X.PdfAnno.updateToolbar = () => {};
  // 🔴 settle 은 persistLocalDeployment 를 직접 부르지 않는다(부르면 진입점이 공유 지점을 안 지나도 가려진다 — 뮤테이션 nophoto 실측)
  const settle = async () => { await wait(30); await (X.OpLog._chains.dep1 || Promise.resolve()); await wait(5); };
  const ops = () => (store["oplog:dep1"] || []);
  const pinOps = (id) => ops().filter((o) => o.entity === "pin" && String(o.id) === String(id));
  return { X, State, store, server, nav, settle, ops, pinOps, calls };
}

const P1 = { id: 1001, x: 10, y: 10, page: 1, label: "1", checkboard: true };

(async () => {
  /* ── E1. CHECKER 연속 탭(_placeCheckboardPin — CHECKER·360 핀의 유일한 생성 지점) ── */
  console.log("\n[E1] 오프라인 CHECKER 연속 탭 → 핀마다 oplog upsert");
  {
    const T = boot({ pins: [P1], serverPins: [P1], baseIds: ["1001"] });
    const made = [];
    for (let i = 0; i < 4; i++) { const p = T.X.App._placeCheckboardPin({ x: 20 + i * 10, y: 30 }); if (p) { made.push(p); } await wait(2); }
    await T.settle();
    ok(made.length === 4, "전제: 핀 4개 생성", made.length);
    const per = made.map((p) => T.pinOps(p.id).length);
    ok(per.every((n) => n >= 1), "🔴 생성된 4핀 각각 oplog upsert ≥ 1", per);
    ok(per.every((n) => n === 1), "핀마다 정확히 1건(중복 기록 없음)", per);
    ok(T.pinOps(P1.id).length === 0, "안 바뀐 기존 핀은 기록하지 않음", T.pinOps(P1.id));
  }

  /* ── E2. 핀 이동(11_UI 드래그 = 필드 변경 후 _autoSave — 개별 기록 없던 진입점) ── */
  console.log("\n[E2] 오프라인 핀 이동(_autoSave 만 부르는 진입점) → oplog upsert");
  {
    const T = boot({ pins: [P1], serverPins: [P1], baseIds: ["1001"] });
    T.State.pins[0].x = 55; T.X.App._autoSave();
    await T.settle();
    const o = T.pinOps(P1.id);
    ok(o.length === 1 && o[0].action === "upsert" && o[0].data.x === 55, "이동한 핀 upsert 1건(x=55)", o);
  }

  /* ── E3. PhotoBatch._uploadOneRow + _markUnsaved(run·시각매칭·자동연결 공유 지점) ── */
  console.log("\n[E3] 오프라인 PhotoBatch 사진 연결 → 그 핀 oplog upsert(pendingOpId 포함)");
  {
    const T = boot({ pins: [P1], serverPins: [P1], baseIds: ["1001"] });
    const pin = T.State.pins[0];
    const r = await T.X.PhotoBatch._uploadOneRow(pin, { file: {}, name: "R0010001.JPG", is360: false, sortKey: NaN }, true, new Set(), "test");
    T.X.PhotoBatch._markUnsaved();
    await T.settle();
    ok(r && r.status === "done" && r.offline === true, "전제: 오프라인 큐 적립", r);
    const o = T.pinOps(pin.id);
    ok(o.length >= 1, "🔴 PhotoBatch 경로 oplog ≥ 1", o.length);
    ok(o.length && o[o.length - 1].data.pendingOpId === pin.pendingOpId, "op 본문에 pendingOpId(재연결 치환 대상) 포함", o.map((x) => x.data && x.data.pendingOpId));
  }

  /* ── E4. ThetaIntake._register(PhotoBatch 재사용 — 33_ThetaIntake.js:280) ── */
  console.log("\n[E4] 오프라인 THETA 인입 등록 → oplog upsert");
  {
    const T = boot({ pins: [P1], serverPins: [P1], baseIds: ["1001"] });
    const pin = T.State.pins[0];
    const r = await T.X.ThetaIntake._register(pin, { file: {}, name: "R0010002.JPG", is360: true, sortKey: NaN });
    await T.settle();
    ok(r && r.status === "done", "전제: 등록 완료", r);
    ok(T.pinOps(pin.id).length >= 1, "🔴 ThetaIntake 경로 oplog ≥ 1", T.pinOps(pin.id).length);
  }

  /* ── E5. 기존 개별 기록 진입점(재채번 등: recordCurrent → _autoSave) — 공유 지점과 겹쳐도 1건 ── */
  console.log("\n[E5] 개별 기록 + 공유 지점 → 중복 0");
  {
    const T = boot({ pins: [P1], serverPins: [P1], baseIds: ["1001"] });
    const pin = T.State.pins[0];
    pin.label = "7"; pin.labelManual = true;
    T.X.OpLog.recordCurrent("pin", "upsert", pin.id, pin);
    T.X.App._autoSave();
    await T.settle();
    ok(T.pinOps(pin.id).length === 1, "같은 편집은 oplog 1건", T.pinOps(pin.id).length);
  }

  /* ── E6. 기준(이전 스냅샷)이 없으면 기록하지 않는다 — 서버 핀 전체를 옛 값으로 덮는 op 금지 ── */
  console.log("\n[E6] 오프라인 번들 스냅샷 없음 → 추측 기록 0");
  {
    const T = boot({ pins: [P1], serverPins: [P1], baseIds: ["1001"], bundle: false });
    T.X.App._autoSave();
    await T.settle();
    ok(T.ops().length === 0, "기준 없을 때 oplog 0건", T.ops().length);
  }

  /* ── E7. oplog 기록을 기다리는 사이에 들어온 탭도 기록된다(스냅샷 = 기록과 같은 시점 사본) ── */
  console.log("\n[E7] 기록 도중 들어온 CHECKER 탭 → 그 핀도 oplog");
  {
    let T = null, fired = false, late = null;
    T = boot({ pins: [P1], serverPins: [P1], baseIds: ["1001"], onSave: async (k) => {
      if (fired || String(k).indexOf("oplog:") !== 0) return;
      fired = true; await wait(3); late = T.X.App._placeCheckboardPin({ x: 77, y: 77 });   // 첫 op 저장이 끝나기 전에 다음 탭
    } });
    const first = T.X.App._placeCheckboardPin({ x: 66, y: 66 });
    await T.settle(); await T.settle();
    ok(!!first && !!late && fired, "전제: 기록 도중 두 번째 탭 발생", { first: !!first, late: !!late, fired });
    ok(!!first && !!late && T.pinOps(first.id).length === 1 && T.pinOps(late.id).length === 1, "🔴 두 핀 모두 oplog 1건씩",
      { first: first && T.pinOps(first.id).length, late: late && T.pinOps(late.id).length });
  }

  /* ── R. 오프라인 → 온라인 복귀(도면 draft PATCH 실패, /ops 만 성공) → 서버 핀 수 = 로컬 핀 수 ── */
  console.log("\n[R] 오프라인 CHECKER 4 + 사진 1 → 복귀(draft PATCH 실패) → 서버 = 로컬");
  {
    const T = boot({ pins: [P1], serverPins: [P1], baseIds: ["1001"] });
    for (let i = 0; i < 4; i++) { T.X.App._placeCheckboardPin({ x: 20 + i * 10, y: 40 }); await wait(2); }
    const last = T.State.pins[T.State.pins.length - 1];
    await T.X.PhotoBatch._uploadOneRow(last, { file: {}, name: "R0010003.JPG", is360: false, sortKey: NaN }, true, new Set(), "test");
    T.X.PhotoBatch._markUnsaved();
    await T.settle();
    const localBefore = T.State.pins.map((p) => String(p.id));
    T.nav.onLine = true;
    // 실제 복귀 순서(SyncQueue._onReconnect): 도면 draft → oplog. draft PATCH 는 실패(약전파) — 여기선 oplog 만 성공.
    await T.X.App._flushOpLogs();
    const localAfter = T.State.pins.map((p) => String(p.id));
    const srvIds = T.server.live().map((p) => String(p.id));
    ok(T.server.opsPosts === 1, "전제: /ops 1회 전송", T.server.opsPosts);
    ok(localBefore.every((id) => localAfter.indexOf(id) >= 0), "복귀 후 화면 핀 유실 0", { localBefore, localAfter });
    ok(srvIds.length === localAfter.length && localAfter.every((id) => srvIds.indexOf(id) >= 0), "🔴 서버 핀 수 = 로컬 핀 수(ID 일치)", { server: srvIds.length, local: localAfter.length });
    const sp = T.server.pins.get(String(last.id));
    ok(!!(sp && sp.pendingOpId === last.pendingOpId), "사진 연결(pendingOpId)도 서버 핀에 반영", sp);
    ok(T.ops().length === 0, "적용된 op 는 큐에서 제거", T.ops().length);
  }

  /* ── M. oplog 에 없는 내 핀(기준 없을 때 만든 핀 · 동기화 도중 만든 핀)도 복귀 병합에서 지워지지 않는다 ── */
  console.log("\n[M] _flushOpLogs = 병합(_mergeConflict) — 덮어쓰기 아님");
  {
    const PX = { id: 2002, x: 40, y: 40, page: 1, label: "2", checkboard: true };
    const T = boot({ pins: [P1, PX], serverPins: [P1], baseIds: ["1001"] });
    T.store["oplog:dep1"] = [{ opId: "o-1", entity: "pin", action: "upsert", id: P1.id, data: Object.assign({}, P1, { note: "edit" }), ts: Date.now(), author: "t" }];
    T.nav.onLine = true;
    await T.X.App._flushOpLogs();
    const ids = T.State.pins.map((p) => String(p.id));
    ok(ids.indexOf("2002") >= 0, "🔴 oplog 에 없는 내 미동기화 핀 보존", ids);
    ok((T.State.pins.find((p) => p.id === P1.id) || {}).note === "edit", "서버 반영분(op 적용 결과)은 화면에 들어온다", T.State.pins);
    ok(T.State.depVersion === T.server.version, "버전은 서버값으로 갱신", { st: T.State.depVersion, srv: T.server.version });
    ok(JSON.stringify(T.State.pinBaseIds) === JSON.stringify(["1001"]), "병합 기준(pinBaseIds) = 서버가 아는 핀", T.State.pinBaseIds);
  }

  /* ── E8. PinActionPop 라벨 수정(자동저장 OFF 경로) → draft·번들 스냅샷·oplog ── */
  console.log("\n[E8] 오프라인 PinActionPop 라벨 수정 → 로컬 보관 + oplog 1건");
  {
    const dom = { "pap-label-input": { value: "967" }, "pap-title": { textContent: "" } };
    const T = boot({ pins: [P1], serverPins: [P1], baseIds: ["1001"], dom });
    T.X.PinActionPop._pinId = P1.id;
    T.X.PinActionPop._saveLabel();
    await T.settle();
    const bundlePins = JSON.parse(T.store["bundle:dep:dep1"].pins);
    ok(T.State.pins[0].label === "967", "전제: 화면 라벨 967", T.State.pins[0].label);
    ok(T.calls.draft >= 1, "🔴 도면 draft 보관(_saveDraftLocal) 호출", T.calls.draft);
    ok(bundlePins[0].label === "967", "🔴 번들 스냅샷 라벨 967(오프라인 새로고침 복원원)", bundlePins[0].label);
    const o = T.pinOps(P1.id);
    ok(o.length === 1 && o[0].data.label === "967", "oplog upsert 1건(label 967) — 개별 기록 제거 후에도 단일 지점이 기록", o.map((x) => x.data && x.data.label));
  }

  /* ── E9. 주석 — /ops 응답 반영이 덮어쓰기 아닌 병합(App._mergeAnnos) ── */
  console.log("\n[E9] 복귀 시 주석 병합 — 응답 대기 중 그린 주석 보존 + 서버 tombstone 반영");
  {
    const T = boot({ pins: [P1], serverPins: [P1], baseIds: ["1001"] });
    const A = { id: "anA", page: 1, type: "rect", x: 1, y: 1, w: 2, h: 2 }, B = { id: "anB", page: 1, type: "rect", x: 5, y: 5, w: 2, h: 2 }, C = { id: "anC", page: 1, type: "rect", x: 9, y: 9, w: 2, h: 2 };
    T.server.annos.set("anS", { id: "anS", page: 1, type: "rect", x: 3, y: 3, w: 1, h: 1 });   // 남이 그린 주석
    T.server.annos.set("anC", { id: "anC", _deleted: true, ts: Date.now() + 1000 });            // 남이 지운 주석
    T.State.annotations = [A, B, C];
    T.store["oplog:dep1"] = [{ opId: "o-a", entity: "anno", action: "upsert", id: "anA", data: A, ts: Date.now(), author: "t" }];
    T.nav.onLine = true;
    await T.X.App._flushOpLogs();
    const ids = T.State.annotations.map((a) => a.id).sort();
    ok(ids.indexOf("anA") >= 0 && ids.indexOf("anB") >= 0, "🔴 oplog 주석 A + oplog 없는 내 주석 B 보존", ids);
    ok(ids.indexOf("anS") >= 0, "서버에만 있는 남의 주석은 들어온다", ids);
    ok(ids.indexOf("anC") < 0, "서버 tombstone 주석은 되살리지 않는다", ids);
  }

  /* ── E10. 오프라인 주석 삭제 3경로(개별·되돌리기·페이지 전체) → oplog "anno delete" ── */
  console.log("\n[E10] 오프라인 주석 삭제 → oplog anno delete(경로별 1건) · 남은 주석은 기록 0");
  {
    const A1 = { id: "a1", page: 1, type: "rect", x: 1, y: 1, w: 1, h: 1 }, A2 = { id: "a2", page: 1, type: "rect", x: 2, y: 2, w: 1, h: 1 };
    const A3 = { id: "a3", page: 2, type: "rect", x: 3, y: 3, w: 1, h: 1 }, A4 = { id: "a4", page: 2, type: "rect", x: 4, y: 4, w: 1, h: 1 }, A5 = { id: "a5", page: 3, type: "rect", x: 5, y: 5, w: 1, h: 1 };
    const T = boot({ pins: [P1], serverPins: [P1], baseIds: ["1001"], annos: [A1, A2, A3, A4, A5], serverAnnos: [A1, A2, A3, A4, A5] });
    T.X.PdfAnno._removeById("a1");
    T.State.pdfPage = 2; await T.X.PdfAnno.clearPage();
    T.State.pdfPage = 3; T.X.PdfAnno.undo();
    await T.settle();
    const annoOps = T.ops().filter((o) => o.entity === "anno");
    const del = annoOps.filter((o) => o.action === "delete").map((o) => o.id).sort();
    ok(JSON.stringify(del) === JSON.stringify(["a1", "a3", "a4", "a5"]), "🔴 삭제 4건(개별 a1 · 페이지 a3,a4 · 되돌리기 a5) 모두 delete op", del);
    ok(annoOps.filter((o) => o.action === "upsert").length === 0, "안 바뀐 주석(a2)은 upsert 기록 0", annoOps.map((o) => o.action + ":" + o.id));
    ok(Object.keys(T.X.App._annoTombstones()).sort().join() === "a1,a3,a4,a5", "삭제 id 는 tombstone 으로 남는다", Object.keys(T.X.App._annoTombstones()));
  }

  /* ── E11. 오프라인 삭제 → 도면 PATCH 실패 → 복귀(/ops 만) → 주석 부활 0 ── */
  console.log("\n[E11] 오프라인 주석 삭제 → 복귀(draft PATCH 실패) → 서버·화면 모두 부활 0");
  {
    const A = { id: "anDel", page: 1, type: "rect", x: 1, y: 1, w: 1, h: 1 }, K = { id: "anKeep", page: 1, type: "rect", x: 2, y: 2, w: 1, h: 1 };
    const T = boot({ pins: [P1], serverPins: [P1], baseIds: ["1001"], annos: [A, K], serverAnnos: [A, K] });
    T.X.PdfAnno._removeById("anDel");
    await T.settle();
    T.nav.onLine = true;
    await T.X.App._flushOpLogs();
    const srvLive = Array.from(T.server.annos.values()).filter((a) => !a._deleted).map((a) => a.id);
    const local = T.State.annotations.map((a) => a.id);
    ok(srvLive.indexOf("anDel") < 0 && !!(T.server.annos.get("anDel") || {})._deleted, "🔴 서버는 기존 /ops tombstone 경로로 삭제(anDel → {_deleted})", Array.from(T.server.annos.values()));
    ok(local.indexOf("anDel") < 0, "🔴 복귀 병합 후 화면에 부활 0", local);
    ok(local.indexOf("anKeep") >= 0 && srvLive.indexOf("anKeep") >= 0, "안 지운 주석은 그대로", { local, srvLive });
  }

  /* ── E12. 라이브폴·409 병합(_mergeConflict) — 내가 막 지운 주석(아직 미저장)을 서버본이 되살리지 않는다 ── */
  console.log("\n[E12] _mergeConflict 주석 병합 — 내 tombstone 존중 + 남의 새 주석 반영");
  {
    const A = { id: "anMine", page: 1, type: "rect", x: 1, y: 1, w: 1, h: 1 }, S = { id: "anOther", page: 1, type: "rect", x: 7, y: 7, w: 1, h: 1 };
    const T = boot({ pins: [P1], serverPins: [P1], baseIds: ["1001"], annos: [A], serverAnnos: [A] });
    T.nav.onLine = true;
    T.X.PdfAnno._removeById("anMine");                 // 온라인 삭제 — 자동저장 전에 남의 저장이 먼저 도착
    T.X.App._mergeConflict({ pins: JSON.stringify([P1]), zones: "[]", annotations: JSON.stringify([A, S]), version: 5 });
    const ids = T.State.annotations.map((a) => a.id).sort();
    ok(ids.indexOf("anMine") < 0, "🔴 내가 지운 주석은 서버본이 있어도 부활 0", ids);
    ok(ids.indexOf("anOther") >= 0, "남이 새로 그린 주석은 들어온다(409 재시도가 지우지 않음)", ids);
    const keep = T.State.annotations.slice();
    T.X.App._mergeConflict({ pins: JSON.stringify([P1]), zones: "[]", version: 6 });   // 주석 필드 없는 부분 응답
    ok(T.State.annotations.length === keep.length, "서버본에 주석 필드가 없으면 건드리지 않는다", T.State.annotations.length);
  }

  /* ── E13. 스냅샷에 이미 서버 tombstone 으로 있는 주석은 다시 delete 기록하지 않는다 ── */
  console.log("\n[E13] 이미 서버에서 지워진(†) 주석 → 중복 delete op 0");
  {
    const K = { id: "anK", page: 1, type: "rect", x: 2, y: 2, w: 1, h: 1 };
    const T = boot({ pins: [P1], serverPins: [P1], baseIds: ["1001"], annos: [K] });
    T.store["bundle:dep:dep1"].annotations = JSON.stringify([{ id: "anGone", _deleted: true, ts: 1 }, K]);   // /ops 응답이 남긴 스냅샷 모양
    T.X.App._annoTombstones().anGone = 1;
    T.X.App._autoSave();
    await T.settle();
    ok(T.ops().filter((o) => o.entity === "anno").length === 0, "중복 delete op 0", T.ops());
  }

  /* ── M2. 남이 지운 핀(tombstone)은 병합에서 반영된다 — 기존 규칙 불변 ── */
  console.log("\n[M2] 서버 tombstone 은 병합에서 반영(삭제 부활 0)");
  {
    const T = boot({ pins: [P1], serverPins: [P1], baseIds: ["1001"] });
    T.server.pins.set("1001", { id: 1001, _deleted: true, ts: Date.now() + 1000 });
    T.store["oplog:dep1"] = [{ opId: "o-2", entity: "zone", action: "upsert", id: "z1", data: { id: "z1" }, ts: Date.now(), author: "t" }];
    T.nav.onLine = true;
    await T.X.App._flushOpLogs();
    ok(T.State.pins.length === 0, "서버에서 지워진 핀은 화면에서도 제거", T.State.pins);
  }

  console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
  process.exit(failed === 0 ? 0 : 1);
})().catch((e) => { console.log("ERROR " + (e && e.stack || e)); process.exit(1); });
