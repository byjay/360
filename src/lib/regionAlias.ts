/**
 * src/lib/regionAlias.ts — [WO 20261012-pinsync] 원본 ↔ 벡터 복사 구역 핀 연동의 순수 계산 SoT.
 *
 * 마스터 "전체 PDF에서 구역을 지정하고 그 구역에 핀을 박았는데 구역의 페이지에서는 그게 연동이 안되네 서로 연동되게해야지."
 * 설계 .tmp/design-pinsync.md (A★): 원본 배포본 D0 가 핀 정본. 벡터 복사 구역 배포본 D1 은 핀에 관해서 D0 의 별칭 —
 *   읽기 = D0 핀을 구역 상자(box)로 **투영**, 쓰기 = 구역 좌표를 D0 좌표로 **역변환**해 D0 에만 쓴다(같은 사실 1곳 저장).
 *
 * 좌표 수식 = 클라 public/js/modules/10_MapCtrl.js deckCropPctToPage / pageToDeckCropPct 와 **같은 수식**의 서버 사본.
 *   (클라는 IIFE 번들이라 공유 import 경로가 없다) → 드리프트는 tests/p151 ① 교차구현 일치 테스트가 못박는다.
 *   함수명은 41_RegionMerge.toBase/fromBase 와 같은 의미·같은 이름(개념 분기 방지).
 * 의존성 0 · 입력 불변 · 예외 대신 null.
 *
 * 1차 범위 = 핀만. zones/annotations/checkboard_start 는 구역(D1) 로컬로 남는다(설계 §7 — 문서화된 한계).
 */

export type Crop = { x: number, y: number, w: number, h: number }
/** 구역 상자 = 기준(원본) 배포본 home 의 page 페이지 % 상자 crop. deckId = 그 상자를 정의한 decks 행. */
export type Box = { home: string, page: number, crop: Crop, deckId: string }

const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)
const live = (p: any) => !!p && p.id != null && !p._deleted

/** 구역(D1 page 1 %) → 원본(D0 src_page %) — = MapCtrl.deckCropPctToPage */
export function toBase(x: number, y: number, crop: Crop): { x: number, y: number } {
  if (!crop || !(crop.w > 0) || !(crop.h > 0)) return { x, y }
  return { x: crop.x + (x / 100) * crop.w, y: crop.y + (y / 100) * crop.h }
}

/** 원본(D0 src_page %) → 구역(D1 page 1 %). 상자 밖 = null(투영 제외) — = MapCtrl.pageToDeckCropPct */
export function fromBase(x: number, y: number, crop: Crop): { x: number, y: number } | null {
  if (!crop || !(crop.w > 0) || !(crop.h > 0)) return { x, y }
  if (x < crop.x || x > crop.x + crop.w || y < crop.y || y > crop.y + crop.h) return null
  return { x: (x - crop.x) / crop.w * 100, y: (y - crop.y) / crop.h * 100 }
}

export function parseCrop(v: unknown): Crop | null {
  let c: any = v
  if (typeof v === 'string') { try { c = JSON.parse(v) } catch { return null } }
  if (!c || !fin(c.x) || !fin(c.y) || !fin(c.w) || !fin(c.h) || !(c.w > 0) || !(c.h > 0)) return null
  return { x: c.x, y: c.y, w: c.w, h: c.h }
}

export function parsePins(json: unknown): any[] {
  if (Array.isArray(json)) return json
  try { const a = JSON.parse(String(json || '[]')); return Array.isArray(a) ? a : [] } catch { return [] }
}

/** 원본 핀이 상자 안인가(살아있고 그 페이지·상자 안). */
export function inBox(p: any, box: { page: number, crop: Crop }): boolean {
  return live(p) && fin(p.x) && fin(p.y) && (Number(p.page) || 1) === box.page && fromBase(p.x, p.y, box.crop) !== null
}

/** 구역 행(decks) 목록에서 depId(D1)의 핀 정본 상자를 찾는다 — DB 무관 순수 판정(작업본·배포 스냅샷 공용).
 *  @returns Box | 'ambiguous'(같은 D1 을 서로 다른 상자로 가리키는 구역 2개 이상) | null(별칭 아님) */
export function aliasBoxOf(decks: any[], depId: string): Box | 'ambiguous' | null {
  const id = String(depId || '')
  if (!id) return null
  const rows = (Array.isArray(decks) ? decks : []).filter((d) => d && !Number(d.deleted) && String(d.deployment_id || '') === id && d.src_dep_id)
  if (!rows.length) return null
  const boxes: Box[] = []
  for (const d of rows) {
    const crop = parseCrop(d.src_crop)
    const home = String(d.src_dep_id)
    const page = Number(d.src_page) || 1
    if (!crop || home === id) continue
    boxes.push({ home, page, crop, deckId: String(d.id) })
  }
  if (!boxes.length) return null
  const key = (b: Box) => JSON.stringify([b.home, b.page, b.crop.x, b.crop.y, b.crop.w, b.crop.h])
  if (new Set(boxes.map(key)).size > 1) return 'ambiguous'
  return boxes[0]
}

/** 원본 핀 → 구역 핀(살아있고 상자 안만 · id/label/첨부 보존 · 순서 보존). tombstone 은 좌표가 없어 상자 판정이 불가 →
 *  그대로 싣는다(클라 병합의 부활 방지용 — 원본 GET 과 같은 취급). */
export function projectPins(pins: any[], box: { page: number, crop: Crop }): any[] {
  const out: any[] = []
  for (const p of (Array.isArray(pins) ? pins : [])) {
    if (!p || p.id == null) continue
    if (p._deleted) { out.push(p); continue }
    if (!inBox(p, box)) continue
    const q = fromBase(p.x, p.y, box.crop)!
    out.push(Object.assign({}, p, { x: q.x, y: q.y, page: 1 }))
  }
  return out
}

/** 구역 핀 1개 → 원본 좌표. homePin(같은 id 원본 핀)의 투영값과 좌표가 같으면(=구역에서 움직이지 않음) 원본 좌표를
 *  **그대로** 쓴다 — 부동소수 왕복 오차로 원본 바이트가 흔들리거나 개정 재기준화(rebaseArrayJson)가 오판하지 않게. */
export function unprojectPin(p: any, box: { page: number, crop: Crop }, homePin?: any): any {
  if (!p || p._deleted || !fin(p.x) || !fin(p.y)) return p
  if (homePin && live(homePin) && fin(homePin.x) && fin(homePin.y) && (Number(homePin.page) || 1) === box.page) {
    const q = fromBase(homePin.x, homePin.y, box.crop)
    if (q && q.x === p.x && q.y === p.y) return Object.assign({}, p, { x: homePin.x, y: homePin.y, page: box.page })
  }
  const b = toBase(p.x, p.y, box.crop)
  return Object.assign({}, p, { x: b.x, y: b.y, page: box.page })
}

export function unprojectPins(pins: any[], box: { page: number, crop: Crop }, homePins?: any[]): any[] {
  const byId = new Map<string, any>()
  for (const h of (Array.isArray(homePins) ? homePins : [])) if (h && h.id != null) byId.set(String(h.id), h)
  return (Array.isArray(pins) ? pins : []).map((p) => unprojectPin(p, box, p && p.id != null ? byId.get(String(p.id)) : undefined))
}

/** 구역 PATCH(핀 배열 전량) → 새 원본 핀 배열.
 *  = (home − live∩box) ∪ unproject(incoming), **원본 순서 보존**(번호 순번이 배열 순서에 묶여 있다 — PinSeries.numbers):
 *   · 상자 밖·다른 페이지·tombstone 원본 핀 = 바이트 그대로 유지
 *   · 상자 안 원본 핀 = incoming 에 같은 id 가 있으면 그 자리에서 교체, 없으면 제거(구역에서 지움 — PATCH 전량 치환 의미 그대로)
 *   · incoming 의 새 id = 끝에 추가 */
export function mergeIntoHome(homePins: any[], incoming: any[], box: { page: number, crop: Crop }): any[] {
  const home = Array.isArray(homePins) ? homePins : []
  const inc = unprojectPins(incoming, box, home)
  const incById = new Map<string, any>()
  for (const p of inc) if (p && p.id != null) incById.set(String(p.id), p)
  const used = new Set<string>()
  const out: any[] = []
  for (const h of home) {
    const k = h && h.id != null ? String(h.id) : null
    if (k != null && incById.has(k)) { if (!used.has(k)) { out.push(incById.get(k)); used.add(k) } continue }
    if (inBox(h, box)) continue
    out.push(h)
  }
  for (const p of inc) {
    const k = p && p.id != null ? String(p.id) : null
    if (k == null || used.has(k)) continue
    out.push(p); used.add(k)
  }
  return out
}

/** 번호·채번용 원본 최소 사본 — src_page 의 핀 전체(상자 밖 포함 · tombstone 제외), 구역 좌표계 page=1 로 정규화.
 *  author 는 싣지 않는다: 채번(PinSeries.nextInBand)은 author 를 무시한다(01b WO 20260930-numdup) → 정보 노출 최소. */
export function basePinsMin(pins: any[], page: number): any[] {
  const out: any[] = []
  for (const p of (Array.isArray(pins) ? pins : [])) {
    if (!live(p) || (Number(p.page) || 1) !== page) continue
    const o: any = { id: p.id, page: 1, label: p.label == null ? null : p.label }
    if (p.checkboard) o.checkboard = true
    out.push(o)
  }
  return out
}

/** /ops 핀 op 1개 → 원본 좌표(upsert 의 x/y/page 만). 다른 엔티티·delete 는 그대로. */
export function unprojectOp(op: any, box: { page: number, crop: Crop }, homePin?: any): any {
  if (!op || op.entity !== 'pin' || op.action === 'delete' || !op.data || typeof op.data !== 'object') return op
  const d = op.data
  if (fin(d.x) && fin(d.y)) return Object.assign({}, op, { data: unprojectPin(Object.assign({}, d, { id: op.id }), box, homePin) })
  if (d.page != null) return Object.assign({}, op, { data: Object.assign({}, d, { page: box.page }) })
  return op
}

/** 별칭 배포본의 version — 원본 version 에 큰 오프셋을 더한 값(단조 증가 · 역산 가능).
 *  🔴 왜 원본 version 그대로가 아닌가: 이 기능 배포 전에 구역을 연 클라는 base_version = D1 자기 version 을 들고 있다.
 *  그 값이 우연히 D0.version 과 같으면 낙관적 잠금을 통과해 "핀 0개 구역" 본문이 원본 상자 안 핀을 전부 지운다(조용한 유실).
 *  오프셋 공간은 D1 자기 version(작은 정수)과 절대 겹치지 않는다 → 그 클라는 409 → 병합(서버 투영 핀 흡수) 후 재저장. */
export const ALIAS_VERSION_OFFSET = 1_000_000_000
export function aliasVersion(homeVersion: unknown): number { return ALIAS_VERSION_OFFSET + (Number(homeVersion) || 0) }
/** 별칭 version → 원본 version. 오프셋 공간 밖(별칭 이전 값) = null(어느 원본 버전 기준인지 모름). */
export function homeVersionOf(aliasVer: unknown): number | null {
  const v = Number(aliasVer)
  if (aliasVer == null || !Number.isFinite(v) || v < ALIAS_VERSION_OFFSET) return null
  return v - ALIAS_VERSION_OFFSET
}

/** 이관(§2-2) 계획 — 구역 자기 핀(D1 좌표) → 원본 좌표 + id 충돌 재발급(rg<deckId>-<n>, provenance srcDeckId/srcPinId).
 *  inside = 구역 화면 범위(0..100) 안, outside = 밖(원본에선 상자 밖이 되어 구역에 안 보인다 — 유실은 아님). */
export function planMigration(d1Pins: any[], homePins: any[], box: Box): { pins: any[], idMap: Record<string, string>, inside: number, outside: number } {
  const taken = new Set<string>()
  for (const h of (Array.isArray(homePins) ? homePins : [])) if (h && h.id != null) taken.add(String(h.id))
  const idMap: Record<string, string> = {}
  const pins: any[] = []
  let inside = 0, outside = 0, n = 0
  for (const p of (Array.isArray(d1Pins) ? d1Pins : [])) {
    if (!live(p)) continue
    const inView = fin(p.x) && fin(p.y) && (Number(p.page) || 1) === 1 && p.x >= 0 && p.x <= 100 && p.y >= 0 && p.y <= 100
    if (inView) inside++; else outside++
    const q = unprojectPin(p, box)
    let id: any = p.id
    if (taken.has(String(id))) {
      do { n++; id = 'rg' + box.deckId + '-' + n } while (taken.has(String(id)))
      idMap[String(p.id)] = String(id)
      pins.push(Object.assign({}, q, { id, srcDeckId: box.deckId, srcPinId: p.id }))
    } else pins.push(q)
    taken.add(String(id))
  }
  return { pins, idMap, inside, outside }
}
