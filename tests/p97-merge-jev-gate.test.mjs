/**
 * p97 — 구역 합치기 "같은 위치 중복 핀" Jev 판정: 어댑터(src/lib/jevDup.ts) + 게이트(41_RegionMerge.decideDup)
 * (프레임워크 0 · 실행: node tests/p97-merge-jev-gate.test.mjs)
 *
 * 경계: 외부 HTTP(OpenRouter) 만 fetch 스텁으로 대체한다(타임아웃·4xx·정상 응답 재현). 어댑터·게이트는 실 소스.
 * 검사: ① 타임아웃(JEV_TIMEOUT_MS) → ok:false 'timeout' → 게이트가 거리 규칙으로 판정
 *       ② 요청 형식(공식 문서 docs.typesafe.ai/api: model·state·questions{type:choice,instructions,criteria{same,different}})
 *       ③ 401 재시도 없음 · 429 1회 재시도   ④ 확률 게이트 p≥0.90 사용 / 0.70~0.90 추정 / <0.70 규칙
 *       ⑤ 회사명 게이트 어댑터(askJevSameCompany)가 공유 지점(jevDecide) 리팩터 후에도 noul 을 그대로 돌려준다
 * 뮤테이션: P97_MERGE_SRC=<변형 41_RegionMerge.js>(예: P_EST 게이트 제거 → ④ FAIL → EXIT=1)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
let failed = 0;
const ok = (c, l) => { console.log((c ? "  PASS " : "  FAIL ") + l); if (!c) failed++; };

const out = path.join(os.tmpdir(), "p97-jev-" + process.pid + ".mjs");
await esbuild.build({ entryPoints: [path.join(ROOT, "src/lib/jevDup.ts")], bundle: true, format: "esm", platform: "neutral", outfile: out, logLevel: "silent" });
const L = await import(pathToFileURL(out).href);
const out2 = path.join(os.tmpdir(), "p97-jevc-" + process.pid + ".mjs");
await esbuild.build({ entryPoints: [path.join(ROOT, "src/lib/jev.ts")], bundle: true, format: "esm", platform: "neutral", outfile: out2, logLevel: "silent" });
const JC = await import(pathToFileURL(out2).href);

const ENV = { OPENROUTER_API_KEY: "test-key-not-real" };
const PAIRS = [{ i: 0, distance_pct: 0.5, incoming: { label: "1", note: "", photo: "" }, existing: { label: "1", note: "", photo: "" } },
  { i: 3, distance_pct: 2.1, incoming: { label: "7", note: "밸브", photo: "" }, existing: { label: "7", note: "배관", photo: "" } }];
const realFetch = globalThis.fetch;
let calls = [];
const stub = (fn) => { calls = []; globalThis.fetch = async (url, init) => { calls.push({ url, init }); return fn(url, init, calls.length); }; };
const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/* ① 타임아웃 */
console.log("\n[①] 타임아웃 → 실패 값(예외·거짓 성공 없음)");
stub((url, init) => new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))));
const t0 = Date.now();
const rT = await L.askJevDupPairs(ENV, PAIRS);
const dt = Date.now() - t0;
ok(rT.ok === false && rT.error === "timeout" && dt >= JC.JEV_TIMEOUT_MS - 50 && dt < JC.JEV_TIMEOUT_MS + 2000, "① timeout → ok:false 'timeout' (" + dt + "ms, 한도 " + JC.JEV_TIMEOUT_MS + ")");
const rK = await L.askJevDupPairs({}, PAIRS);
ok(rK.ok === false && rK.error === "no-key" && calls.length === 1, "① 키 없음 → 'no-key', 외부 호출 0 (누적 호출 " + calls.length + ")");

/* ② 요청 형식 + 정상 응답 */
console.log("\n[②] 요청 형식 · 정상 응답");
stub(() => json(200, { answers: { q0: { type: "choice", choice: "same", probabilities: { same: 0.95, different: 0.05 }, confidence: 0.9 },
  q1: { type: "choice", choice: "different", probabilities: { same: 0.2, different: 0.8 }, confidence: 0.5 } } }));
const rOk = await L.askJevDupPairs(ENV, PAIRS);
const body = JSON.parse(calls[0].init.body);
ok(calls[0].url === JC.JEV_ENDPOINT && body.model === JC.JEV_MODEL && Array.isArray(body.state.pairs) && body.state.pairs.length === 2,
  "② endpoint·model·state.pairs");
const q = body.questions.q1;
ok(q && q.type === "choice" && q.instructions && JSON.stringify(Object.keys(q.criteria).sort()) === '["different","same"]' && JSON.stringify(q.instructions).includes("pairs[1]"),
  "② choice + instructions(필수) + criteria{same,different} · 쌍 경로 참조");
ok(calls[0].init.headers.Authorization === "Bearer " + ENV.OPENROUTER_API_KEY && !JSON.stringify(rOk).includes(ENV.OPENROUTER_API_KEY), "② 키는 헤더에만 · 결과에 키 없음");
ok(rOk.ok && rOk.probes[0].i === 0 && rOk.probes[0].label === "same" && rOk.probes[0].p === 0.95 && rOk.probes[1].i === 3 && rOk.probes[1].p === 0.8,
  "② 확률 = probabilities[choice] (라벨만 버리지 않음) " + JSON.stringify(rOk.probes));
stub(() => json(200, { answers: { q0: { choice: "maybe", probabilities: { maybe: 1 } } } }));
const rBad = await L.askJevDupPairs(ENV, PAIRS.slice(0, 1));
ok(rBad.ok && rBad.probes[0].ok === false && rBad.probes[0].error === "bad-answer", "② 후보 밖 답 → bad-answer(폴백 대상)");

/* ③ 재시도 규율 */
console.log("\n[③] 401 재시도 없음 · 429 1회 재시도");
stub(() => json(401, { error: "unauthorized" }));
const r401 = await L.askJevDupPairs(ENV, PAIRS);
ok(!r401.ok && r401.error === "http-401" && calls.length === 1, "③ 401 → 1회 호출 후 http-401");
stub((u, i, n) => (n === 1 ? json(429, {}) : json(200, { answers: { q0: { choice: "different", probabilities: { same: 0.01, different: 0.99 } }, q1: { choice: "same", probabilities: { same: 0.9, different: 0.1 } } } })));
const r429 = await L.askJevDupPairs(ENV, PAIRS);
ok(r429.ok && calls.length === 2, "③ 429 → 1회 재시도 후 성공(" + calls.length + "회)");
ok(L.sanitizeDupPairs(new Array(L.DUP_MAX_PAIRS + 1).fill(PAIRS[0])).error && L.sanitizeDupPairs([{ i: -1, distance_pct: 1 }]).error, "③ 신뢰 경계 — 상한 초과·음수 i 거부");

/* ⑤ 회사명 어댑터 회귀 */
stub(() => json(200, { answers: { same_company: { type: "noul", noul: 0.93 } } }));
const rc = await JC.askJevSameCompany(ENV, "한라ENS", "HANLA ENS");
ok(rc.ok && rc.p === 0.93 && JSON.parse(calls[0].init.body).questions.same_company.type === "noul", "⑤ 회사명 게이트 어댑터 = 공유 jevDecide 경유, noul 그대로");
globalThis.fetch = realFetch;

/* ④ 게이트 — 실 41_RegionMerge.js */
console.log("\n[④] 확률 게이트(클라 SoT)");
const sb = { console, fetch: async () => { throw new Error("no net"); }, navigator: { onLine: true }, Auth: { headers: () => ({}) } };
vm.createContext(sb);
const mergeSrc = process.env.P97_MERGE_SRC ? fs.readFileSync(process.env.P97_MERGE_SRC, "utf8") : rd("public/js/modules/41_RegionMerge.js");
for (const s of [rd("public/js/modules/01_State.js"), rd("public/js/modules/01b_PinSeries.js"), rd("public/js/modules/10_MapCtrl.js"), mergeSrc]) vm.runInContext(s, sb);
const RM = vm.runInContext("RegionMerge", sb);
const near = { distance_pct: 0.5 }, far = { distance_pct: 2.0 };
const d95 = RM.decideDup(far, { ok: true, label: "same", p: 0.95 });
const d80 = RM.decideDup(far, { ok: true, label: "same", p: 0.80 });
const d60 = RM.decideDup(far, { ok: true, label: "same", p: 0.60 });
const dTo = RM.decideDup(near, { ok: false, error: "timeout" });
ok(d95.source === "jev" && d95.verdict === "same" && !d95.estimated, "④ p=0.95 → Jev 그대로");
ok(d80.source === "jev" && d80.verdict === "same" && d80.estimated === true, "④ p=0.80 → Jev + 「추정」");
ok(d60.source === "rule" && d60.verdict === "different" && d60.p === 0.6 && d60.reason === "low-p", "④ p=0.60 → 거리 규칙(2% → different), p 는 감사용으로 보존");
ok(dTo.source === "rule" && dTo.verdict === "same" && dTo.reason === "timeout", "④ 타임아웃 → 거리 규칙(0.5% → same)");
// 서버 불통(네트워크 실패) → checkDups 도 규칙으로
const cd = await RM.checkDups([{ i: 0, distance_pct: 0.4, existingId: 1, incoming: {}, existing: {} }]);
ok(cd[0].source === "rule" && cd[0].verdict === "same" && cd[0].reason === "network", "④ 서버 불통 → 거리 규칙(reason=network)");
ok(RM.SAME_PCT < RM.NEAR_PCT && RM.P_EST < RM.P_USE && RM.JEV_CHUNK === L.DUP_MAX_PAIRS, "④ 상수 정합(SAME<NEAR · P_EST<P_USE · 청크 = 서버 상한)");

for (const f of [out, out2]) { try { fs.unlinkSync(f); } catch {} }
console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
