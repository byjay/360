/**
 * 단위 테스트 (프레임워크 0 · 실행: node tests/p143-revision-core.test.mjs)
 * WO 20261010-revision — 도면 개정 관리의 순수 계산 SoT(src/lib/revCore.ts): 개정 표기 · 아핀(2점 닮음/3점 아핀) · 이월 · diff · 되돌림 병합.
 *
 *  A 개정 표기(창고 revisionFormat 이식 + 알파벳): 정규화 · 다음 번호 · 중복 키
 *  B 2점 닮음변환 — 회전·배율·이동, 가로세로 비율이 다른 페이지에서도 회전이 찌그러지지 않음(물리 좌표)
 *  C 3점 아핀(전단 포함) 정확해 · 4점 최소제곱 잔차 · 공선/동일점 거부
 *  D 역변환 — 왕복 오차 < 0.1%(이월 좌표 반올림 포함)
 *  E 자동 제안 — 같은 비율 = identity · 다른 비율 = 비율 유지 가운데 맞춤
 *  F 이월 — 핀(tombstone 불변·검토 배지·페이지 밖 표시·입력 불변) · 영역(rect/poly/circle) · 주석 · crop
 *  G diff(창고 cableRevisionDiff 이식) — added/removed/moved/unchanged
 *  H 되돌림 병합 — 손대지 않은 핀은 스냅샷 좌표, 적용 뒤 옮긴/새 핀은 역변환, tombstone 유지
 *
 * 뮤테이션: MUT=<이름> → revCore 사본에 치환 적용(치환 대상 없음 = EXIT 3). 각 뮤테이션은 EXIT=1 이어야 한다.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import esbuild from "esbuild";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
let failed = 0;
const ok = (cond, label, d) => { console.log((cond ? "  PASS " : "  FAIL ") + label + (!cond && d !== undefined ? " :: " + JSON.stringify(d).slice(0, 300) : "")); if (!cond) failed++; };

const MUTS = {
  sign:     ["B += ux * vy - uy * vx", "B += ux * vy + uy * vx"],                       // 회전 방향 뒤집힘
  aspect:   ["const S = scaleAff(srcDims), D = scaleAff(dstDims), Di = invertAff(D)!", "const S = IDENTITY, D = IDENTITY, Di = IDENTITY"],   // 물리 비율 무시
  inverse:  ["e: (m.c * m.f - m.d * m.e) / D, f: (m.b * m.e - m.a * m.f) / D", "e: -m.e / D, f: -m.f / D"],
  tomb:     ["if (!live(p) || !fin(p.x) || !fin(p.y)) return p", "if (!fin(p.x) || !fin(p.y)) return p"],
  collinear:["if (!(spread > 1e-12) || (sxx * syy - sxy * sxy) < 1e-10 * spread * spread) return null", "if (!(spread > 1e-12)) return null"],
  merge:    ["if (sameXY({ x: R4(carried.x), y: R4(carried.y) }, p)) {", "if (false) {"],
  rotrect:  ["if (isAxisAligned(t)) Object.assign(out, bboxOf(pts))", "if (true) Object.assign(out, bboxOf(pts))"],
  fit:      ["e: (dstDims.w - s * srcDims.w) / 2, f: (dstDims.h - s * srcDims.h) / 2", "e: 0, f: 0"],
  nextalpha:["String.fromCharCode(v.charCodeAt(0) + 1)", "String.fromCharCode(v.charCodeAt(0))"],
};
const MUT = process.env.MUT || "";
let src = path.join(ROOT, "src/lib/revCore.ts");
const tmp = path.join(ROOT, ".tmp", "p143core-" + process.pid);
fs.mkdirSync(tmp, { recursive: true });
if (MUT) {
  const m = MUTS[MUT];
  if (!m) { console.log("unknown MUT " + MUT); process.exit(3); }
  const s = fs.readFileSync(src, "utf8").replace(/\r\n/g, "\n");
  if (!s.includes(m[0])) { console.log("MUT " + MUT + " 치환 대상 없음"); process.exit(3); }
  src = path.join(tmp, "revCore.ts");
  fs.writeFileSync(src, s.replace(m[0], m[1]));
  console.log("[MUT=" + MUT + "]");
}
const outFile = path.join(tmp, "revCore.mjs");
await esbuild.build({ entryPoints: [src], bundle: true, format: "esm", platform: "neutral", outfile: outFile, logLevel: "silent" });
const R = await import(pathToFileURL(outFile).href);

const near = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const nearPt = (p, q, eps = 1e-6) => near(p.x, q.x, eps) && near(p.y, q.y, eps);
const toPhys = (p, d) => ({ x: p.x * d.w / 100, y: p.y * d.h / 100 });
const toPct = (P, d) => ({ x: P.x * 100 / d.w, y: P.y * 100 / d.h });
const physSim = (deg, s, tx, ty) => { const r = deg * Math.PI / 180; return { a: s * Math.cos(r), b: s * Math.sin(r), c: -s * Math.sin(r), d: s * Math.cos(r), e: tx, f: ty }; };
let seed = 7; const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);

console.log("\n[A. 개정 표기]");
{
  const cases = [["rev a", "Rev.A"], ["REV.1", "Rev.1"], ["R2", "Rev.2"], ["b", "Rev.B"], ["03", "Rev.3"], ["Revision 4", "Rev.4"], ["  Rev.  c ", "Rev.C"], ["", ""], ["Rev.A1-prelim", "Rev.A1-prelim"]];
  for (const [i, o] of cases) ok(R.normalizeRevLabel(i) === o, `A normalize ${JSON.stringify(i)} → ${JSON.stringify(o)}`, R.normalizeRevLabel(i));
  const nx = [["Rev.A", "Rev.B"], ["Rev.Z", "Rev.AA"], ["Rev.AZ", "Rev.BA"], ["Rev.3", "Rev.4"], ["0", "Rev.1"], ["", "Rev.1"], ["draft", "Rev.1"]];
  for (const [i, o] of nx) ok(R.nextRevLabel(i) === o, `A next ${JSON.stringify(i)} → ${o}`, R.nextRevLabel(i));
  ok(R.revLabelKey("rev b") === R.revLabelKey("Rev.B") && R.revLabelKey("1") === R.revLabelKey("REV 1") && R.revLabelKey("Rev.A") !== R.revLabelKey("Rev.B"), "A 중복 키 — 표기 달라도 같은 개정은 같은 키");
}

console.log("\n[B. 2점 닮음 — 회전·배율·이동, 비정사각 페이지]");
{
  const sd = { w: 1189, h: 841 }, dd = { w: 1600, h: 1000 };   // A0 가로 → 다른 비율
  const T = physSim(25, 1.2, 140, -60);
  const fwd = (p) => toPct(R.applyAff(T, toPhys(p, sd)), dd);
  const sp = [{ x: 12, y: 18 }, { x: 81, y: 64 }];
  const r = R.solveCarry(sd, dd, sp, sp.map(fwd));
  ok(r.ok && r.kind === "similarity", "B 2점 → 닮음변환", r);
  let worst = 0;
  for (let i = 0; i < 50; i++) { const p = { x: rnd() * 100, y: rnd() * 100 }; const q = R.applyAff(r.t, p), w = fwd(p); worst = Math.max(worst, Math.hypot(q.x - w.x, q.y - w.y)); }
  ok(worst < 1e-6, "B 기준점 밖 임의 50점도 참값과 일치(최대 오차 " + worst.toExponential(2) + "%)", worst);
  // 물리 직각 보존: 페이지 위 수평·수직 선분이 회전 후에도 직각(종이 비율 보정 검증)
  const o = toPhys(R.applyAff(r.t, { x: 50, y: 50 }), dd), ax = toPhys(R.applyAff(r.t, { x: 60, y: 50 }), dd), ay = toPhys(R.applyAff(r.t, { x: 50, y: 50 + 10 * sd.w / sd.h }), dd);
  const dot = (ax.x - o.x) * (ay.x - o.x) + (ax.y - o.y) * (ay.y - o.y);
  ok(Math.abs(dot) < 1e-6 * Math.hypot(ax.x - o.x, ax.y - o.y) ** 2, "B 실제 종이 위 직각 보존(찌그러짐 0)", dot);
  const ang = Math.atan2(ax.y - o.y, ax.x - o.x) * 180 / Math.PI, sc = Math.hypot(ax.x - o.x, ax.y - o.y) / (10 * sd.w / 100);
  ok(near(ang, 25, 1e-6) && near(sc, 1.2, 1e-9), "B 회전 25° · 배율 1.2 복원(" + ang.toFixed(6) + "°, ×" + sc.toFixed(9) + ")", { ang, sc });
  const same = R.solveCarry(sd, dd, [{ x: 10, y: 10 }, { x: 10, y: 10 }], [{ x: 1, y: 1 }, { x: 2, y: 2 }]);
  ok(!same.ok && /같은 위치/.test(same.error), "B 같은 점 두 번 → 거부", same);
  ok(!R.solveCarry(sd, dd, [{ x: 1, y: 1 }], [{ x: 1, y: 1 }]).ok && !R.solveCarry(null, dd, sp, sp).ok, "B 점 1개·크기 없음 → 거부");
}

console.log("\n[C. 3점 아핀(전단) · 4점 최소제곱 · 공선 거부]");
{
  const A = { a: 0.9, b: 0.12, c: -0.3, d: 1.1, e: 7, f: -4 };
  const sp = [{ x: 10, y: 10 }, { x: 90, y: 20 }, { x: 40, y: 85 }];
  const r = R.solveCarry({ w: 1, h: 1 }, { w: 1, h: 1 }, sp, sp.map((p) => R.applyAff(A, p)));
  ok(r.ok && r.kind === "affine" && ["a", "b", "c", "d", "e", "f"].every((k) => near(r.t[k], A[k], 1e-9)), "C 3점 → 전단 포함 아핀 정확해", r);
  ok(r.ok && r.rms < 1e-9, "C 3점 잔차 0", r.rms);
  const sp4 = sp.concat([{ x: 70, y: 70 }]);
  const dp4 = sp4.map((p) => R.applyAff(A, p)); dp4[3] = { x: dp4[3].x + 0.4, y: dp4[3].y - 0.3 };   // 4번째 점을 0.5% 잘못 찍음
  const r4 = R.solveCarry({ w: 1, h: 1 }, { w: 1, h: 1 }, sp4, dp4);
  ok(r4.ok && r4.rms > 0.05 && r4.maxErr < 0.5, "C 4점 최소제곱 — 잘못 찍은 점이 잔차로 드러남(rms " + (r4.rms || 0).toFixed(3) + "%)", r4);
  const col = R.solveCarry({ w: 1, h: 1 }, { w: 1, h: 1 }, [{ x: 0, y: 0 }, { x: 50, y: 50 }, { x: 100, y: 100 }], [{ x: 0, y: 0 }, { x: 40, y: 50 }, { x: 90, y: 100 }]);
  ok(!col.ok && /한 줄/.test(col.error), "C 세 점 한 줄 → 거부", col);
  const nearCol = R.solveCarry({ w: 1, h: 1 }, { w: 1, h: 1 }, [{ x: 0, y: 0 }, { x: 50, y: 50.0001 }, { x: 100, y: 100 }], [{ x: 0, y: 0 }, { x: 40, y: 50 }, { x: 90, y: 100 }]);
  ok(!nearCol.ok && /한 줄/.test(nearCol.error), "C 거의 한 줄(0.0001%) → 같은 사유로 거부(거대 배율로 새지 않음)", nearCol);
  ok(R.affSane({ a: 0, b: 0, c: 0, d: 0, e: 0, f: 0 }) !== "" && R.affSane({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) === "" && R.affSane({ a: 1 }) !== "", "C 비정상 변환(퇴화·숫자 아님) 거부");
}

console.log("\n[D. 역변환 왕복 오차 < 0.1%]");
{
  const T = R.solveCarry({ w: 1189, h: 841 }, { w: 1189, h: 841 }, [{ x: 20, y: 20 }, { x: 80, y: 70 }], [{ x: 24, y: 17 }, { x: 77, y: 79 }]).t;
  const inv = R.invertAff(T);
  ok(!!inv && R.isIdentity(R.composeAff(inv, T), 1e-12), "D T⁻¹∘T = I");
  let worst = 0;
  const pins = Array.from({ length: 200 }, (_, i) => ({ id: i, x: rnd() * 100, y: rnd() * 100, page: 1 }));
  const there = R.carryPins(pins, T, null), back = R.carryPins(there, inv, null);
  pins.forEach((p, i) => { worst = Math.max(worst, Math.hypot(back[i].x - p.x, back[i].y - p.y)); });
  ok(worst < 0.1, "D 핀 200개 이월→역이월 최대 오차 " + worst.toExponential(2) + "% (< 0.1%)", worst);
  ok(worst < 1e-3, "D 반올림(1e-4) 포함해도 1e-3% 미만", worst);
  ok(R.invertAff({ a: 1, b: 1, c: 1, d: 1, e: 0, f: 0 }) === null, "D 특이행렬 역변환 = null");
}

console.log("\n[E. 자동 제안]");
{
  const same = R.autoCarry({ w: 2384, h: 1684 }, { w: 4096, h: 2893.4 });
  ok(same.ok && same.kind === "identity" && R.isIdentity(same.t), "E 비율 같음(해상도만 다름) → % 그대로", same);
  const fit = R.autoCarry({ w: 1000, h: 500 }, { w: 1000, h: 1000 });
  const tl = R.applyAff(fit.t, { x: 0, y: 0 }), br = R.applyAff(fit.t, { x: 100, y: 100 });
  ok(fit.ok && fit.kind === "fit" && nearPt(tl, { x: 0, y: 25 }) && nearPt(br, { x: 100, y: 75 }), "E 2:1 → 1:1 = 가로 맞춤·세로 가운데(0,25)~(100,75)", { tl, br });
}

console.log("\n[F. 이월]");
{
  const T = { a: 0.5, b: 0, c: 0, d: 0.5, e: 10, f: 20 };
  const pins = [{ id: 1, x: 10, y: 10, page: 1, label: "1", imageId: "img_a" }, { id: 2, _deleted: true, ts: 5, x: 1, y: 1 }, { id: 3, x: 50, y: 60, page: 2, label: "P1", note: "n" }];
  const before = JSON.stringify(pins);
  const out = R.carryPins(pins, T, { rev: "rev_x", at: 99 });
  ok(JSON.stringify(pins) === before, "F 입력 불변");
  ok(out[0].x === 15 && out[0].y === 25 && out[0].imageId === "img_a" && out[0].label === "1" && out[0].revReview.rev === "rev_x", "F 핀 좌표만 이월 + 검토 배지(revReview) · 다른 필드 보존", out[0]);
  ok(JSON.stringify(out[1]) === JSON.stringify(pins[1]), "F tombstone 그대로", out[1]);
  const off = R.carryPins([{ id: 9, x: 90, y: 90 }], { a: 1, b: 0, c: 0, d: 1, e: 30, f: 0 }, { rev: "r", at: 1 })[0];
  ok(off.x === 120 && off.revReview.out === true, "F 페이지 밖으로 나간 핀 = 자르지 않고 out 표시", off);
  ok(!("revReview" in R.carryPins([{ id: 1, x: 1, y: 1 }], T, null)[0]), "F flag 없으면 배지 없음(미리보기용)");
  const z = R.carryZones([{ id: "z1", x: 10, y: 10, w: 20, h: 10, page: 1, label: "A" }, { id: "z2", shape: "circle", cx: 50, cy: 50, r: 10, x: 40, y: 40, w: 20, h: 20 },
    { id: "z3", shape: "poly", points: [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 0, y: 10 }] }, { id: "z4", _deleted: true }], T);
  ok(z[0].x === 15 && z[0].y === 25 && z[0].w === 10 && z[0].h === 5 && !z[0].shape && z[0].label === "A", "F 영역 rect 축 정렬 = rect 유지", z[0]);
  ok(z[1].cx === 35 && z[1].cy === 45 && z[1].r === 5 && z[1].w === 10, "F 영역 circle 중심·반지름·bbox", z[1]);
  ok(z[2].points[1].x === 15 && z[2].points[1].y === 20 && z[2].w === 5, "F 영역 poly 점마다 + bbox", z[2]);
  ok(z[3]._deleted === true && !("x" in z[3]), "F 영역 tombstone 그대로");
  const rot = R.solveCarry({ w: 1, h: 1 }, { w: 1, h: 1 }, [{ x: 0, y: 0 }, { x: 10, y: 0 }], [{ x: 50, y: 50 }, { x: 50, y: 60 }]).t;   // 90° 회전
  const zr = R.carryZones([{ id: "r", x: 0, y: 0, w: 10, h: 5 }], rot)[0];
  ok(zr.shape === "poly" && zr.points.length === 4, "F 회전이면 rect → 4점 poly(모양 보존)", zr);
  const an = R.carryAnnos([{ id: "a1", type: "pen", pts: [{ x: 0, y: 0 }, { x: 10, y: 10 }] }, { id: "a2", type: "rect", x: 10, y: 10, w: 10, h: 10 }, { id: "a3", type: "text", x: 2, y: 4, text: "t" }], T);
  ok(an[0].pts[1].x === 15 && an[1].x === 15 && an[1].w === 5 && an[2].x === 11 && an[2].y === 22 && an[2].text === "t", "F 주석 pen·rect·text", an);
  const cr = R.carryCrop({ x: 10, y: 10, w: 40, h: 20 }, T);
  ok(cr.x === 15 && cr.y === 25 && cr.w === 20 && cr.h === 10, "F 구역 crop", cr);
  ok(R.carryCrop(null, T) === null, "F crop 없음 → 그대로");
}

console.log("\n[G. diff]");
{
  const a = [{ id: 1, x: 10, y: 10 }, { id: 2, x: 20, y: 20 }, { id: 3, x: 30, y: 30 }, { id: 4, _deleted: true }];
  const b = [{ id: 1, x: 10.2, y: 10 }, { id: 2, x: 25, y: 20, label: "2" }, { id: 5, x: 1, y: 1 }, { id: 3, _deleted: true }];
  const d = R.diffPins(a, b);
  ok(d.added.join() === "5" && d.removed.join() === "3" && d.moved.length === 1 && d.moved[0].id === "2" && d.moved[0].dist === 5 && d.unchanged === 1, "G added 5 · removed 3(삭제) · moved 2(5%) · unchanged 1(0.2%<0.5%)", d);
}

console.log("\n[H. 되돌림 병합]");
{
  const T = { a: 0.8, b: 0.1, c: -0.1, d: 0.8, e: 12, f: 5 };
  const snap = [{ id: 1, x: 10.123456, y: 9.876543, label: "1" }, { id: 2, x: 50, y: 50, label: "2" }, { id: 3, x: 70, y: 20, label: "3" }];
  const applied = R.carryPins(snap, T, { rev: "rev_h", at: 1 });
  // 적용 뒤: 1 = 그대로(사진만 붙임), 2 = 사람이 옮김, 3 = 삭제, 4 = 새로 찍음
  const cur = [Object.assign({}, applied[0], { imageId: "img_new" }), Object.assign({}, applied[1], { x: 40, y: 40, revReview: null }), { id: 3, _deleted: true, ts: 9 }, { id: 4, x: 60, y: 60 }];
  const back = R.revertPinsMerge(cur, snap, T, "rev_h");
  ok(back[0].x === 10.123456 && back[0].y === 9.876543 && back[0].imageId === "img_new" && !("revReview" in back[0]), "H 손대지 않은 핀 = 스냅샷 좌표 정확 복원 + 적용 뒤 붙인 사진 보존", back[0]);
  const inv = R.invertAff(T), e2 = R.applyAff(inv, { x: 40, y: 40 }), e4 = R.applyAff(inv, { x: 60, y: 60 });
  ok(near(back[1].x, e2.x, 1e-3) && near(back[1].y, e2.y, 1e-3), "H 적용 뒤 옮긴 핀 = 역변환(사람이 옮긴 의도 보존)", back[1]);
  ok(back[2]._deleted === true && near(back[3].x, e4.x, 1e-3), "H 삭제 유지 · 새 핀 역변환", back.slice(2));
  const zs = [{ id: "z", x: 10, y: 10, w: 10, h: 10 }];
  const zb = R.revertShapesMerge(R.carryZones(zs, T), zs, T, R.carryZones);
  ok(JSON.stringify(zb[0]) === JSON.stringify(zs[0]), "H 영역 — 손대지 않았으면 스냅샷 그대로", zb[0]);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("\n" + (failed ? "FAIL " + failed : "ALL PASS"));
process.exit(failed ? 1 : 0);
