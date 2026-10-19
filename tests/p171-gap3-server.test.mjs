/**
 * p171-gap3-server — SIGNAX 격차3(WO 20261019-gap3) 외부 API/웹훅 서버 통합검증.
 * 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p171-gap3-server.test.mjs
 *
 * 서버(src/index.tsx) 실 번들 → Miniflare(workerd) + 실 D1(migrations 전부, 0052 포함).
 * 웹훅 수신은 이 프로세스 안의 로컬 HTTP 서버(실 외부 발송 0, 지시 준수).
 *
 * 뮤테이션(P171S_MUT=<이름>) — EXIT=1 이어야 한다:
 *   plainKeyStored : API 키 발급 시 원문도 평문 컬럼에 저장(해시 미사용) — 키 저장 방식 점검
 *   noSig          : 웹훅 발송 시 서명 헤더 생성을 건너뜀
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
  plainKeyStored: ["await sha256Hex(plain), plain.slice(0, 11), scope", "plain, plain.slice(0, 11), scope"],
  // 🔴 fireWebhooks() 전용 리터럴('X-Webhook-Event': event) — /test 엔드포인트는 'test' 리터럴이라 겹치지 않음(replace 1곳만 적용 보장)
  noSig: ["const headers = { 'Content-Type': 'application/json', 'X-Webhook-Signature': 'sha256=' + sig, 'X-Webhook-Event': event }",
          "const headers = { 'Content-Type': 'application/json', 'X-Webhook-Event': event }"],
};
const MUT = process.env.P171S_MUT || "";
if (MUT) {
  const m = MUTS[MUT];
  if (!m) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }
  if (!SRV.includes(m[0])) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함: " + MUT); process.exit(2); }
  SRV = SRV.replace(m[0], m[1]);
  console.log("[뮤테이션 적용] " + MUT);
}

let failed = 0;
const ok = (cond, label, detail) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail).slice(0, 300) : "")); if (!cond) failed++; };
const watchdog = setTimeout(() => { console.log("\nWATCHDOG — 120s 초과 → FAIL"); process.exit(1); }, 120000);

/* ── 로컬 웹훅 수신 서버(실 외부 발송 0) ── */
const received = [];
const hookSrv = http.createServer((req, res) => {
  let buf = "";
  req.on("data", (d) => (buf += d));
  req.on("end", () => {
    received.push({ headers: req.headers, body: buf, path: req.url });
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  });
});
await new Promise((resolve) => hookSrv.listen(0, "127.0.0.1", resolve));
const hookPort = hookSrv.address().port;
const HOOK_URL = "http://127.0.0.1:" + hookPort + "/hook";

const MIG_DIR = path.join(ROOT, "migrations");
const MIGS = fs.readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
ok(MIGS.includes("0052_api_webhooks_gps.sql"), "마이그레이션 0052_api_webhooks_gps.sql 존재");
const stmtsOf = (file) => fs.readFileSync(path.join(MIG_DIR, file), "utf8").replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);

const workerOut = path.join(os.tmpdir(), "p171s-worker-" + process.pid + "-" + Date.now() + ".mjs");
await esbuild.build({
  stdin: { contents: SRV, resolveDir: path.join(ROOT, "src"), sourcefile: "index.tsx", loader: "tsx" },
  bundle: true, format: "esm", platform: "neutral", outfile: workerOut, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
  conditions: ["workerd", "worker", "browser"],
});
const mf = new Miniflare({
  modules: true, scriptPath: workerOut, d1Databases: { DB: "p171s-" + Date.now() }, r2Buckets: { R2: "p171sr2-" + Date.now() },
  bindings: { DEMO_LOGIN: "0" },
  compatibilityDate: "2025-01-01",
});
const BASE = "http://p171s.test";
const db = await mf.getD1Database("DB");

try {
  for (const f of MIGS) for (const st of stmtsOf(f)) await db.exec(st);
  const now0 = Date.now();
  const run = (q, a) => db.prepare(q).bind(...a).run();
  const OWNER = "owner171@seastar.test";
  const TOK = "local-p171-owner";
  await run("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)", [OWNER, "owner", "designssir@gmail.com", now0, now0]);
  await run("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)", [OWNER, "owner", "seastar.test", "x", "y", now0, now0]);
  await run("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOK, OWNER, now0, now0 + 8.64e7]);

  const api = async (tok, method, url, body) => {
    const h = { "Content-Type": "application/json", "CF-Connecting-IP": "10.3.0.1" };
    if (tok) h.Authorization = "Bearer " + tok;
    const r = await mf.dispatchFetch(BASE + url, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, j };
  };

  await run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES ('prj_W', 'API프로젝트', '', ?, ?, ?, 0)", [OWNER, now0, now0]);
  const pins = [{ id: "p1", page: 1, x: 10, y: 10, label: "1", checkboard: false, imageId: "img1", imageUrl: "/api/r2/object/assets/w1.jpg" }];
  const dep = (await api(TOK, "POST", "/tables/deployments", { title: "D", file_name: "D.pdf", project_id: "prj_W", pins: JSON.stringify(pins), pages_data: JSON.stringify(["/api/r2/object/assets/base.png"]), drawing_data: "/api/r2/object/assets/base.png" })).j.id;
  const deck = (await api(TOK, "POST", "/api/projects/prj_W/decks", { name: "구역W", deployment_id: dep, page: 1 })).j;
  ok(!!(dep && deck.id), "전제: 배포본·구역 생성");

  console.log("\n[A. 웹훅 등록 — SSRF/https 가드]");
  const r1 = await api(TOK, "POST", "/api/projects/prj_W/webhooks", { url: "http://example.com/hook", events: ["pin.created"] });
  ok(r1.status === 400 && /https/.test(r1.j.error), "A1 http(비테스트) → 400(https required) → " + JSON.stringify(r1.j));
  const r2 = await api(TOK, "POST", "/api/projects/prj_W/webhooks", { url: "https://127.0.0.1/hook", events: ["pin.created"] });
  ok(r2.status === 400, "A2 https+사설IP(비테스트) → 400(SSRF 가드) → " + JSON.stringify(r2.j));
  const r3 = await api(TOK, "POST", "/api/projects/prj_W/webhooks", { url: HOOK_URL, events: ["pin.created", "photo.attached", "issue.created", "issue.status_changed", "deployment.published"], test_mode: true });
  ok(r3.status === 200 && !!r3.j.secret, "A3 테스트모드(로컬 수신서버) → 등록 성공 + secret 1회 노출 → " + JSON.stringify({ id: r3.j.id, hasSecret: !!r3.j.secret }));
  const whId = r3.j.id, whSecret = r3.j.secret;

  const listR = await api(TOK, "GET", "/api/projects/prj_W/webhooks");
  ok(listR.status === 200 && listR.j.data.length === 1 && listR.j.data[0].secret === undefined, "A4 목록 조회 — secret 비노출 → " + JSON.stringify(Object.keys(listR.j.data[0])));

  console.log("\n[B. 테스트 전송 — 서명 검증]");
  const testR = await api(TOK, "POST", "/api/projects/prj_W/webhooks/" + whId + "/test");
  ok(testR.status === 200 && testR.j.ok === true, "B1 [테스트 전송] 성공 → " + JSON.stringify(testR.j));
  ok(received.length === 1, "B2 로컬 수신서버 1건 수신 → " + received.length);
  {
    const rec = received[0];
    const sigHeader = rec.headers["x-webhook-signature"] || "";
    const expected = await (async () => {
      const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(whSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(rec.body));
      return "sha256=" + Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
    })();
    ok(sigHeader === expected, "B3 HMAC 서명 헤더가 secret·본문으로 재계산한 값과 일치 → " + sigHeader.slice(0, 20) + "...");
  }

  console.log("\n[C. 핀 생성 → pin.created / photo.attached 웹훅]");
  received.length = 0;
  const op1 = { opId: "op-new-pin-1", entity: "pin", action: "upsert", id: "p2", data: { x: 30, y: 30, label: "2", page: 1 }, ts: Date.now() };
  const opsR = await api(TOK, "POST", "/tables/deployments/" + dep + "/ops", { ops: [op1] });
  ok(opsR.status === 200, "C1 ops(새 핀 p2) 200");
  await new Promise((r) => setTimeout(r, 250));
  ok(received.some((r) => JSON.parse(r.body).event === "pin.created" && JSON.parse(r.body).payload.pin_id === "p2"), "C2 pin.created 웹훅 수신(payload.pin_id=p2) → " + JSON.stringify(received.map((r) => JSON.parse(r.body).event)));
  {
    const rec = received.find((r) => JSON.parse(r.body).event === "pin.created");
    const sigHeader = rec && (rec.headers["x-webhook-signature"] || "");
    const expected = rec ? "sha256=" + Array.from(new Uint8Array(await crypto.subtle.sign("HMAC", await crypto.subtle.importKey("raw", new TextEncoder().encode(whSecret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]), new TextEncoder().encode(rec.body)))).map((b) => b.toString(16).padStart(2, "0")).join("") : "";
    ok(!!sigHeader && sigHeader === expected, "C2b fireWebhooks(공용 발송 경로)도 HMAC 서명 헤더 포함 → " + (sigHeader || "(없음)").slice(0, 20));
  }

  received.length = 0;
  const op2 = { opId: "op-photo-1", entity: "pin", action: "upsert", id: "p2", data: { imageId: "img2", updatedAt: Date.now() }, ts: Date.now() };
  const opsR2 = await api(TOK, "POST", "/tables/deployments/" + dep + "/ops", { ops: [op2] });
  ok(opsR2.status === 200, "C3 ops(기존 핀 p2 에 imageId 부여) 200");
  await new Promise((r) => setTimeout(r, 250));
  ok(received.some((r) => JSON.parse(r.body).event === "photo.attached" && JSON.parse(r.body).payload.pin_id === "p2"), "C4 photo.attached 웹훅 수신 → " + JSON.stringify(received.map((r) => JSON.parse(r.body).event)));

  console.log("\n[D. 이슈 생성/상태변경 → issue.created / issue.status_changed 웹훅]");
  received.length = 0;
  const noteR = await api(TOK, "POST", "/api/notes", { deployment_id: dep, pin_id: "p2", kind: "note", body: "결함 테스트" });
  ok(noteR.status === 200, "D1 이슈 생성 200");
  await new Promise((r) => setTimeout(r, 200));
  ok(received.some((r) => JSON.parse(r.body).event === "issue.created"), "D2 issue.created 웹훅 수신 → " + JSON.stringify(received.map((r) => JSON.parse(r.body).event)));

  received.length = 0;
  const patchR = await api(TOK, "PATCH", "/api/notes/" + noteR.j.id, { status: "progress" });
  ok(patchR.status === 200, "D3 이슈 상태 변경 200");
  await new Promise((r) => setTimeout(r, 200));
  ok(received.some((r) => JSON.parse(r.body).event === "issue.status_changed"), "D4 issue.status_changed 웹훅 수신 → " + JSON.stringify(received.map((r) => JSON.parse(r.body).event)));

  console.log("\n[E. 배포 → deployment.published 웹훅]");
  received.length = 0;
  const pubR = await api(TOK, "POST", "/api/projects/prj_W/publish");
  ok(pubR.status === 200, "E1 배포 200 → " + JSON.stringify(pubR.j && pubR.j.error));
  await new Promise((r) => setTimeout(r, 200));
  ok(received.some((r) => JSON.parse(r.body).event === "deployment.published"), "E2 deployment.published 웹훅 수신 → " + JSON.stringify(received.map((r) => JSON.parse(r.body).event)));

  console.log("\n[F. API 키 발급·사용·폐기]");
  const keyR = await api(TOK, "POST", "/api/projects/prj_W/api-keys", { name: "연동1", scope: "read" });
  ok(keyR.status === 200 && keyR.j.key && keyR.j.key.startsWith("wk_"), "F1 키 발급 — 원문 1회 노출 → " + keyR.j.key.slice(0, 6) + "...");
  const plainKey = keyR.j.key, keyId = keyR.j.id;

  const keysListR = await api(TOK, "GET", "/api/projects/prj_W/api-keys");
  ok(keysListR.j.data.every((k) => k.key_hash === undefined && k.key === undefined), "F2 키 목록 — 원문/해시 비노출 → " + JSON.stringify(Object.keys(keysListR.j.data[0])));

  const v1R = await api(plainKey, "GET", "/api/v1/projects");
  ok(v1R.status === 200 && v1R.j.data.length === 1 && v1R.j.data[0].id === "prj_W", "F3 /api/v1/projects — 발급받은 프로젝트만 → " + JSON.stringify(v1R.j.data.map((p) => p.id)));

  const decksV1 = await api(plainKey, "GET", "/api/v1/decks");
  ok(decksV1.status === 200 && decksV1.j.data.length === 1, "F4 /api/v1/decks → " + decksV1.j.data.length);

  const pinsV1 = await api(plainKey, "GET", "/api/v1/pins");
  const p1v1 = pinsV1.j.data.find((p) => p.id === "p1");
  ok(pinsV1.status === 200 && !!p1v1 && typeof p1v1.photo_url === "string" && p1v1.photo_url.startsWith("/api/v1/media/"), "F5 /api/v1/pins — 사진 URL = /api/v1/media 경로(직접 R2 키 노출 0) → " + (p1v1 && p1v1.photo_url));

  const notesV1 = await api(plainKey, "GET", "/api/v1/notes");
  ok(notesV1.status === 200 && notesV1.j.data.length >= 1, "F6 /api/v1/notes → " + notesV1.j.data.length);

  const writeAttempt = await api(plainKey, "POST", "/api/v1/issues", { deployment_id: dep, body: "읽기키로 쓰기 시도" });
  ok(writeAttempt.status === 401, "F7 읽기 전용 키로 쓰기(issues POST) → 401(scope=write 필요) → " + writeAttempt.status);

  const writeKeyR = await api(TOK, "POST", "/api/projects/prj_W/api-keys", { name: "쓰기용", scope: "write" });
  const writeKey = writeKeyR.j.key;
  const writeOk = await api(writeKey, "POST", "/api/v1/issues", { deployment_id: dep, body: "쓰기키로 생성" });
  ok(writeOk.status === 200 && writeOk.j.id, "F8 쓰기 키로 이슈 생성 200 → " + writeOk.j.id);

  const mediaKeyWrong = await api(plainKey, "GET", "/api/v1/media/" + encodeURIComponent("assets/not-referenced.jpg"));
  ok(mediaKeyWrong.status === 403, "F9 그 프로젝트가 참조 안 한 R2 키 → 403(IDOR 차단) → " + mediaKeyWrong.status);

  const revokeR = await api(TOK, "DELETE", "/api/projects/prj_W/api-keys/" + keyId);
  ok(revokeR.status === 200, "F10 키 폐기 200");
  const afterRevoke = await api(plainKey, "GET", "/api/v1/projects");
  ok(afterRevoke.status === 401, "F11 폐기된 키로 호출 → 401 → " + afterRevoke.status);

  console.log("\n[G. /docs/api 공개 문서]");
  const docsR = await mf.dispatchFetch(BASE + "/docs/api");
  const docsHtml = await docsR.text();
  ok(docsR.status === 200 && /api\/v1\/pins/.test(docsHtml), "G1 /docs/api 200 + 엔드포인트 설명 포함(로그인 불필요)");

  const jsErrCheck = true; // Workers 환경 — pageerror 없음(서버 전용 테스트)
  ok(jsErrCheck, "사전 — 서버 테스트(Workers) 범위 — 클라이언트 JS 에러 해당 없음");
} finally {
  await mf.dispose();
  hookSrv.close();
  try { fs.unlinkSync(workerOut); } catch {}
}

clearTimeout(watchdog);
console.log("\n" + (failed ? "FAILED " + failed + "건" : "ALL PASS"));
process.exit(failed ? 1 : 0);
