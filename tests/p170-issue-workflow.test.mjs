/**
 * p170 — SIGNAX 격차2: 이슈 워크플로(담당자 계정 연결 + 알림 + 마크업↔이슈 연동) (WO 20261019-issueflow)
 * 프레임워크 0 · 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p170-issue-workflow.test.mjs
 *
 * 서버(src/index.tsx) 실 번들 → Miniflare(workerd) + 실 D1(migrations 전부, 0051 포함). 목 0.
 * 메일 — RESEND_API_KEY 는 더미, MAIL_STUB_URL 로 로컬 스텁(HTTP 서버, 이 프로세스 안)으로 보낸다
 *   (🔴 지시: 테스트에서 실제 외부 발송 금지 — api.resend.com 에 안 나간다, 로컬호스트만 왕복).
 *
 * 뮤테이션: P170_MUT=<이름> → 서버 소스를 바꿔 실행 → EXIT=1 이어야 한다(대상 문자열 못 찾으면 EXIT=2).
 *   dedupe    : 멱등 키 무시(강제 중복 발송) — 2번째 due_soon 스캔에서 메일이 또 나간다
 *   shape     : 도형 참조 저장 제거 — pano_view.shape 가 항상 null
 *   assignee  : 담당자 이메일 정규화 제거 — assignee_email 이 항상 null([내 담당] 필터 무력화)
 *   nokeyhide : 메일 키 없음을 가짜 성공으로 은폐 — mailed_at 이 거짓으로 채워짐
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import esbuild from "esbuild";
import { Miniflare } from "miniflare";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
let SRV = rd("src/index.tsx");

const MUTS = {
  dedupe: ["inserted = !!Number((res && res.meta && res.meta.changes) || 0)", "inserted = true"],
  shape: ["shape: parsePanoShape(o.shape),", "shape: null,"],
  assignee: ["return (s && isValidEmail(s)) ? s.toLowerCase() : null", "return null"],
  nokeyhide: [
    "if (r === null) { console.log('[notifyEvent] mail skipped(no key)', opts.kind); return }",
    "if (r === null) { await c.env.DB.prepare('UPDATE notifications SET mailed_at = ? WHERE id = ?').bind(Date.now(), id).run(); return }",
  ],
};
const MUT = process.env.P170_MUT || "";
if (MUT) {
  const m = MUTS[MUT];
  if (!m) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }
  if (!SRV.includes(m[0])) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함: " + MUT); process.exit(2); }
  SRV = SRV.replace(m[0], m[1]);
  console.log("[뮤테이션 적용] " + MUT);
}

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };
const watchdog = setTimeout(() => { console.log("\nWATCHDOG — 120s 초과 → FAIL"); process.exit(1); }, 120000);

/* ── 로컬 메일 스텁(이 프로세스 안의 HTTP 서버) — api.resend.com 대신 이 주소로 보낸다(실 외부 발송 0) ── */
const mailCalls = [];
const stubSrv = http.createServer((req, res) => {
  let buf = "";
  req.on("data", (d) => (buf += d));
  req.on("end", () => {
    mailCalls.push(JSON.parse(buf || "{}"));
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ id: "mail_" + mailCalls.length }));
  });
});
await new Promise((resolve) => stubSrv.listen(0, "127.0.0.1", resolve));
const stubPort = stubSrv.address().port;
const MAIL_STUB_URL = "http://127.0.0.1:" + stubPort + "/emails";

const MIG_DIR = path.join(ROOT, "migrations");
const MIGS = fs.readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
ok(MIGS.includes("0051_issue_workflow.sql"), "마이그레이션 0051_issue_workflow.sql 존재");
const stmtsOf = (file) => fs.readFileSync(path.join(MIG_DIR, file), "utf8").replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);

const workerOut = path.join(os.tmpdir(), "p170-worker-" + process.pid + ".mjs");
await esbuild.build({
  stdin: { contents: SRV, resolveDir: path.join(ROOT, "src"), sourcefile: "index.tsx", loader: "tsx" },
  bundle: true, format: "esm", platform: "neutral", outfile: workerOut, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
  conditions: ["workerd", "worker", "browser"],
});
const FAKE_KEY = "re_p170_fake_key_" + Date.now();
const mf = new Miniflare({
  modules: true, scriptPath: workerOut, d1Databases: { DB: "p170-" + Date.now() }, r2Buckets: { R2: "p170r2-" + Date.now() },
  bindings: { DEMO_LOGIN: "0", RESEND_API_KEY: FAKE_KEY, MAIL_STUB_URL },
  compatibilityDate: "2025-01-01",
});
const BASE = "http://p170.test";
const db = await mf.getD1Database("DB");

try {
  for (const f of MIGS) for (const st of stmtsOf(f)) await db.exec(st);
  const now0 = Date.now();
  const run = (q, a) => db.prepare(q).bind(...a).run();
  const U = { o: "owner170@seastar.test", d2: "designer170b@seastar.test" };
  const TOK = {};
  const addUser = async (k, designer) => {
    if (designer) await run("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)", [U[k], k, "designssir@gmail.com", now0, now0]);
    await run("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)", [U[k], "이름" + k, U[k].split("@")[1], "x", "y", now0, now0]);
    TOK[k] = "local-p170-" + k;
    await run("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOK[k], U[k], now0, now0 + 8.64e7]);
  };
  await addUser("o", true);
  await addUser("d2", true);

  const api = async (who, method, url, body) => {
    const h = { "Content-Type": "application/json", "CF-Connecting-IP": "10.3.0.1" };
    const t = who && (TOK[who] || who);
    if (t) h.Authorization = "Bearer " + t;
    const r = await mf.dispatchFetch(BASE + url, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, j };
  };

  await run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES ('prj_I', '이슈 프로젝트', '', ?, ?, ?, 0)", [U.o, now0, now0]);
  await api("o", "POST", "/api/projects/prj_I/members", { email: U.d2, role: "designer" });
  const pins = [
    { id: "p1", page: 1, x: 20, y: 20, label: "1", checkboard: false, imageId: "img1" },
    { id: "p2", page: 1, x: 40, y: 40, label: "2", checkboard: false, imageId: "img2" },
  ];
  const PAGE_URL = "/api/r2/object/assets/p170-base.png";
  const dep = (await api("o", "POST", "/tables/deployments", { title: "D", file_name: "D.pdf", project_id: "prj_I", pins: JSON.stringify(pins), pages_data: JSON.stringify([PAGE_URL]), drawing_data: PAGE_URL })).j.id;
  const deck = (await api("o", "POST", "/api/projects/prj_I/decks", { name: "구역I", deployment_id: dep, page: 1 })).j;
  ok(!!(dep && deck.id), "전제: 배포본·구역 생성");

  console.log("\n[① 담당자 계정 연결 — 이메일 정규화 + 자유텍스트 보존 + 내 담당 필터]");
  const n1 = await api("o", "POST", "/api/notes", { deployment_id: dep, pin_id: "p1", kind: "note", body: "용접부 누수", assignee: U.d2 });
  ok(n1.status === 200 && n1.j.assignee === U.d2, "① 생성 시 assignee(자유텍스트 그대로) 저장 — " + n1.j.assignee);
  const n1AsD2 = await api("d2", "GET", "/api/notes?deployment_id=" + dep + "&pin_id=p1");
  const n1Full = (n1AsD2.j.data || []).find((x) => x.id === n1.j.id);
  ok(!!n1Full && n1Full.assignee_email === U.d2.toLowerCase(), "① assignee_email = 본인 이메일 정규화(디자이너 d2 로 조회, 자기 담당이라 안 가려짐) — " + (n1Full && n1Full.assignee_email));

  const n2 = await api("o", "POST", "/api/notes", { deployment_id: dep, pin_id: "p2", kind: "note", body: "도장 벗겨짐" });
  const patchFree = await api("o", "PATCH", "/api/notes/" + n2.j.id, { assignee: "현장 김반장(무선)" });
  ok(patchFree.status === 200 && patchFree.j.assignee === "현장 김반장(무선)", "① 자유텍스트 담당자 PATCH → 그대로 저장(유실 0) — " + patchFree.j.assignee);
  ok(patchFree.j.assignee_email == null, "① 비이메일 자유텍스트는 assignee_email null(지어내지 않음)");

  const mineList = await api("d2", "GET", "/api/projects/prj_I/requests?mine=1");
  const mineIds = (mineList.j.data || []).map((x) => x.id);
  ok(mineIds.includes(n1.j.id) && !mineIds.includes(n2.j.id), "① [내 담당] 필터 — d2 담당 1건만 — " + JSON.stringify(mineIds));

  console.log("\n[② 알림 — 담당자 지정·상태변경·댓글, 앱 내 + 메일(로컬 스텁)]");
  const notifAfterAssign = await api("d2", "GET", "/api/notifications");
  const assignNotif = (notifAfterAssign.j.data || []).find((x) => x.kind === "assignee" && x.note_id === n1.j.id);
  ok(!!assignNotif, "② 담당자 지정 알림(d2 수신함) 생성 — " + JSON.stringify(assignNotif && assignNotif.title));
  ok(mailCalls.length >= 1 && mailCalls[mailCalls.length - 1].to && mailCalls[mailCalls.length - 1].to.includes(U.d2), "② 메일 스텁 호출(수신자 d2) — calls=" + mailCalls.length);
  const mailCountAfterAssign = mailCalls.length;

  const statusR = await api("o", "PATCH", "/api/notes/" + n1.j.id, { status: "progress" });
  ok(statusR.status === 200 && statusR.j.status === "progress", "② 상태변경 PATCH 200");
  const notifAfterStatus = await api("d2", "GET", "/api/notifications");
  const statusNotif = (notifAfterStatus.j.data || []).find((x) => x.kind === "status" && x.note_id === n1.j.id);
  ok(!!statusNotif, "② 상태변경 알림(d2, 자신이 담당 — 변경자는 owner 이므로 알림 받음) 생성");
  ok(mailCalls.length === mailCountAfterAssign + 1, "② 상태변경 메일 1건 추가 발송 — calls=" + mailCalls.length);

  const replyR = await api("d2", "POST", "/api/notes", { kind: "reply", parent_id: n1.j.id, body: "확인했습니다, 조치 중" });
  ok(replyR.status === 200, "② d2(담당자 본인)의 답변 작성 200");
  const notifOwner = await api("o", "GET", "/api/notifications");
  const commentNotif = (notifOwner.j.data || []).find((x) => x.kind === "comment" && x.note_id === n1.j.id);
  ok(!!commentNotif, "② 답변 알림 — 작성자(owner)에게 'comment' 알림(답변자 d2 자신은 제외)");

  if (assignNotif) {
    const readRes = await api("d2", "POST", "/api/notifications/" + assignNotif.id + "/read");
    ok(readRes.status === 200 && readRes.j.changed === 1, "② 알림 읽음 처리 1건 — " + JSON.stringify(readRes.j));
    const readAgain = await api("d2", "POST", "/api/notifications/" + assignNotif.id + "/read");
    ok(readAgain.j.changed === 0, "② 이미 읽은 알림 재요청 → changed 0(멱등)");
  } else {
    ok(false, "② 알림 읽음 처리 — 선행 담당자 알림이 없어 스킵(이미 상단에서 FAIL 기록됨)");
  }

  console.log("\n[③ 마감 임박/초과 — Pages Cron 미지원 → 요청 경로 편승(_scan_due=1), 평생 1회만]");
  const now1 = Date.now();
  const soon = await api("o", "POST", "/api/notes", { deployment_id: dep, pin_id: "p1", kind: "note", body: "마감 임박 테스트", assignee: U.d2, due_at: now1 + 3600 * 1000 });
  const over = await api("o", "POST", "/api/notes", { deployment_id: dep, pin_id: "p2", kind: "note", body: "마감 초과 테스트", assignee: U.d2, due_at: now1 - 3600 * 1000 });
  const mailBeforeScan = mailCalls.length;
  await api("o", "GET", "/api/projects/prj_I/requests?_scan_due=1");
  const afterScan1 = await api("d2", "GET", "/api/notifications");
  const soonN = (afterScan1.j.data || []).filter((x) => x.kind === "due_soon" && x.note_id === soon.j.id);
  const overN = (afterScan1.j.data || []).filter((x) => x.kind === "due_over" && x.note_id === over.j.id);
  ok(soonN.length === 1, "③ 마감 임박 알림 1건(due_soon) — " + soonN.length);
  ok(overN.length === 1, "③ 마감 초과 알림 1건(due_over) — " + overN.length);
  const mailAfterScan1 = mailCalls.length;
  ok(mailAfterScan1 === mailBeforeScan + 2, "③ 메일도 각 1건(총 +2) — calls " + mailBeforeScan + "→" + mailAfterScan1);

  // 2번째 스캔 — 멱등(중복 알림·중복 메일 0). 뮤테이션 dedupe 는 여기서 거짓이 된다(강제 중복발송).
  await api("o", "GET", "/api/projects/prj_I/requests?_scan_due=1");
  const afterScan2 = await api("d2", "GET", "/api/notifications");
  const soonN2 = (afterScan2.j.data || []).filter((x) => x.kind === "due_soon" && x.note_id === soon.j.id);
  const mailAfterScan2 = mailCalls.length;
  ok(soonN2.length === 1 && mailAfterScan2 === mailAfterScan1,
    "③ 2번째 스캔 — 멱등(중복 알림·중복 메일 0) — soonN=" + soonN2.length + " mail " + mailAfterScan1 + "→" + mailAfterScan2);

  console.log("\n[④ 마크업↔이슈 — 360 사진 위 도형 좌표 + 시점(yaw/pitch) 저장·복원]");
  const shapeView = { image_id: "img1", yaw: 12.5, pitch: -6.25, fov: 70, shape: { id: "shp_abc", type: "circle", lon: 12.5, lat: -6.25, radiusDeg: 3 } };
  const n3 = await api("o", "POST", "/api/notes", { deployment_id: dep, pin_id: "p1", kind: "note", body: "펌프 누유 — 표시 위치", view: shapeView });
  ok(n3.status === 200 && n3.j.pano_view && n3.j.pano_view.image_id === "img1" && n3.j.pano_view.yaw === 12.5, "④ 생성 응답에 pano_view(사진·시점) 저장 — " + JSON.stringify(n3.j.pano_view && { i: n3.j.pano_view.image_id, y: n3.j.pano_view.yaw }));
  ok(n3.j.pano_view && n3.j.pano_view.shape && n3.j.pano_view.shape.type === "circle" && n3.j.pano_view.shape.lon === 12.5 && n3.j.pano_view.shape.id === "shp_abc",
    "④ 도형(원) 좌표·id 저장 — " + JSON.stringify(n3.j.pano_view && n3.j.pano_view.shape));
  const n3Reload = await api("o", "GET", "/api/notes?deployment_id=" + dep + "&pin_id=p1");
  const n3Row = (n3Reload.j.data || []).find((x) => x.id === n3.j.id);
  ok(!!n3Row && n3Row.pano_view && n3Row.pano_view.image_id === "img1", "④ 재조회 시에도 같은 사진·시점 복원");

  const n4 = await api("o", "POST", "/api/notes", { deployment_id: dep, pin_id: "p2", kind: "note", body: "시점만 있는 이슈(도형 없음)", view: { image_id: "img2", yaw: 90, pitch: 0, fov: 75 } });
  ok(n4.status === 200 && n4.j.pano_view && n4.j.pano_view.shape == null && n4.j.pano_view.image_id === "img2", "④ 도형 없이 시점만 있는 이슈도 지원(shape:null, yaw/pitch 는 그대로)");

  const badShape = await api("o", "POST", "/api/notes", { deployment_id: dep, pin_id: "p1", kind: "note", body: "깨진 도형", view: { image_id: "img1", yaw: 1, pitch: 1, shape: { type: "circle" } } });
  ok(badShape.status === 200 && badShape.j.pano_view && badShape.j.pano_view.shape == null && badShape.j.pano_view.yaw === 1, "④ 도형 형식이 깨지면 shape 만 null(시점은 지어내지 않되 보존)");

  console.log("\n[⑤ 메일 키 없음 — 가짜 성공 금지(은폐 0), 앱 내 알림은 그대로 쌓임]");
  {
    const workerOut2 = path.join(os.tmpdir(), "p170-worker-nokey-" + process.pid + ".mjs");
    await esbuild.build({
      stdin: { contents: SRV, resolveDir: path.join(ROOT, "src"), sourcefile: "index.tsx", loader: "tsx" },
      bundle: true, format: "esm", platform: "neutral", outfile: workerOut2, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
      conditions: ["workerd", "worker", "browser"],
    });
    const mf2 = new Miniflare({
      modules: true, scriptPath: workerOut2, d1Databases: { DB: "p170nk-" + Date.now() }, r2Buckets: { R2: "p170nkr2-" + Date.now() },
      bindings: { DEMO_LOGIN: "0" },   // 🔴 RESEND_API_KEY 미설정 — "키 없음" 경로
      compatibilityDate: "2025-01-01",
    });
    const db2 = await mf2.getD1Database("DB");
    try {
      for (const f of MIGS) for (const st of stmtsOf(f)) await db2.exec(st);
      const t0 = Date.now();
      await db2.prepare("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)").bind(U.o, "o", "designssir@gmail.com", t0, t0).run();
      await db2.prepare("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)").bind(U.o, "o", "seastar.test", "x", "y", t0, t0).run();
      await db2.prepare("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)").bind("local-p170-nk", U.o, t0, t0 + 8.64e7).run();
      await db2.prepare("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)").bind(U.d2, "d2", "designssir@gmail.com", t0, t0).run();
      await db2.prepare("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)").bind(U.d2, "d2", "seastar.test", "x", "y", t0, t0).run();
      await db2.prepare("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES ('prj_NK', 'p', '', ?, ?, ?, 0)").bind(U.o, t0, t0).run();
      const api2 = async (method, url, body, token) => {
        const h = { "Content-Type": "application/json", "CF-Connecting-IP": "10.3.0.2", Authorization: "Bearer " + token };
        const r = await mf2.dispatchFetch(BASE + url, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
        let j = null; try { j = await r.json(); } catch {}
        return { status: r.status, j };
      };
      await api2("POST", "/api/projects/prj_NK/members", { email: U.d2, role: "designer" }, "local-p170-nk");
      const pins2 = [{ id: "p1", page: 1, x: 10, y: 10, label: "1" }];
      const dep2 = (await api2("POST", "/tables/deployments", { title: "D2", file_name: "D2.pdf", project_id: "prj_NK", pins: JSON.stringify(pins2), pages_data: JSON.stringify(["/x.png"]), drawing_data: "/x.png" }, "local-p170-nk")).j.id;
      const nNK = await api2("POST", "/api/notes", { deployment_id: dep2, pin_id: "p1", kind: "note", body: "키 없음 테스트", assignee: U.d2 }, "local-p170-nk");
      ok(nNK.status === 200, "⑤ 메일 키 없어도 이슈 생성 자체는 정상(알림이 저장을 막지 않음)");
      const row = await db2.prepare("SELECT mailed_at FROM notifications WHERE note_id = ? AND kind = 'assignee'").bind(nNK.j.id).first();
      ok(!!row && row.mailed_at == null, "⑤ 메일 키 없음 → mailed_at NULL(가짜 성공 금지, 앱 내 알림만 쌓임)");
    } finally {
      await mf2.dispose();
      fs.unlinkSync(workerOut2);
    }
  }
} finally {
  clearTimeout(watchdog);
  await mf.dispose();
  stubSrv.close();
  try { fs.unlinkSync(workerOut); } catch {}
}

console.log(failed ? ("\n총 " + failed + "건 실패") : "\n전체 PASS");
process.exit(failed ? 1 : 0);
