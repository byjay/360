/**
 * p129 — WO 20261007-qrcov 요구 B: 촬영 현황(분류 경계 13/14/15일 · 구역 집계 SoT · CHECKER 제외 · 기준 일수 저장)
 * (프레임워크 0 · 실행: node tests/p129-coverage.test.mjs)
 *
 * [재현: 해당없음 — 신규 기능] 지휘자 R3(2026-10-07, HEAD 869ba0e): coverage·staleness·촬영 현황 0건.
 * 🔴 목 금지 — 51_Coverage.js 와 SoT(14_TimeLapse._normalize · 31_Projects.pinsForDeck · 01b_PinSeries · 43_ProjectInfo ·
 *   src/index.tsx parseStaleDays) 실제 소스를 vm 에서 실행(tests/_lib/qrcov-harness.mjs).
 */
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { readSources, makeBoot, runMutations, tick, DAY } from "./_lib/qrcov-harness.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const BASE = readSources(ROOT);

/** src: 소스 묶음(뮤테이션 시 일부 교체). 반환 = 실패 라벨 배열. quiet=true 면 PASS 출력 생략(뮤테이션 재실행). */
async function suite(src, quiet) {
  const fails = [];
  const ok = (cond, label) => { if (!quiet) console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) fails.push(label); };
  const boot = makeBoot(src);
  /* ── C1~C5 촬영 현황 ── */
  {
    const { X, S } = boot("");
    const C = X.Coverage;
    const now = Date.UTC(2026, 9, 7, 12, 0, 0);
    const shot = (days) => ({ id: "s" + days, imageId: "img" + days, shotAt: now - days * DAY });
    ok(C.classify(shot(13), now, 14) === "fresh", "C1 13일 → 최신");
    ok(C.classify(shot(14), now, 14) === "fresh", "C1 🔴 정확히 14일 → 최신(초과만 오래됨)");
    ok(C.classify(shot(15), now, 14) === "stale", "C1 15일 → 오래됨");
    ok(C.classify({ id: "x", imageId: "i", shotAt: now - 14 * DAY - 1 }, now, 14) === "stale", "C1 14일+1ms → 오래됨");
    ok(C.classify({ id: "n" }, now, 14) === "none", "C1 사진 없음 → 미촬영");
    ok(C.classify({ id: "u", imageId: "i" }, now, 14) === "unknown", "C1 사진은 있으나 시각 기록 없음 → 시각 미상(지어내지 않음)");
    const hist = { id: "h", imageId: "new", shotAt: now - 2 * DAY, timeline: [{ imageId: "old", shotAt: now - 40 * DAY }] };
    ok(C.latestShotAt(hist) === now - 2 * DAY && C.classify(hist, now, 14) === "fresh", "C1 이력 중 최신 shotAt(TimeLapse._normalize SoT)");
    ok(C.staleDays({ info_json: { staleDays: 7 } }) === 7 && C.staleDays({ info_json: { staleDays: 0 } }) === 14 &&
       C.staleDays({ info_json: { staleDays: 400 } }) === 14 && C.staleDays({ info_json: {} }) === 14, "C2 기준 일수 = info_json.staleDays(1~365), 무효·없음 → 14");
    ok(C.classify(shot(8), now, C.staleDays({ info_json: { staleDays: 7 } })) === "stale", "C2 기준 7일이면 8일 = 오래됨");
    const mixed = [shot(1), shot(30), { id: "n2" }, { id: "ck", checkboard: true }, { id: "ck2", checkboard: true, imageId: "z" }];
    const sum = C.summarize(mixed, now, 14);
    ok(sum.total === 3 && sum.fresh === 1 && sum.stale === 1 && sum.none === 1, "C3 🔴 CHECKER 핀 제외 — 360 핀만 집계 " + JSON.stringify(sum));
    S.regMode = "checkboard";
    ok(/CHECKER/.test(C.reason()) && C.toggle() === false && C.on === false, "C3 CHECKER 모드 → 토글 비활성 + 사유");
    S.regMode = "photo";
    const deck = { id: "dck_A", deployment_id: "dep1", page: 1, crop: { x: 0, y: 0, w: 50, h: 50 } };
    S.pins = [{ id: "in1", x: 10, y: 10, page: 1 }, { id: "in2", x: 20, y: 20, page: 1, imageId: "a", shotAt: Date.now() - 30 * DAY },
              { id: "out1", x: 80, y: 80, page: 1 }, { id: "out2", x: 70, y: 90, page: 1 }];
    const ds = C.deckSummary(deck);
    ok(ds && ds.none === 1 && ds.stale === 1 && ds.total === 2, "C4 🔴 구역 집계 = Projects.pinsForDeck(크롭 안만) " + JSON.stringify(ds));
    ok(C.deckSummary({ id: "dck_B", deployment_id: "dep2" }) === null, "C4 미로드 구역 = null(모름 — 0 날조 금지)");
    ok(C.treeBadgeHtml(deck) === "", "C5 꺼져 있으면 트리 배지 0");
    ok(C.toggle() === true && /tree-cov-badge/.test(C.treeBadgeHtml(deck)) && /✕1/.test(C.treeBadgeHtml(deck)) && /!1/.test(C.treeBadgeHtml(deck)), "C5 켜면 트리 배지 ✕1 !1(글리프+숫자 — 색만 아님)");
    const st = C.STYLE;
    ok(st.none.glyph !== st.stale.glyph && st.stale.glyph !== st.fresh.glyph && st.none.radius !== st.fresh.radius, "C5 상태마다 글리프·모양이 다르다(색만으로 구분 금지)");
  }

  /* ── C6 기준 일수 저장 경로 — 클라이언트 정규화 + 서버 화이트리스트 ── */
  {
    const { X } = boot("");
    const n = X.ProjectInfo._normalize({ note: "a", schedule: [], staleDays: 21 });
    const bad = X.ProjectInfo._normalize({ staleDays: "x" });
    ok(n.staleDays === 21 && bad.staleDays === null, "C6 ProjectInfo._normalize staleDays 21 / 무효 → null");
    const fnSrc = /function parseStaleDays\(v: any\): number \| null \{[\s\S]*?\n\}/.exec(src.server);
    let parse = null;
    if (fnSrc) parse = vm.runInNewContext("(" + fnSrc[0].replace("(v: any): number | null", "(v)") + ")");
    ok(!!parse && parse(30) === 30 && parse(0) === null && parse(366) === null && parse("7") === 7 && parse(2.5) === null, "C6 서버 parseStaleDays 1~365 정수만");
    ok(/staleDays: parseStaleDays\(o\.staleDays\)/.test(src.server) && /staleDays: parseStaleDays\(incoming\.staleDays\)/.test(src.server), "C6 서버 GET 파싱·PATCH 저장 둘 다 staleDays 통과(화이트리스트)");
  }

  /* ── W 배선(촬영 현황) — 렌더 고아 0 ── */
  {
    ok(/51_Coverage\.js/.test(src.manifest), "W manifest 에 51_Coverage");
    ok(/Coverage\.decorate\(\)/.test(src.uiSrc) && /Coverage\.treeBadgeHtml\(deck\)/.test(src.uiSrc), "W 11_UI — 핀 데코·트리 배지");
    ok(/Coverage\.renderAllPinsSummary\(this\._scopedPins\(\)\)/.test(src.allpins), "W 21_AllPins — 전체 포인트 패널 요약(같은 범위 SoT)");
    ok(/id: "coverage"/.test(src.menu) && /"coverage":/.test(src.help), "W 45_FeatureMenu·36_Help — 촬영 현황 등록");
    ok(/Coverage\.init\(\)/.test(src.footer) && /data-pinfo-stale/.test(src.pinfo), "W 초기화 · 프로젝트 정보 기준 일수 입력");
  }
  return fails;
}

const MUT = [
  ["M6 오래됨 경계 > → >=", "cov", "(now - t) > n * this.DAY_MS", "(now - t) >= n * this.DAY_MS"],
  ["M7 구역 집계 SoT 우회(State.pins 전체)", "cov", "const pins = Projects.pinsForDeck(State.pins || [], deck);", "const pins = State.pins || [];"],
  ["M8 CHECKER 핀 포함", "cov", '(typeof PinSeries === "undefined" || PinSeries.seriesOf(pin) === "content")', "true"]
];
const fails = await suite(BASE, false);
const mutBad = await runMutations(BASE, MUT, suite);
const total = fails.length + mutBad;
console.log(total ? "\n" + total + " FAIL" : "\nALL PASS");
process.exit(total ? 1 : 0);
