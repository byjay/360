/**
 * src/lib/revCore.ts — [WO 20261010-revision] 도면 개정(Rev) 관리의 순수 계산 SoT.
 *
 * 서버(src/index.tsx 개정 라우트)만 이 파일을 쓴다. 클라이언트는 미리보기도 서버(/revisions/preview)에 맡긴다
 *   → 아핀 계산·이월 규칙이 두 벌이 되지 않는다(번들은 IIFE 라 서버 모듈을 import 할 수 없다).
 * 의존성 0 · 입력 불변(원본 미변경) · 예외 대신 null/에러 문자열.
 *
 * 재사용(창고): 02-hooks-utils/utils/revisionFormat.ts(개정 표기 파싱 SoT — 숫자 + 이 프로젝트 요구의 알파벳 확장)
 *             02-hooks-utils/utils/cableRevisionDiff.ts(added/removed/modified 분류 → 핀 added/removed/moved 로 이식)
 *
 * 좌표계: 핀·영역·주석·구역 crop 은 전부 "페이지 기준 %"(0..100). 아핀은 % 공간 2x3 행렬
 *   {a,b,c,d,e,f}: x' = a·x + c·y + e,  y' = b·x + d·y + f  (CSS matrix(a,b,c,d,e,f) 와 같은 배치).
 *   기준점 2개 = 닮음변환(이동·회전·균일 배율) — 회전·배율은 **실제 종이 비율**(물리 좌표)에서 풀어야
 *   가로세로 비율이 다른 페이지에서 회전이 찌그러지지 않는다 → dims({w,h}) 로 %↔물리 변환 후 풀고 되돌린다.
 *   기준점 3개 이상 = 일반 아핀(최소제곱). 아핀은 축 배율에 불변이라 % 공간에서 풀어도 같다.
 */

export type Pt = { x: number, y: number }
export type Dims = { w: number, h: number }
export type Aff = { a: number, b: number, c: number, d: number, e: number, f: number }

export const IDENTITY: Aff = Object.freeze({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 }) as Aff

/* ═════════════ 개정 표기 (창고 revisionFormat.ts 이식 + 알파벳) ═════════════ */

const REV_RE = /^(?:rev(?:ision)?\.?\s*|r\.?\s*)?([A-Za-z]{1,2}|\d{1,4})$/i

/** 자유서식("rev a" · "REV.1" · "R2" · "B" · "3") → 표준 표기 "Rev.A" / "Rev.3". 형식 밖이면 공백 정리한 원문(최대 24자). 빈값 → "". */
export function normalizeRevLabel(s: unknown): string {
  const str = String(s == null ? '' : s).trim().replace(/\s+/g, ' ')
  if (!str) return ''
  const m = str.match(REV_RE)
  if (!m) return str.slice(0, 24)
  const v = m[1]
  return 'Rev.' + (/^\d+$/.test(v) ? String(parseInt(v, 10)) : v.toUpperCase())
}

/** 중복 판정 키 — 같은 개정을 다른 표기로 두 번 올리지 못하게(대소문자·공백 무시). */
export function revLabelKey(s: unknown): string {
  return normalizeRevLabel(s).toUpperCase().replace(/\s+/g, '')
}

/** 다음 개정 제안 — Rev.A→Rev.B, Rev.Z→Rev.AA, Rev.3→Rev.4. 형식 밖·빈값이면 Rev.1(기준 개정 Rev.0 다음). */
export function nextRevLabel(prev: unknown): string {
  const n = normalizeRevLabel(prev)
  const m = n.match(/^Rev\.(.+)$/)
  if (!m) return 'Rev.1'
  const v = m[1]
  if (/^\d+$/.test(v)) return 'Rev.' + (parseInt(v, 10) + 1)
  if (/^[A-Z]$/.test(v)) return 'Rev.' + (v === 'Z' ? 'AA' : String.fromCharCode(v.charCodeAt(0) + 1))
  if (/^[A-Z]{2}$/.test(v)) {
    const hi = v.charCodeAt(0), lo = v.charCodeAt(1)
    return 'Rev.' + (lo < 90 ? v[0] + String.fromCharCode(lo + 1) : (hi < 90 ? String.fromCharCode(hi + 1) + 'A' : 'ZZ'))
  }
  return 'Rev.1'
}

/* ═════════════ 아핀 ═════════════ */

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

export function isAff(m: any): m is Aff {
  return !!m && fin(m.a) && fin(m.b) && fin(m.c) && fin(m.d) && fin(m.e) && fin(m.f)
}
export function det(m: Aff): number { return m.a * m.d - m.b * m.c }
export function applyAff(m: Aff, p: Pt): Pt { return { x: m.a * p.x + m.c * p.y + m.e, y: m.b * p.x + m.d * p.y + m.f } }
/** m2 ∘ m1 (m1 먼저 적용). */
export function composeAff(m2: Aff, m1: Aff): Aff {
  return {
    a: m2.a * m1.a + m2.c * m1.b, b: m2.b * m1.a + m2.d * m1.b,
    c: m2.a * m1.c + m2.c * m1.d, d: m2.b * m1.c + m2.d * m1.d,
    e: m2.a * m1.e + m2.c * m1.f + m2.e, f: m2.b * m1.e + m2.d * m1.f + m2.f,
  }
}
export function invertAff(m: Aff): Aff | null {
  const D = det(m)
  if (!fin(D) || Math.abs(D) < 1e-12) return null
  return { a: m.d / D, b: -m.b / D, c: -m.c / D, d: m.a / D, e: (m.c * m.f - m.d * m.e) / D, f: (m.b * m.e - m.a * m.f) / D }
}
/** 회전·전단 없음(축 정렬) — 사각형이 사각형으로 남는가. */
export function isAxisAligned(m: Aff, eps = 1e-9): boolean { return Math.abs(m.b) < eps && Math.abs(m.c) < eps }
export function isIdentity(m: Aff, eps = 1e-9): boolean {
  return Math.abs(m.a - 1) < eps && Math.abs(m.d - 1) < eps && Math.abs(m.b) < eps && Math.abs(m.c) < eps && Math.abs(m.e) < eps && Math.abs(m.f) < eps
}
/** 서버가 받는 변환의 정상 범위 — 비정상(퇴화·뒤집힘 과다·거대 이동)은 거부. % 공간 기준. */
export function affSane(m: any): string {
  if (!isAff(m)) return '변환 값이 숫자가 아닙니다'
  const D = det(m)
  if (Math.abs(D) < 1e-3) return '변환이 퇴화했습니다(기준점이 한 줄 위에 있거나 너무 가깝습니다)'
  if (Math.abs(D) > 1e3) return '배율이 비정상적으로 큽니다'
  if (Math.abs(m.e) > 1e4 || Math.abs(m.f) > 1e4) return '이동량이 비정상적으로 큽니다'
  return ''
}

/** 물리 좌표 ↔ % : P = S·p, S = diag(w/100, h/100). */
const scaleAff = (d: Dims): Aff => ({ a: d.w / 100, b: 0, c: 0, d: d.h / 100, e: 0, f: 0 })
const dimsOk = (d: any): d is Dims => !!d && fin(d.w) && fin(d.h) && d.w > 0 && d.h > 0

/** 기준점 ≥2 최소제곱 닮음변환(회전 + 균일 배율 + 이동, 반사 없음). 2점이면 정확해. */
export function solveSimilarity(src: Pt[], dst: Pt[]): Aff | null {
  const n = Math.min(src.length, dst.length)
  if (n < 2) return null
  let px = 0, py = 0, qx = 0, qy = 0
  for (let i = 0; i < n; i++) { px += src[i].x; py += src[i].y; qx += dst[i].x; qy += dst[i].y }
  px /= n; py /= n; qx /= n; qy /= n
  let ss = 0, A = 0, B = 0
  for (let i = 0; i < n; i++) {
    const ux = src[i].x - px, uy = src[i].y - py, vx = dst[i].x - qx, vy = dst[i].y - qy
    ss += ux * ux + uy * uy
    A += ux * vx + uy * vy
    B += ux * vy - uy * vx
  }
  if (!(ss > 1e-12)) return null
  A /= ss; B /= ss
  return { a: A, b: B, c: -B, d: A, e: qx - (A * px - B * py), f: qy - (B * px + A * py) }
}

/** 3x3 선형계 (Cramer). 퇴화면 null. */
function solve3(M: number[][], v: number[]): number[] | null {
  const d3 = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0])
  const D = d3(M)
  if (!fin(D) || Math.abs(D) < 1e-12) return null
  const out: number[] = []
  for (let k = 0; k < 3; k++) {
    const Mk = M.map((row, i) => row.map((x, j) => (j === k ? v[i] : x)))
    out.push(d3(Mk) / D)
  }
  return out
}

/** 기준점 ≥3 최소제곱 일반 아핀. 세 점이 한 줄이면 null. */
export function solveAffine(src: Pt[], dst: Pt[]): Aff | null {
  const n = Math.min(src.length, dst.length)
  if (n < 3) return null
  // 수치 안정: 원점 이동 후 풀기
  let px = 0, py = 0
  for (let i = 0; i < n; i++) { px += src[i].x; py += src[i].y }
  px /= n; py /= n
  let sxx = 0, sxy = 0, syy = 0, sx = 0, sy = 0
  const bx = [0, 0, 0], by = [0, 0, 0]
  for (let i = 0; i < n; i++) {
    const x = src[i].x - px, y = src[i].y - py, X = dst[i].x, Y = dst[i].y
    sxx += x * x; sxy += x * y; syy += y * y; sx += x; sy += y
    bx[0] += x * X; bx[1] += y * X; bx[2] += X
    by[0] += x * Y; by[1] += y * Y; by[2] += Y
  }
  const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]]
  // 공선성: 중심화 공분산 행렬식이 산포 대비 0 에 가까우면 거부
  const spread = sxx + syy
  if (!(spread > 1e-12) || (sxx * syy - sxy * sxy) < 1e-10 * spread * spread) return null
  const r1 = solve3(M, bx), r2 = solve3(M, by)
  if (!r1 || !r2) return null
  // x' = a(x-px) + c(y-py) + e0 → e = e0 - a·px - c·py
  const a = r1[0], c = r1[1], b = r2[0], d = r2[1]
  return { a, b, c, d, e: r1[2] - a * px - c * py, f: r2[2] - b * px - d * py }
}

export type CarrySolve = { ok: true, t: Aff, kind: 'similarity' | 'affine' | 'identity' | 'fit', rms: number, maxErr: number } | { ok: false, error: string }

/**
 * 이전 개정 % → 새 개정 % 변환.
 * srcPts/dstPts = 양쪽 도면에 찍은 같은 지점(%) 짝. 2점 = 닮음(물리 비율 보정), ≥3점 = 아핀.
 * rms/maxErr = 기준점 잔차(새 도면 % 단위) — 3점 이상에서 사람이 잘못 찍은 점을 알려준다.
 */
export function solveCarry(srcDims: Dims, dstDims: Dims, srcPts: Pt[], dstPts: Pt[]): CarrySolve {
  if (!dimsOk(srcDims) || !dimsOk(dstDims)) return { ok: false, error: '도면 크기 정보가 없습니다' }
  const n = Math.min((srcPts || []).length, (dstPts || []).length)
  if (n < 2) return { ok: false, error: '기준점이 2쌍 이상 필요합니다' }
  for (let i = 0; i < n; i++) if (!fin(srcPts[i]?.x) || !fin(srcPts[i]?.y) || !fin(dstPts[i]?.x) || !fin(dstPts[i]?.y)) return { ok: false, error: '기준점 좌표가 숫자가 아닙니다' }
  let t: Aff | null
  let kind: 'similarity' | 'affine'
  if (n === 2) {
    const S = scaleAff(srcDims), D = scaleAff(dstDims), Di = invertAff(D)!
    const phys = solveSimilarity(srcPts.slice(0, 2).map((p) => applyAff(S, p)), dstPts.slice(0, 2).map((p) => applyAff(D, p)))
    if (!phys) return { ok: false, error: '기준점 두 개가 같은 위치입니다 — 서로 떨어진 두 지점을 찍으세요' }
    t = composeAff(Di, composeAff(phys, S))
    kind = 'similarity'
  } else {
    t = solveAffine(srcPts.slice(0, n), dstPts.slice(0, n))
    if (!t) return { ok: false, error: '기준점이 한 줄 위에 있습니다 — 삼각형을 이루게 찍으세요' }
    kind = 'affine'
  }
  const why = affSane(t)
  if (why) return { ok: false, error: why }
  let se = 0, mx = 0
  for (let i = 0; i < n; i++) {
    const q = applyAff(t, srcPts[i])
    const e = Math.hypot(q.x - dstPts[i].x, q.y - dstPts[i].y)
    se += e * e; if (e > mx) mx = e
  }
  return { ok: true, t, kind, rms: Math.sqrt(se / n), maxErr: mx }
}

/** 자동 제안(기준점 없이) — 비율이 같으면 % 좌표 그대로(identity), 다르면 새 페이지 안에 비율 유지·가운데 맞춤. */
export function autoCarry(srcDims: Dims, dstDims: Dims): CarrySolve {
  if (!dimsOk(srcDims) || !dimsOk(dstDims)) return { ok: false, error: '도면 크기 정보가 없습니다' }
  const r1 = srcDims.w / srcDims.h, r2 = dstDims.w / dstDims.h
  if (Math.abs(r1 - r2) / r1 < 0.005) return { ok: true, t: { ...IDENTITY }, kind: 'identity', rms: 0, maxErr: 0 }
  const s = Math.min(dstDims.w / srcDims.w, dstDims.h / srcDims.h)
  const phys: Aff = { a: s, b: 0, c: 0, d: s, e: (dstDims.w - s * srcDims.w) / 2, f: (dstDims.h - s * srcDims.h) / 2 }
  const t = composeAff(invertAff(scaleAff(dstDims))!, composeAff(phys, scaleAff(srcDims)))
  return { ok: true, t, kind: 'fit', rms: 0, maxErr: 0 }
}

/* ═════════════ 이월(핀·영역·주석·구역 crop) ═════════════ */

const R4 = (v: number) => Math.round(v * 1e4) / 1e4
const R3 = (v: number) => Math.round(v * 1e3) / 1e3
const live = (o: any) => !!o && o.id != null && !o._deleted
const outOfPage = (p: Pt) => p.x < 0 || p.x > 100 || p.y < 0 || p.y > 100

export type ReviewFlag = { rev: string, at: number, out?: boolean }

/** 핀 이월 — 살아있는 핀의 x/y 만 바꾼다(tombstone·다른 필드 불변). 좌표는 자르지 않는다(되돌림이 정확하도록) —
 *  페이지 밖으로 나간 핀은 revReview.out 으로 표시. flag 가 있으면 이월된 핀마다 revReview(검토 필요) 기록. */
export function carryPins(pins: any[], t: Aff, flag?: { rev: string, at: number } | null): any[] {
  return (Array.isArray(pins) ? pins : []).map((p) => {
    if (!live(p) || !fin(p.x) || !fin(p.y)) return p
    const q = applyAff(t, { x: p.x, y: p.y })
    const np: any = Object.assign({}, p, { x: R4(q.x), y: R4(q.y) })
    if (flag) { const rf: ReviewFlag = { rev: flag.rev, at: flag.at }; if (outOfPage(np)) rf.out = true; np.revReview = rf }
    return np
  })
}

function bboxOf(pts: Pt[]) {
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y)
  const x = Math.min(...xs), y = Math.min(...ys)
  return { x: R3(x), y: R3(y), w: R3(Math.max(...xs) - x), h: R3(Math.max(...ys) - y) }
}
const rectCorners = (r: any): Pt[] => [{ x: r.x, y: r.y }, { x: r.x + r.w, y: r.y }, { x: r.x + r.w, y: r.y + r.h }, { x: r.x, y: r.y + r.h }]
const linScale = (t: Aff) => Math.sqrt(Math.abs(det(t)))

/** 영역(zones) 이월 — rect(축 정렬 유지면 rect, 회전·전단이면 4점 poly) · circle(중심 이동, 반지름 × √|det|) · poly(점마다). bbox(x,y,w,h) 재계산. */
export function carryZones(zones: any[], t: Aff): any[] {
  return (Array.isArray(zones) ? zones : []).map((z) => {
    if (!live(z)) return z
    const out: any = Object.assign({}, z)
    if (z.shape === 'circle' && fin(z.cx) && fin(z.cy) && fin(z.r)) {
      const c = applyAff(t, { x: z.cx, y: z.cy })
      out.cx = R3(c.x); out.cy = R3(c.y); out.r = R3(z.r * linScale(t))
      Object.assign(out, { x: R3(out.cx - out.r), y: R3(out.cy - out.r), w: R3(out.r * 2), h: R3(out.r * 2) })
    } else if (z.shape === 'poly' && Array.isArray(z.points)) {
      out.points = z.points.map((p: any) => (fin(p?.x) && fin(p?.y)) ? (() => { const q = applyAff(t, p); return { x: R3(q.x), y: R3(q.y) } })() : p)
      const ok = out.points.filter((p: any) => fin(p?.x) && fin(p?.y))
      if (ok.length) Object.assign(out, bboxOf(ok))
    } else if (fin(z.x) && fin(z.y) && fin(z.w) && fin(z.h)) {
      const pts = rectCorners(z).map((p) => applyAff(t, p))
      if (isAxisAligned(t)) Object.assign(out, bboxOf(pts))
      else { out.shape = 'poly'; out.points = pts.map((p) => ({ x: R3(p.x), y: R3(p.y) })); Object.assign(out, bboxOf(pts)) }
    }
    return out
  })
}

/** 주석(annotations) 이월 — pen(점마다) · highlight/rect(변환된 네 모서리의 외접 사각형) · text(기준점). */
export function carryAnnos(annos: any[], t: Aff): any[] {
  return (Array.isArray(annos) ? annos : []).map((a) => {
    if (!live(a)) return a
    const out: any = Object.assign({}, a)
    if (Array.isArray(a.pts)) {
      out.pts = a.pts.map((p: any) => (fin(p?.x) && fin(p?.y)) ? (() => { const q = applyAff(t, p); return Object.assign({}, p, { x: R3(q.x), y: R3(q.y) }) })() : p)
    } else if (fin(a.x) && fin(a.y) && fin(a.w) && fin(a.h)) {
      Object.assign(out, bboxOf(rectCorners(a).map((p) => applyAff(t, p))))
    } else if (fin(a.x) && fin(a.y)) {
      const q = applyAff(t, a); out.x = R3(q.x); out.y = R3(q.y)
    }
    return out
  })
}

/** 구역 crop({x,y,w,h} %) 이월 — 외접 사각형. 형식 밖이면 그대로. */
export function carryCrop(crop: any, t: Aff): any {
  if (!crop || !fin(crop.x) || !fin(crop.y) || !fin(crop.w) || !fin(crop.h)) return crop
  return Object.assign({}, crop, bboxOf(rectCorners(crop).map((p) => applyAff(t, p))))
}

/* ═════════════ 핀 diff (창고 cableRevisionDiff.ts 이식: key=id, 추적필드=page·x·y) ═════════════ */

export type PinMove = { id: string, label: string, from: { page: number, x: number, y: number }, to: { page: number, x: number, y: number }, dist: number }
export type PinDiff = { added: string[], removed: string[], moved: PinMove[], unchanged: number }

/** oldPins(기준) → newPins(대상). 같은 좌표계여야 의미가 있다(이전 개정 핀은 carryPins 로 먼저 옮겨서 넣는다). eps = % 거리. */
export function diffPins(oldPins: any[], newPins: any[], eps = 0.5): PinDiff {
  const key = (p: any) => String(p.id)
  const oldMap = new Map<string, any>(), newMap = new Map<string, any>()
  for (const p of oldPins || []) if (live(p)) oldMap.set(key(p), p)
  for (const p of newPins || []) if (live(p)) newMap.set(key(p), p)
  const added: string[] = [], removed: string[] = [], moved: PinMove[] = []
  let unchanged = 0
  for (const k of newMap.keys()) if (!oldMap.has(k)) added.push(k)
  for (const k of oldMap.keys()) if (!newMap.has(k)) removed.push(k)
  for (const [k, o] of oldMap) {
    const n = newMap.get(k)
    if (!n) continue
    const op = Number(o.page || 1), np = Number(n.page || 1)
    const dist = (fin(o.x) && fin(o.y) && fin(n.x) && fin(n.y)) ? Math.hypot(n.x - o.x, n.y - o.y) : 0
    if (op !== np || dist > eps) moved.push({ id: k, label: String(n.label ?? o.label ?? ''), from: { page: op, x: o.x, y: o.y }, to: { page: np, x: n.x, y: n.y }, dist: R3(dist) })
    else unchanged++
  }
  added.sort(); removed.sort(); moved.sort((a, b) => a.id.localeCompare(b.id))
  return { added, removed, moved, unchanged }
}

/* ═════════════ 되돌리기 병합(적용 뒤 다른 저장이 있었을 때) ═════════════ */

const sameXY = (a: any, b: any, eps = 1e-6) => fin(a?.x) && fin(a?.y) && fin(b?.x) && fin(b?.y) && Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps

/**
 * 핀 되돌리기 병합 — 적용 뒤 다른 저장(사진 첨부·라벨 수정·새 핀·삭제)이 있었어도 그 변경을 잃지 않는다.
 *  · 스냅샷에도 있고 적용 이후 위치를 안 건드린 핀 → 스냅샷 좌표·스냅샷 revReview 로 되돌림(나머지 필드는 현재값 유지)
 *  · 적용 이후 사람이 옮긴 핀·적용 이후 새로 생긴 핀 → 현재 좌표를 역변환
 *  · tombstone(삭제)은 그대로 유지
 * cur = 현재 서버 핀, snap = 적용 직전 핀, t = 적용 변환, rev = 이 개정 id.
 */
export function revertPinsMerge(cur: any[], snap: any[], t: Aff, rev: string): any[] {
  const inv = invertAff(t)!
  const snapById = new Map<string, any>()
  for (const p of snap || []) if (p && p.id != null) snapById.set(String(p.id), p)
  return (cur || []).map((p) => {
    if (!live(p) || !fin(p.x) || !fin(p.y)) return p
    const s = snapById.get(String(p.id))
    const out: any = Object.assign({}, p)
    if (s && live(s) && fin(s.x) && fin(s.y)) {
      const carried = applyAff(t, s)
      if (sameXY({ x: R4(carried.x), y: R4(carried.y) }, p)) {
        out.x = s.x; out.y = s.y
        if (s.revReview !== undefined) out.revReview = s.revReview; else delete out.revReview
        return out
      }
    }
    const q = applyAff(inv, p)
    out.x = R4(q.x); out.y = R4(q.y)
    if (out.revReview && out.revReview.rev === rev) delete out.revReview
    return out
  })
}

/** 영역·주석 되돌리기 병합 — 스냅샷을 이월한 값과 지금 값이 같으면 스냅샷으로, 다르면(적용 뒤 수정·추가) 현재 값을 역이월. */
export function revertShapesMerge(cur: any[], snap: any[], t: Aff, carry: (xs: any[], m: Aff) => any[]): any[] {
  const inv = invertAff(t)!
  const snapById = new Map<string, any>()
  for (const s of snap || []) if (s && s.id != null) snapById.set(String(s.id), s)
  return (cur || []).map((o) => {
    if (!live(o)) return o
    const s = snapById.get(String(o.id))
    if (s && live(s) && JSON.stringify(carry([s], t)[0]) === JSON.stringify(o)) return s
    return carry([o], inv)[0]
  })
}
