/**
 * p171-gap3-pure — SIGNAX 격차3(WO 20261019-gap3) 순수 함수 단위검증.
 * 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p171-gap3-pure.test.mjs
 *
 * 대상:
 *   A. 48_GPS.js GPS.Calib — 2점 상사변환 / 3점+ 최소제곱 아핀 / 잔차 / 픽셀↔GPS 역변환
 *   B. src/lib/webhooks.ts — SSRF 가드(validateWebhookUrl) / HMAC 서명 / 재시도(deliverWithRetry) / 레이트리밋
 *   C. 69_CaptureSession.js — 수동 시계보정 ±120초 clamp
 *
 * 뮤테이션 5건(P171_MUT=<이름>) — 각각 EXIT=1 이어야 한다(대상 문자열 못 찾으면 EXIT=2):
 *   invertSign   : gpsToPixel 역행렬 부호 반전(y 계산의 -c 를 +c로) → 라운드트립 오차 폭증
 *   noSsrf       : validateWebhookUrl 의 사설호스트 거부 제거 → 내부망 URL 이 통과
 *   weakHmac     : hmacSignHex 가 항상 고정 문자열 반환 → 서명이 바뀌지 않음
 *   noRetryBackoff: deliverWithRetry 가 실패해도 1회만 시도 → attempts.length 항상 1
 *   noClamp      : setManualOffsetSec 의 clamp 제거 → 999초가 그대로 저장
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const ok = (cond, label, detail) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail).slice(0, 300) : ""));
  if (!cond) failed++;
};

const MUT = process.env.P171_MUT || "";

/* ══ A. GPS.Calib — vm 로드 ══ */
let gpsSrc = rd("public/js/modules/48_GPS.js");
if (MUT === "invertSign") {
  const needle = "const y = (-m.c * Ex + m.a * Nx) / det;";
  if (!gpsSrc.includes(needle)) { console.log("뮤테이션 대상 없음: invertSign"); process.exit(2); }
  gpsSrc = gpsSrc.replace(needle, "const y = (m.c * Ex + m.a * Nx) / det;");
  console.log("[뮤테이션 적용] invertSign");
}
function loadGPS(src) {
  const sandbox = { console, Math, JSON, Date };
  sandbox.window = sandbox; sandbox.navigator = {}; sandbox.document = undefined; sandbox.localStorage = undefined;
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__GPS = GPS;", sandbox);
  return sandbox.__GPS;
}
const GPS = loadGPS(gpsSrc);

{
  const ref = { lat: 35.1, lng: 129.0 };
  const trueA = { a: 0.5, b: 0.1, e: 2, c: -0.05, d: 0.6, f: 1 };
  const fwd = (x, y) => ({ E: trueA.a * x + trueA.b * y + trueA.e, N: trueA.c * x + trueA.d * y + trueA.f });
  const pxPoints = [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 0, y: 100 }, { x: 80, y: 40 }];
  const pts = pxPoints.map((p) => { const { E, N } = fwd(p.x, p.y); const g = GPS.Calib.fromENU(ref, E, N); return { x: p.x, y: p.y, lat: g.lat, lng: g.lng }; });

  const fit2 = GPS.Calib.fit(pts.slice(0, 2));
  ok(!!fit2 && fit2.maxResidualM < 0.01, "A1 2점 상사변환 — 합성데이터 잔차<0.01m → " + (fit2 && fit2.maxResidualM));

  const fit3 = GPS.Calib.fit(pts);
  ok(!!fit3 && fit3.maxResidualM < 0.01, "A2 3점+ 최소제곱 아핀 — 잔차<0.01m → " + (fit3 && fit3.maxResidualM));

  const testPt = { x: 55, y: 22 };
  const g = GPS.Calib.pixelToGps(fit3, testPt.x, testPt.y);
  const back = GPS.Calib.gpsToPixel(fit3, g.lat, g.lng);
  const err = Math.hypot(back ? back.x - testPt.x : 999, back ? back.y - testPt.y : 999);
  ok(err < 0.001, "A3 픽셀→GPS→픽셀 라운드트립 오차<0.001px → " + err);

  ok(GPS.Calib.fit([{ x: 1, y: 1, lat: 35, lng: 129 }]) === null, "A4 점<2 → null(지어내지 않음)");
  ok(GPS.Calib.fit([{ x: 1, y: 1, lat: 35, lng: 129 }, { x: 1, y: 1, lat: 35.01, lng: 129.01 }]) === null, "A5 2점이 같은 픽셀(축퇴) → null");

  const col = GPS.Calib.fit([{ x: 0, y: 0, lat: 35, lng: 129 }, { x: 10, y: 0, lat: 35.0001, lng: 129 }, { x: 20, y: 0, lat: 35.0002, lng: 129 }]);
  ok(col === null, "A6 3점 일직선(특이행렬) → null");

  // 잔차 경고(4점, 1점 10m 벗어남 → 최소제곱이 분산해도 경고 임계(5m) 근접/초과 가능 시나리오 — 임계식 자체 검증)
  ok(GPS.Calib.RESIDUAL_WARN_M === 5, "A7 정확도 경고 임계 = 5m(판정기준 §지시)");
  const noisy = [{ x: 0, y: 0, lat: 35, lng: 129 }, { x: 100, y: 0, lat: 35, lng: 129.002 }, { x: 0, y: 100, lat: 35.002, lng: 129 }, { x: 100, y: 100, lat: 35.002 + 40 / 110574, lng: 129.002 }];
  const fitNoisy = GPS.Calib.fit(noisy);
  ok(!!fitNoisy && fitNoisy.maxResidualM > 5 && !!fitNoisy.warn, "A8 잔차>5m → warn 문자열 생성 → " + (fitNoisy && fitNoisy.maxResidualM.toFixed(2)) + " / " + (fitNoisy && fitNoisy.warn));
}

/* ══ B. webhooks.ts — esbuild 로 TS 제거 후 동적 import ══ */
let whSrc = rd("src/lib/webhooks.ts");
const MUTS_B = {
  noSsrf: ["if (!testMode && isPrivateOrLocalHost(u.hostname)) {", "if (false && !testMode && isPrivateOrLocalHost(u.hostname)) {"],
  weakHmac: ["export async function hmacSignHex(secret: string, body: string): Promise<string> {", "export async function hmacSignHex(secret: string, body: string): Promise<string> { return 'deadbeef'.repeat(8); //MUT\n"],
  noRetryBackoff: ["const attempts = Number.isFinite(opts.attempts) ? Number(opts.attempts) : 3", "const attempts = 1"],
};
if (MUT && MUTS_B[MUT]) {
  const [from, to] = MUTS_B[MUT];
  if (!whSrc.includes(from)) { console.log("뮤테이션 대상 없음: " + MUT); process.exit(2); }
  whSrc = whSrc.replace(from, to);
  console.log("[뮤테이션 적용] " + MUT);
}
const whJs = esbuild.transformSync(whSrc, { loader: "ts", format: "esm" }).code;
const whTmp = path.join(os.tmpdir(), "p171-webhooks-" + process.pid + "-" + Date.now() + ".mjs");
fs.writeFileSync(whTmp, whJs);
const WH = await import(pathToFileURL(whTmp).href);
fs.unlinkSync(whTmp);

{
  ok(WH.isPrivateOrLocalHost("10.0.0.5") === true, "B1 사설(10.0.0.0/8) 판정 true");
  ok(WH.isPrivateOrLocalHost("192.168.1.1") === true, "B2 사설(192.168.0.0/16) 판정 true");
  ok(WH.isPrivateOrLocalHost("localhost") === true, "B3 localhost 판정 true");
  ok(WH.isPrivateOrLocalHost("example.com") === false, "B4 공개 도메인 판정 false");

  const r1 = WH.validateWebhookUrl("http://example.com/hook", false);
  ok(r1.ok === false && /https/.test(r1.error), "B5 http(비테스트) → 거부(https required) → " + JSON.stringify(r1));
  const r2 = WH.validateWebhookUrl("https://10.0.0.5/hook", false);
  ok(r2.ok === false, "B6 https + 사설IP(비테스트) → SSRF 가드로 거부 → " + JSON.stringify(r2));
  const r3 = WH.validateWebhookUrl("http://127.0.0.1:9999/hook", true);
  ok(r3.ok === true, "B7 테스트모드 → http+localhost 허용(로컬 수신서버 검증용) → " + JSON.stringify(r3));
  const r4 = WH.validateWebhookUrl("https://example.com/hook", false);
  ok(r4.ok === true, "B8 https + 공개도메인 → 허용");

  const sig1 = await WH.hmacSignHex("secret1", "body-a");
  const sig2 = await WH.hmacSignHex("secret1", "body-b");
  const sig3 = await WH.hmacSignHex("secret2", "body-a");
  ok(sig1 !== sig2, "B9 다른 본문 → 다른 서명");
  ok(sig1 !== sig3, "B10 다른 비밀키 → 다른 서명");
  ok(/^[0-9a-f]{64}$/.test(sig1), "B11 HMAC-SHA256 hex(64자) 형식 → len=" + sig1.length);

  // 재시도 — 스텁 fetch 로 항상 실패 → 3회 시도 + 짧은 delay(테스트용 delayFn 주입, 실 대기 0)
  let calls = 0;
  const failFetch = async () => { calls++; return { status: 500 }; };
  const r5 = await WH.deliverWithRetry("https://example.com/h", "{}", {}, { fetchFn: failFetch, delayFn: async () => {} });
  ok(r5.finalOk === false && r5.attempts.length === 3 && calls === 3, "B12 3회 재시도 후 실패 기록 → attempts=" + r5.attempts.length + " calls=" + calls);

  let calls2 = 0;
  const okOnThird = async () => { calls2++; return { status: calls2 === 3 ? 200 : 500 }; };
  const r6 = await WH.deliverWithRetry("https://example.com/h", "{}", {}, { fetchFn: okOnThird, delayFn: async () => {} });
  ok(r6.finalOk === true && r6.attempts.length === 3, "B13 3번째 시도에서 성공 → finalOk=true attempts=3");

  // 레이트리밋
  const now = 1_000_000;
  const step1 = WH.rateLimitStep(null, 2, 60000, now);
  ok(!!step1 && step1.count === 1, "B14 첫 요청 → count=1");
  const row1 = { rl_window_start: step1.windowStart, rl_count: step1.count };
  const step2 = WH.rateLimitStep(row1, 2, 60000, now + 1000);
  ok(!!step2 && step2.count === 2, "B15 같은 윈도 2번째 → count=2");
  const row2 = { rl_window_start: step2.windowStart, rl_count: step2.count };
  const step3 = WH.rateLimitStep(row2, 2, 60000, now + 2000);
  ok(step3 === null, "B16 같은 윈도 3번째(한도 2 초과) → null(거부)");
  const step4 = WH.rateLimitStep(row2, 2, 60000, now + 61000);
  ok(!!step4 && step4.count === 1, "B17 윈도 만료 후 → 새 윈도 count=1");

  const key = WH.newApiKeyPlain();
  ok(key.startsWith("wk_") && key.length > 10, "B18 API 키 원문 생성 형식 → " + key);
}

/* ══ C. CaptureSession.setManualOffsetSec — ±120초 clamp ══ */
let csSrc = rd("public/js/modules/69_CaptureSession.js");
if (MUT === "noClamp") {
  const needle = "const s = Math.max(-this.MANUAL_OFFSET_MAX_S, Math.min(this.MANUAL_OFFSET_MAX_S, Number(sec) || 0));";
  if (!csSrc.includes(needle)) { console.log("뮤테이션 대상 없음: noClamp"); process.exit(2); }
  csSrc = csSrc.replace(needle, "const s = Number(sec) || 0;");
  console.log("[뮤테이션 적용] noClamp");
}
{
  const seriesSrc = rd("public/js/modules/01b_PinSeries.js");
  const sandbox = { console, JSON, Map, Set, Date, Math };
  sandbox.window = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(seriesSrc + "\n" + csSrc + "\n;globalThis.__CS = CaptureSession;", sandbox);
  const CS = sandbox.__CS;
  CS._s = { manualOffsetMs: 0 };
  CS.setManualOffsetSec(50);
  ok(CS._s.manualOffsetMs === 50000, "C1 50초 → 50000ms");
  CS.setManualOffsetSec(999);
  ok(CS._s.manualOffsetMs === 120000, "C2 999초 입력 → ±120초로 clamp → " + CS._s.manualOffsetMs);
  CS.setManualOffsetSec(-999);
  ok(CS._s.manualOffsetMs === -120000, "C3 -999초 입력 → -120초로 clamp → " + CS._s.manualOffsetMs);
}

console.log("\n" + (failed ? "FAILED " + failed + "건" : "ALL PASS"));
process.exit(failed ? 1 : 0);
