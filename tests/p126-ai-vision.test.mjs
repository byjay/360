/**
 * p126 — [WO 20261007-aivision · 무료 전환] 360 사진 AI 분석 서버 — Workers AI 무료 할당량만(유료 폴백 0)
 *        스키마 검증·권한·캐시·사용자 일일 상한·전체 무료 할당(Neurons) 소진 시 비활성·바인딩 없음·허용 목록 밖 모델 비활성·클라 URL 무시
 * 프레임워크 0 · 실행: node tests/p126-ai-vision.test.mjs
 *
 * [재현] 지휘자 R1(2026-10-07, 869ba0e): `git show HEAD:src/lib/aiVision.ts | grep -n -i -E "claude|openrouter|model"` → 유료 모델
 *   anthropic/claude-sonnet-5.5 ($2/M in · $10/M out) → FAIL(마스터 "돈 안 드는 걸로").
 *
 * L = src/lib/aiVision.ts 순수 함수 — runner 주입(Workers AI 바인딩 대체). 🔴 정적 가드: 소스에 유료 제공자·인증 헤더·전역 fetch( 가 없어야 한다.
 * S = 서버 src/index.tsx 실 번들 → Miniflare(workerd) + 실 D1(migrations 전부, 0037·0038 포함) + 실 R2.
 *     🔴 Workers AI 바인딩(env.AI)은 Miniflare serviceBindings 의 fixture 로 대체한다(실 호출 0, 과금 0).
 * 뮤테이션: P126_MUT=<이름> → 소스를 바꿔 실행 → EXIT=1 이어야 한다(대상 문자열 못 찾으면 EXIT=2).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";
import { Miniflare } from "miniflare";

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
  "cap-off": ["S", "  if (visionQuotaExhausted(neuronsToday)) {", "  if (false) {"],
  "exhausted-status": ["S", "  if (exhausted) reason = VISION_EXHAUSTED_REASON", "  if (false) reason = VISION_EXHAUSTED_REASON"],
  "nobinding-open": ["S", "  if (!c.env || !visionRunnerOf(c.env)) return 'AI 바인딩 미구성", "  if (false) return 'AI 바인딩 미구성"],
  "client-url": ["S", "  const img = await loadVisionImage(c, cur)", "  const img = (body.image_url ? { ok: true, dataUrl: String(body.image_url), bytes: 0 } : await loadVisionImage(c, cur))"],
  "image-owner": ["S", "  if (!cur) return c.json({ error: 'image_id 가 이 포인트의 사진(현재/이력)이 아닙니다' }, 400)", "  if (!cur) return c.json({ error: 'x' }, 200)"],
  // 라이브러리 — 🔴 유료 가드
  "paid-model-default": ["L", "export const AI_VISION_MODEL_DEFAULT = '@cf/meta/llama-4-scout-17b-16e-instruct'", "export const AI_VISION_MODEL_DEFAULT = 'anthropic/claude-sonnet-5.5'"],
  "allowlist-off": ["L", "  return isFreeModel(model) ? model : null", "  return model"],
  "paid-endpoint": ["L", "  let out: any\n  try {\n    out = await run(model, input)",
    "  let out: any\n  try {\n    out = await fetch('https://openrouter.ai/api/v1/chat/completions', { method: 'POST', headers: { Authorization: 'Bearer paid' }, body: JSON.stringify(input) }).then((r) => r.json())"],
  "neuron-undercount": ["L", "  if (!rate || pt == null || ct == null) return { neurons: AI_VISION_NEURONS_FALLBACK_PER_CALL, estimated: true }", "  if (!rate || pt == null || ct == null) return { neurons: 0, estimated: true }"],
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
const SCOUT = "@cf/meta/llama-4-scout-17b-16e-instruct";
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
const USAGE = { prompt_tokens: 2100, completion_tokens: 300, total_tokens: 2400 };
const NEURONS_GOOD = Math.ceil((2100 * 24545 + 300 * 77273) / 1e6 * 100) / 100;   // 74.73
const wa = (obj, usage) => ({ response: JSON.stringify(obj), usage: usage === undefined ? USAGE : usage });

/* ══ ① src/lib/aiVision.ts — 순수 + 🔴 유료 가드(정적) ══ */
console.log("\n[① src/lib/aiVision.ts — 무료 제공자 가드·스키마 검증·Neuron 환산·runner 어댑터]");
{
  ok(!/openrouter|anthropic|api\.openai|groq|Authorization/i.test(LIB), "① 🔴 정적 가드: 소스에 유료 제공자 이름·인증 헤더 0");
  ok(!/(?<![\w.])fetch\(/.test(LIB), "① 🔴 정적 가드: 전역 fetch( 0(외부 엔드포인트 호출 경로 없음)");
  const out = path.join(os.tmpdir(), "p126-lib-" + process.pid + ".mjs");
  await esbuild.build({ stdin: { contents: LIB, resolveDir: path.join(ROOT, "src/lib"), sourcefile: "aiVision.ts", loader: "ts" }, bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" });
  const L = await import(pathToFileURL(out).href);
  ok(L.AI_VISION_PROVIDER === "workers-ai" && L.isFreeModel(L.AI_VISION_MODEL_DEFAULT) && /^@cf\//.test(L.AI_VISION_MODEL_DEFAULT), "① 기본 모델이 무료 Workers AI 허용 목록 안(@cf/…) — " + L.AI_VISION_MODEL_DEFAULT);
  ok(Object.keys(L.AI_VISION_FREE_MODELS).every((m) => /^@cf\//.test(m)), "① 허용 목록 전부 @cf/ (Workers AI)");
  ok(L.visionModelOf({}) === L.AI_VISION_MODEL_DEFAULT && L.visionModelOf({ AI_VISION_MODEL: "@cf/meta/llama-3.2-11b-vision-instruct" }) === "@cf/meta/llama-3.2-11b-vision-instruct", "① AI_VISION_MODEL 로 목록 안 모델 선택 가능");
  ok(L.visionModelOf({ AI_VISION_MODEL: "anthropic/claude-sonnet-5.5" }) === null && L.visionModelOf({ AI_VISION_MODEL: "@cf/moonshotai/kimi-k2.7-code" }) === null, "① 🔴 허용 목록 밖(유료·require_workers_paid) → null(비활성, 폴백 없음)");
  ok(L.AI_VISION_GLOBAL_NEURON_CAP < L.AI_VISION_FREE_NEURONS_PER_DAY && L.AI_VISION_FREE_NEURONS_PER_DAY === 10000, "① 전체 상한(" + L.AI_VISION_GLOBAL_NEURON_CAP + ") < 무료 할당 10,000 Neurons/일");
  const nn = L.neuronsOf(SCOUT, USAGE);
  ok(nn.neurons === NEURONS_GOOD && nn.estimated === false, "① Neuron 환산(Scout 24545/77273 per M) — " + nn.neurons);
  const nf = L.neuronsOf(SCOUT, null);
  ok(nf.neurons === L.AI_VISION_NEURONS_FALLBACK_PER_CALL && nf.estimated === true, "① usage 없음 → 보수적 고정값(과소집계 금지) — " + nf.neurons);
  ok(L.visionQuotaExhausted(L.AI_VISION_GLOBAL_NEURON_CAP - L.AI_VISION_NEURONS_FALLBACK_PER_CALL - 1) === false && L.visionQuotaExhausted(L.AI_VISION_GLOBAL_NEURON_CAP - L.AI_VISION_NEURONS_FALLBACK_PER_CALL + 1) === true, "① 소진 판정 = 사용량 + 다음 1회 추정 > 상한");
  ok(L.visionDayStartUtc(Date.UTC(2026, 9, 7, 13, 5)) === Date.UTC(2026, 9, 7), "① 집계 창 = UTC 자정");

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
  ok(L.parseModelJson("```json\n{\"a\":1}\n```").a === 1 && L.parseModelJson({ b: 2 }).b === 2 && L.parseModelJson("nope") === null, "① parseModelJson — 펜스·객체(JSON 모드)·실패 null");

  const refs = L.pinImageRefs({ imageId: "img9", timeline: [{ imageId: "img7", shotAt: 1 }, { imageUrl: "/api/r2/object/assets/a.jpg?t=tok", at: 2 }, { imageUrl: "https://evil.example/x.jpg" }] });
  ok(refs.length === 3 && refs[0].ref === "img:img9" && refs[0].current && refs[1].ref === "r2:assets/a.jpg" && refs[2].ref === "img:img7", "① pinImageRefs — 현재 + 이력(최근순), R2 키 추출(?t= 제거), 외부 URL 제외(SSRF)");
  ok(L.pinImageRefs({ imageUrl: "https://cdn.example/p.jpg" }).length === 0, "① 외부 URL 만 있는 핀 → 참조 0(서버가 읽지 않음)");
  ok(L.visionCacheKey("img:a", null, "m") === "m|img:a|" && L.visionCacheKey("img:a", "img:b", "m") !== L.visionCacheKey("img:a", null, "m"), "① 캐시 키 = 모델|현재|비교");

  // 호출 어댑터 — runner 스텁(Workers AI 바인딩 대체)
  let calls = [];
  const stub = (fn) => { calls = []; return async (model, input) => { calls.push({ model, input }); return fn(model, input, calls.length); }; };
  const noBind = await L.askVision({}, { imageDataUrl: PNG1 }, null);
  ok(!noBind.ok && noBind.error === "no-ai-binding" && noBind.usage.neurons === 0, "① 바인딩 없음 → no-ai-binding(호출 0, Neurons 0)");
  const paid = await L.askVision({ AI_VISION_MODEL: "anthropic/claude-sonnet-5.5" }, { imageDataUrl: PNG1 }, stub(() => wa(GOOD)));
  ok(!paid.ok && paid.error === "model-not-free" && calls.length === 0, "① 🔴 유료 모델 지정 → model-not-free(runner 호출 0 — 폴백 없음)");
  const good = await L.askVision({}, { imageDataUrl: PNG1, compareDataUrl: PNG1, pinLabel: "P1" }, stub(() => wa(GOOD)));
  ok(good.ok && good.usage.neurons === NEURONS_GOOD && good.usage.cost_usd === 0 && good.usage.prompt_tokens === 2100 && good.value.items.length === 3 && good.model === SCOUT, "① fixture → ok + usage(토큰·Neurons·비용 0)");
  const sent = calls[0].input;
  ok(calls[0].model === SCOUT && sent.response_format && sent.response_format.type === "json_schema" && sent.response_format.json_schema && sent.response_format.json_schema.type === "object", "① 요청: 모델 ID + response_format json_schema(Workers AI JSON 모드)");
  const parts = sent.messages[1].content;
  ok(parts.filter((p) => p.type === "image_url").length === 2 && parts.every((p) => p.type !== "image_url" || /^data:image\//.test(p.image_url.url)) && parts[0].type === "text", "① 요청: 이미지 2장(현재+비교) data URL(Workers AI 는 HTTP URL 불가) + 텍스트");
  const l32 = await L.askVision({ AI_VISION_MODEL: "@cf/meta/llama-3.2-11b-vision-instruct" }, { imageDataUrl: PNG1 }, stub(() => wa(GOOD)));
  ok(l32.ok && !calls[0].input.response_format && l32.usage.neurons === Math.ceil((2100 * 4410 + 300 * 61493) / 1e6 * 100) / 100, "① llama-3.2-vision(JSON 모드 없음) → response_format 미전송 + 그 모델 환산율");
  const objResp = await L.askVision({}, { imageDataUrl: PNG1 }, stub(() => ({ response: GOOD, usage: USAGE })));
  ok(objResp.ok && objResp.value.items.length === 3, "① JSON 모드가 객체로 돌려줘도 통과");
  const bad = await L.askVision({}, { imageDataUrl: PNG1 }, stub(() => wa({ summary: "x", items: [{ kind: "banana", label: "a", confidence: 0.5 }] })));
  ok(!bad.ok && bad.error === "schema:item[0]-kind" && bad.usage.neurons === NEURONS_GOOD, "① 스키마 불합격 → ok:false(schema:…) + Neurons 는 집계(모델은 돌았다)");
  const thrown = await L.askVision({}, { imageDataUrl: PNG1 }, stub(() => { throw new Error("JSON Mode couldn't be met"); }));
  ok(!thrown.ok && thrown.error === "json-mode-unmet" && thrown.usage.neurons === L.AI_VISION_NEURONS_FALLBACK_PER_CALL, "① 'JSON Mode couldn't be met' → json-mode-unmet + 보수적 Neurons");
  const nousage = await L.askVision({}, { imageDataUrl: PNG1 }, stub(() => wa(GOOD, null)));
  ok(nousage.ok && nousage.usage.neurons === L.AI_VISION_NEURONS_FALLBACK_PER_CALL && nousage.usage.neurons_estimated === true, "① usage 없으면 보수적 고정값(지어내지 않고 과대집계)");
  const nojson = await L.askVision({}, { imageDataUrl: PNG1 }, stub(() => ({ response: "그냥 산문", usage: USAGE })));
  ok(!nojson.ok && nojson.error === "no-json-content", "① JSON 아닌 본문 → no-json-content");
  // runner 어댑터 — .run 우선, .fetch(fixture) 폴백
  let ran = 0;
  ok(typeof L.visionRunnerOf({ AI: { run: async () => { ran++; return wa(GOOD); } } }) === "function" && L.visionRunnerOf({}) === null, "① visionRunnerOf — env.AI.run 어댑터 / 없으면 null");
}

/* ══ ② 서버 — Miniflare + 실 D1(0037·0038) + 실 R2 + serviceBindings AI fixture ══ */
console.log("\n[② 서버 /api/ai/analyze-photo — Miniflare + 실 D1 + Workers AI fixture(실 호출 0·과금 0)]");
const MIG_DIR = path.join(ROOT, "migrations");
const MIGS = fs.readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
ok(MIGS.includes("0037_ai_vision.sql") && MIGS.includes("0038_ai_vision_neurons.sql"), "② 마이그레이션 0037·0038 존재");
const stmtsOf = (file) => fs.readFileSync(path.join(MIG_DIR, file), "utf8").replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
const workerOut = path.join(os.tmpdir(), "p126-worker-" + process.pid + ".mjs");
await esbuild.build({
  stdin: { contents: SRV, resolveDir: path.join(ROOT, "src"), sourcefile: "index.tsx", loader: "tsx" },
  bundle: true, format: "esm", platform: "neutral", outfile: workerOut, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent",
  conditions: ["workerd", "worker", "browser"], plugins: [libPlugin],
});

// Workers AI fixture — env.AI(serviceBindings) 로 들어온 /run/<model> 요청을 기록하고 지정 응답을 돌려준다(과금 0)
const upstream = { calls: [], reply: () => wa(GOOD) };
const aiFixture = async (req) => {
  const url = new URL(req.url);
  let body = null; try { body = await req.json(); } catch {}
  upstream.calls.push({ model: decodeURIComponent(url.pathname.replace(/^\/run\//, "")), body });
  return new Response(JSON.stringify(upstream.reply(body)), { headers: { "Content-Type": "application/json" } });
};
const mkMf = (bindings, withAI) => new Miniflare({
  modules: true, scriptPath: workerOut, d1Databases: { DB: "p126-" + Date.now() + Math.random().toString(36).slice(2) }, r2Buckets: { R2: "p126r2-" + Date.now() },
  bindings: { DEMO_LOGIN: "0", ...bindings }, compatibilityDate: "2025-01-01", ...(withAI ? { serviceBindings: { AI: aiFixture } } : {}),
});
const mf = mkMf({}, true);
const mfNoAI = mkMf({}, false);
const mfPaid = mkMf({ AI_VISION_MODEL: "anthropic/claude-sonnet-5.5" }, true);
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
  for (const id of ["img_cur", "img_old", "img_lim"]) {
    await run("INSERT INTO pano_images (id, name, image_data, width, height, created_at, updated_at, deleted, tenant_id) VALUES (?, ?, ?, 1, 1, ?, ?, 0, 'tnt_default')", [id, id, PNG1, now0, now0]);
  }
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
  ok(stV.status === 200 && stV.j.enabled === true && stV.j.provider === "workers-ai" && stV.j.model === SCOUT && stV.j.daily_limit === 30 && stV.j.used === 0, "② vision-status → enabled, provider workers-ai, 모델·상한 — " + JSON.stringify(stV.j).slice(0, 160));
  ok(stV.j.neurons_used_today === 0 && stV.j.neuron_cap === 7000 && stV.j.free_neurons_per_day === 10000 && stV.j.exhausted === false, "② 상태에 전체 무료 할당 사용량/상한(Neurons) 동봉");
  ok((await A(null, "GET", "/api/ai/vision-status")).status === 401, "② 비로그인 상태 조회 → 401");

  // 권한
  const vr = await A("v", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p1" });
  ok(vr.status === 403 && upstream.calls.length === 0, "② 열람자 → 403(모델 호출 0) — " + vr.status);
  const xr = await A("x", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p1" });
  ok(xr.status === 403 && upstream.calls.length === 0, "② 프로젝트 멤버 아닌 디자이너 → 403(deploymentWriteDenied 공유 게이트) — " + xr.status);
  await addUser(db, "w", false);
  await run("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES ('prj_W', '소유자만', '', ?, ?, ?, 0)", [U.w, now0, now0]);
  await run("INSERT INTO deployments (id, title, file_name, drawing_data, pages_data, pins, created_at, updated_at, deleted, project_id, tenant_id) VALUES ('dep_W', 'W', 'W.pdf', '', '[]', ?, ?, ?, 0, 'prj_W', 'tnt_default')",
    [JSON.stringify([{ id: "w1", page: 1, x: 1, y: 1, label: "W1", imageId: "img_cur" }]), now0, now0]);
  const wr = await A("w", "POST", "/api/ai/analyze-photo", { deployment_id: "dep_W", pin_id: "w1" });
  ok(wr.status === 403 && upstream.calls.length === 0, "② 디자이너 권한 없는 소유자 → 403(requireDesigner — 디자이너 이상만) — " + wr.status);

  // 디자이너 200 — 클라가 보낸 image_url 은 무시(서버가 D1 에서 읽은 data URL 만 모델로)
  const r1 = await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p1", image_url: "https://evil.example/injected.jpg", image: "data:image/png;base64,AAAA" });
  ok(r1.status === 200 && r1.j.ok === true && r1.j.cached === false && r1.j.result && r1.j.result.items.length === 3, "② 디자이너 → 200 + 구조화 결과(items 3) — " + r1.status);
  ok(upstream.calls.length === 1 && upstream.calls[0].model === SCOUT, "② Workers AI 바인딩 1회, 모델 = " + (upstream.calls[0] && upstream.calls[0].model));
  const sentImgs = (upstream.calls[0].body.messages[1].content || []).filter((p) => p.type === "image_url").map((p) => p.image_url.url);
  ok(sentImgs.length === 1 && sentImgs[0] === PNG1, "② 🔴 모델이 받은 이미지 = 서버가 D1 에서 읽은 것(클라 image_url/image 필드 무시)");
  ok(!JSON.stringify(upstream.calls[0].body).includes("evil.example"), "② 클라가 보낸 URL 이 모델 요청 어디에도 없음");
  ok(r1.j.usage && r1.j.usage.cost_usd === 0 && r1.j.usage.neurons === NEURONS_GOOD && r1.j.usage.prompt_tokens === 2100 && r1.j.provider === "workers-ai", "② 응답에 토큰·Neurons·비용 0 + provider");
  ok(!JSON.stringify(r1.j).includes("data:image"), "② 응답에 이미지 데이터 없음");
  ok(r1.j.estimate_p === 0.7 && r1.j.result.defect_suggestion && r1.j.result.defect_suggestion.severity === "mid", "② 「추정」 기준(0.7) + 결함 제안 동봉(서버는 등록하지 않음)");
  const noteCnt = await db.prepare("SELECT COUNT(*) AS n FROM pin_notes").first();
  ok(Number(noteCnt.n) === 0, "② 🔴 AI 가 결함 노트를 자동 등록하지 않음(pin_notes 0)");
  const row1 = await db.prepare("SELECT neurons, cost_usd, status FROM ai_vision_results WHERE pin_id = 'p1'").first();
  ok(row1 && row1.neurons === NEURONS_GOOD && row1.cost_usd === 0 && row1.status === "ok", "② D1 행에 neurons 기록(0038) · cost_usd 0 — " + JSON.stringify(row1));

  // 캐시 적중 — 모델 호출 0회
  const r1b = await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p1" });
  ok(r1b.status === 200 && r1b.j.cached === true && r1b.j.usage.neurons === NEURONS_GOOD && upstream.calls.length === 1, "② 같은 사진 재요청 → cached:true, 모델 호출 여전히 1회");
  const r1c = await A("o", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p1", image_id: "img_cur" });
  ok(r1c.status === 200 && r1c.j.cached === true && upstream.calls.length === 1, "② 다른 사용자(소유자)도 같은 사진 → 캐시 적중");

  // 비교(이전 사진)
  upstream.reply = () => wa({ ...GOOD, change_summary: "좌측 펌프 커버가 새로 설치됨" });
  const r2c = await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p1", compare_image_id: "img_old" });
  ok(r2c.status === 200 && r2c.j.cached === false && r2c.j.compare === true && r2c.j.result.change_summary === "좌측 펌프 커버가 새로 설치됨", "② compare_image_id(이력) → 변화 요약 동봉 — " + r2c.status);
  const sent2 = (upstream.calls[1].body.messages[1].content || []).filter((p) => p.type === "image_url").length;
  ok(upstream.calls.length === 2 && sent2 === 2, "② 비교 요청은 이미지 2장(현재+이전) 전송, 모델 2회");

  const badImg = await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p1", image_id: "img_lim" });
  ok(badImg.status === 400 && upstream.calls.length === 2, "② 다른 핀의 image_id → 400(모델 호출 0)");
  ok((await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p1", compare_image_id: "nope" })).status === 400, "② 핀 소유 아닌 compare_image_id → 400");
  ok((await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "zzz" })).status === 404, "② 없는 핀 → 404");
  ok((await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: "nope", pin_id: "p1" })).status === 404, "② 없는 배포본 → 404");
  ok((await A("d", "POST", "/api/ai/analyze-photo", { pin_id: "p1" })).status === 400, "② deployment_id 누락 → 400");

  // R2 경로
  upstream.reply = () => wa(GOOD);
  const rr2 = await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p2" });
  const sent3 = (upstream.calls[2] && upstream.calls[2].body.messages[1].content || []).filter((p) => p.type === "image_url").map((p) => p.image_url.url);
  ok(rr2.status === 200 && upstream.calls.length === 3 && sent3.length === 1 && sent3[0].startsWith("data:image/jpeg;base64,"), "② R2 원본(imageUrl 키) → 서버가 R2 에서 읽어 data URL 로 전송 — " + rr2.status);
  const rr3 = await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p3" });
  ok(rr3.status === 413 && rr3.j.code === "image-too-large" && upstream.calls.length === 3, "② 4MB 초과 원본 → 413 정직한 오류(모델 호출 0) — " + rr3.status);
  ok((await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p4" })).status === 400 && upstream.calls.length === 3, "② 외부 URL 만 있는 핀 → 400(SSRF 차단)");
  ok((await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p5" })).status === 400, "② 사진 없는 핀 → 400");

  // 스키마 불합격 → 502 + error 행(Neurons 는 집계)
  upstream.reply = () => wa({ summary: "x", items: [{ kind: "banana", label: "a", confidence: 0.5 }] });
  const bad = await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p6" });
  ok(bad.status === 502 && String(bad.j.code).startsWith("schema:") && bad.j.enabled === true, "② 스키마 불합격 → 502(code schema:…) 지어내지 않음 — " + bad.status);
  const errRow = await db.prepare("SELECT status, error, neurons FROM ai_vision_results WHERE pin_id = 'p6'").first();
  ok(errRow && errRow.status === "error" && String(errRow.error).startsWith("schema:") && errRow.neurons === NEURONS_GOOD, "② 실패도 기록(status=error) + Neurons 집계(모델은 돌았다)");
  upstream.reply = () => wa(GOOD, null);   // usage 없는 응답
  const again = await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p6" });
  const againRow = await db.prepare("SELECT neurons FROM ai_vision_results WHERE pin_id = 'p6' AND status = 'ok'").first();
  ok(again.status === 200 && again.j.cached === false && upstream.calls.length === 5 && againRow && againRow.neurons === 200, "② 실패 행은 캐시 아님 → 재호출 200 · usage 없는 응답은 보수적 200 Neurons 기록");
  upstream.reply = () => wa(GOOD);

  // 감사 로그
  const logs = await db.prepare("SELECT action, actor_email, detail FROM activity_log WHERE action = 'ai.vision' ORDER BY ts").all();
  const lrows = logs.results || [];
  const d0 = JSON.parse(lrows[0].detail);
  ok(lrows.length >= 6 && d0.neurons === NEURONS_GOOD && d0.cost_usd === 0 && d0.provider === "workers-ai" && d0.cached === false && lrows[0].actor_email === U.d, "② activity_log 'ai.vision' — Neurons·비용 0·제공자·캐시 여부(" + lrows.length + "건)");
  ok(!lrows.some((r) => String(r.detail).includes("data:image")), "② 로그에 이미지 데이터 없음");

  // 사용자 일일 상한(30회/24h)
  const usedNow = await db.prepare("SELECT COUNT(*) AS n FROM ai_vision_results WHERE created_by = ?").bind(U.d).first();
  for (let i = Number(usedNow.n); i < 30; i++) {
    await run("INSERT INTO ai_vision_results (id, cache_key, image_ref, model, status, error, neurons, created_by, created_at) VALUES (?, ?, 'img:fill', 'm', 'error', 'fill', 0, ?, ?)", ["fill" + i, "m|img:fill" + i + "|", U.d, now0]);
  }
  const st2 = await A("d", "GET", "/api/ai/vision-status");
  ok(st2.j.used === 30 && st2.j.remaining === 0 && st2.j.enabled === true, "② vision-status used=30 remaining=0(전체 할당은 아직 여유) — " + JSON.stringify({ used: st2.j.used, remaining: st2.j.remaining }));
  await run("UPDATE deployments SET pins = ? WHERE id = ?", [JSON.stringify(pins.concat([{ id: "p7", page: 1, x: 70, y: 10, label: "P7", imageId: "img_old" }, { id: "p8", page: 1, x: 80, y: 10, label: "P8", imageId: "img_lim", timeline: [{ imageId: "img_old" }] }])), dep]);
  const lim = await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p7" });
  ok(lim.status === 429 && lim.j.limit === 30 && upstream.calls.length === 5, "② 사용자 일일 상한 초과 → 429 + 사유(모델 호출 0) — " + lim.status);
  ok((await A("d", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p1" })).j.cached === true, "② 상한 초과여도 캐시 적중은 200(비용 0)");
  const other = await A("o", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p7" });
  ok(other.status === 200 && upstream.calls.length === 6, "② 사용자 상한은 사용자별 — 다른 사용자는 정상 호출");

  // 🔴 전체 무료 할당(Neurons) 소진 → 비활성 + "오늘 무료 사용량 소진 — 내일 다시", 유료 폴백 없음
  await run("INSERT INTO ai_vision_results (id, cache_key, image_ref, model, status, neurons, created_by, created_at) VALUES ('capfill', 'm|cap|', 'img:cap', 'm', 'error', ?, ?, ?)", [6900, U.o, now0]);
  const stCap = await A("o", "GET", "/api/ai/vision-status");
  ok(stCap.j.enabled === false && stCap.j.exhausted === true && /오늘 무료 사용량 소진/.test(stCap.j.reason || "") && stCap.j.neurons_used_today > 6900, "② 할당 소진 → vision-status enabled:false + exhausted + 사유 — " + (stCap.j && stCap.j.reason));
  const capR = await A("o", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p8", compare_image_id: "img_old" });
  ok(capR.status === 429 && capR.j.exhausted === true && /오늘 무료 사용량 소진/.test(capR.j.error) && upstream.calls.length === 6, "② 할당 소진 분석 → 429 exhausted(모델 호출 0 — 유료 폴백 없음) — " + capR.status);
  ok((await A("o", "POST", "/api/ai/analyze-photo", { deployment_id: dep, pin_id: "p1" })).j.cached === true, "② 할당 소진 중에도 캐시 적중은 200(비용 0)");
  await run("UPDATE ai_vision_results SET created_at = ? WHERE id = 'capfill'", [now0 - 2 * 86400000]);   // 어제(UTC 창 밖) → 다시 열림
  const stBack = await A("o", "GET", "/api/ai/vision-status");
  ok(stBack.j.enabled === true && stBack.j.exhausted === false, "② 날짜가 바뀌면(UTC 창 밖) 다시 활성 — '내일 다시'");

  // AI 바인딩 없음 — 비활성 + 사유, 분석 503(모델 호출 0)
  const db2 = await mfNoAI.getD1Database("DB");
  for (const f of MIGS) for (const st of stmtsOf(f)) await db2.exec(st);
  await addUser(db2, "o", true);
  const stN = await api(mfNoAI, "o", "GET", "/api/ai/vision-status");
  ok(stN.status === 200 && stN.j.enabled === false && /AI 바인딩/.test(stN.j.reason || ""), "② 바인딩 없음 → enabled:false + 사유 — " + (stN.j && stN.j.reason));
  const anN = await api(mfNoAI, "o", "POST", "/api/ai/analyze-photo", { deployment_id: "x", pin_id: "p1" });
  ok(anN.status === 503 && anN.j.enabled === false, "② 바인딩 없음 분석 → 503(조용한 실패 금지) — " + anN.status);

  // 🔴 유료 모델 ID 를 시크릿으로 지정 — 허용 목록 밖 → 비활성(모델 호출 0)
  const db3 = await mfPaid.getD1Database("DB");
  for (const f of MIGS) for (const st of stmtsOf(f)) await db3.exec(st);
  await addUser(db3, "o", true);
  const before = upstream.calls.length;
  const stP = await api(mfPaid, "o", "GET", "/api/ai/vision-status");
  ok(stP.j.enabled === false && /허용 목록/.test(stP.j.reason || "") && stP.j.model === null, "② 🔴 AI_VISION_MODEL=유료 → enabled:false + '허용 목록 밖' 사유 — " + (stP.j && stP.j.reason));
  const anP = await api(mfPaid, "o", "POST", "/api/ai/analyze-photo", { deployment_id: "x", pin_id: "p1" });
  ok(anP.status === 503 && upstream.calls.length === before, "② 🔴 유료 모델 지정 분석 → 503(모델 호출 0, 유료 폴백 없음) — " + anP.status);
} finally {
  clearTimeout(watchdog);
  await mf.dispose().catch(() => {});
  await mfNoAI.dispose().catch(() => {});
  await mfPaid.dispose().catch(() => {});
  try { fs.unlinkSync(workerOut); } catch {}
}

console.log(failed ? `\n${failed} FAIL` : "\nALL PASS");
process.exit(failed ? 1 : 0);
