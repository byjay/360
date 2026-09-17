// [WO 20260917 css-var-integrity] public/css/*.css 3개 파일 전체에서
// var(--x) 로 참조되는 커스텀 속성이 실제로 정의돼 있는지, 정의가 사용보다
// 캐스케이드 순서(파일 로드 순서: style → tokens → skin)상 앞에 오는지 검증한다.
// 폴백 형태 var(--x, 기본값)은 정의가 없어도 유효하므로 예외 처리한다(목록으로 출력).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// index.html <link> 순서 그대로(캐스케이드 순서) — style.css → seastar-family-tokens.css → seastar-3d-skin.css
const FILES = ["style.css", "seastar-family-tokens.css", "seastar-3d-skin.css"].map((f) => ({
  name: f,
  path: path.join(__dirname, "..", "public", "css", f),
}));

function stripComments(css) { return css.replace(/\/\*[\s\S]*?\*\//g, ""); }

const sources = FILES.map((f) => ({ name: f.name, css: stripComments(readFileSync(f.path, "utf8")) }));
const cascadeAll = sources.map((s) => s.css).join("\n");

/** var(--x) 참조 전체를 (이름, 폴백여부, 등장 오프셋[캐스케이드 전체 기준]) 로 수집. */
function collectUsages() {
  const usages = [];
  let offset = 0;
  for (const s of sources) {
    const re = /var\(\s*--([a-zA-Z0-9_-]+)\s*(,[^)]*)?\)/g;
    let m;
    while ((m = re.exec(s.css)) !== null) {
      usages.push({ name: m[1], hasFallback: !!m[2], file: s.name, offsetInFile: m.index, offsetGlobal: offset + m.index });
    }
    offset += s.css.length + 1; // "\n" 조인 보정
  }
  return usages;
}

/** --x: 정의 전체를 (이름, 등장 오프셋[캐스케이드 전체 기준]) 로 수집. */
function collectDefinitions() {
  const defs = [];
  let offset = 0;
  for (const s of sources) {
    const re = /(?:^|[;{\s])--([a-zA-Z0-9_-]+)\s*:/g;
    let m;
    while ((m = re.exec(s.css)) !== null) {
      defs.push({ name: m[1], file: s.name, offsetInFile: m.index, offsetGlobal: offset + m.index });
    }
    offset += s.css.length + 1;
  }
  return defs;
}

const usages = collectUsages();
const definitions = collectDefinitions();
const definedNames = new Set(definitions.map((d) => d.name));

const results = [];
const record = (name, pass, detail) => results.push({ name, pass, detail });

// ── ① 폴백 없는 var(--x) 참조는 전부 정의돼 있어야 한다 ──
const noFallbackUsages = usages.filter((u) => !u.hasFallback);
const fallbackUsages = usages.filter((u) => u.hasFallback);
const fallbackExempt = [...new Set(fallbackUsages.map((u) => u.name))].sort();

const undefinedNoFallback = noFallbackUsages.filter((u) => !definedNames.has(u.name));
const undefinedNames = [...new Set(undefinedNoFallback.map((u) => u.name))].sort();

record(
  "① var(--x) (폴백 없음) 참조는 전부 3파일 어딘가에 정의돼 있다",
  undefinedNoFallback.length === 0,
  `미정의: ${JSON.stringify(undefinedNames)} / 폴백으로 예외처리된 변수(${fallbackExempt.length}개): ${JSON.stringify(fallbackExempt)}`
);

// ── ② 정의가 사용보다 캐스케이드 순서상 앞선다(각 사용에 대해 그 이전에 같은 이름의 정의가 최소 1개 존재) ──
const outOfOrder = [];
for (const u of noFallbackUsages) {
  const priorDef = definitions.find((d) => d.name === u.name && d.offsetGlobal < u.offsetGlobal);
  if (!priorDef) outOfOrder.push(`--${u.name} (사용: ${u.file}@${u.offsetInFile})`);
}
record(
  "② 정의가 사용보다 캐스케이드 순서(파일 로드 순서)상 앞에 온다",
  outOfOrder.length === 0,
  outOfOrder.length === 0 ? "전건 순서 정상" : `순서 위반: ${JSON.stringify(outOfOrder)}`
);

for (const r of results) {
  const mark = r.pass ? "PASS" : "FAIL";
  console.log(`[${mark}] ${r.name} :: ${r.detail}`);
}
const failCount = results.filter((r) => !r.pass).length;
if (failCount > 0) {
  console.error(`\n${failCount}건 실패`);
  process.exit(1);
} else {
  console.log(`\n전체 ${results.length}건 PASS`);
  process.exit(0);
}
