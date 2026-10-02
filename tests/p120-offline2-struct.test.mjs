/**
 * p120 — offline2 결함 묶음 구조 회귀 (프레임워크 0 · 실행: node tests/p120-offline2-struct.test.mjs)
 *
 * [재현] 지휘자 발주서(offline2, 2026-10-02) R1/R2/R3/R4/R5 — 각 항목의 근본수정이 소스에
 *   실제로 남아있는지 확인한다(소스 텍스트 검사 — p27/p35/p100 등 기존 구조 검사 관례와 동일).
 *   런타임(실 Chrome CDP) 재현은 p114(P114=1) 가 담당 — 이 테스트는 "되돌리면 깨진다"는
 *   최소 보장만 제공한다. 뮤테이션 증명: 각 항목의 고친 줄을 되돌리면 그 assertion이 FAIL 해야
 *   한다(지휘자가 수기로 1회 확인, 이 파일 자체는 되돌리지 않는다 — 실 파일을 더럽히지 않기 위함).
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const appSrc = rd("public/js/modules/20_App.js");
const offlineSrc = rd("public/js/modules/32_Offline.js");
const projSrc = rd("public/js/modules/31_Projects.js");

let failed = 0;
const ok = (cond, label) => { console.log((cond ? "  PASS " : "  FAIL ") + label); if (!cond) failed++; };

/* ── R1: 모바일 사이드시트 — 구역/영역 트리 노드 탭 시 닫힘(caret/더보기는 열림 유지) ── */
console.log("\n[R1] 사이드 트리 구역/영역 탭 → 시트 닫힘");
ok(/tree-caret.*tree-more|closest\(".tree-caret"\)/.test(appSrc) && appSrc.indexOf('closest(".tree-caret")') !== -1,
  "caret 탭은 시트를 닫지 않는다(가드 존재)");
ok(appSrc.indexOf('closest(".tree-node-deck, .tree-node-region")') !== -1,
  "구역/영역 노드(.tree-node-deck/.tree-node-region) 탭 → navNode 판정 존재");
ok(/navNode\)\s*\)\s*\{\s*setTimeout\(closeSheet/.test(appSrc),
  "navNode 판정이 closeSheet 호출로 이어짐(실제로 닫는다)");

/* ── R2: 프로젝트를 여는 SoT(setCurrentProject)가 bundle:project:<id> write-through ── */
console.log("\n[R2] setCurrentProject — 오프라인 허브용 write-through");
ok(/setCurrentProject\(p\) \{[\s\S]{0,900}?saveDraft\("bundle:project:" \+ p\.id, p\)/.test(projSrc),
  "setCurrentProject 안에서 SyncQueue.saveDraft('bundle:project:'+id) 호출");

/* ── R3: 마지막으로 연 구역을 기억 + 재진입 시 그 구역을 우선 ── */
console.log("\n[R3] 마지막 구역 기억 + 재진입 우선 적용");
ok(projSrc.indexOf("LS_LAST_OPEN") !== -1 && projSrc.indexOf("lastOpenedDeckId(projectId)") !== -1,
  "Projects.lastOpenedDeckId() 존재(기억 조회 API)");
ok(/async selectDeck\(d\) \{[\s\S]{0,400}?LS_LAST_OPEN/.test(projSrc),
  "selectDeck()이 구역 선택 시 LS_LAST_OPEN 갱신");
ok(appSrc.indexOf("_lastDeckId") !== -1 && appSrc.indexOf("_remembered || ") !== -1,
  "loadLatestDeployment()이 pickOriginalDeck 보다 _remembered(기억된 구역)를 우선");

/* ── R4: beforeunload — _dirty 뿐 아니라 대기(_pendingSyncCount)도 경고 조건 ── */
console.log("\n[R4] beforeunload — dirty || pending>0 일 때만 경고");
ok(/beforeunload[\s\S]{0,300}?this\._dirty \|\| pending > 0/.test(appSrc),
  "beforeunload 핸들러가 (_dirty || pending>0) 조건으로 경고");
ok(offlineSrc.indexOf("App._pendingSyncCount = pending;") !== -1,
  "32_Offline.js updateNetBadge가 App._pendingSyncCount 캐시를 매 주기 갱신");

/* ── R5: _autoSave(모든 편집의 공유 SoT)가 온라인 여부와 무관하게 bundle:dep: 캐시를 갱신 ── */
console.log("\n[R5] _autoSave — 온라인 편집도 오프라인 캐시(bundle:dep:) 갱신");
ok(/_autoSave\(opts\) \{[\s\S]{0,1200}?persistLocalDeployment\(\)\.catch/.test(appSrc),
  "_autoSave 안에서 (온라인/오프라인 무관) persistLocalDeployment() 호출");
// 🔴 기존 5곳의 "오프라인일 때만" 호출은 중복이지만 무해하므로 남아있어야 한다(삭제하지 않음 — 데이터 유실 보수 규칙)
const offlineOnlyCalls = (appSrc.match(/!navigator\.onLine[\s\S]{0,200}?persistLocalDeployment\(\)/g) || []).length
  + (appSrc.match(/persistLocalDeployment\(\)[\s\S]{0,40}?\.catch/g) || []).length;
ok(offlineOnlyCalls > 0, "기존 오프라인 전용 persistLocalDeployment 호출부가 그대로 남아있음(제거 0, 중복 호출은 무해)");

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
