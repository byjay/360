/**
 * 회귀 테스트 — SCENE 프로젝트 최상위 폴더 지정 시 하위 폴더(Revisions/<N>/Scans/…)의 스캔(.fls/.e57)·
 * 360 사진을 재귀로 찾아 번호 매칭 대상에 올리는 기능 (프레임워크 0 · 실행: node tests/p180-scanproject-recursive.test.mjs)
 *
 * [재현] R1~R2(지휘자 실측, 발주서) — Z: 실제 SCENE 프로젝트 구조는 최상위에 @preview.jpg·*.lsproj 등,
 * 스캔 200개는 Revisions/1/Scans/scan_0.fls~scan_199.fls(+E57_scan_0.fls)에만 있고 같은 폴더에
 * *.fls.cache(OLE2, 동일 이름+.cache) 200개가 섞여 있다. Revisions/2·3/Scans 는 비어 있음(실제로는).
 * 기존 _listEntries(handle 모드, 최상위 1단만 values() 열거)는 이 구조에서 0개를 돌려줬다
 * (public/js/modules/60_PhotoFolder.js:329-345, 발주서 R2).
 *
 * 대상: 60_PhotoFolder.js — _listEntries(재귀+_EXT_RE 필터)·_dedupeByName(Revisions/<N> 최대 우선,
 * 동률이면 lastModified 최신)·_revisionNum·_scanSummaryLine·previewBatch(rows.scanSummary).
 * 실 모듈 소스를 vm 에 그대로 평가한다(재구현 금지, 목 아님).
 */
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const PF_SRC = rd("public/js/modules/60_PhotoFolder.js");

let failed = 0;
const ok = (cond, label, detail) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (detail != null && !cond ? " :: " + JSON.stringify(detail).slice(0, 500) : "")); if (!cond) failed++; };

/* ══════════════════════════════════════════════════════════════
   가짜 FileSystemDirectoryHandle/FileSystemFileHandle 트리(R1 구조 축소판)
   root/
     Revisions/
       1/Scans/ scan_0.fls(lastModified=1000) · scan_10.fls(lastModified=5000, 구버전) · scan_10.fls.cache(제외 대상)
       3/Scans/ scan_10.fls(lastModified=2000, 리비전 번호가 더 커 — mtime 더 오래돼도 이게 선택돼야 함)
     WorkspaceData/ x.dat(제외 대상)
     @preview.jpg(최상위, 360 사진 대상)
   ══════════════════════════════════════════════════════════════ */
function fileHandle(name, lastModified) {
  return { kind: "file", name, getFile: async () => ({ name, lastModified, arrayBuffer: async () => new ArrayBuffer(0) }) };
}
function dirHandle(name, children) {
  return { kind: "directory", name, async *values() { for (const c of children) yield c; } };
}
function buildRoot() {
  return dirHandle("root", [
    dirHandle("Revisions", [
      dirHandle("1", [
        dirHandle("Scans", [
          fileHandle("scan_0.fls", 1000),
          fileHandle("scan_10.fls", 5000),       // 구버전(리비전1) — mtime 은 더 최신이지만 리비전 번호가 낮음
          fileHandle("scan_10.fls.cache", 9999)   // _EXT_RE 비대상 — 제외돼야 함
        ])
      ]),
      dirHandle("3", [
        dirHandle("Scans", [
          fileHandle("scan_10.fls", 2000)         // 리비전3 — mtime 더 오래돼도 리비전 번호가 커 선택돼야 함
        ])
      ])
    ]),
    dirHandle("WorkspaceData", [
      fileHandle("x.dat", 1)                      // _EXT_RE 비대상 — 제외돼야 함
    ]),
    fileHandle("@preview.jpg", 1)                 // 360 사진 대상(최상위)
  ]);
}

function makeLocalStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

/** 60_PhotoFolder.js 를 vm 에 그대로 평가(실 소스, 목 아님). */
function loadPF(src, opts = {}) {
  const uploadCalls = [];
  const State = Object.assign({ pins: [], pdfPage: 1, checkboard: true, regMode: "photo" }, opts.state || {});
  const Auth = { readonly: false };
  const PinSeries = Object.assign({
    seriesOf: (p) => (p && p.checkboard) ? "checkboard" : "content",
    mediaOf: (p) => !!(p && (p.imageId || p.pendingOpId)),
    formatNo: (no) => String(no),
    numbers: (pins, page) => new Map()
  }, opts.pinSeries || {});
  const App = { _detect360: (file, cb) => cb(true, 4096, 2048) };
  const PhotoBatch = {
    _usedPhotoNames: () => new Set(),
    _uploadOneRow: async (pin, row) => { uploadCalls.push({ pinId: pin.id, name: row.name }); pin.imageId = "img_" + row.name; return { status: "done" }; },
    _markUnsaved: () => {}
  };
  const UI = { renderPinList: () => {}, renderPinsOnMap: () => {} };
  const Prompt = { toast: () => {} };
  const Projects = Object.assign({ currentProject: { id: "projT" }, currentDeck: null, decks: [], pinsForDeck: (pins) => pins }, opts.projects || {});
  const document = { getElementById: () => null, body: { appendChild() {} }, querySelector: () => null, createElement: () => ({ style: {} }) };
  const sandbox = {
    console, Map, Set, Promise, Buffer, File, Blob, TextEncoder, TextDecoder,
    document, window: { showDirectoryPicker: undefined, document },
    localStorage: makeLocalStorage(), State, Auth, PinSeries, App, PhotoBatch, UI, Prompt, Projects,
    SyncQueue: undefined, THREE: undefined, Cloud: undefined, FLS: undefined, FlsPano: undefined
  };
  vm.createContext(sandbox);
  vm.runInContext(src + "\n;globalThis.__PF = PhotoFolder;", sandbox);
  return { PF: sandbox.__PF, uploadCalls, State };
}

/* ══════════════════════════════════════════════════════════════
   ① _listEntries(handle 모드, 재귀) — scan_0·scan_10(Revisions/3 선택)·@preview.jpg 만, cache·dat 제외
   ══════════════════════════════════════════════════════════════ */
console.log("\n[① _listEntries 재귀 — 스캔 2개 + 사진 1개, cache/dat 제외]");
let entries;
{
  const { PF } = loadPF(PF_SRC);
  PF._entry("__root__").mode = "handle";
  PF._entry("__root__").dirHandle = buildRoot();
  PF._entry("__root__").permGranted = true;

  entries = await PF._listEntries("__root__");
  const names = entries.map((e) => e.name).sort();
  ok(names.length === 3 && names.join(",") === "@preview.jpg,scan_0.fls,scan_10.fls",
    "①a 재귀 열거 결과(최상위 1단만 보던 기존 버전은 0개) — " + JSON.stringify(names));
  ok(!entries.some((e) => /\.cache$/i.test(e.name)), "①b scan_10.fls.cache 제외(_EXT_RE 비대상)");
  ok(!entries.some((e) => e.name === "x.dat"), "①c x.dat 제외(_EXT_RE 비대상)");

  const scan10 = entries.find((e) => e.name === "scan_10.fls");
  ok(!!scan10 && /Revisions\/3\/Scans\//.test(scan10.relPath), "①d 중복 scan_10.fls → Revisions/3 선택(리비전 번호 우선, mtime 무시) — relPath=" + (scan10 && scan10.relPath));
  ok(scan10 && scan10._dupTotal === 2 && scan10._dupNote === "Revisions/3", "①e 중복 메타 _dupTotal=2 _dupNote=Revisions/3 — " + JSON.stringify(scan10 && { t: scan10._dupTotal, n: scan10._dupNote }));
}

/* ══════════════════════════════════════════════════════════════
   ② _scanSummaryLine — "스캔 2개 발견" + "이미지 1개(번호 없음 — 매칭 제외 1개)"
   [WO 20261022-smallfixes R2] @preview.jpg 는 확장자만으로 360 여부를 알 수 없고(2:1 판정 전)
   파일명 끝에 숫자가 없어 매칭 대상도 아니다 — "360 사진"이라 부르지 않고 그 사실을 그대로 드러낸다.
   ══════════════════════════════════════════════════════════════ */
console.log("\n[② _scanSummaryLine — 요약 1줄]");
{
  const { PF } = loadPF(PF_SRC);
  const line = PF._scanSummaryLine(entries);
  ok(/스캔 2개\(\.fls\/\.e57\) 발견/.test(line), "②a 스캔 2개(.fls/.e57) 발견 — " + line);
  ok(/위치/.test(line), "②b 위치 표기 포함 — " + line);
  ok(/이미지 1개/.test(line), "②c 이미지 1개(360 이라 단정하지 않음) — " + line);
  ok(!/360 사진/.test(line), "②c-2 '360 사진' 문구를 쓰지 않는다(2:1 미판정) — " + line);
  ok(/번호 없음 — 매칭 제외 1개/.test(line), "②e @preview.jpg(번호 없음) → 매칭 제외 1개 안내 — " + line);

  const zero = PF._scanSummaryLine([]);
  ok(zero === "이 폴더 하위에 스캔(.fls/.e57)·이미지가 없습니다", "②d 0건이면 정직한 안내문 — " + zero);
}

/* ══════════════════════════════════════════════════════════════
   ③ findMatches — 10번 핀 ↔ scan_10.fls(Revisions/3) 매칭
   ══════════════════════════════════════════════════════════════ */
console.log("\n[③ findMatches — 10번 핀 매칭]");
{
  const { PF } = loadPF(PF_SRC);
  const m = PF.findMatches(10, entries);
  ok(m.length === 1 && m[0].name === "scan_10.fls" && /Revisions\/3\//.test(m[0].relPath),
    "③ 10번 핀 → scan_10.fls(Revisions/3) 1건 매칭 — " + JSON.stringify(m.map((e) => ({ name: e.name, relPath: e.relPath }))));
}

/* ══════════════════════════════════════════════════════════════
   ④ previewBatch 통합 — rows.scanSummary + 10번 핀 "일치"
   ══════════════════════════════════════════════════════════════ */
console.log("\n[④ previewBatch — rows.scanSummary + 10번 핀 일치]");
{
  const numbersMock = () => new Map([["p10", { no: 10 }]]);
  const { PF } = loadPF(PF_SRC, { state: { pins: [{ id: "p10", page: 1 }] }, pinSeries: { numbers: numbersMock } });
  PF._entry("__root__").mode = "handle";
  PF._entry("__root__").dirHandle = buildRoot();
  PF._entry("__root__").permGranted = true;

  const rows = await PF.previewBatch("__root__", null);
  ok(rows.length === 1 && rows[0].status === "일치" && rows[0].candidates[0].name === "scan_10.fls",
    "④a previewBatch: 10번 핀 ↔ scan_10.fls 일치 — " + JSON.stringify(rows.map((r) => r.status)));
  ok(typeof rows.scanSummary === "string" && /스캔 2개\(\.fls\/\.e57\) 발견/.test(rows.scanSummary), "④b rows.scanSummary 부착 — " + rows.scanSummary);
}

/* ══════════════════════════════════════════════════════════════
   ② fallback(webkitdirectory) 모드도 같은 규칙(webkitRelativePath 기준)
   ══════════════════════════════════════════════════════════════ */
console.log("\n[⑤ fallback 모드 — webkitRelativePath 기준 동일 규칙]");
{
  const { PF } = loadPF(PF_SRC);
  const mk = (name, relPath, lastModified) => ({ name, webkitRelativePath: relPath, lastModified, arrayBuffer: async () => new ArrayBuffer(0) });
  PF._entry("__root__").mode = "fallback";
  PF._entry("__root__").fallbackFiles = [
    mk("scan_0.fls", "root/Revisions/1/Scans/scan_0.fls", 1000),
    mk("scan_10.fls", "root/Revisions/1/Scans/scan_10.fls", 5000),
    mk("scan_10.fls.cache", "root/Revisions/1/Scans/scan_10.fls.cache", 9999),
    mk("scan_10.fls", "root/Revisions/3/Scans/scan_10.fls", 2000),
    mk("x.dat", "root/WorkspaceData/x.dat", 1),
    mk("@preview.jpg", "root/@preview.jpg", 1)
  ];
  const fEntries = await PF._listEntries("__root__");
  const names = fEntries.map((e) => e.name).sort();
  ok(names.length === 3 && names.join(",") === "@preview.jpg,scan_0.fls,scan_10.fls",
    "⑤a fallback 모드 동일 결과 — " + JSON.stringify(names));
  const s10 = fEntries.find((e) => e.name === "scan_10.fls");
  ok(!!s10 && /Revisions\/3\//.test(s10.relPath), "⑤b fallback 모드도 Revisions/3 선택 — " + (s10 && s10.relPath));
}

/* ══════════════════════════════════════════════════════════════
   뮤테이션 증명 A — 재귀 제거 시 0개로 깨져야 함(스캔 기준)
   ══════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션 A] 재귀 호출 제거 시 하위 스캔이 0개로 깨져야 함");
{
  const needle = 'await walk(entry, relPrefix + entry.name + "/", depth + 1);';
  const mutated = PF_SRC.replace(needle, '/* mutated: no recursion */ void entry; void relPrefix; void depth;');
  if (mutated === PF_SRC) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PF } = loadPF(mutated);
    PF._entry("__root__").mode = "handle";
    PF._entry("__root__").dirHandle = buildRoot();
    PF._entry("__root__").permGranted = true;
    const mutEntries = await PF._listEntries("__root__");
    const scans = mutEntries.filter((e) => /\.(fls|e57)$/i.test(e.name));
    ok(scans.length === 0, "재귀 제거 시 하위(Revisions/…)의 스캔 2개가 0개로 깨짐 → got " + scans.length + " :: " + JSON.stringify(mutEntries.map((e) => e.name)));
  }
}

/* ══════════════════════════════════════════════════════════════
   뮤테이션 증명 B — 중복 제거(_dedupeByName) 생략 시 scan_10.fls 가 2개로 깨져야 함
   ══════════════════════════════════════════════════════════════ */
console.log("\n[뮤테이션 B] _dedupeByName 생략 시 scan_10.fls 중복 2개로 깨져야 함");
{
  const needle = "await walk(e.dirHandle, \"\", 0);\n        return await this._dedupeByName(out);";
  const mutated = PF_SRC.replace(needle, 'await walk(e.dirHandle, "", 0);\n        return out; /* mutated: dedupe skipped */');
  if (mutated === PF_SRC) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함(소스 변경?)"); failed++; }
  else {
    const { PF } = loadPF(mutated);
    PF._entry("__root__").mode = "handle";
    PF._entry("__root__").dirHandle = buildRoot();
    PF._entry("__root__").permGranted = true;
    const mutEntries = await PF._listEntries("__root__");
    const dupCount = mutEntries.filter((e) => e.name === "scan_10.fls").length;
    ok(dupCount === 2, "중복 제거 생략 시 scan_10.fls 가 2개로 깨짐 → got " + dupCount);
  }
}

console.log("\n" + (failed === 0 ? "ALL PASS" : failed + " FAILED"));
process.exit(failed === 0 ? 0 : 1);
