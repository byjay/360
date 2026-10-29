#!/usr/bin/env node
/**
 * markup-crop-ocr-eval.mjs — p184 마킹 도면 "잉크 덩어리 → 확대 조각 → 비전 OCR" 2단계 실측(측정 전용, 앱 코드 미수정)
 *
 * 배경: markup-ink-eval.mjs(1단계, 채도 기반 잉크 덩어리 검출)가 만든 blobs.json/report.json 을 이어받아,
 * 정답 근처 덩어리(19개) + 정답 없는 큰 덩어리(면적 상위 20개, 오검출 후보) 를 bbox 주변 여백 포함해
 * 정사각으로 잘라 2x 확대한 뒤, Workers AI 무료 비전 모델(scout) 에 "손글씨 숫자인지" 1회씩 순차 질의한다.
 *
 * 재사용(74_MarkupAlign.js, 재구현 금지): computeHomography, applyH — markup-ink-eval.mjs 와 동일 방식.
 * blobs.json 의 bbox/cx/cy 는 이미 RAW(4032x1816, EXIF 미반영) 좌표라 photo→orig 호모그래피(H)에 바로 넣을 수 있다
 * (markup-ocr-eval.mjs 처럼 회전 변환을 거칠 필요 없음 — 두 이미지 모두 node-canvas raw pixel 기준).
 *
 * 선행 조건: .tmp/ai-probe/ 의 임시 Worker(AI 바인딩, remote) 가
 *   wrangler dev --config .tmp/ai-probe/wrangler.toml --port 8799 --local-protocol http
 * 로 떠 있어야 한다(HTTP 로만 질의, Workers AI SDK 직접 호출 아님). 모델은 scout 1종만(발주 지정, 유료 모델 금지).
 *
 * 입력(.tmp/, 커밋 대상 아님):
 *   .tmp/markup-samples/s5.jpg      — 현장 마킹 사진(raw pixel 4032x1816)
 *   .tmp/markup-ink/blobs.json      — 1단계 덩어리(105개, bbox/cx/cy/area/color, raw 좌표)
 *   .tmp/markup-eval/points.json    — 4점 호모그래피(photo raw→orig)
 *   .tmp/markup-eval/truth.json     — 정답 36개(orig 좌표계, label 에 '?' 있으면 번호 불명)
 *
 * 출력(.tmp/markup-crop/, 커밋 대상 아님):
 *   c###.png     — 조각 2x 확대 PNG(39개)
 *   manifest.json, report.json, result.png(격자 시각화)
 *
 * 실행: TEMP/TMP=E:\code-project\360\.tmp 지정 후 node build-tools/markup-crop-ocr-eval.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'
import { createCanvas, loadImage } from 'canvas'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SAMPLES = path.join(ROOT, '.tmp/markup-samples')
const EVAL_DIR = path.join(ROOT, '.tmp/markup-eval')
const INK_DIR = path.join(ROOT, '.tmp/markup-ink')
const OUT_DIR = path.join(ROOT, '.tmp/markup-crop')
const MODULE_SRC = fs.readFileSync(path.join(ROOT, 'public/js/modules/74_MarkupAlign.js'), 'utf8').replace(/\r\n/g, '\n')

const PROBE_URL = 'http://127.0.0.1:8799/'
const MODEL_ID = '@cf/meta/llama-4-scout-17b-16e-instruct' // 발주 지정: 무료 모델 1종만(src/lib/aiVision.ts:19 허용목록)
const MAX_TOKENS = 120 // 출력 스키마가 작아(bool+문자열+정수) 1200 같은 큰 값 불필요(markup-ocr-eval.mjs 의 40s+ 타임아웃 교훈)
const CALL_TIMEOUT_MS = 45000
const RETRY = 1 // 실패 시 1회만 재시도(발주 지정)
const NEURON_BUDGET = 2500 // 발주 지정 상한(일일 7000 중 이번 측정분)
const FALLBACK_NEURON_ESTIMATE_PER_CALL = 60 // 호출 전 예산 점검용 보수적 추정(실측 전)

const MATCH_RADIUS_FRAC = 0.03 // markup-ink-eval.mjs 와 동일(발주 지정값) — report.json matchRadiusPx(107.1)/origW(3570) 재현
const CROP_SIDE_MULT = 3 // bbox.h 의 약 3배를 정사각 한 변으로(발주 지정)
const MIN_CROP_SIDE = 160 // 최소 한 변(발주 지정)
const UPSCALE = 2 // 모델에 보낼 때 2x 확대(발주 지정)
const TOP_N_NO_TRUTH = 20 // 정답 없는 덩어리 중 면적 상위 N개(발주 지정)

function loadAlign() {
  const sandbox = { console, State: { pins: [] } }
  vm.createContext(sandbox)
  vm.runInContext(MODULE_SRC + '\n;globalThis.__MA = MarkupAlign;', sandbox)
  return vm.runInContext('__MA', sandbox)
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)) }

/* ── 정사각 크롭 창(이미지 경계 안으로 "이동"해 가능한 한 정사각을 유지, 불가하면 축소) ── */
function squareWindow(cx, cy, side, imgW, imgH) {
  let s = Math.min(side, imgW, imgH)
  let x0 = cx - s / 2, y0 = cy - s / 2
  if (x0 < 0) x0 = 0
  if (y0 < 0) y0 = 0
  if (x0 + s > imgW) x0 = imgW - s
  if (y0 + s > imgH) y0 = imgH - s
  return { x0: Math.round(x0), y0: Math.round(y0), s: Math.round(s) }
}

function canvasToDataUrl(canvas) {
  const buf = canvas.toBuffer('image/jpeg', { quality: 0.9 })
  return 'data:image/jpeg;base64,' + buf.toString('base64')
}

/* ── JSON 추출(모델이 설명을 덧붙여도 첫 {..} 블록만) ───────────────────────── */
function extractJson(text) {
  if (!text || typeof text !== 'string') return null
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

const MARK_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    type: 'object',
    properties: {
      is_handwritten_number: { type: 'boolean' },
      number: { type: 'string' }, // 없으면 "" (null 유니온 타입은 CF AI json_schema 검증기가 불안정할 수 있어 회피)
      digits_visible: { type: 'integer' },
    },
    required: ['is_handwritten_number', 'number', 'digits_visible'],
  },
}

const PROMPT_TEXT =
  '이 이미지는 선박 도면 사진에서 자른 작은 조각이다. 사람이 "손으로 쓴" 숫자(마킹 번호, 보통 1~2자리)가 있는지만 판별하라. ' +
  '인쇄된 도면 글자·치수·눈금(tick) 숫자는 제외한다(그건 손글씨가 아니다). ' +
  '손글씨 숫자가 보이면 그 숫자 문자열과 보이는 자리수를 적어라. 확실하지 않거나 숫자가 아니면 추측하지 말고 ' +
  'is_handwritten_number=false, number="", digits_visible=0 으로 답하라. ' +
  'JSON 만 출력(설명 금지): {"is_handwritten_number":true,"number":"17","digits_visible":2}'

async function postProbe(payload, timeoutMs) {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(PROBE_URL, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload), signal: ctrl.signal })
    return { res }
  } catch (e) {
    return { err: String((e && e.message) || e) }
  } finally {
    clearTimeout(timer)
  }
}

async function callOnce(dataUrl) {
  const input = {
    messages: [{ role: 'user', content: [{ type: 'text', text: PROMPT_TEXT }, { type: 'image_url', image_url: { url: dataUrl } }] }],
    max_tokens: MAX_TOKENS,
    temperature: 0.1,
    response_format: MARK_SCHEMA,
  }
  const t0 = Date.now()
  const { res, err } = await postProbe({ model: MODEL_ID, input }, CALL_TIMEOUT_MS)
  const ms = Date.now() - t0
  if (!res) return { ok: false, error: 'fetch-failed: ' + err, ms }
  let body
  try { body = await res.json() } catch (e) { return { ok: false, error: 'bad-response-json: ' + String(e), ms } }
  if (!body.ok) return { ok: false, error: body.error || 'probe-error', ms }
  const out = body.out
  const rawResp = out.response != null ? out.response : (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content)
  const parsed = (rawResp && typeof rawResp === 'object' && !Array.isArray(rawResp)) ? rawResp : extractJson(rawResp)
  const neurons = out.usage && typeof out.usage.neurons === 'number' ? out.usage.neurons : null
  if (!parsed || typeof parsed.is_handwritten_number !== 'boolean') {
    return { ok: false, error: 'bad-schema', raw: rawResp, ms, neurons }
  }
  return {
    ok: true,
    is_handwritten_number: parsed.is_handwritten_number,
    number: typeof parsed.number === 'string' ? parsed.number.trim() : '',
    digits_visible: typeof parsed.digits_visible === 'number' ? parsed.digits_visible : null,
    ms, neurons, rawText: rawResp,
  }
}

async function callWithRetry(dataUrl) {
  let r = await callOnce(dataUrl)
  if (r.ok) return r
  await new Promise((res) => setTimeout(res, 1500))
  const r2 = await callOnce(dataUrl)
  r2.retried = true
  return r2
}

function numDigitsOnly(s) { return String(s || '').replace(/[^0-9]/g, '') }
function isPureNumericLabel(label) { return /^[0-9]+$/.test(String(label || '')) }

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  const Align = loadAlign()

  console.log('[1/6] 호모그래피 로드(points.json, photo raw → orig)')
  const pts = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'points.json'), 'utf8'))
  const photoPts = pts.pairs.map((p) => ({ x: p.photo[0], y: p.photo[1] }))
  const origPts = pts.pairs.map((p) => ({ x: p.orig[0], y: p.orig[1] }))
  const H = Align.computeHomography(photoPts, origPts)
  if (!H) throw new Error('호모그래피 계산 실패(4점 특이)')
  const origW = pts.origSize.w

  console.log('[2/6] blobs.json/truth.json 로드 + 매칭(markup-ink-eval.mjs 와 동일 반경)')
  const blobsData = JSON.parse(fs.readFileSync(path.join(INK_DIR, 'blobs.json'), 'utf8'))
  const truth = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'truth.json'), 'utf8'))
  const blobsOrig = blobsData.blobs
    .map((b) => { const m = Align.applyH(H, b.cx, b.cy); return m ? { ...b, origX: m.x, origY: m.y } : null })
    .filter(Boolean)
  const matchRadius = origW * MATCH_RADIUS_FRAC

  // 정답 → 가장 가까운(미사용) 덩어리 1개씩 배정
  const usedBlob = new Set()
  const truthMatches = []
  for (const t of truth) {
    let best = -1, bestD = Infinity
    for (let i = 0; i < blobsOrig.length; i++) {
      if (usedBlob.has(i)) continue
      const d = Math.hypot(blobsOrig[i].origX - t.x, blobsOrig[i].origY - t.y)
      if (d <= matchRadius && d < bestD) { bestD = d; best = i }
    }
    if (best >= 0) { usedBlob.add(best); truthMatches.push({ truth: t, blob: blobsOrig[best], dist: bestD }) }
  }
  console.log(`  정답 근처 덩어리 매칭 = ${truthMatches.length}개 (report.json matchedTruthCount=19 재현 기대)`)

  // 정답 없는 덩어리(어떤 정답과도 반경 안이 아닌 것) 중 면적 상위 N
  const isNearAnyTruth = (b) => truth.some((t) => Math.hypot(b.origX - t.x, b.origY - t.y) <= matchRadius)
  const noTruthBlobs = blobsOrig.filter((b) => !isNearAnyTruth(b)).sort((a, b) => b.area - a.area).slice(0, TOP_N_NO_TRUTH)
  console.log(`  정답 없는 덩어리 면적 상위 ${noTruthBlobs.length}개 선택`)

  const selected = [
    ...truthMatches.map((m) => ({ kind: 'near-truth', blob: m.blob, truthLabel: m.truth.label, truthDist: m.dist })),
    ...noTruthBlobs.map((b) => ({ kind: 'no-truth-top-area', blob: b, truthLabel: null, truthDist: null })),
  ]

  console.log('[3/6] 사진 로드(raw) + 조각별 크롭 2x 확대 저장')
  const img = await loadImage(path.join(SAMPLES, 's5.jpg'))
  if (img.width !== blobsData.meta.imageSize.w || img.height !== blobsData.meta.imageSize.h) {
    console.error(`[경고] s5.jpg 크기(${img.width}x${img.height}) != blobs.json.meta.imageSize(${blobsData.meta.imageSize.w}x${blobsData.meta.imageSize.h})`)
  }
  const photoCanvas = createCanvas(img.width, img.height)
  photoCanvas.getContext('2d').drawImage(img, 0, 0)

  const manifest = []
  for (let i = 0; i < selected.length; i++) {
    const sel = selected[i]
    const id = 'c' + String(i).padStart(3, '0')
    const b = sel.blob
    const side = Math.max(b.bbox.h * CROP_SIDE_MULT, MIN_CROP_SIDE)
    const win = squareWindow(b.cx, b.cy, side, img.width, img.height)
    const cropCanvas = createCanvas(win.s * UPSCALE, win.s * UPSCALE)
    const cctx = cropCanvas.getContext('2d')
    cctx.imageSmoothingEnabled = true
    cctx.drawImage(photoCanvas, win.x0, win.y0, win.s, win.s, 0, 0, win.s * UPSCALE, win.s * UPSCALE)
    fs.writeFileSync(path.join(OUT_DIR, id + '.png'), cropCanvas.toBuffer('image/png'))
    const truncated = (b.bbox.w > win.s) || (b.bbox.maxX > win.x0 + win.s) || (b.bbox.minX < win.x0) || (b.bbox.maxY > win.y0 + win.s) || (b.bbox.minY < win.y0)
    manifest.push({
      id, kind: sel.kind, blobId: b.id, bbox: b.bbox, cx: b.cx, cy: b.cy, area: b.area, color: b.color,
      origX: b.origX, origY: b.origY, truthLabel: sel.truthLabel, truthDist: sel.truthDist != null ? Number(sel.truthDist.toFixed(1)) : null,
      cropWindow: win, side, truncated, _cropCanvas: cropCanvas,
    })
  }
  fs.writeFileSync(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest.map(({ _cropCanvas, ...m }) => m), null, 2))

  console.log(`[4/6] scout 모델 호출(${manifest.length}건, 순차, 조각당 1회+실패 시 1회 재시도, neuron 예산 ${NEURON_BUDGET})`)
  let neuronsUsed = 0, callCount = 0, retryCount = 0, failCount = 0
  const results = []
  for (const m of manifest) {
    if (neuronsUsed + FALLBACK_NEURON_ESTIMATE_PER_CALL > NEURON_BUDGET) {
      console.log(`  [예산초과로 중단] ${m.id} 이후 ${manifest.length - results.length}건 건너뜀 (neuronsUsed=${neuronsUsed.toFixed(1)})`)
      results.push({ id: m.id, ok: false, skipped: 'budget' })
      continue
    }
    const dataUrl = canvasToDataUrl(m._cropCanvas)
    const r = await callWithRetry(dataUrl)
    callCount++
    if (r.retried) retryCount++
    if (!r.ok) failCount++
    if (typeof r.neurons === 'number') neuronsUsed += r.neurons
    else if (r.ok || r.retried) neuronsUsed += FALLBACK_NEURON_ESTIMATE_PER_CALL
    results.push({ id: m.id, ...r })
    console.log(`  ${m.id} [${m.kind}${m.truthLabel ? ' truth=' + m.truthLabel : ''}] -> ok=${r.ok} num=${r.ok ? JSON.stringify(r.number) : r.error} neurons=${typeof r.neurons === 'number' ? r.neurons.toFixed(2) : 'n/a'}`)
  }

  console.log('[5/6] 집계')
  const byId = new Map(results.map((r) => [r.id, r]))
  const nearTruthManifest = manifest.filter((m) => m.kind === 'near-truth')
  const noTruthManifest = manifest.filter((m) => m.kind === 'no-truth-top-area')

  // ① 번호 읽힌 정답(라벨이 순수 숫자, '?' 없음) 중 번호 일치
  const numericNear = nearTruthManifest.filter((m) => isPureNumericLabel(m.truthLabel))
  let numMatch = 0, numEvaluable = 0
  for (const m of numericNear) {
    const r = byId.get(m.id)
    if (!r || !r.ok) continue
    numEvaluable++
    if (r.is_handwritten_number && numDigitsOnly(r.number) === numDigitsOnly(m.truthLabel)) numMatch++
  }
  // ② 번호 불명 정답(라벨에 '?' 또는 비숫자) — 평가 제외, 모델이 뭔가 찾았는지만 정보성 기록
  const ambiguousNear = nearTruthManifest.filter((m) => !isPureNumericLabel(m.truthLabel))
  const ambiguousDetectedCount = ambiguousNear.filter((m) => { const r = byId.get(m.id); return r && r.ok && r.is_handwritten_number }).length
  // ③ 정답 없는 덩어리(오검출 후보)에서 모델이 숫자를 지어낸 수
  let falsePositive = 0, noTruthEvaluable = 0
  for (const m of noTruthManifest) {
    const r = byId.get(m.id)
    if (!r || !r.ok) continue
    noTruthEvaluable++
    if (r.is_handwritten_number) falsePositive++
  }
  const totalMsCalls = results.reduce((a, r) => a + (r.ms || 0), 0)

  const report = {
    totalCrops: manifest.length,
    nearTruthCount: nearTruthManifest.length,
    noTruthCount: noTruthManifest.length,
    numberMatch: { evaluableCount: numEvaluable, denomLabel: '정답 번호가 순수 숫자(? 없음)인 근처 덩어리', matchCount: numMatch, rate: numEvaluable ? Number((numMatch / numEvaluable).toFixed(3)) : null },
    ambiguousTruth: { count: ambiguousNear.length, detectedByModel: ambiguousDetectedCount, note: "라벨에 '?' 또는 비숫자 — 정답 자체가 불명이라 일치율 분모에서 제외, 모델 검출 여부만 정보성 기록" },
    falsePositive: { evaluableCount: noTruthEvaluable, detectedCount: falsePositive, rate: noTruthEvaluable ? Number((falsePositive / noTruthEvaluable).toFixed(3)) : null },
    calls: callCount, retries: retryCount, failCount, skippedForBudget: results.filter((r) => r.skipped === 'budget').length,
    totalMs: totalMsCalls, totalNeurons: Number(neuronsUsed.toFixed(2)),
    neuronBudget: NEURON_BUDGET, modelId: MODEL_ID,
  }
  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify({ report, results, manifest: manifest.map(({ _cropCanvas, ...m }) => m) }, null, 2))

  console.log('[6/6] 시각화 result.png(격자)')
  const COLS = 8
  const CELL = 180, THUMB = 150, PAD = 10
  const rows = Math.ceil(manifest.length / COLS)
  const grid = createCanvas(COLS * CELL, rows * (CELL + 24))
  const gctx = grid.getContext('2d')
  gctx.fillStyle = '#fff'; gctx.fillRect(0, 0, grid.width, grid.height)
  gctx.font = '12px sans-serif'
  for (let i = 0; i < manifest.length; i++) {
    const m = manifest[i]
    const r = byId.get(m.id)
    const col = i % COLS, row = Math.floor(i / COLS)
    const x = col * CELL + PAD, y = row * (CELL + 24) + PAD
    gctx.drawImage(m._cropCanvas, 0, 0, m._cropCanvas.width, m._cropCanvas.height, x, y, THUMB, THUMB)
    gctx.strokeStyle = m.kind === 'near-truth' ? '#00a000' : '#a00000'
    gctx.lineWidth = 2
    gctx.strokeRect(x, y, THUMB, THUMB)
    const truthTxt = m.truthLabel != null ? m.truthLabel : '-'
    const aiTxt = r && r.ok ? (r.is_handwritten_number ? r.number : 'no') : (r ? 'ERR' : '?')
    gctx.fillStyle = '#000'
    gctx.fillText(`${m.id} T:${truthTxt} A:${aiTxt}`, x, y + THUMB + 14)
  }
  fs.writeFileSync(path.join(OUT_DIR, 'result.png'), grid.toBuffer('image/png'))

  console.log('\n=== 요약 ===')
  console.log(`번호 일치: ${report.numberMatch.matchCount}/${report.numberMatch.evaluableCount} (${report.numberMatch.rate})`)
  console.log(`번호 불명 정답(참고): ${report.ambiguousTruth.count}개 중 모델 검출 ${report.ambiguousTruth.detectedByModel}개`)
  console.log(`거짓양성(정답없는 덩어리에서 숫자 지어냄): ${report.falsePositive.detectedCount}/${report.falsePositive.evaluableCount} (${report.falsePositive.rate})`)
  console.log(`호출 ${report.calls}건(재시도 ${report.retries}, 실패 ${report.failCount}, 예산초과 건너뜀 ${report.skippedForBudget}) / neurons ${report.totalNeurons} / ${report.totalMs}ms`)
}

main().catch((e) => { console.error(e); process.exit(1) })
