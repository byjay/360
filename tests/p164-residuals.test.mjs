/**
 * p164 — 잔여 3건(2026-10-18 지시 "남은 거 다 구현해라" 직전 착지 보고 "미착수" 항목).
 * 프레임워크 0 · 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p164-residuals.test.mjs
 *
 * [재현](발주서 그대로, 착수 시 재확인 — .tmp/repro-r1.mjs):
 *  R1 56_Delivery.js 보고서 위치 칸 — 연결 핀(f874a75 pin.linkId) 2개(PLAN p1 · ELEV p2) 시드 →
 *     수정 전 locText=undefined, p.page/x/y 는 대표(PLAN)만 — ELEV 좌표가 보고서에서 증발한다.
 *  R2 11_UI.js:736/746 "영역 지정해 하위 구역 만들기"·"원본에서 여러 영역…" reason 에 sheet_link 판정이
 *     없다 — 시트 묶음 구역에서도 두 메뉴가 활성(design-multisheet.md Phase4 "비활성+사유" 위반).
 *  R3 viewer_events/viewer_auth_challenges 보관 정리 쿼리 0(주석 "정리 배치를 붙일 때" 만 있고 구현 없음).
 *
 * 구현: 56_Delivery.js(locText 병기) · 11_UI.js+src/index.tsx(클라+서버 거부) · src/index.tsx(확률적 정리 + 보관일 노출).
 * 뮤테이션 3개(각 EXIT=1 이어야 통과): LOC_PAIR(병기 제거) · SRV_DENY(서버 거부 제거) · CLEANUP(정리 쿼리 제거)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { Miniflare } from "miniflare";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const M = "public/js/modules/";
let failed = 0;
const ok = (cond, label, d) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (!cond && d !== undefined ? " :: " + JSON.stringify(d).slice(0, 400) : "")); if (!cond) failed++; };
const J = (x) => JSON.stringify(x);
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const watchdog = setTimeout(() => { console.log("\nWATCHDOG — 180s 초과 → FAIL"); process.exit(1); }, 180000);

const MUT = process.env.P164_MUT || "";

/* ══════════════════════════════════════════════════════════════════════
 * Part A — R1: 56_Delivery.js 연결 핀 위치 병기(순수 vm, 재구현 0)
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[A·R1 납품 보고서 위치 칸 — 연결 핀 시트별 좌표 병기]");
{
  let delSrc = rd(M + "56_Delivery.js");
  const LOC_PAIR_TARGET =
    'const locText = _locMembers.length > 1\n' +
    '            ? _locMembers.slice().sort((a, b) => (a.page || 1) - (b.page || 1))\n' +
    '                .map((m) => (_sheetLabel(m) ? _sheetLabel(m) + " " : "") + (m.page || 1) + "쪽 · X " + _fmtXY(m.x) + "% · Y " + _fmtXY(m.y) + "%")\n' +
    '                .join(" / ")\n' +
    '            : (pg + "쪽 · X " + _fmtXY(pin.x) + "% · Y " + _fmtXY(pin.y) + "%");';
  const LOC_PAIR_REMOVED = 'const locText = (pg + "쪽 · X " + _fmtXY(pin.x) + "% · Y " + _fmtXY(pin.y) + "%");';
  if (MUT === "LOC_PAIR") {
    if (!delSrc.includes(LOC_PAIR_TARGET)) { console.log("  FAIL 뮤테이션 LOC_PAIR 대상 문자열 없음"); process.exit(2); }
    delSrc = delSrc.replace(LOC_PAIR_TARGET, LOC_PAIR_REMOVED);
    console.log("[뮤테이션 적용] LOC_PAIR");
  }
  const sb = {
    console, JSON, Map, Set, Math, Number, String, Array, Object, Date, RegExp, Promise,
    State: { pins: [], pdfPage: 1 }, Auth: { readonly: false }, Prompt: { toast() {} }, UI: { renderPinsOnMap() {}, renderPinList() {} },
    TimeLapse: { _normalize: () => [] },
    Requests: { KIND: {}, STATUS: {}, SEVERITY_STYLE: {}, KIND_STYLE: {}, STATUS_STYLE: {}, _isOpen: () => false, _isOverdue: () => false },
    Coverage: { isTarget: () => false, classify: () => null, summarize: () => ({ none: 0, stale: 0, fresh: 0, unknown: 0, total: 0 }), STYLE: { none: { label: "x" }, stale: { label: "y" }, unknown: { label: "z" } }, DEFAULT_DAYS: 30, staleDays: () => 30 },
  };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(rd(M + "01b_PinSeries.js") + "\n;globalThis.PinSeries=PinSeries;", sb);
  vm.runInContext(rd(M + "66_PinLink.js") + "\n;globalThis.PinLink=PinLink;", sb);
  vm.runInContext(rd(M + "65_Sheets.js") + "\n;globalThis.Sheets=Sheets;", sb);
  vm.runInContext(delSrc + "\n;globalThis.Delivery=Delivery;", sb);

  const pins = [
    { id: "p1", page: 1, label: "12", linkId: "p1", x: 10, y: 20 },
    { id: "p2", page: 2, label: "12", linkId: "p1", x: 30, y: 40 },
  ];
  const decks = [
    { id: "S1", name: "구역S", deployment_id: "depA", page: null, crop: null, parent_id: null },
    { id: "SH1", name: "A DK PLAN", deployment_id: "depA", page: 1, crop: null, parent_id: "S1" },
    { id: "SH2", name: "A DK ELEV", deployment_id: "depA", page: 2, crop: null, parent_id: "S1" },
  ];
  const deps = { depA: { pins, zones: [], title: "원본" } };
  const sections = sb.Delivery.sections(decks, deps, decks);
  const model = sb.Delivery.buildModel({ sections, now: Date.now(), staleDays: 30, notes: [], skipped: [], scopeLabel: "x" });
  ok(model.pins.length === 1, "A1 대표 1행(연결 멤버 제외) — 실측 " + model.pins.length);
  const row = model.pins[0];
  ok(/PLAN/.test(row.locText) && /ELEV/.test(row.locText), "A2 위치 칸에 PLAN·ELEV 둘 다 병기 — " + row.locText);
  ok(/X 10\.0% · Y 20\.0%/.test(row.locText) && /X 30\.0% · Y 40\.0%/.test(row.locText), "A3 각 시트 좌표 정확 — " + row.locText);
  ok(row.locText.indexOf(" / ") > 0, "A4 ' / ' 로 구분(인쇄 레이아웃 한 줄, 넘침 방지) — " + row.locText);
  ok(row.locText.length < 120, "A5 위치 텍스트 길이 상한(A4 칸 안 유지) — " + row.locText.length + "자");

  // 비연결(단일) 핀 — 종전 포맷 바이트 불변(회귀 0)
  const solo = { id: "z", page: 1, label: "9", x: 50, y: 60 };
  const sections2 = sb.Delivery.sections(decks, { depA: { pins: [solo], zones: [], title: "원본" } }, decks);
  const model2 = sb.Delivery.buildModel({ sections: sections2, now: Date.now(), staleDays: 30, notes: [], skipped: [], scopeLabel: "x" });
  ok(model2.pins[0].locText === "1쪽 · X 50.0% · Y 60.0%", "A6 비연결 핀 = 종전 포맷 그대로(회귀 0) — " + model2.pins[0].locText);
}

/* ══════════════════════════════════════════════════════════════════════
 * Part B — R2(클라) : 시트 묶음 구역·하위에서 영역 잘라오기 메뉴 비활성(사유 표시)
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[B·R2(클라) 시트 묶음 — 영역 잘라오기 2종 메뉴 비활성]");
{
  const sb = {
    console, JSON, Map, Set, Math, Number, String, Array, Object, Date, RegExp, Promise,
    document: undefined, window: undefined,
    State: { mode: "designer", pins: [], pdfPage: 1 },
    Auth: { isDesigner: true, readonly: false, isSuper: false },
  };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(rd(M + "31_Projects.js") + "\n;globalThis.Projects=Projects;", sb);
  vm.runInContext(rd(M + "65_Sheets.js") + "\n;globalThis.Sheets=Sheets;", sb);
  vm.runInContext(rd(M + "11_UI.js") + "\n;globalThis.UI=UI;", sb);
  const decks = [
    { id: "B", name: "A DK", parent_id: null, deployment_id: null, page: null, sheet_link: 1 },
    { id: "S1", name: "A DK PLAN", parent_id: "B", deployment_id: "depA", page: 1 },
    { id: "C1", name: "하위영역", parent_id: "S1", deployment_id: "depA", page: 1 },   // 묶음의 하위(조상 체인에 B)
  ];
  sb.Projects.decks = decks;
  const itemsOf = (deck) => sb.UI.deckMenuItems(deck, null);
  const findLabel = (items, re) => items.find((it) => re.test(it.label));

  const onB = itemsOf(decks[0]);
  const cut1B = findLabel(onB, /영역 지정해 하위 구역 만들기/);
  const cut2B = findLabel(onB, /원본에서 여러 영역/);
  ok(cut1B && cut1B.reason, "B1 묶음 deck 자신 — [영역 지정해 하위 구역 만들기] 비활성(사유) — " + J(cut1B && cut1B.reason));
  ok(cut2B && cut2B.reason, "B2 묶음 deck 자신 — [원본에서 여러 영역…] 비활성(사유) — " + J(cut2B && cut2B.reason));
  ok(/시트 묶음/.test(cut1B.reason) && /묶음을 해제/.test(cut1B.reason), "B3 사유 문구 — 시트 묶음·해제 안내 — " + cut1B.reason);

  const onChild = itemsOf(decks[2]);   // 묶음의 하위(자기 sheet_link 없음, 조상 B 가 ON)
  const cutChild = findLabel(onChild, /영역 지정해 하위 구역 만들기/);
  ok(cutChild && cutChild.reason, "B4 묶음 하위 구역도 비활성(조상 체인 판정) — " + J(cutChild && cutChild.reason));

  // 묶음 OFF(종전) — 비활성 사유 0(도면 등록돼 있으면)
  const decksOff = decks.map((d) => ({ ...d, sheet_link: d.id === "B" ? null : d.sheet_link }));
  sb.Projects.decks = decksOff;
  const onBoff = itemsOf(decksOff[1]);   // S1(도면 등록됨, 부모 B sheet_link=null)
  const cutOff = findLabel(onBoff, /영역 지정해 하위 구역 만들기/);
  ok(cutOff && cutOff.reason === "", "B5 🔴 묶음 꺼짐(회귀 0) — 비활성 사유 없음 — " + J(cutOff && cutOff.reason));
}

/* ══════════════════════════════════════════════════════════════════════
 * Part C — R2(서버) + R3 : 실 워커(esbuild) + 실 D1(Miniflare, 전 migration)
 * ══════════════════════════════════════════════════════════════════════ */
console.log("\n[C 실 서버 — 시트 묶음 영역 추출 400 거부 · 열람 로그 보관 정리]");
{
  let srvSrc = rd("src/index.tsx");
  // 테스트 결정성: 확률 정리를 매 요청 100% 로(운영값 1% 는 소스에 그대로 — 별도 상수 검사로 확인)
  const PROB_TARGET = "const VIEW_LOG_CLEANUP_PROB = 0.01";
  if (!srvSrc.includes(PROB_TARGET)) { console.log("  FAIL VIEW_LOG_CLEANUP_PROB 상수를 찾지 못함"); process.exit(2); }
  srvSrc = srvSrc.replace(PROB_TARGET, "const VIEW_LOG_CLEANUP_PROB = 1");

  const SRV_DENY_TARGET =
    "  const isExtract = crop != null || !!(src && src.crop)\n" +
    "  if (isExtract && parentId) {\n" +
    "    const bundleId = await sheetBundleAncestorId(c.env.DB, parentId)\n" +
    "    if (bundleId) return c.json({ error: SHEET_BUNDLE_EXTRACT_DENY }, 400)\n" +
    "  }\n";
  const CLEANUP_TARGET =
    "    await c.env.DB.prepare(\n" +
    "      'DELETE FROM viewer_auth_challenges WHERE id IN (SELECT id FROM viewer_auth_challenges WHERE expires_at < ? LIMIT ?)'\n" +
    "    ).bind(now - VIEW_AUTH_CHALLENGE_RETENTION_MS, VIEW_LOG_CLEANUP_LIMIT).run()\n" +
    "    await c.env.DB.prepare(\n" +
    "      'DELETE FROM viewer_events WHERE id IN (SELECT id FROM viewer_events WHERE ts < ? LIMIT ?)'\n" +
    "    ).bind(now - VIEW_EVENT_RETENTION_MS, VIEW_LOG_CLEANUP_LIMIT).run()\n";
  if (!srvSrc.includes(SRV_DENY_TARGET)) { console.log("  FAIL SRV_DENY 대상 문자열 없음"); process.exit(2); }
  if (!srvSrc.includes(CLEANUP_TARGET)) { console.log("  FAIL CLEANUP 대상 문자열 없음"); process.exit(2); }
  if (MUT === "SRV_DENY") { srvSrc = srvSrc.replace(SRV_DENY_TARGET, ""); console.log("[뮤테이션 적용] SRV_DENY"); }
  if (MUT === "CLEANUP") { srvSrc = srvSrc.replace(CLEANUP_TARGET, ""); console.log("[뮤테이션 적용] CLEANUP"); }

  const tmpEntry = path.join(ROOT, "src", "__p164_mut.tsx");
  fs.writeFileSync(tmpEntry, srvSrc);
  const workerOut = path.join(os.tmpdir(), "p164-worker-" + process.pid + ".mjs");
  try {
    await esbuild.build({ entryPoints: [tmpEntry], bundle: true, format: "esm", platform: "neutral", outfile: workerOut, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent", conditions: ["workerd", "worker", "browser"] });
  } finally { fs.unlinkSync(tmpEntry); }

  const MIG_DIR = path.join(ROOT, "migrations");
  const MIGS = fs.readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
  const stmtsOf = (file) => fs.readFileSync(path.join(MIG_DIR, file), "utf8").replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);

  const mf = new Miniflare({
    modules: true, scriptPath: workerOut, d1Databases: { DB: "p164-" + Math.random().toString(36).slice(2) }, r2Buckets: { R2: "p164r2" },
    bindings: { DEMO_LOGIN: "0" }, compatibilityDate: "2025-01-01",
  });
  try {
    const db = await mf.getD1Database("DB");
    for (const f of MIGS) for (const st of stmtsOf(f)) await db.exec(st);
    const now = Date.now(), PID = "prj_p164";
    const U = "owner@p164.test";
    await db.prepare("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, 'o', 'seed', ?, ?, 0)").bind(U, now, now).run();
    await db.prepare("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, 'o', 'p164.test', 'x', 'y', 1, ?, ?, 0)").bind(U, now, now).run();
    await db.prepare("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)").bind("local-p164", U, now, now + 8.64e7).run();
    await db.prepare("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, 'P164', '', ?, ?, ?, 0)").bind(PID, U, now, now).run();
    const H = { Authorization: "Bearer local-p164", "Content-Type": "application/json" };
    const api = async (method, url, body) => { const r = await mf.dispatchFetch("http://p164.test" + url, { method, headers: H, body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch (e) {} return { s: r.status, j }; };

    /* ── R2(서버): 묶음 켜면 영역 추출(크롭·벡터복사) 400 · 끄면 다시 허용 ── */
    const dep = await api("POST", "/tables/deployments", { title: "A DK.pdf", file_name: "A DK.pdf", project_id: PID, pins: "[]", zones: "[]", annotations: "[]", routes: "[]", pages_data: J(["p1"]) });
    ok(dep.s === 200 && dep.j && dep.j.id, "C1 배포본 생성 " + dep.s);
    const DA = dep.j && dep.j.id;
    const B = (await api("POST", "/api/projects/" + PID + "/decks", { name: "A DK", deployment_id: DA, page: 1 })).j;
    const put = await api("PUT", "/api/decks/" + B.id, { sheet_link: 1 });
    ok(put.s === 200 && put.j.sheet_link === 1, "C2 묶음 켜기 200");

    const crop = { x: 10, y: 10, w: 20, h: 20 };
    const extractWindow = await api("POST", "/api/projects/" + PID + "/decks", { name: "영역A", parent_id: B.id, deployment_id: DA, page: 1, crop });
    const extractVector = await api("POST", "/api/projects/" + PID + "/decks", { name: "영역B", parent_id: B.id, deployment_id: DA, page: 1, crop: null, src_dep_id: DA, src_page: 1, src_crop: crop });
    ok(extractWindow.s === 400 && /영역 잘라오기를 지원하지 않습니다/.test((extractWindow.j && extractWindow.j.error) || ""), "C3 묶음 안 창 방식 추출 → 400 — " + extractWindow.s + " " + J(extractWindow.j));
    ok(extractVector.s === 400, "C4 묶음 안 벡터복사 추출 → 400 — " + extractVector.s);
    const plain = await api("POST", "/api/projects/" + PID + "/decks", { name: "하위(이름만)", parent_id: B.id });
    ok(plain.s === 200, "C5 🔴 '+ 하위 구역'(crop·src 없음) 은 그대로 허용(과차단 0) — " + plain.s);

    const off = await api("PUT", "/api/decks/" + B.id, { sheet_link: 0 });
    ok(off.s === 200 && off.j.sheet_link === 0, "C6 묶음 끄기 200");
    const extractAfterOff = await api("POST", "/api/projects/" + PID + "/decks", { name: "영역C", parent_id: B.id, deployment_id: DA, page: 1, crop });
    ok(extractAfterOff.s === 200, "C7 묶음 끄면 영역 추출 다시 허용(해제 가능) — " + extractAfterOff.s);

    /* ── R3: 보관 정리 — 만료 지난 challenge(7일) · 오래된 event(365일) 삭제, 최근 것은 보존 ── */
    const oldC = now - (8 * 24 * 60 * 60 * 1000);       // 만료 8일 지남 → 삭제 대상
    const freshC = now - (1 * 24 * 60 * 60 * 1000);      // 만료 1일 지남 → 보존
    await db.prepare("INSERT INTO viewer_auth_challenges (id, project_id, email, email_hash, method, created_at, expires_at) VALUES ('vac_old', ?, NULL, 'h', 'server', ?, ?)").bind(PID, oldC, oldC).run();
    await db.prepare("INSERT INTO viewer_auth_challenges (id, project_id, email, email_hash, method, created_at, expires_at) VALUES ('vac_fresh', ?, NULL, 'h', 'server', ?, ?)").bind(PID, freshC, freshC).run();
    const oldE = now - (366 * 24 * 60 * 60 * 1000);      // 366일 지남 → 삭제 대상
    const freshE = now - (10 * 24 * 60 * 60 * 1000);     // 10일 → 보존
    await db.prepare("INSERT INTO viewer_events (project_id, email, ts, kind) VALUES (?, 'x@p164.test', ?, 'open')").bind(PID, oldE).run();
    await db.prepare("INSERT INTO viewer_events (project_id, email, ts, kind) VALUES (?, 'x@p164.test', ?, 'open')").bind(PID, freshE).run();

    // /api/view-auth/start 는 유효 링크가 없어 404 로 끝나지만, 정리는 핸들러 맨 앞(runLater)에서 이미 걸린다.
    await api("POST", "/api/view-auth/start", { email: "nobody@p164.test" });
    await wait(400);

    const vac = (await db.prepare("SELECT id FROM viewer_auth_challenges ORDER BY id").all()).results.map((r) => r.id);
    const ve = (await db.prepare("SELECT ts FROM viewer_events ORDER BY ts").all()).results.map((r) => r.ts);
    ok(!vac.includes("vac_old") && vac.includes("vac_fresh"), "C8 만료 8일 지난 challenge 삭제 · 1일 지난 것은 보존 — 남음 " + J(vac));
    ok(!ve.includes(oldE) && ve.includes(freshE), "C9 366일 지난 event 삭제 · 10일 지난 것은 보존 — 남은 ts " + J(ve));

    /* ── 디자이너 화면 노출: GET viewer-access 에 보관일 ── */
    await db.prepare(
      "INSERT INTO viewer_access_policy (project_id, email_auth, updated_by, updated_at) VALUES (?, 0, 'o', ?)"
    ).bind(PID, now).run();
    const va = await api("GET", "/api/projects/" + PID + "/viewer-access");
    ok(va.s === 200 && va.j.retention_days === 365, "C10 GET viewer-access.retention_days === 365 — " + J(va.j && va.j.retention_days));
    ok(Number.isFinite(va.j.auth_challenge_retention_days) && va.j.auth_challenge_retention_days === 7, "C11 auth_challenge_retention_days === 7 — " + J(va.j && va.j.auth_challenge_retention_days));
  } finally { await mf.dispose(); }
}

/* ── 정적: 68_ViewerAuth.js 가 retention_days 를 화면에 표시하는지(문구 존재) ── */
console.log("\n[D 정적 — 디자이너 화면에 보관 기간 문구]");
{
  const ui = rd(M + "68_ViewerAuth.js");
  ok(/retention_days/.test(ui) && /보관/.test(ui), "D1 68_ViewerAuth.js 가 retention_days 를 화면 문구로 사용");
}

clearTimeout(watchdog);
console.log(failed ? ("\n" + failed + " FAILED") : "\nALL PASS");
process.exit(failed ? 1 : 0);
