/**
 * p126 — [WO 20261007-aivision] 360 사진 AI 분석 서버 — 스키마 검증·권한·캐시·일일 상한·키 없음·클라 URL 무시
 * 프레임워크 0 · 실행: node tests/p126-ai-vision.test.mjs
 *
 * [재현: 해당없음 — 신규 기능] 지휘자 R1: `git grep -n -i -E 'ai/analyze|vision' HEAD -- src/index.tsx public/js/modules | wc -l` → 1(무관).
 *
 * L = src/lib/aiVision.ts 순수 함수 — fetch 스텁(OpenRouter 외부 호출만 대체, 로직은 실 소스).
 * S = 서버 src/index.tsx 실 번들 → Miniflare(workerd) + 실 D1(migrations 전부, 0037 포함) + 실 R2.
 *     🔴 업스트림(OpenRouter)만 기록 응답(fixture) HTTP 서버로 대체한다 — 실제 과금 호출 금지(발주서 §검증).
 *     AI_VISION_BASE_URL 바인딩이 그 fixture 서버를 가리킨다(운영은 미설정 = openrouter.ai).
 * 뮤테이션: P126_MUT=<이름> → 소스를 바꿔 실행 → EXIT=1 이어야 한다(대상 문자열 못 찾으면 EXIT=2).
 */
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { Miniflare } from "miniflare";
import { listenSafePort } from "./_lib/safe-listen.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
let SRV = rd("src/index.tsx");
let LIB = rd("src/lib/aiVision.ts");

const MUTS = {
  // 서버
  "perm-gate": ["S", "  const user = await requireDesigner(c)\n  if (!user) return c.json({ error: 'forbidden — designer login required' }, 403)\n  const reason = visionDisabledReason(c)",
    "  const user = await getUser(c)\n  if (!user) return c.json({ error: 'forbidden — designer login required' }, 403)\n  const reason = visionDisabledReason(c)"],
  "project-gate": ["S", "    const denied = await deploymentWriteDenied(c, user, dep.project_id)\n    if (denied) return c.json({ error: denied.error }, denied.status)\n  }\n  let pins: any[] = []",
    "  }\n  let pins: any[] = []"],
  "cache-off": ["S", "  if (hit && hit.result) {", "  if (false) {"],
  "limit-off": ["S", "  if (used >= AI_VISION_DAILY_LIMIT) {", "  if (false) {"],
  "client-url": ["S", "  const img = await loadVisionImage(c, cur)", "  const img = (body.image_url ? { ok: true, dataUrl: String(body.image_url), bytes: 0 } : await loadVisionImage(c, cur))"],
  "nokey-open": ["S", "  if (!c.env || !c.env.OPENROUTER_API_KEY) return 'AI 키 미설정", "  if (false) return 'AI 키 미설정"],
  "image-owner": ["S", "  if (!cur) return c.json({ error: 'image_id 가 이 포인트의 사진(현재/이력)이 아닙니다' }, 400)", "  if (!cur) return c.json({ error: 'x' }, 200)"],
  // 라이브러리
  "schema-enum": ["L", "if (!(VISION_KINDS as readonly string[]).includes(it.kind)) return", "if (false) return"],
  "schema-summary": ["L", "if (typeof raw.summary !== 'string' || !raw.summary.trim()) return", "if (false) return"],
  "refs-external": ["L", "const m = url.match(/^\\/api\\/r2\\/object\\/([^?#]+)/)", "const m = url.match(/^(?:\\/api\\/r2\\/object\\/|https?:\\/\\/)(.+)/)"],
};
const MUT = process.env.P126_MUT || "";
if (MUT) {
  const m = MUTS[MUT];
  if (!m) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }
  const target = m[0] === "S" ? SRV : LIB;
  if (!target.includes(m[1])) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함: " + MUT); process.exit(2); }
  if (m[0] === "S") SRV = SRV.replace(m[1], m[2]); else LIB = LIB.replace(m[1], m[2]);
  console.log("[뮤테이션 적용] " + MUT);
}

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };
const watchdog = setTimeout(() => { console.log("\nWATCHDOG — 180s 초과 → FAIL"); process.exit(1); }, 180000);

/* 뮤테이션으로 바뀐 lib 를 서버 번들에도 반영 — esbuild 플러그인으로 ./lib/aiVision 해석을 가로챈다 */
const libPlugin = {
  name: "p126-lib",
  setup(b) {
    b.onResolve({ filter: /\/lib\/aiVision$/ }, () => ({ path: "p126-aivision", namespace: "p126" }));
    b.onLoad({ filter: /.*/, namespace: "p126" }, () => ({ contents: LIB, loader: "ts", resolveDir: path.join(ROOT, "src/lib") }));
  },
};

const PNG1 = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";
const GOOD = {
  summary: "기관실 통로. 좌측에 펌프 2기, 우측 배관 플랜지에 녹 흔적.",
  items: [
    { kind: "equipment", label: "FW PUMP", confidence: 0.92, yaw: 80, pitch: -5 },
    { kind: "defect", label: "플랜지 부식", confidence: 0.55, yaw: 250, pitch: -12 },
    { kind: "hazard", label: "바닥 기름", confidence: 0.8, yaw: null, pitch: null },
  ],
  change_summary: null,
  defect_suggestion: { title: "배관 플랜지 부식", detail: "우측 플랜지 볼트 주변 녹 — 확인 필요", severity: "mid", confidence: 0.6 },
};
const completion = (obj, extra) => ({ id: "gen-x", model: "anthropic/claude-sonnet-5.5", choices: [{ message: { role: "assistant", content: JSON.stringify(obj) } }],
  usage: { prompt_tokens: 1700, completion_tokens: 260, cost: 0.0062, ...(extra || {}) } });

/* ══ ① src/lib/aiVision.ts — 순수 ══ */
console.log("\n[① src/lib/aiVision.ts — 스키마 검증·파싱·이미지 참조·호출 어댑터(fetch 스텁)]");
{
  const out = path.join(os.tmpdir(), "p126-lib-" + process.pid + ".mjs");
  await esbuild.build({ stdin: { contents: LIB, resolveDir: path.join(ROOT, "src/lib"), sourcefile: "aiVision.ts", loader: "ts" }, bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" });
  const L = await import(pathToFileURL(out).href);
  ok(L.AI_VISION_MODEL_DEFAULT === "anthropic/claude-sonnet-5.5", "① 모델 ID SoT = anthropic/claude-sonnet-5.5(OpenRouter /models 라이브 확인값)");
  ok(L.visionModelOf({ AI_VISION_MODEL: " x/y " }) === "x/y" && L.visionModelOf({}) === L.AI_VISION_MODEL_DEFAULT, "① AI_VISION_MODEL 시크릿으로 덮어쓰기, 없으면 기본값");

  const v = L.validateVisionResult(GOOD);
  ok(v.ok && v.value.items.length === 3 && v.value.items[2].yaw === undefined && v.value.defect_suggestion.severity === "mid" && !("change_summary" in v.value), "① 정상 응답 통과(yaw/pitch null → 미기재, change_summary null → 생략)");
  ok(!L.validateVisionResult({ items: [] }).ok && L.validateVisionResult({ items: [] }).error === "summary-missing", "① 필드 누락(summary) → ok:false");
  ok(!L.validateVisionResult({ summary: "x" }).ok, "① 필드 누락(items) → ok:false");
  const badKind = L.validateVisionResult({ summary: "x", items: [{ kind: "banana", label: "a", confidence: 0.5 }] });
  ok(!badKind.ok && badKind.error === "item[0]-kind", "① 잘못된 enum(kind=banana) → ok:false");
  ok(!L.validateVisionResult({ summary: "x", items: [], defect_suggestion: { title: "t", detail: "d", severity: "critical", confidence: 0.9 } }).ok, "① 잘못된 enum(severity=critical) → ok:false");
  ok(!L.validateVisionResult({ summary: "x", items: [{ kind: "other", label: "a", confidence: 1.5 }] }).ok, "① confidence 범위 밖 → ok:false");
  ok(!L.validateVisionResult({ summary: "x", items: [{ kind: "other", label: "a", confidence: 0.5, yaw: 10 }] }).ok, "① yaw 만 있고 pitch 없음 → ok:false");
  ok(!L.validateVisionResult({ summary: "x", items: [{ kind: "other", label: "a", confidence: 0.5, yaw: 400, pitch: 0 }] }).ok, "① yaw 범위 밖 → ok:false");
  const long = L.validateVisionResult({ summary: "s".repeat(5000), items: [{ kind: "other", label: "l".repeat(500), confidence: 0.5 }] });
  ok(long.ok && long.value.summary.length === 2000 && long.value.items[0].label.length === 120, "① 문자열 길이 상한(summary 2000 · label 120) — 모델 출력은 데이터로만");
  ok(L.parseModelJson("```json\n{\"a\":1}\n```").a === 1 && L.parseModelJson([{ type: "text", text: "{\"b\":2}" }]).b === 2 && L.parseModelJson("nope") === null, "① parseModelJson — 펜스·parts 배열·실패 null");

  const refs = L.pinImageRefs({ imageId: "img9", timeline: [{ imageId: "img7", shotAt: 1 }, { imageUrl: "/api/r2/object/assets/a.jpg?t=tok", at: 2 }, { imageUrl: "https://evil.example/x.jpg" }] });
  ok(refs.length === 3 && refs[0].ref === "img:img9" && refs[0].current && refs[1].ref === "r2:assets/a.jpg" && refs[2].ref === "img:img7", "① pinImageRefs — 현재 + 이력(최근순), R2 키 추출(?t= 제거), 외부 URL 제외(SSRF)");
  ok(L.pinImageRefs({ imageUrl: "https://cdn.example/p.jpg" }).length === 0, "① 외부 URL 만 있는 핀 → 참조 0(서버가 읽지 않음)");
  ok(L.visionCacheKey("img:a", null, "m") === "m|img:a|" && L.visionCacheKey("img:a", "img:b", "m") !== L.visionCacheKey("img:a", null, "m"), "① 캐시 키 = 모델|현재|비교");

  // 호출 어댑터 — fetch 스텁
  let calls = [];
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  const stub = (fn) => { calls = []; return async (url, init) => { calls.push({ url, init }); return fn(url, init, calls.length); }; };
  const noKey = await L.askVision({}, { imageDataUrl: PNG1 }, stub(() => json(200, completion(GOOD))));
  ok(!noKey.ok && noKey.error === "no-key" && calls.length === 0, "① 키 없음 → no-key(호출 0)");
  const good = await L.askVision({ OPENROUTER_API_KEY: "k" }, { imageDataUrl: PNG1, compareDataUrl: PNG1, pinLabel: "P1" }, stub(() => json(200, completion(GOOD))));
  ok(good.ok && good.usage.cost_usd === 0.0062 && good.usage.prompt_tokens === 1700 && good.value.items.length === 3, "① 200 fixture → ok + usage(토큰·비용 그대로)");
  const sent = JSON.parse(calls[0].init.body);
  ok(sent.model === L.AI_VISION_MODEL_DEFAULT && sent.response_format && sent.response_format.type === "json_schema" && sent.response_format.json_schema.strict === true, "① 요청: 모델 ID + response_format json_schema(strict)");
  ok(sent.messages[1].content.filter((p) => p.type === "image_url").length === 2 && sent.usage && sent.usage.include === true, "① 요청: 이미지 2장(현재+비교) + usage.include");
  ok(calls[0].url.startsWith("https://openrouter.ai/api/v1/") && calls[0].init.headers.Authorization === "Bearer k", "① 기본 업스트림 = openrouter.ai, 키는 헤더에만");
  const bad = await L.askVision({ OPENROUTER_API_KEY: "k" }, { imageDataUrl: PNG1 }, stub(() => json(200, completion({ summary: "x", items: [{ kind: "banana", label: "a", confidence: 0.5 }] }))));
  ok(!bad.ok && bad.error === "schema:item[0]-kind", "① 스키마 불합격 응답 → ok:false(schema:…) — 지어내지 않음");
  const h429 = await L.askVision({ OPENROUTER_API_KEY: "k" }, { imageDataUrl: PNG1 }, stub(() => json(429, { error: "rate" })));
  ok(!h429.ok && h429.error === "http-429" && h429.status === 429, "① 업스트림 429 → http-429(값으로)");
  const nojson = await L.askVision({ OPENROUTER_API_KEY: "k" }, { imageDataUrl: PNG1 }, stub(() => json(200, { choices: [{ message: { content: "그냥 산문" } }] })));
  ok(!nojson.ok && nojson.error === "no-json-content", "① JSON 아닌 본문 → no-json-content");
  const nocost = await L.askVision({ OPENROUTER_API_KEY: "k" }, { imageDataUrl: PNG1 }, stub(() => json(200, { choices: [{ message: { content: JSON.stringify(GOOD) } }] })));
  ok(nocost.ok && nocost.usage.cost_usd === null && nocost.usage.prompt_tokens === null, "① usage 없으면 null(비용 지어내지 않음)");
}

/* ══ ② 서버 — Miniflare + 실 D1(0037) + 실 R2 + fixture 업스트림 ══ */
console.log("\n[② 서버 /api/ai/analyze-photo — Miniflare + 실 D1 + fixture 업스트림(실 과금 호출 0)]");
const MIG_DIR = path.join(ROOT, "migrations");
const MIGS = fs.readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
ok(MIGS.includes("0037_ai_vision.sql"), "② 마이그레이션 0037_ai_vision.sql 존재");
const stmtsOf = (file) => fs.readFileSync(path.join(MIG_DIR, file), "utf8").replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
const workerOut = path.join(os.tmpdir(), "p126-worker-" + process.pid + ".mjs");
await esbuild.build({
  stdin: { contents: SRV, resolveDir: path.join(ROOT, "src"), sourcefile: "index.tsx", loader: "tsx" },
  bundle: true, format: "esm", platform: "neutral", outfile: workerOut, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
  conditions: ["workerd", "worker", "browser"], plugins: [libPlugin],
});

// fixture 업스트림 — 요청 본문을 기록하고 지정된 응답을 돌려준다(과금 0)
const upstream = { calls: [], reply: () => completion(GOOD) };
const fx = http.createServer((req, res) => {
  let buf = "";
  req.on("data", (d) => { buf += d; });
  req.on("end", () => {
    let body = null; try { body = JSON.parse(buf); } catch {}
    upstream.calls.push({ url: req.url, auth: req.headers.authorization || "", body });
    const r = upstream.reply(body);
    res.writeHead(r.status || 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(r.status ? r.body : r));
  });
});
await listenSafePort(fx, "127.0.0.1");
const FX_BASE = "http://127.0.0.1:" + fx.address().port + "/v1";
const FAKE_KEY = "sk-or-p126-fake-" + Date.now();

const mkMf = (bindings) => new Miniflare({
  modules: true, scriptPath: workerOut, d1Databases: { DB: "p126-" + Date.now() + Math.random().toString(36).slice(2) }, r2Buckets: { R2: "p126r2-" + Date.now() },
  bindings: { DEMO_LOGIN: "0", ...bindings }, compatibilityDate: "2025-01-01",
});
const mf = mkMf({ OPENROUTER_API_KEY: FAKE_KEY, AI_VISION_BASE_URL: FX_BASE });
const mfNoKey = mkMf({});
const BASE = "http://p126.test";
try {
  const db = await mf.getD1Database("DB");
  for (const f of MIGS) for (const st of stmtsOf(f)) await db.exec(st);
  const now0 = Date.now();
  const run = (q, a) => db.prepare(q).bind(...a).run();
  const U = { o: "own126@seastar.test", d: "dsg126@seastar.test", v: "viewer126@seastar.test", x: "other-designer126@seastar.test", w: "owner-nodesigner126@seastar.test" };
  const TOK = {};
  const addUser = async (dbx, k, designer) => {
    const r2 = (q, a) => dbx.prepare(q).bind(...a).run();
    if (designer) await r2("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 0)", [U[k], k, "designssir@gmail.com", now0, now0]);
    await r2("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, ?, ?, ?, 1, ?, ?, 0)", [U[k], "이름" + k, U[k].split("@")[1], "x", "y", now0, now0]);
    TOK[k] = "local-p126-" + k;
    await r2("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)", [TOK[k], U[k], now0, now0 + 8.64e7]);
  };
  await addUser(db, "o", true);
  await addUser(db, "d", true);   // 프로젝트 멤버(designer)
  await addUser(db, "x", true);   // 전역 디자이너지만 이 프로젝트 멤버 아님
  await addUser(db, "v", false);  // 열람자
  const api = async (inst, who, method, url, body) => {
    const h = { "Content-Type": "application/json", "CF-Connecting-IP": "10.3.0.1" };
    const t = who && (TOK[who] || who);
    if (t) h.Authorization = "Bearer " + t;
    const r = await inst.dispatchFetch(BASE + url, { method, headers: h, body: body == null ? undefined : JSON.stringify(body) });
    let j = null; try { j = await r.json(); } catch {}
    return { status: r.status, j };
  };
  const A = (who, method, url, body) => api(mf, who, method, url, body);

  await run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES ('prj_V', 'AI 프로젝트', '', ?, ?, ?, 0)", [U.o, now0, now0]);
  await A("o", "POST", "/api/projects/prj_V/members", { email: U.d, role: "designer" });
  // pano_images 2건(현재 img_cur · 이력 img_old) — D1 축소본(data URL)
  for (const id of ["img_cur", "img_old", "img_lim"]) {
    await run("INSERT INTO pano_images (id, name, image_data, width, height, created_at, updated_at, deleted, tenant_id) VALUES (?, ?, ?, 1, 1, ?, ?, 0, 'tnt_default')", [id, id, PNG1, now0, now0]);
  }
  // R2 원본(핀 p2 는 imageUrl 로만 참조) + 4MB 초과(핀 p3)
  const r2 = await mf.getR2Bucket("R2");
  await r2.put("assets/p126-small.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xd9]), { httpMetadata: { contentType: "image/jpeg" } });
  await r2.put("assets/p126-big.jpg", new Uint8Array(4 * 1024 * 1024 + 1), { httpMetadata: { contentType: "image/jpeg" } });
  const pins = [
    { id: "p1", page: 1, x: 10, y: 10, label: "기관실 P1", imageId: "img_cur", timeline: [{ id: "tl1", imageId: "img_old", shotAt: now0 - 1e6 }] },
    { id: "p2", page: 1, x: 20, y: 10, label: "P2", imageUrl: "/api/r2/object/assets/p126-small.jpg?t=abc" },
    { id: "p3", page: 1, x: 30, y: 10, label: "P3", imageUrl: "/api/r2/object/assets/p126-big.jpg" },
    { id: "p4", page: 1, x: 40, y: 10, label: "P4", imageUrl: "https://evil.example/not-ours.jpg" },
    { id: "p5", page: 1, x: 50, y: 10, label: "P5" },
    { id: "p6", page: 1, x: 60, y: 10, label: "P6", imageId: "img_lim" },
  ];
  const dep = (await A("o", "POST", "/tables/deployments", { title: "V", file_name: "V.pdf", project_id: "prj_V", pins: JSON.stringify(pins), pages_data: "[]", drawing_data: "" })).j.id;
  ok(!!dep, "② 전제: 배포본 생성");

  // 상태 조회
  const stV = await A("v", "GET", "/api/ai/vision-status");
  ok(stV.status === 200 && stV.j.enabled === true && stV.j.model === "anthropic/claude-sonnet-5.5" && stV.j.daily_limit === 30 && stV.j.used === 0, "② vision-status(키 있음) → enabled:true, 모델·상한·사용량, 키 미반환 — " + JSON.stringify(stV.j).slice(0, 120));
  ok(!JSON.stringify(stV.j).includes(FAKE_KEY), "② 상태 응답에 키 값 없음");
  const stNone = await A(null, "GET", "/api/ai/vision-status");
  ok(stNone.status === 401, "② 비로그인 상태 조회 → 401");

  // 권한
  const vr = await A("v", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p1" });
  ok(vr.status === 403 && upstream.calls.length === 0, "② 열람자 → 403(업스트림 0) — " + vr.status);
  const xr = await A("x", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p1" });
  ok(xr.status === 403 && upstream.calls.length === 0, "② 프로젝트 멤버 아닌 디자이너 → 403(deploymentWriteDenied 공유 게이트) — " + xr.status);
  // 디자이너 아닌 소유자(designers 미등록) — 프로젝트 게이트는 통과하지만 requireDesigner 가 막아야 한다
  await addUser(db, "w", false);
  await run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES ('prj_W', '소유자만', '', ?, ?, ?, 0)", [U.w, now0, now0]);
  await run("INSERT INTO deployments (id, title, file_name, drawing_data, pages_data, pins, created_at, updated_at, deleted, project_id, tenant_id) VALUES ('dep_W', 'W', 'W.pdf', '', '[]', ?, ?, ?, 0, 'prj_W', 'tnt_default')",
    [JSON.stringify([{ id: "w1", page: 1, x: 1, y: 1, label: "W1", imageId: "img_cur" }]), now0, now0]);
  const wr = await A("w", "POST", "/api/ai/analyze-photo", { deployment_id: "dep_W", pin_id: "w1" });
  ok(wr.status === 403 && upstream.calls.length === 0, "② 디자이너 권한 없는 소유자 → 403(requireDesigner — 디자이너 이상만) — " + wr.status);

  // 디자이너 200 — 클라가 보낸 image_url 은 무시(서버가 D1 에서 읽은 data URL 만 업스트림으로)
  const r1 = await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p1", image_url: "https://evil.example/injected.jpg", image: "data:image/png;base64,AAAA" });
  ok(r1.status === 200 && r1.j.ok === true && r1.j.cached === false && r1.j.result && r1.j.result.items.length === 3, "② 디자이너 → 200 + 구조화 결과(items 3) — " + r1.status);
  ok(upstream.calls.length === 1 && upstream.calls[0].auth === "Bearer " + FAKE_KEY && upstream.calls[0].url.endsWith("/chat/completions"), "② 업스트림 1회, 키는 서버→업스트림 헤더로만");
  const sentImgs = (upstream.calls[0].body.messages[1].content || []).filter((p) => p.type === "image_url").map((p) => p.image_url.url);
  ok(sentImgs.length === 1 && sentImgs[0] === PNG1, "② 🔴 업스트림이 받은 이미지 = 서버가 D1 에서 읽은 것(클라 image_url/image 필드 무시)");
  ok(!JSON.stringify(upstream.calls[0].body).includes("evil.example"), "② 클라가 보낸 URL 이 업스트림 요청 어디에도 없음");
  ok(r1.j.usage && r1.j.usage.cost_usd === 0.0062 && r1.j.usage.prompt_tokens === 1700 && r1.j.model === "anthropic/claude-sonnet-5.5", "② 응답에 토큰·비용(fixture 값) + 모델");
  ok(!JSON.stringify(r1.j).includes(FAKE_KEY) && !JSON.stringify(r1.j).includes("data:image"), "② 응답에 키·이미지 데이터 없음");
  ok(r1.j.estimate_p === 0.7 && r1.j.result.defect_suggestion && r1.j.result.defect_suggestion.severity === "mid", "② 「추정」 기준(0.7) + 결함 제안 동봉(서버는 등록하지 않음)");
  const noteCnt = await db.prepare("SELECT COUNT(*) AS n FROM pin_notes").first();
  ok(Number(noteCnt.n) === 0, "② 🔴 AI 가 결함 노트를 자동 등록하지 않음(pin_notes 0)");

  // 캐시 적중 — 업스트림 0회
  const r1b = await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p1" });
  ok(r1b.status === 200 && r1b.j.cached === true && upstream.calls.length === 1, "② 같은 사진 재요청 → cached:true, 업스트림 여전히 1회");
  const r1c = await A("o", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p1", image_id: "img_cur" });
  ok(r1c.status === 200 && r1c.j.cached === true && upstream.calls.length === 1, "② 다른 사용자(소유자)도 같은 사진 → 캐시 적중(업스트림 1회 유지)");

  // 비교(이전 사진) — 다른 캐시 키 → 업스트림 2회, 이미지 2장
  upstream.reply = () => completion({ ...GOOD, change_summary: "좌측 펌프 커버가 새로 설치됨" });
  const r2c = await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p1", compare_image_id: "img_old" });
  ok(r2c.status === 200 && r2c.j.cached === false && r2c.j.compare === true && r2c.j.result.change_summary === "좌측 펌프 커버가 새로 설치됨", "② compare_image_id(이력) → 변화 요약 동봉 — " + r2c.status);
  const sent2 = (upstream.calls[1].body.messages[1].content || []).filter((p) => p.type === "image_url").length;
  ok(upstream.calls.length === 2 && sent2 === 2, "② 비교 요청은 이미지 2장(현재+이전) 전송, 업스트림 2회");

  // 식별자 검증 — 이 핀 사진이 아닌 id
  const badImg = await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p1", image_id: "img_lim" });
  ok(badImg.status === 400 && upstream.calls.length === 2, "② 다른 핀의 image_id → 400(업스트림 0)");
  const badCmp = await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p1", compare_image_id: "nope" });
  ok(badCmp.status === 400, "② 핀 소유 아닌 compare_image_id → 400");
  ok((await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "zzz" })).status === 404, "② 없는 핀 → 404");
  ok((await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: "nope", pin_id: "p1" })).status === 404, "② 없는 배포본 → 404");
  ok((await A("d", "POST", "/api/ai/analyze-photo", { pin_id: "p1" })).status === 400, "② deployment_id 누락 → 400");

  // R2 경로 — 핀 imageUrl(/api/r2/object/<key>) → 서버가 R2 직접 읽음
  upstream.reply = () => completion(GOOD);
  const rr2 = await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p2" });
  const sent3 = (upstream.calls[2] && upstream.calls[2].body.messages[1].content || []).filter((p) => p.type === "image_url").map((p) => p.image_url.url);
  ok(rr2.status === 200 && upstream.calls.length === 3 && sent3.length === 1 && sent3[0].startsWith("data:image/jpeg;base64,"), "② R2 원본(imageUrl 키) → 서버가 R2 에서 읽어 data URL 로 전송 — " + rr2.status);
  const rr3 = await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p3" });
  ok(rr3.status === 413 && rr3.j.code === "image-too-large" && upstream.calls.length === 3, "② 4MB 초과 원본 → 413 정직한 오류(업스트림 0) — " + rr3.status);
  const rr4 = await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p4" });
  ok(rr4.status === 400 && upstream.calls.length === 3, "② 외부 URL 만 있는 핀 → 400(서버는 외부 URL 을 가져오지 않음, SSRF 차단)");
  ok((await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p5" })).status === 400, "② 사진 없는 핀 → 400");

  // 스키마 불합격 업스트림 → 502 + error 행 기록(캐시 아님)
  upstream.reply = () => completion({ summary: "x", items: [{ kind: "banana", label: "a", confidence: 0.5 }] });
  const bad = await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p6" });
  ok(bad.status === 502 && String(bad.j.code).startsWith("schema:") && bad.j.enabled === true, "② 스키마 불합격 응답 → 502(code schema:…) 지어내지 않음 — " + bad.status);
  const errRow = await db.prepare("SELECT status, error FROM ai_vision_results WHERE pin_id = 'p6'").first();
  ok(errRow && errRow.status === "error" && String(errRow.error).startsWith("schema:"), "② 실패도 기록(status=error) — 재시도 폭주 상한에 포함");
  upstream.reply = () => completion(GOOD);
  const again = await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p6" });
  ok(again.status === 200 && again.j.cached === false && upstream.calls.length === 5, "② 실패 행은 캐시로 쓰이지 않음 → 재요청 시 업스트림 재호출(200)");

  // 감사 로그
  const logs = await db.prepare("SELECT action, actor_email, detail FROM activity_log WHERE action = 'ai.vision' ORDER BY ts").all();
  const lrows = logs.results || [];
  const d0 = JSON.parse(lrows[0].detail);
  ok(lrows.length >= 6 && d0.cost_usd === 0.0062 && d0.prompt_tokens === 1700 && d0.cached === false && lrows[0].actor_email === U.d, "② activity_log 'ai.vision' — 토큰·비용·캐시 여부 기록(" + lrows.length + "건)");
  ok(!lrows.some((r) => String(r.detail).includes(FAKE_KEY) || String(r.detail).includes("data:image")), "② 로그에 키·이미지 데이터 없음");

  // 일일 상한 — 사용자 d 의 최근 24h 행을 30개로 채운 뒤 새 사진 요청 → 429
  const usedNow = await db.prepare("SELECT COUNT(*) AS n FROM ai_vision_results WHERE created_by = ?").bind(U.d).first();
  for (let i = Number(usedNow.n); i < 30; i++) {
    await run("INSERT INTO ai_vision_results (id, cache_key, image_ref, model, status, error, created_by, created_at) VALUES (?, ?, 'img:fill', 'm', 'error', 'fill', ?, ?)", ["fill" + i, "m|img:fill" + i + "|", U.d, now0]);
  }
  const st2 = await A("d", "GET", "/api/ai/vision-status");
  ok(st2.j.used === 30 && st2.j.remaining === 0, "② vision-status used=30 remaining=0 — " + JSON.stringify({ used: st2.j.used, remaining: st2.j.remaining }));
  await run("UPDATE deployments SET pins = ? WHERE id = ?", [JSON.stringify(pins.concat([{ id: "p7", page: 1, x: 70, y: 10, label: "P7", imageId: "img_old" }])), dep]);
  const lim = await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p7" });
  ok(lim.status === 429 && lim.j.limit === 30 && upstream.calls.length === 5, "② 일일 상한 초과 → 429 + 사유(업스트림 0) — " + lim.status + " " + (lim.j && lim.j.error));
  const limCached = await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p1" });
  ok(limCached.status === 200 && limCached.j.cached === true, "② 상한 초과여도 캐시 적중은 200(비용 0)");
  const other = await A("o", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p7" });
  ok(other.status === 200 && upstream.calls.length === 6, "② 상한은 사용자별 — 다른 사용자는 정상 호출");

  // 키 없음 — 비활성 + 사유, 분석 503
  const db2 = await mfNoKey.getD1Database("DB");
  for (const f of MIGS) for (const st of stmtsOf(f)) await db2.exec(st);
  await addUser(db2, "o", true);
  const stN = await api(mfNoKey, "o", "GET", "/api/ai/vision-status");
  ok(stN.status === 200 && stN.j.enabled === false && /OPENROUTER_API_KEY/.test(stN.j.reason || ""), "② 키 없음 → enabled:false + 사유(시크릿 이름) — " + (stN.j && stN.j.reason));
  const anN = await api(mfNoKey, "o", "POST", "/api/ai/analyze-photo", { deployment_id: "x", pin_id: "p1" });
  ok(anN.status === 503 && anN.j.enabled === false && upstream.calls.length === 6, "② 키 없음 분석 → 503(조용한 실패 금지, 업스트림 0) — " + anN.status);
} finally {
  clearTimeout(watchdog);
  await mf.dispose().catch(() => {});
  await mfNoKey.dispose().catch(() => {});
  fx.close();
  try { fs.unlinkSync(workerOut); } catch {}
}

console.log(failed ? `\n${failed} FAIL` : "\nALL PASS");
process.exit(failed ? 1 : 0);
