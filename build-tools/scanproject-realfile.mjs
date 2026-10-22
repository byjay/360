#!/usr/bin/env node
/**
 * 실폴더 런타임 검증 — [WO 20261022-scanproject] SCENE 프로젝트 최상위 폴더를 지정했을 때
 * 60_PhotoFolder.js(_listEntries 재귀·_dedupeByName·_scanSummaryLine)와 같은 규칙(이름만
 * node:fs 로 재귀 열거 — FileSystemDirectoryHandle 은 node 에 없어 브라우저 API 를 직접 쓸 수
 * 없다, "node fs 로 같은 규칙" 허용분, 발주서 §검증)으로 하위의 스캔(.fls/.e57)·360 사진을
 * 찾아 개수·소요시간을 보고한다. 내용은 읽지 않고 이름(stat)만 본다.
 *
 * 실행(E: 안에서, TEMP/TMP 지정 — CLAUDE.md §G-5):
 *   TEMP=E:\code-project\360\.tmp TMP=E:\code-project\360\.tmp node build-tools/scanproject-realfile.mjs "<SCENE 프로젝트 최상위 폴더>"
 */
import fs from "node:fs";
import path from "node:path";

const EXT_RE = /\.(jpe?g|png|heic|e57|fls)$/i; // 60_PhotoFolder._EXT_RE 와 동일
const MAX_DEPTH = 8, MAX_DIRS = 20000;

const root = process.argv[2];
if (!root) { console.error("사용법: node scanproject-realfile.mjs <SCENE 프로젝트 최상위 폴더>"); process.exit(1); }
if (!fs.existsSync(root)) { console.error("폴더 없음: " + root); process.exit(1); }

function revisionNum(relPath) {
  const m = /Revisions[\\/](\d+)[\\/]/i.exec(relPath || "");
  return m ? parseInt(m[1], 10) : -1;
}

function walk(dir, relPrefix, depth, out, dirCountRef) {
  if (depth > MAX_DEPTH || dirCountRef.n >= MAX_DIRS) return;
  dirCountRef.n++;
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (e) { return; }
  for (const it of items) {
    const abs = path.join(dir, it.name);
    const rel = relPrefix + it.name;
    if (it.isDirectory()) {
      if (/\.fls$/i.test(it.name)) continue; // 레거시 원본 스캔 디렉터리 — 재귀 제외(60_PhotoFolder 와 동일)
      walk(abs, rel + "/", depth + 1, out, dirCountRef);
    } else if (it.isFile() && EXT_RE.test(it.name)) {
      let mtime = 0;
      try { mtime = fs.statSync(abs).mtimeMs; } catch (e) {}
      out.push({ name: it.name, relPath: rel, lastModified: mtime });
    }
  }
}

function dedupeByName(entries) {
  const groups = new Map();
  entries.forEach((en) => { if (!groups.has(en.name)) groups.set(en.name, []); groups.get(en.name).push(en); });
  const out = [];
  for (const list of groups.values()) {
    if (list.length === 1) { out.push(list[0]); continue; }
    const withRev = list.map((en) => ({ en, rev: revisionNum(en.relPath) }));
    const maxRev = Math.max(...withRev.map((x) => x.rev));
    let cands = (maxRev > -1) ? withRev.filter((x) => x.rev === maxRev).map((x) => x.en) : list;
    let chosen = cands[0];
    if (cands.length > 1) chosen = cands.slice().sort((a, b) => b.lastModified - a.lastModified)[0];
    chosen._dupTotal = list.length;
    out.push(chosen);
  }
  return out;
}

const t0 = Date.now();
const raw = [];
walk(root, "", 0, raw, { n: 0 });
const entries = dedupeByName(raw);
const t1 = Date.now();

const scans = entries.filter((e) => /\.(e57|fls)$/i.test(e.name));
const photos = entries.filter((e) => /\.(jpe?g|png|heic)$/i.test(e.name));
const dupGroups = entries.filter((e) => e._dupTotal > 1);

console.log("폴더: " + root);
console.log("원시 매칭 파일(중복 포함): " + raw.length + "개");
console.log("중복 제거 후: " + entries.length + "개 (스캔 " + scans.length + " · 360 사진 " + photos.length + ")");
console.log("중복 그룹: " + dupGroups.length + "개");
console.log("소요시간: " + (t1 - t0) + "ms");
if (scans.length) console.log("스캔 위치 예시: " + scans[0].relPath);
