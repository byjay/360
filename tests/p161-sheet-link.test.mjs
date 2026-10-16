/**
 * p161 — 도면 간 핀 번호 연결(시트 묶음 번호 공간 · pin.linkId) + 영숫자 핀 번호(A1 / ER-12 / B2-05)
 * 프레임워크 0 · 실행: TEMP=<repo>\.tmp TMP=<repo>\.tmp node tests/p161-sheet-link.test.mjs
 *
 * 설계 정본: .tmp/design-multisheet.md §2(P2·P3·P4) / §3(P5) / §4-4·4-5. WO 20261016-multisheet.
 * 마스터: "플랜 섹션 엘리베이션이 있을 때 똑같은 핀 번호를 플랜 상에도 표기하고 엘리베이션 상에도 같이 매칭할 수 있는
 *   그런 옵션 체크 기능으로 구현해" / "핀번호는 순수숫자외 알파벳+숫자조합도 설정가능하게해".
 * 지휘자 재현 .tmp/repro-p2.cjs(EXIT=1: page1·page3 각자 1번, linkId·scopePages 0, num_prefix 0)를 이 파일 R0 가 대체한다
 *   — 연결 ON 기준으로 판정이 반전(같은 번호 공간 · 연결 경로 · 서버 num_prefix)돼야 PASS.
 *
 * 실 소스 vm(재구현 0): 01b_PinSeries · 66_PinLink · 31_Projects · 20_App(_mergePins/deletePin) · 60_PhotoFolder ·
 *   50_QrLink · 51_Coverage · 56_Delivery · 21_AllPins. 서버 = 실 워커(src/index.tsx esbuild) + 실 D1(Miniflare, 전 migration 0049 포함).
 * 기준선(연결 OFF 무변경 보장) = 커밋 09e52bb 의 01b_PinSeries.js 원문(git show) — 같은 입력에 대해 결과가 같아야 한다.
 *
 * 뮤테이션(P161_MUT=<이름>, 각 EXIT=1 이어야 통과 · 대상 문자열 없으면 EXIT=2):
 *   M1 scope-always-group  M2 dup-ignore-link  M3 match-no-prefix  M4 delete-head-only
 *   M5 repair-noop         M6 reset-drop-prefix M7 rx-greedy
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { Miniflare } from "miniflare";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const rd = (p) => fs.readFileSync(path.join(ROOT, p), "utf8").replace(/\r\n/g, "\n");
const M = "public/js/modules/";
const SRC = {
  series: rd(M + "01b_PinSeries.js"), link: rd(M + "66_PinLink.js"), proj: rd(M + "31_Projects.js"),
  app: rd(M + "20_App.js"), pf: rd(M + "60_PhotoFolder.js"), qr: rd(M + "50_QrLink.js"), cov: rd(M + "51_Coverage.js"),
  del: rd(M + "56_Delivery.js"), ap: rd(M + "21_AllPins.js"), srv: rd("src/index.tsx"),
};
const MUTS = {
  "scope-always-group": ["proj", "      const bundle = this.sheetBundleOf(cur);\n      if (!bundle) return [pg];", "      const bundle = this.sheetBundleOf(cur) || this._deckChain(cur)[1] || cur;\n      if (!bundle) return [pg];"],
  "dup-ignore-link":    ["series", "const units = new Set(list.map(p => this._unitKey(p)));", "const units = new Set(list.map(p => String(p.id)));"],
  "match-no-prefix":    ["pf", "const keep = base.filter((e) => fk(e) === mine);", "const keep = base;"],
  "delete-head-only":   ["link", "if (this.isHead(p)) return this.groupIds(pins, p);", ""],
  "repair-noop":        ["link", "    repair(pins) {\n", "    repair(pins) { return { pins: pins, removed: [], released: [], relabeled: [] };\n"],
  "reset-drop-prefix":  ["series", "newLabel: this.labelOf(pfxText.get(pf.key), start + i, sfxText.get(pf.key)) };", "newLabel: String(start + i) };"],
  // [WO 20261016-bulkedit] 번호 일괄 편집
  "bulk-no-dupcheck":   ["series", "changes.forEach((c) => { const k = keyOf(c.newLabel); if (k && count.get(k) > 1) { c.conflict = true; conflicts.add(c.id); } });", ""],
  "bulk-no-snapshot":   ["series", "        pin.numReset = { batch: String(batch), from: pin.label == null ? null : pin.label, fromManual: !!pin.labelManual, to: c.newLabel, at: t };\n", ""],
  "rx-greedy":          ["series", "LABEL_RX: /^\\s*(?:([A-Za-z]{1,6})([-_]?)|", "LABEL_RX: /^\\s*(?:([A-Za-z0-9]{1,6})([-_]?)|"],
};
const MUT = process.env.P161_MUT || "";
if (MUT) {
  const m = MUTS[MUT];
  if (!m) { console.log("알 수 없는 뮤테이션: " + MUT); process.exit(2); }
  if (!SRC[m[0]].includes(m[1])) { console.log("  FAIL 뮤테이션 대상 문자열을 찾지 못함: " + MUT); process.exit(2); }
  SRC[m[0]] = SRC[m[0]].replace(m[1], m[2]);
  console.log("[뮤테이션 적용] " + MUT);
}
let failed = 0;
const ok = (cond, label, d) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (!cond && d !== undefined ? " :: " + JSON.stringify(d).slice(0, 400) : "")); if (!cond) failed++; };
const J = (x) => JSON.stringify(x);

/* ── 클라이언트 샌드박스(실 소스) ───────────────────────────────────────────── */
function client(opts) {
  const o = opts || {};
  const toasts = [];
  const State = Object.assign({ pins: [], pdfPage: 1, mode: "designer", currentDeploymentId: null, autoSaveDepId: null, zoom: 1 }, o.state || {});
  const sb = {
    console, JSON, Map, Set, Math, Number, String, Array, Object, Date, RegExp, Promise, Error, parseInt, isFinite,
    State, navigator: { onLine: true }, location: { origin: "http://p161.test" },
    Prompt: { toast: (t) => toasts.push(t), confirm: async () => (o.confirm !== false), ask: async () => (o.ask || null) },
    UI: { $: () => null, renderPinsOnMap() {}, renderPinList() {}, escapeHtml: (s) => String(s) },
    Log: { push() {} }, OpLog: { recordCurrent() {} }, Zones: { refreshPinLinks() {} }, _revokeVideoBlob() {},
    Auth: { headers: () => (o.headers || {}), readonly: false, isDesigner: true },
    fetch: o.fetch || (async () => { throw new Error("no fetch"); }),
  };
  sb.window = sb; sb.globalThis = sb;
  vm.createContext(sb);
  vm.runInContext(SRC.series + "\n;globalThis.PinSeries = PinSeries;", sb);
  vm.runInContext(SRC.link, sb);
  if (o.projects !== false) vm.runInContext(SRC.proj + "\n;globalThis.Projects = Projects;", sb);
  if (o.app) vm.runInContext(SRC.app + "\n;globalThis.App = App;", sb);
  if (o.pf) vm.runInContext(SRC.pf + "\n;globalThis.PhotoFolder = PhotoFolder;", sb);
  if (o.consumers) {
    vm.runInContext(SRC.qr + "\n;globalThis.QrPrint = QrPrint;", sb);
    vm.runInContext(SRC.cov + "\n;globalThis.Coverage = Coverage;", sb);
    vm.runInContext(SRC.del + "\n;globalThis.Delivery = Delivery;", sb);
    vm.runInContext(SRC.ap + "\n;globalThis.AllPins = AllPins;", sb);
  }
  if (sb.Projects) { sb.Projects.decks = o.decks || []; sb.Projects.currentDeck = o.currentDeck || null; }
  return { sb, State, PS: sb.PinSeries, PL: sb.PinLink, Projects: sb.Projects, App: sb.App, PF: sb.PhotoFolder, toasts };
}
/** 기준선(09e52bb) 01b_PinSeries — 연결 기능 이전 원문. */
function legacySeries() {
  let src = null;
  try { src = execSync("git show 09e52bb:public/js/modules/01b_PinSeries.js", { cwd: ROOT, encoding: "utf8", maxBuffer: 1 << 26 }).replace(/\r\n/g, "\n"); } catch (e) { src = null; }
  if (!src) return null;
  const sb = { console, JSON, Map, Set, Math, Number, String, Array, Object, Date, RegExp, State: { pins: [], pdfPage: 1 } };
  vm.createContext(sb);
  vm.runInContext(src + "\n;globalThis.__PS = PinSeries;", sb);
  return sb.__PS;
}

/* 묶음 시트 구성: B(구역, 폴더) 아래 S1/S2/S3 = depA p1/p2/p3, X = depB p1(다른 파일) */
const decksOf = (link, prefix) => [
  { id: "B", name: "A DK", parent_id: null, deployment_id: null, page: null, sheet_link: link, num_prefix: prefix || null },
  { id: "S1", name: "A DK PLAN", parent_id: "B", deployment_id: "depA", page: 1 },
  { id: "S2", name: "A DK SECTION", parent_id: "B", deployment_id: "depA", page: 2 },
  { id: "S3", name: "A DK ELEVATION", parent_id: "B", deployment_id: "depA", page: 3 },
  { id: "X", name: "다른 파일", parent_id: "B", deployment_id: "depB", page: 1 },
];
const linkedClient = (pins, page, link, prefix, extra) => {
  const decks = decksOf(link, prefix);
  return client(Object.assign({ decks, currentDeck: decks.find((d) => d.page === page && d.deployment_id === "depA"), state: { pins, pdfPage: page, currentDeploymentId: "depA" } }, extra || {}));
};

/* ══ R0 — 지휘자 재현(repro-p2) 반전 ══ */
console.log("\n[R0 재현 반전 — 연결 ON: PLAN·ELEV 가 같은 번호 공간 + 연결 경로 존재 + 서버 num_prefix]");
{
  const pins = [{ id: "p1a", page: 1, label: "1" }];
  const c = linkedClient(pins, 3, 1);
  const nx = c.PS.nextInBand(c.State.pins, 3, "content", 1, 1);
  ok(J(c.PS.scopePages(3)) === "[1,2,3]", "R0 scopePages(3) = [1,2,3](연결 ON) — 실측 " + J(c.PS.scopePages(3)));
  ok(nx.no === 2, "R0 ELEV 새 핀 = 2(PLAN 1 과 같은 번호 공간 — 재현 시 1) — 실측 " + nx.no);
  ok(typeof c.PL.link === "function" && typeof c.PS.scopePages === "function", "R0 연결 경로(PinLink.link · PinSeries.scopePages) 존재");
  ok(/num_prefix/.test(SRC.srv) && /parseDeckSheetOpts/.test(SRC.srv), "R0 서버 num_prefix 저장 경로(parseDeckSheetOpts) 존재");
}

/* ══ U1 / N6 — 🔴 연결 OFF = 기준선과 결과 동일 ══ */
console.log("\n[U1·N6 연결 OFF(묶음 sheet_link=null) · Projects 없음 = 09e52bb 기준선과 결과 동일]");
{
  const L = legacySeries();
  ok(!!L, "U1 기준선 소스 로드(git show 09e52bb)");
  const fixture = () => [
    { id: 1, page: 1, label: "1", checkboard: true }, { id: 2, page: 1, label: "2" }, { id: 3, page: 1, label: "2", createdAt: 5 },
    { id: 4, page: 1, label: "Room A" }, { id: 5, page: 1, label: "012" }, { id: 6, page: 1, label: "7", checkboard: true, imageId: "i" },
    { id: 7, page: 2, label: "1" }, { id: 8, page: 2, label: "3", checkboard: true }, { id: 9, page: 2 }, { id: 10, page: 2, label: "105" },
    { id: 11, page: 3, label: "1" }, { id: 12, page: 3, label: "1", createdAt: 9 }, { id: 13, page: 3, label: "4", _deleted: true },
  ];
  const summarize = (PS, pins) => {
    const out = {};
    [1, 2, 3].forEach((pg) => {
      const nm = {}; PS.numbers(pins, pg).forEach((v, k) => { nm[k] = [v.no, v.kind, v.series]; });
      const nx = PS.nextInBand(pins, pg, "content", 1, 1);
      const nx2 = PS.nextInBand(pins, pg, "checkboard", 2, 101);
      const dup = Array.from(PS.duplicateNoIds(pins, pg)).sort();
      const rp = PS.resetPlan(pins, pg, { order: "no" });
      const vc = [PS.validateCheckboardLabel(pins, pg, 1, "2").ok, PS.validateCheckboardLabel(pins, pg, 1, "99").ok];
      out[pg] = { nm, nx: [nx.no, nx.full], nx2: [nx2.no], dup, rp: rp.ok ? rp.changes.map((c) => [c.id, c.newLabel, c.oldNo]) : rp.reason, rpc: rp.ok ? Array.from(rp.collisions).sort() : [], vc,
        last: PS.lastResetBatch(pins, pg) };
    });
    const cp = fixture();
    out.rc = PS.resolveConcurrentNos(cp, ["1", "2", "7", "11"], null).map((c) => [c.id, c.from, c.to]);
    out.rcLabels = cp.map((p) => p.label);
    return J(out);
  };
  const base = L ? summarize(L, fixture()) : "x";
  const a = client({ projects: false });
  const b = linkedClient(null, 2, null);   // 묶음은 있으나 연결 OFF
  const sa = summarize(a.PS, fixture());
  b.State.pins = fixture();
  const sbb = summarize(b.PS, b.State.pins);
  ok(J(b.PS.scopePages(2)) === "[2]", "U1 연결 OFF → scopePages(2) === [2] — 실측 " + J(b.PS.scopePages(2)));
  ok(sa === base, "U1 Projects 없음 — numbers/nextInBand/duplicateNoIds/resetPlan/validate/resolveConcurrentNos 기준선과 동일", sa === base ? undefined : { new: sa.slice(0, 300), base: base.slice(0, 300) });
  ok(sbb === base, "U1 🔴 묶음 있음·연결 OFF — 기준선과 동일(M1 이 깨뜨려야 한다)", sbb === base ? undefined : { new: sbb.slice(0, 300), base: base.slice(0, 300) });
  const m = a.PS.numbers(fixture(), 1).get(5);
  ok(m && m.text === "12" && a.PS.textOf(m) === "12" && a.PS.formatNo(12, "content") === "12", "N6 순수 숫자 표시 불변(012 → '12', formatNo 종전)");
}

/* ══ U2·U3 — 연결 ON 채번 · 연결 배치 ══ */
console.log("\n[U2·U3 연결 ON — 묶음 전체 최댓값+1 · [기존 번호에 연결] = 대표 번호 그대로]");
{
  const pins = [{ id: "a1", page: 1, label: "1", x: 10, y: 10 }, { id: "a2", page: 1, label: "2", x: 20, y: 20, imageId: "img-a2" }];
  const c = linkedClient(pins, 2, 1);
  ok(c.PS.nextInBand(c.State.pins, 2, "content", 1, 1).no === 3, "U2 p2 새 핀 = 3(페이지별이면 1)");
  c.PL.setMode("link");
  ok(c.PL._mode === "link" && c.PL._pending === "a1", "U3 [기존 번호에 연결] — 다음 미연결 번호 자동 제안 = 1(a1) — 실측 " + c.PL._pending);
  c.PL.choose("a2");
  const head = c.PL.takePending(c.State.pins, 2);
  ok(head && head.id === "a2", "U3 takePending = 고른 대표(a2)");
  const mem = { id: "b2", page: 2, x: 50, y: 50, label: "" };
  c.PL.link(c.State.pins, head, mem); c.State.pins.push(mem);
  ok(mem.linkId === "a2" && head.linkId === "a2" && mem.label === "2", "U3 linkId = 대표 id · label '2' 복사");
  const n1 = c.PS.numbers(c.State.pins, 1).get("a2"), n2 = c.PS.numbers(c.State.pins, 2).get("b2");
  ok(n1.no === 2 && n2.no === 2 && n1.text === n2.text, "U3 양쪽 numbers() 둘 다 2");
  ok(c.PS.markerStyle(mem).filled === true, "U3 🔴 대표 사진 공유 — 멤버 마커 filled(대표 imageId) ");
  ok(c.PL.headOf(c.State.pins, mem) === head, "U3 headOf(멤버) = 대표(팝업·파노가 대표 사진)");
  c.PL.advance(2);
  ok(c.PL._pending === "a1", "U3 연결 후 다음 미연결 번호(1)로 진행");
}

/* ══ U4 — 중복 2단 ══ */
console.log("\n[U4 duplicateNoIds — 같은 linkId = 1건 · 링크 밖 같은 번호 = 중복]");
{
  const pins = [{ id: "a2", page: 1, label: "2", linkId: "a2" }, { id: "b2", page: 2, label: "2", linkId: "a2" }];
  const c = linkedClient(pins, 1, 1);
  ok(c.PS.duplicateNoIds(c.State.pins, 1).size === 0 && c.PS.duplicateNoIds(c.State.pins, 2).size === 0, "U4(ㄱ) 링크 멤버만 → 중복 0건");
  c.State.pins.push({ id: "c2", page: 3, label: "2" });
  ok(c.PS.duplicateNoIds(c.State.pins, 3).has("c2") && c.PS.duplicateNoIds(c.State.pins, 1).has("a2"), "U4(ㄴ) 🔴 링크 밖 p3#2 와 그 그룹이 중복 표시");
  const v = c.PS.validateCheckboardLabel(c.State.pins, 2, "b2", "2");
  ok(v.ok === false, "U4 개별 번호 검증 — 링크 밖에 2 가 있으면 거부");
  c.State.pins.pop();
  ok(c.PS.validateCheckboardLabel(c.State.pins, 2, "b2", "2").ok === true, "U4 같은 연결 묶음의 같은 번호는 정상(거부 0)");
}

/* ══ U5 — 삭제(실 App.deletePin → _removePins) ══ */
console.log("\n[U5 삭제 — 대표 = 묶음 전체 · 멤버 = 그 멤버만]");
{
  const mk = () => [{ id: "a2", page: 1, label: "2", linkId: "a2", imageId: "i" }, { id: "b2", page: 2, label: "2", linkId: "a2" }, { id: "c2", page: 3, label: "2", linkId: "a2" }, { id: "z", page: 1, label: "9" }];
  const c = linkedClient(mk(), 1, 1, null, { app: true });
  c.App._autoSave = () => {};
  await c.App.deletePin("a2");
  ok(J(c.State.pins.map((p) => p.id)) === J(["z"]), "U5 대표 삭제 → 묶음 전원 제거(유령 종속 0) — 남은 " + J(c.State.pins.map((p) => p.id)));
  ok(["a2", "b2", "c2"].every((id) => c.State.pinTombstones && c.State.pinTombstones[id]), "U5 tombstone 전원 기록(병합 부활 금지)");
  const c2 = linkedClient(mk(), 2, 1, null, { app: true });
  c2.App._autoSave = () => {};
  await c2.App.deletePin("b2");
  ok(J(c2.State.pins.map((p) => p.id)) === J(["a2", "c2", "z"]), "U5 멤버 삭제 → 그 멤버만");
}

/* ══ U6 — 병합(실 App._mergePins) · repair 결정성 · 오프라인 유실 0 ══ */
console.log("\n[U6 병합 — 대표가 남의 저장으로 사라짐 → 내용 없는 멤버 제거 · 결정적 · 다른 핀 유실 0]");
{
  const run = () => {
    const c = linkedClient([], 2, 1, null, { app: true });
    c.State.pinTombstones = {};
    const srv = [{ id: "s1", page: 1, label: "1" }, { id: "s9", page: 2, label: "9", updatedAt: 5 }];   // 서버: a2(대표) 를 남이 지움 · s9 새로 생김
    const local = [{ id: "s1", page: 1, label: "1" }, { id: "a2", page: 1, label: "2", linkId: "a2" }, { id: "b2", page: 2, label: "2", linkId: "a2" },
      { id: "keep", page: 2, label: "5", linkId: "gone", imageId: "x" }, { id: "off1", page: 3, label: "6" }];
    const out = c.App._mergePins(srv, local, ["s1", "a2"], []);
    return { ids: out.map((p) => p.id).sort(), keep: out.find((p) => p.id === "keep"), tomb: Object.keys(c.State.pinTombstones).sort() };
  };
  const r1 = run(), r2 = run();
  ok(!r1.ids.includes("b2"), "U6 대표 없는 내용 없는 멤버(b2) 제거 — 결과 " + J(r1.ids));
  ok(r1.tomb.includes("b2"), "U6 제거분 tombstone 기록");
  ok(r1.keep && r1.keep.linkId === undefined && r1.keep.imageId === "x", "U6 🔴 내용 있는 고아 멤버는 연결만 풀고 보존(유실 0)");
  ok(["s1", "s9", "keep", "off1"].every((id) => r1.ids.includes(id)), "U6 오프라인 병합 — 서버 새 핀 s9 · 내 오프라인 핀 off1 · 공통 s1 유실 0");
  ok(J(r1.ids) === J(r2.ids) && J(r1.tomb) === J(r2.tomb), "U6 결정적(2회 실행 동일)");
  const c = linkedClient([], 1, 1);
  const rel = c.PL.repair([{ id: "h", page: 1, label: "4", linkId: "h" }, { id: "m", page: 2, label: "3", linkId: "h" }]);
  ok(rel.relabeled.includes("m") && rel.pins[1].label === "4", "U6 번호 갈라진 멤버 → 대표 번호로 정렬");
}

/* ══ U7 — 소비자 dedupe(실 소스) ══ */
console.log("\n[U7 dedupe — QR · 촬영현황 · 납품 · 전체 포인트 = 논리 핀 1개]");
{
  const pins = [{ id: "a2", page: 1, label: "2", linkId: "a2", imageId: "i", x: 1, y: 1 }, { id: "b2", page: 2, label: "2", linkId: "a2", x: 2, y: 2 }, { id: "z", page: 1, label: "1", x: 3, y: 3 }];
  const c = linkedClient(pins, 1, 1, null, { consumers: true });
  const deck = { id: "B", deployment_id: "depA" };
  ok(c.sb.QrPrint.deckPins(deck).length === 2 && !c.sb.QrPrint.deckPins(deck).some((p) => p.id === "b2"), "U7 QR 인쇄 대상 = 대표만(2개)");
  const cov = c.sb.Coverage.deckSummary({ id: "S1", deployment_id: "depA" }, Date.now());
  ok(cov && cov.total <= 2, "U7 촬영현황 집계 이중 아님 — total " + (cov && cov.total));
  const secs = c.sb.Delivery.sections([{ id: "S1", name: "PLAN", deployment_id: "depA", page: null, crop: null, parent_id: null }], { depA: { pins: pins, zones: [], allPins: pins } }, []);
  const rows = secs.reduce((n, s) => n + (s.items ? s.items.length : 0), 0);
  ok(rows === 2, "U7 납품 보고서 행 = 논리 핀 2개 — 실측 " + rows);
  c.sb.Projects.currentDeck = { id: "S1", deployment_id: "depA" };
  ok(c.sb.AllPins._scopedPins().length === 2, "U7 전체 포인트 목록 = 2(멤버 제외)");
}

/* ══ N1 — parseLabel ══ */
console.log("\n[N1 parseLabel — 9케이스 + 왕복 무손실]");
{
  const c = client({ projects: false });
  const T = [["12", "", "", 12, 0], ["A12", "A", "", 12, 0], ["A001", "A", "", 1, 3], ["ER-12", "ER", "-", 12, 0], ["B2-05", "B2", "-", 5, 2], ["A10", "A", "", 10, 0]];
  T.forEach(([s, pre, sep, no, pad]) => { const r = c.PS.parseLabel(s); ok(r && r.prefix === pre && r.sep === sep && r.no === no && r.pad === pad && r.text === s, "N1 " + s + " → " + J(r)); });
  ["2ND", "A1B2", "ABCDEFG1", "1F"].forEach((s) => ok(c.PS.parseLabel(s) === null, "N1 " + s + " → null(자유 텍스트)"));
  const sf = c.PS.parseLabel("1-F"), sf2 = c.PS.parseLabel("A12_R2");
  ok(sf && sf.no === 1 && sf.suffix === "-F" && sf.text === "1-F" && sf2 && sf2.prefix === "A" && sf2.no === 12 && sf2.suffix === "_R2", "N1 뒤 글자 1-F · A12_R2 왕복");
  const nm = c.PS.numbers([{ id: 1, page: 1, label: "1-F" }, { id: 2, page: 1, label: "1-R", checkboard: true }], 1);
  ok(nm.get(1).text === "1-F" && nm.get(1).no === 1 && nm.get(2).text === "1-R", "N1 표시 = 1-F / 1-R(번호 1, 매칭 정수 그대로)");
  ok(c.PS.duplicateNoIds([{ id: 1, page: 1, label: "1-F" }, { id: 2, page: 1, label: "1-R" }], 1).size === 0, "N1 1-F 와 1-R 은 중복 아님");
}

/* ══ BE — 번호 일괄 편집(앞·뒤 글자 · 제거 · 다시 매기기 · 조합) ══ */
console.log("\n[BE 번호 일괄 편집 — 미리보기 → 중복 차단 → 적용(setLabel) → 되돌리기]");
{
  const c = client({ projects: false });
  const P = (labels) => labels.map((l, i) => ({ id: "p" + i, page: 1, label: l, x: 10 + i, y: 10 }));
  let pins = P(["1", "2", "3"]);
  let plan = c.PS.bulkEditPlan(pins, 1, { addPrefix: "A" });
  ok(plan.ok && J(plan.changes.map((x) => x.newLabel)) === J(["A1", "A2", "A3"]), "BE1 앞 글자 A → A1,A2,A3");
  c.PS.applyReset(pins, plan, "be1", 1);
  ok(J(pins.map((p) => p.label)) === J(["A1", "A2", "A3"]), "BE1 적용");
  c.PS.applyUndoReset(pins, c.PS.undoResetPlan(pins, "be1"));
  ok(J(pins.map((p) => p.label)) === J(["1", "2", "3"]), "BE1 🔴 되돌리기 — 옛 label 전원 복원");
  plan = c.PS.bulkEditPlan(pins, 1, { addSuffix: "-F" });
  ok(plan.ok && J(plan.changes.map((x) => x.newLabel)) === J(["1-F", "2-F", "3-F"]) && !plan.warnSuffixDigit, "BE2 뒤 글자 -F → 1-F,2-F,3-F");
  pins = P(["A1", "B2-F"]);
  plan = c.PS.bulkEditPlan(pins, 1, { stripPrefix: true, stripSuffix: true });
  ok(plan.ok && J(plan.changes.map((x) => x.newLabel)) === J(["1", "2"]), "BE3 기존 앞·뒤 글자 제거 → 1,2");
  pins = [{ id: "a", page: 1, label: "9", x: 50, y: 5 }, { id: "b", page: 1, label: "4", x: 10, y: 5 }, { id: "c", page: 1, label: "7", x: 10, y: 50 }];
  plan = c.PS.bulkEditPlan(pins, 1, { order: "pos", addPrefix: "A", renumber: { start: 10, step: 5 } });
  ok(plan.ok && J(plan.changes.map((x) => [x.id, x.newLabel])) === J([["b", "A10"], ["a", "A15"], ["c", "A20"]]), "BE4 조합 — 위치순 + 앞 글자 A + 10부터 5씩 → " + J(plan.changes.map((x) => x.newLabel)));
  plan = c.PS.bulkEditPlan(pins, 1, { order: "no", renumber: { start: 1, step: 1 } });
  ok(J(plan.changes.map((x) => x.id)) === J(["b", "c", "a"]), "BE4 기존 번호순(4,7,9)");
  pins = P(["1", "2", "3"]);
  plan = c.PS.bulkEditPlan(pins, 1, { targets: [pins[0], pins[1]], renumber: { start: 3, step: 1 } });
  ok(plan.ok === false && plan.conflicts.has("p0") && /중복/.test(plan.reason), "BE5 🔴 대상 밖 3 과 겹침 → 중복 표시 + 적용 차단 — " + plan.reason);
  pins = P(["A1", "B1"]);
  plan = c.PS.bulkEditPlan(pins, 1, { stripPrefix: true });
  ok(plan.ok === false && plan.conflicts.size === 2, "BE5 결과끼리 중복(A1·B1 → 1·1) → 차단");
  pins = P(["1"]);
  ok(c.PS.bulkEditPlan(pins, 1, { addSuffix: "-F2" }).warnSuffixDigit === true, "BE7 뒤 글자에 숫자 → 사진 매칭 경고");
  ok(c.PS.bulkEditPlan(pins, 1, { addPrefix: "ABCDEFG" }).ok === false, "BE8 결과가 번호로 안 읽힘(접두 7자) → 차단");
  ok(c.PS.bulkEditPlan(pins, 1, { addSuffix: "F" }).ok === false, "BE8 뒤 글자 구분자 없음 → 거부(사유)");
  pins = P(["1", "Room"]);
  plan = c.PS.bulkEditPlan(pins, 1, { addPrefix: "A" });
  ok(plan.ok && plan.skipped.length === 1 && plan.changes.length === 1, "BE9 자유 텍스트 이름은 그대로(건너뜀)");
  // 연결 묶음 = 대표 기준 1회 + 멤버 반영
  const lp = [{ id: "h", page: 1, label: "2", linkId: "h", x: 1, y: 1 }, { id: "m", page: 2, label: "2", linkId: "h", x: 1, y: 1 }, { id: "k", page: 2, label: "5", x: 2, y: 2 }];
  const lc = linkedClient(lp, 2, 1);
  const lplan = lc.PS.bulkEditPlan(lc.State.pins, 2, { addPrefix: "A" });
  ok(lplan.ok && lplan.changes.length === 2, "BE6 연결 묶음 = 1행(논리 핀 2개 → 2행) — 실측 " + lplan.changes.length);
  lc.PS.applyReset(lc.State.pins, lplan, "be6", 1);
  ok(lp[0].label === "A2" && lp[1].label === "A2" && lp[0].numReset && lp[1].numReset, "BE6 멤버도 함께 A2(setLabel) + 멤버마다 스냅샷");
  // 권한·오프라인·열람자(실 61_NumReset)
  const nr = client({ projects: false, state: { fileType: "image", mode: "viewer" } });
  vm.runInContext(rd(M + "61_NumReset.js") + "\n;globalThis.NumReset = NumReset;", nr.sb);
  ok(nr.sb.NumReset.openEdit() === false && /열람/.test(nr.sb.NumReset.reason()), "BE 열람자 → 실행 0 · 사유");
  nr.State.mode = "designer"; nr.sb.navigator.onLine = false;
  ok(nr.sb.NumReset.openEdit() === false && /오프라인/.test(nr.sb.NumReset.reason()), "BE 오프라인 → 비활성 · 사유");
  ok(/id: "num-edit".*NumReset\.openEdit\(\)/s.test(rd(M + "45_FeatureMenu.js")) && /allpins-btn-bulkedit[\s\S]*NumReset\.openEdit\(sel\.length \? sel : null\)/.test(rd(M + "21_AllPins.js")), "BE 진입 배선 — 기능 메뉴 [번호 일괄 편집] · 전체 포인트 선택 버튼");
}

/* ══ N2·N3·N7 ══ */
console.log("\n[N2 접두 채번 · N3 접두별 중복 · N7 정렬]");
{
  const pins = [{ id: 1, page: 1, label: "A1" }, { id: 2, page: 1, label: "A2" }, { id: 3, page: 1, label: "7" }];
  const c = client({ projects: false });
  const a = c.PS.nextInBand(pins, 1, "content", 1, 1, undefined, "A");
  ok(a.label === "A3", "N2 접두 A · 기존 A1·A2·7 → A3 — 실측 " + a.label);
  ok(c.PS.nextInBand(pins, 1, "content", 1, 1, undefined, "").label === "8", "N2 순수 숫자 채번엔 영향 0(→ 8)");
  const d = [{ id: 1, page: 1, label: "A12" }, { id: 2, page: 1, label: "B12" }, { id: 3, page: 1, label: "12" }];
  ok(c.PS.duplicateNoIds(d, 1).size === 0, "N3 A12/B12/12 공존 → 중복 0");
  ok(c.PS.duplicateNoIds(d.concat([{ id: 4, page: 1, label: "a-12" }]), 1).size === 2, "N3 A12 와 a-12 는 같은 번호(접두 대소문자·구분자 무시) → 중복 2");
  const s = ["A10", "B1", "A2", "3", "12"].map((l, i) => ({ id: i, label: l })).sort((x, y) => c.PS.byNumber(x, y)).map((p) => p.label);
  ok(J(s) === J(["3", "12", "A2", "A10", "B1"]), "N7 정렬 A2 < A10 < B1 · 순수 숫자 먼저 — " + J(s));
}

/* ══ N4 — 리셋 접두 유지 + 되돌리기 ══ */
console.log("\n[N4 번호 리셋 — 접두 유지(A5,A9,B3 → A1,A2,B1) · 되돌리기 전원 복원]");
{
  const pins = [{ id: 1, page: 1, label: "A5", x: 1, y: 1 }, { id: 2, page: 1, label: "A9", x: 1, y: 2 }, { id: 3, page: 1, label: "B3", x: 1, y: 3 }];
  const c = client({ projects: false });
  const plan = c.PS.resetPlan(pins, 1, { order: "no" });
  c.PS.applyReset(pins, plan, "bt1", 1);
  ok(J(pins.map((p) => p.label)) === J(["A1", "A2", "B1"]), "N4 리셋 결과 " + J(pins.map((p) => p.label)));
  const u = c.PS.undoResetPlan(pins, "bt1");
  c.PS.applyUndoReset(pins, u);
  ok(J(pins.map((p) => p.label)) === J(["A5", "A9", "B3"]), "N4 되돌리기 전원 복원");
  const lp = [{ id: "h", page: 1, label: "7", linkId: "h", x: 1, y: 1 }, { id: "m", page: 2, label: "7", linkId: "h", x: 5, y: 5 }, { id: "k", page: 2, label: "3", x: 1, y: 1 }];
  const lc = linkedClient(lp, 2, 1);
  const lplan = lc.PS.resetPlan(lc.State.pins, 2, { order: "no" });
  ok(lplan.ok && lplan.changes.length === 2, "N4 연결 묶음 = 변경 1행(논리 핀 2개 → 2행) — 실측 " + (lplan.changes && lplan.changes.length));
  lc.PS.applyReset(lc.State.pins, lplan, "bt2", 1);
  ok(lp[0].label === lp[1].label && lp[0].numReset && lp[1].numReset, "N4 연결 멤버 같은 새 번호 + 멤버마다 되돌리기 스냅샷");
}

/* ══ N5 — 사진 폴더 매칭(실 60_PhotoFolder) ══ */
console.log("\n[N5 사진 폴더 — 후보 2개 이상일 때만 접두 요구]");
{
  const c = client({ projects: false, pf: true });
  const E = (n) => ({ name: n });
  const one = c.PF.rankMatches(12, "A", [E("012.jpg")], [{ no: 12, prefix: "A" }]);
  ok(one.matches.length === 1, "N5 A12 단독 ↔ 012.jpg 매칭(마스터 규칙: 숫자 3자리)");
  const two = c.PF.rankMatches(12, "A", [E("012.jpg")], [{ no: 12, prefix: "A" }, { no: 12, prefix: "B" }]);
  ok(two.matches.length === 0 && two.ambiguous.length === 1, "N5 🔴 A12+B12 공존 ↔ 012.jpg 매칭 안 함(선택창)");
  const a012 = c.PF.rankMatches(12, "A", [E("A012.jpg")], [{ no: 12, prefix: "A" }, { no: 12, prefix: "B" }]);
  const b012 = c.PF.rankMatches(12, "B", [E("A012.jpg")], [{ no: 12, prefix: "A" }, { no: 12, prefix: "B" }]);
  ok(a012.matches.length === 1 && b012.matches.length === 0 && b012.ambiguous.length === 0, "N5 A012.jpg → A12 만(B12 0)");
  ok(c.PF._filePrefix("ER_A012.JPG") === "A" && c.PF._filePrefix("B2-05.jpg") === "B2" && c.PF._filePrefix("012.jpg") === "", "N5 파일 접두 추출");
  ok(c.PF.isMatch(1, "A001.jpg") === true && c.PF.isMatch(1, "A1001.jpg", new Set([1001])) === false, "N5 숫자 매칭(isMatch) 종전 그대로");
}

/* ══ T5·T6 — 정적: label 쓰기 = setLabel · 표시 12곳 = textOf ══ */
console.log("\n[T5 label 쓰기 지점 = PinLink.setLabel · T6 표시 호출부 = PinSeries.textOf]");
{
  const R = (f) => rd(M + f);
  const pap = R("27_PinActionPop.js"), app = R("20_App.js"), ap = R("21_AllPins.js"), ui = R("11_UI.js");
  ok(/PinLink\.setLabel\(State\.pins, pin, v/.test(pap), "T5 핀 팝업 번호 저장 → setLabel");
  ok((app.match(/PinLink\.setLabel\(/g) || []).length >= 2, "T5 20_App(일괄 변경·폼 편집) → setLabel");
  ok((ap.match(/PinLink\.setLabel\(/g) || []).length >= 2, "T5 전체 포인트 재채번·되돌리기 → setLabel");
  ok(/PL\.setLabel\(pins, u\.rep, toLabel\)/.test(SRC.series) && /PL\.setLabel\(pins, head, c\.newLabel/.test(SRC.series), "T5 동시충돌 재채번·리셋 → setLabel");
  const mods = fs.readdirSync(path.join(ROOT, M)).filter((f) => /\.js$/.test(f) && f !== "01b_PinSeries.js");
  // formatNo(meta.no …) 는 "textOf 가 없을 때(단독 테스트 스텁)" 폴백 자리에만 허용 — 맨 formatNo 표시 호출 0
  const bad = mods.filter((f) => { const s = R(f); const all = (s.match(/formatNo\((meta2?|info|n)\.no/g) || []).length; const guarded = (s.match(/PinSeries\.textOf \? PinSeries\.textOf\((meta2?|info|n)\) : PinSeries\.formatNo\(\1\.no/g) || []).length; return all !== guarded; });
  ok(bad.length === 0, "T6 표시 호출부에 맨 formatNo(meta.no …) 잔존 0(textOf 폴백 자리 제외) — " + J(bad));
  const cnt = (s) => (s.match(/PinSeries\.textOf\(/g) || []).length;
  const sites = { "11_UI.js": 4, "27_PinActionPop.js": 2, "21_AllPins.js": 1, "50_QrLink.js": 1, "56_Delivery.js": 1, "07_Radar.js": 1 };
  Object.keys(sites).forEach((f) => ok(cnt(R(f)) >= sites[f], "T6 " + f + " textOf ≥ " + sites[f] + " — 실측 " + cnt(R(f))));
  ok(/c\.oldText/.test(R("61_NumReset.js")) && /esc\(c\.newLabel\)/.test(R("61_NumReset.js")), "T6 번호 리셋 미리보기 = 접두 포함 문자열");
  ok(/PinLink\.deckMenuItems\(deck, why\)/.test(ui) && /PinLink\.renderPopRow\(/.test(pap), "UX 구역 ⋯ 메뉴 체크 · 핀 팝업 [다른 도면에서 보기] 배선");
  const manifest = rd(M + "_manifest.txt");
  ok(/66_PinLink\.js/.test(manifest) && /49_AiVision\.js\n99_footer\.js/.test(manifest), "고아 금지 — _manifest 등록 + 49_AiVision→99_footer 인접 유지");
}

/* ══ UX — 메뉴 사유(다른 파일) · 열람자 ══ */
console.log("\n[UX 메뉴 — 다른 파일만 있으면 사유 · 연결 해제(대표 거부)]");
{
  const decks = [{ id: "B", parent_id: null }, { id: "P", parent_id: "B", deployment_id: "d1", page: 1 }, { id: "Q", parent_id: "B", deployment_id: "d2", page: 1 }];
  const c = client({ decks, currentDeck: decks[0] });
  const it = c.PL.deckMenuItems(decks[0], "");
  ok(/다른 파일로 등록된 도면끼리는 번호를 연결할 수 없습니다/.test(it[0].reason), "UX 다른 파일끼리 → 비활성 + 사유 — " + it[0].reason);
  const ok2 = c.PL.deckMenuItems(decksOf(null)[0], "");
  c.Projects.decks = decksOf(null);
  ok(c.PL.deckMenuItems(c.Projects.decks[0], "")[0].reason === "" && /☐ 도면 간 핀 번호 연결/.test(c.PL.deckMenuItems(c.Projects.decks[0], "")[0].label), "UX 같은 PDF 2장 이상 → 체크 활성 ☐");
  const pins = [{ id: "h", page: 1, label: "2", linkId: "h" }, { id: "m", page: 2, label: "2", linkId: "h" }];
  ok(c.PL.unlink(pins, pins[0]).ok === false, "UX 대표 해제 거부(사진·노트가 대표에 있다)");
  const r = c.PL.unlink(pins, pins[1], "5");
  ok(r.ok && pins[1].linkId === undefined && pins[1].label === "5" && pins[0].linkId === undefined, "UX 멤버 해제 → 새 번호 5 · 대표 혼자 남아 묶음 해체");
}

/* ══ S — 실 워커 + 실 D1 ══ */
const MIG_DIR = path.join(ROOT, "migrations");
const MIGS = fs.readdirSync(MIG_DIR).filter((f) => /^\d+_.*\.sql$/.test(f)).sort();
const stmtsOf = (file) => fs.readFileSync(path.join(MIG_DIR, file), "utf8").replace(/--[^\n]*/g, "").split(";").map((s) => s.replace(/\s+/g, " ").trim()).filter(Boolean);
async function buildWorker() {
  const out = path.join(os.tmpdir(), "p161-worker-" + process.pid + "-" + Math.random().toString(36).slice(2) + ".mjs");
  let entry = path.join(ROOT, "src/index.tsx");
  if (MUT && MUTS[MUT][0] === "srv") { entry = path.join(ROOT, "src", "__p161_mut.tsx"); fs.writeFileSync(entry, SRC.srv); }
  try {
    await esbuild.build({ entryPoints: [entry], bundle: true, format: "esm", platform: "neutral", outfile: out, jsx: "automatic", jsxImportSource: "hono/jsx", logLevel: "silent", conditions: ["workerd", "worker", "browser"] });
  } finally { if (entry.endsWith("__p161_mut.tsx")) fs.unlinkSync(entry); }
  return out;
}
console.log("\n[S 실 워커 + 실 D1(Miniflare, migration " + MIGS[MIGS.length - 1] + " 까지)]");
{
  ok(MIGS.includes("0049_deck_sheet_link.sql"), "S0 0049 마이그레이션 파일 존재");
  const script = await buildWorker();
  const mf = new Miniflare({ modules: true, scriptPath: script, d1Databases: { DB: "p161-" + Math.random().toString(36).slice(2) }, r2Buckets: { R2: "p161r2" }, bindings: { DEMO_LOGIN: "0" }, compatibilityDate: "2025-01-01" });
  try {
    const db = await mf.getD1Database("DB");
    for (const f of MIGS) for (const st of stmtsOf(f)) await db.exec(st);
    const now = Date.now(), PID = "prj_p161";
    const U = { o: "owner@p161.test", x: "outsider@p161.test" };
    for (const k of Object.keys(U)) {
      await db.prepare("INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted) VALUES (?, ?, 'seed', ?, ?, 0)").bind(U[k], k, now, now).run();
      await db.prepare("INSERT INTO local_users (email, name, domain, pw_hash, pw_salt, email_verified, created_at, updated_at, deleted) VALUES (?, ?, 'p161.test', 'x', 'y', 1, ?, ?, 0)").bind(U[k], k, now, now).run();
      await db.prepare("INSERT INTO local_sessions (token, email, created_at, expires_at, revoked) VALUES (?, ?, ?, ?, 0)").bind("local-p161-" + k, U[k], now, now + 8.64e7).run();
    }
    await db.prepare("INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted) VALUES (?, 'P161', '', ?, ?, ?, 0)").bind(PID, U.o, now, now).run();
    const H = (k) => ({ Authorization: "Bearer local-p161-" + k, "Content-Type": "application/json" });
    const api = async (k, method, url, body) => { const r = await mf.dispatchFetch("http://p161.test" + url, { method, headers: H(k), body: body ? JSON.stringify(body) : undefined }); let j = null; try { j = await r.json(); } catch (e) {} return { s: r.status, j }; };
    // 배포본(같은 PDF 3페이지) — 대표 핀 a2 는 사진 보유
    const dep = await api("o", "POST", "/tables/deployments", { title: "A DK.pdf", file_name: "A DK.pdf", project_id: PID, pins: J([{ id: "a1", page: 1, label: "1", x: 10, y: 10 }, { id: "a2", page: 1, label: "2", x: 20, y: 20, imageId: "img-a2" }]), zones: "[]", annotations: "[]", routes: "[]", pages_data: J(["p1", "p2", "p3"]) });
    ok(dep.s === 200 && dep.j && dep.j.id, "S 배포본 생성 " + dep.s);
    const DA = dep.j && dep.j.id;
    const mkDeck = async (b) => (await api("o", "POST", "/api/projects/" + PID + "/decks", b)).j;
    const B = await mkDeck({ name: "A DK" });
    const S1 = await mkDeck({ name: "A DK PLAN", parent_id: B.id, deployment_id: DA, page: 1 });
    await mkDeck({ name: "A DK SECTION", parent_id: B.id, deployment_id: DA, page: 2 });
    const S3 = await mkDeck({ name: "A DK ELEVATION", parent_id: B.id, deployment_id: DA, page: 3 });
    ok(B && B.sheet_link === null && B.num_prefix === null, "S 새 구역 기본값 null(= 종전)");
    // S1~S4
    const put = await api("o", "PUT", "/api/decks/" + B.id, { sheet_link: 1, num_prefix: "A" });
    ok(put.s === 200 && put.j.sheet_link === 1 && put.j.num_prefix === "A", "S1 PUT {sheet_link:1,num_prefix:'A'} 저장·반환 — " + J(put.j && { s: put.j.sheet_link, p: put.j.num_prefix }));
    const row = await db.prepare("SELECT sheet_link, num_prefix FROM decks WHERE id = ?").bind(B.id).first();
    ok(row && row.sheet_link === 1 && row.num_prefix === "A", "S1 D1 실측 " + J(row));
    for (const bad of [{ num_prefix: "B2" }, { num_prefix: "A B" }, { num_prefix: "ABCDEFG" }, { sheet_link: 2 }]) {
      const r = await api("o", "PUT", "/api/decks/" + B.id, bad);
      ok(r.s === 400, "S2 잘못된 값 400 — " + J(bad) + " → " + r.s);
    }
    const r0 = await db.prepare("SELECT num_prefix FROM decks WHERE id = ?").bind(B.id).first();
    ok(r0.num_prefix === "A", "S2 400 이면 쓰기 0(값 그대로 A)");
    const out = await api("x", "PUT", "/api/decks/" + B.id, { sheet_link: 0 });
    ok(out.s === 403, "S4 비멤버 PUT → 403 — " + out.s);
    const decks = (await api("o", "GET", "/api/projects/" + PID + "/decks")).j.data;
    ok(decks.find((d) => d.id === B.id).sheet_link === 1, "S GET decks 에 sheet_link 노출");

    // 클라(실 소스) — 서버 데이터로
    const load = async () => { const g = await api("o", "GET", "/tables/deployments/" + DA); return { pins: JSON.parse(g.j.pins || "[]"), version: g.j.version }; };
    const save = async (pins, version) => api("o", "PATCH", "/tables/deployments/" + DA, { pins: J(pins), base_version: version });
    const cl = (pins, page) => client({ decks, currentDeck: decks.find((d) => d.deployment_id === DA && d.page === page), state: { pins, pdfPage: page, currentDeploymentId: DA }, pf: true, app: true });
    ok(cl([], 3).Projects.numPrefixOf() === "A", "S3 자식 시트(ELEVATION)는 묶음 접두 A 상속(가장 가까운 조상)");
    // 연결 → 같은 번호
    let st = await load();
    let c = cl(st.pins, 3);
    c.PL.choose("a2");
    const h = c.PL.takePending(c.State.pins, 3);
    const m3 = { id: "e2", page: 3, x: 40, y: 40, label: "" };
    c.PL.link(c.State.pins, h, m3); c.State.pins.push(m3);
    let sv = await save(c.State.pins, st.version);
    ok(sv.s === 200, "S 연결 저장 PATCH " + sv.s);
    st = await load(); c = cl(st.pins, 3);
    const e2 = c.State.pins.find((p) => p.id === "e2");
    ok(e2 && e2.linkId === "a2", "S 🔴 D1 왕복 — linkId 보존");
    ok(c.PS.numbers(c.State.pins, 3).get("e2").text === "2" && c.PS.numbers(c.State.pins, 1).get("a2").text === "2", "S 연결 → PLAN·ELEV 같은 번호 2");
    ok(c.PS.markerStyle(e2).filled === true && c.PL.headOf(c.State.pins, e2).imageId === "img-a2", "S 대표 사진 공유(멤버 마커 filled · headOf 사진)");
    // 접두 A → A1, A2 (ELEV 에 새 핀 2개)
    const n1 = c.PS.nextInBand(c.State.pins, 3, "content", 1, 1);
    c.State.pins.push({ id: "e3", page: 3, x: 60, y: 60, label: n1.label });
    const n2 = c.PS.nextInBand(c.State.pins, 3, "content", 1, 1);
    c.State.pins.push({ id: "e4", page: 3, x: 70, y: 70, label: n2.label });
    ok(n1.label === "A1" && n2.label === "A2", "S 접두사 A → A1, A2 — 실측 " + n1.label + "," + n2.label);
    sv = await save(c.State.pins, st.version); st = await load(); c = cl(st.pins, 3);
    ok(J(c.State.pins.filter((p) => /^A/.test(p.label)).map((p) => p.label).sort()) === J(["A1", "A2"]), "S D1 왕복 후 A1·A2");
    // 리셋해도 접두 유지 — A1,A2 를 A5,A9 로 바꿔 두고 리셋
    c.PL.setLabel(c.State.pins, c.State.pins.find((p) => p.id === "e3"), "A5", { manual: true });
    c.PL.setLabel(c.State.pins, c.State.pins.find((p) => p.id === "e4"), "A9", { manual: true });
    const rp = c.PS.resetPlan(c.State.pins, 3, { order: "no" });
    c.PS.applyReset(c.State.pins, rp, "s-batch", Date.now());
    sv = await save(c.State.pins, st.version); st = await load(); c = cl(st.pins, 3);
    const lab = (id) => (c.State.pins.find((p) => p.id === id) || {}).label;
    ok(lab("e3") === "A1" && lab("e4") === "A2", "S 🔴 리셋해도 접두 유지(A5,A9 → A1,A2) — 실측 " + lab("e3") + "," + lab("e4"));
    ok(lab("a2") === lab("e2"), "S 리셋 후에도 연결 멤버 같은 번호(" + lab("a2") + "/" + lab("e2") + ")");
    // 사진 폴더 A012.jpg — A12 핀(대표 e3 를 A12 로) + 순수 12 핀 공존
    c.PL.setLabel(c.State.pins, c.State.pins.find((p) => p.id === "e3"), "A12", { manual: true });
    c.State.pins.push({ id: "e5", page: 3, x: 80, y: 80, label: "12" });
    const peers = c.PF._peers(3);
    const ra = c.PF.rankMatches(12, "A", [{ name: "A012.jpg" }, { name: "012.jpg" }], peers);
    const rn = c.PF.rankMatches(12, "", [{ name: "A012.jpg" }, { name: "012.jpg" }], peers);
    ok(ra.matches.length === 1 && ra.matches[0].name === "A012.jpg" && rn.matches.length === 1 && rn.matches[0].name === "012.jpg", "S 사진 폴더 A012.jpg → A12 · 012.jpg → 12(묶음 peers 실측)");
    // 연결 해제
    st = await load(); c = cl(st.pins, 3);
    const mem = c.State.pins.find((p) => p.id === "e2");
    const nx = c.PS.nextInBand(c.State.pins, 3, "content", 1, 1);
    ok(c.PL.unlink(c.State.pins, mem, nx.label).ok, "S 연결 해제 실행");
    sv = await save(c.State.pins, st.version); st = await load(); c = cl(st.pins, 3);
    const e2b = c.State.pins.find((p) => p.id === "e2"), a2b = c.State.pins.find((p) => p.id === "a2");
    ok(e2b.linkId === undefined && a2b.linkId === undefined && e2b.label !== a2b.label, "S 연결 해제 D1 왕복 — linkId 0 · 번호 분리(" + a2b.label + "/" + e2b.label + ")");
    // 오프라인 병합 유실 0 — A(오프라인)가 연결·새 핀, 그 사이 B 가 다른 핀 추가 저장
    st = await load();
    const base = st.pins.map((p) => String(p.id));
    const A = cl(JSON.parse(J(st.pins)), 2);
    A.State.pinTombstones = {};
    const ah = A.State.pins.find((p) => p.id === "a1");
    const am = { id: "off-m", page: 2, x: 5, y: 5, label: "", updatedAt: now + 10 };
    A.PL.link(A.State.pins, ah, am); A.State.pins.push(am);
    A.State.pins.push({ id: "off-n", page: 2, x: 6, y: 6, label: A.PS.nextInBand(A.State.pins, 2, "content", 1, 1).label, updatedAt: now + 11 });
    const Bp = JSON.parse(J(st.pins)); Bp.push({ id: "b-new", page: 1, x: 9, y: 9, label: "A3", updatedAt: now + 12 });
    const sb2 = await save(Bp, st.version);
    ok(sb2.s === 200, "S B 저장 " + sb2.s);
    const conflict = await save(A.State.pins, st.version);
    ok(conflict.s === 409, "S A 저장 = 409(낙관락) " + conflict.s);
    const srv = JSON.parse((conflict.j && conflict.j.current && conflict.j.current.pins) || "[]");
    const merged = A.App._mergePins(srv, A.State.pins, base, Object.keys(A.State.pinTombstones));
    const sv3 = await save(merged, conflict.j.current.version);
    ok(sv3.s === 200, "S 병합본 저장 " + sv3.s);
    const fin = (await load()).pins.map((p) => String(p.id));
    const want = base.concat(["off-m", "off-n", "b-new"]);
    const lost = want.filter((id) => !fin.includes(id));
    ok(lost.length === 0, "S 🔴 오프라인 병합 유실 0 — 기대 " + want.length + " · 실측 " + fin.length + " · 유실 " + J(lost));
    const fp = (await load()).pins;
    ok((fp.find((p) => p.id === "off-m") || {}).linkId === "a1" && (fp.find((p) => p.id === "a1") || {}).linkId === "a1", "S 병합 후 연결(off-m → a1) 보존");
    // S5 배포 스냅샷
    const pub = await api("o", "POST", "/api/projects/" + PID + "/publish", {});
    ok(pub.s === 200, "S5 배포 " + pub.s + " " + J(pub.j && pub.j.error));
    const snap = await db.prepare("SELECT decks_json FROM pub_snapshots WHERE project_id = ?").bind(PID).first();
    const sd = snap ? JSON.parse(snap.decks_json) : [];
    const sB = sd.find((d) => d.id === B.id);
    ok(sB && sB.sheet_link === 1 && sB.num_prefix === "A", "S5 🔴 열람 링크 스냅샷 decks_json 에 sheet_link·num_prefix 동결 — " + J(sB && { s: sB.sheet_link, p: sB.num_prefix }));
    const snapDep = await db.prepare("SELECT row_json FROM pub_snapshot_deps WHERE project_id = ? AND dep_id = ?").bind(PID, DA).first();
    const snapPins = snapDep ? JSON.parse(JSON.parse(snapDep.row_json).pins || "[]") : [];
    ok(snapPins.some((p) => p.linkId === "a1"), "S5 스냅샷 pins 에 linkId 동결(열람자도 같은 번호·이동)");
  } finally { await mf.dispose(); }
}

console.log("\n" + (failed ? ("FAIL " + failed + "건") : "PASS 전체"));
process.exit(failed ? 1 : 0);
