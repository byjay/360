/**
 * p72 — 서비스워커 미디어 캐시 용량 자동 정리 (원장 AC-2)
 * (프레임워크 0 · 실행: node tests/p72-sw-cache-trim.test.mjs)
 *
 * 배경: public/sw.js:48(구버전) — activate 시 옛 캐시 "이름"만 청소할 뿐, 미디어(360 사진/도면,
 *   /api/r2/object/* )가 앱셸과 같은 캐시(wm-shell-v16)에 무제한 누적됐다. 모바일에서 사진을
 *   많이 볼수록 폰 저장공간이 끝없이 찬다.
 *
 * 구현 요약(public/sw.js):
 *  · 미디어를 MEDIA_CACHE('wm-media-v1')로 분리(앱셸 CACHE='wm-shell-v17'와 별개).
 *  · selectEvictions(entries, limit) — 순수 함수. entries=[{key,order,protected}], order 오름차순
 *    = 오래된 것. protected 항목은 상한 초과여도 삭제 후보에서 제외.
 *  · trimMediaCache() — MEDIA_CACHE.keys() 순서를 삽입순 FIFO로 취급, navigator.storage.estimate()
 *    로 여유 20% 미만이면 상한을 60→20으로 낮춰 더 공격적으로 정리(미지원 시 기본 60 유지 = 폴백).
 *  · 오프라인 "프로젝트 다운로드"(32_Offline.js)는 IndexedDB(SyncQueue)만 쓰고 이 SW를 거치는
 *    /tables/* 요청은 isApi()가 걸러 애초에 이 캐시에 들어오지 않는다 — 구조적으로 보호됨.
 *
 * 검사:
 *  ① 상한 이하 → 삭제 0
 *  ② 상한 초과 → 오래된 것부터 초과분만 삭제
 *  ③ protected(앱셸/wm-shared/오프라인 다운로드 대용) 항목은 상한 초과여도 삭제 안 됨
 *  ④ storage.estimate 미지원 → 기본 개수 상한(60)으로 폴백(공격모드 20 미적용)
 *  ⑤ storage.estimate 여유<20% → 공격 상한(20) 적용(보너스 확인)
 *
 * 뮤테이션 2건, 각 EXIT=1 확인 후 원복:
 *  ⓐ protected 필터 제거(`entries.filter((e) => !e.protected)` → `entries`) → ③이 실패해야 함
 *  ⓑ 정렬 방향 반전(`a.order - b.order` → `b.order - a.order`) → ②가 실패해야 함
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SW_PATH = path.join(ROOT, "public/sw.js");
const rd = () => fs.readFileSync(SW_PATH, "utf8").replace(/\r\n/g, "\n");

let failed = 0;
const ok = (cond, label) => {
  console.log((cond ? "  PASS " : "  FAIL ") + label);
  if (!cond) failed++;
};
const mustPatch = (before, after, what) => {
  if (before === after) { console.log("  FAIL 뮤테이션 패치 대상을 찾지 못함: " + what); failed++; return false; }
  return true;
};

/* ══ sw.js 를 vm 샌드박스에 로드하고 selectEvictions/trimMediaCache 를 꺼낸다 ══ */
function loadSW(source, { navStorage } = {}) {
  const mediaStore = new Map(); // url -> true
  const cacheObj = {
    async keys() {
      return Array.from(mediaStore.keys()).map((url) => ({ url }));
    },
    async delete(reqLike) {
      const url = reqLike && reqLike.url;
      return mediaStore.delete(url);
    },
    async put(req) { mediaStore.set(typeof req === "string" ? req : req.url, true); },
    async match() { return undefined; },
  };
  const sandbox = {
    self: {
      addEventListener() {},
      navigator: navStorage === undefined ? {} : { storage: navStorage },
    },
    caches: { open: async () => cacheObj },
    console,
  };
  vm.createContext(sandbox);
  const appended = source + "\n;globalThis.__SW_TEST = { selectEvictions, trimMediaCache, MEDIA_CACHE, MEDIA_CACHE_MAX_ENTRIES, MEDIA_CACHE_MAX_ENTRIES_LOW_STORAGE, STORAGE_LOW_RATIO };";
  vm.runInContext(appended, sandbox);
  return { api: sandbox.__SW_TEST, mediaStore };
}

/* ══ ① ② ③ — 순수 함수 selectEvictions ══════════════════════════════ */
{
  const src = rd();
  const { api } = loadSW(src);
  const { selectEvictions } = api;

  // ① 상한 이하 → 삭제 0
  const under = [
    { key: "a", order: 0, protected: false },
    { key: "b", order: 1, protected: false },
  ];
  ok(selectEvictions(under, 5).length === 0, "① 상한(5) 이하(2개) → 삭제 0");

  // ② 상한 초과 → 오래된 것부터 초과분만 삭제 (5개 중 상한 3 → 가장 오래된 2개: order 0,1)
  const over = [
    { key: "k2", order: 2, protected: false },
    { key: "k0", order: 0, protected: false },
    { key: "k4", order: 4, protected: false },
    { key: "k1", order: 1, protected: false },
    { key: "k3", order: 3, protected: false },
  ];
  const evicted = selectEvictions(over, 3);
  ok(evicted.length === 2, "② 상한 초과(5→3) → 삭제 개수 = 초과분(2) → " + evicted.length);
  ok(
    evicted.every((k) => k === "k0" || k === "k1") && evicted.length === 2,
    "② 삭제 대상 = 가장 오래된 순(order 0,1) → " + JSON.stringify(evicted)
  );

  // ③ protected 항목은 상한 초과여도 삭제 안 됨(앱셸/wm-shared/오프라인 다운로드 대용)
  const withProtected = [
    { key: "shell", order: 0, protected: true },   // 가장 오래됐지만 보호
    { key: "shared", order: 1, protected: true },  // 보호
    { key: "m1", order: 2, protected: false },
    { key: "m2", order: 3, protected: false },
    { key: "m3", order: 4, protected: false },
  ];
  const evicted2 = selectEvictions(withProtected, 1); // 미디어(비보호) 3개 중 상한 1 → 2개 삭제
  ok(
    !evicted2.includes("shell") && !evicted2.includes("shared"),
    "③ protected 항목은 상한 초과여도 삭제 후보에서 제외 → " + JSON.stringify(evicted2)
  );
  ok(evicted2.length === 2 && evicted2.includes("m1") && evicted2.includes("m2"),
    "③ 비보호 항목만 오래된 순으로 초과분 삭제 → " + JSON.stringify(evicted2));
}

/* ══ ④ storage.estimate 미지원 → 기본 상한(60) 폴백 ══════════════════ */
{
  const src = rd();
  const { api, mediaStore } = loadSW(src, { navStorage: undefined }); // self.navigator = {} (storage 없음)
  for (let i = 0; i < 25; i++) mediaStore.set("/api/r2/object/img" + i, true); // 25개 (60 미만, 20 초과)
  await api.trimMediaCache();
  ok(mediaStore.size === 25, "④ storage.estimate 미지원 → 기본상한(60) 적용, 25개는 그대로 유지 → " + mediaStore.size);
}

/* ══ ⑤(보너스) storage.estimate 여유<20% → 공격 상한(20) 적용 ═══════ */
{
  const src = rd();
  const lowStorage = { estimate: async () => ({ usage: 950, quota: 1000 }) }; // 여유 5% < 20%
  const { api, mediaStore } = loadSW(src, { navStorage: lowStorage });
  for (let i = 0; i < 25; i++) mediaStore.set("/api/r2/object/img" + i, true); // 25개 (공격상한 20 초과)
  await api.trimMediaCache();
  ok(mediaStore.size === 20, "⑤ 저장공간 여유<20% → 공격상한(20)까지 정리 → " + mediaStore.size);
}

/* ══ 뮤테이션 ⓐ protected 필터 제거 → ③이 실패해야 함 ═══════════════ */
{
  const src = rd();
  const before = "const trimmable = entries.filter((e) => !e.protected);";
  const after = "const trimmable = entries;";
  if (mustPatch(before, after, "ⓐ protected 필터 제거")) {
    const patched = src.replace(before, after);
    const { api } = loadSW(patched);
    const withProtected = [
      { key: "shell", order: 0, protected: true },
      { key: "shared", order: 1, protected: true },
      { key: "m1", order: 2, protected: false },
    ];
    const evicted = api.selectEvictions(withProtected, 1);
    const stillProtects = !evicted.includes("shell") && !evicted.includes("shared");
    ok(!stillProtects, "ⓐ 뮤테이션 후 protected 보호 실패해야 함(EXIT=1 기대) → " + JSON.stringify(evicted));
  }
}

/* ══ 뮤테이션 ⓑ 정렬 방향 반전 → ②가 실패해야 함 ════════════════════ */
{
  const src = rd();
  const before = ".sort((a, b) => a.order - b.order)";
  const after = ".sort((a, b) => b.order - a.order)";
  if (mustPatch(before, after, "ⓑ 정렬 방향 반전")) {
    const patched = src.replace(before, after);
    const { api } = loadSW(patched);
    const over = [
      { key: "k2", order: 2, protected: false },
      { key: "k0", order: 0, protected: false },
      { key: "k4", order: 4, protected: false },
      { key: "k1", order: 1, protected: false },
      { key: "k3", order: 3, protected: false },
    ];
    const evicted = api.selectEvictions(over, 3);
    const correct = evicted.length === 2 && evicted.every((k) => k === "k0" || k === "k1");
    ok(!correct, "ⓑ 뮤테이션 후 오래된순 삭제 실패해야 함(EXIT=1 기대) → " + JSON.stringify(evicted));
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
