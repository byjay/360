// 측정 전용 스크립트 — 앱 코드 수정 금지. 손글씨 마킹 사진(.tmp/markup-samples/s5.jpg) 을
// 겹치는 타일로 잘라 Workers AI 비전 모델 2종(llama-4-scout-17b, llama-3.2-11b-vision)에
// "번호 + 그 번호가 가리키는 점" 을 질의하고, 호모그래피로 원본 도면 좌표로 변환해
// 정답(.tmp/markup-eval/truth.json) 과 대조해 recall/precision/번호 일치율을 잰다.
//
// 선행 조건: .tmp/ai-probe/ 의 임시 Worker(AI 바인딩, remote) 가
//   wrangler dev --config .tmp/ai-probe/wrangler.toml --port 8799 --local-protocol http
// 로 떠 있어야 한다(이 스크립트는 그 Worker 에 HTTP 로만 질의 — Workers AI SDK 직접 호출 아님).
//
// 실행: TEMP/TMP=E:\code-project\360\.tmp 지정 후
//   node build-tools/markup-ocr-eval.mjs
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { createCanvas, loadImage, ImageData } from 'canvas'

const ROOT = 'E:/code-project/360'
const EVAL_DIR = path.join(ROOT, '.tmp/markup-eval')
const OUT_DIR = path.join(ROOT, '.tmp/markup-ocr')
const PROBE_URL = 'http://127.0.0.1:8799/'
const PHOTO_PATH = path.join(ROOT, '.tmp/markup-samples/s5.jpg')
const RAW_H = 1816 // s5.jpg raw(node-canvas, EXIF 미반영) 높이 — points.json.photoSize.h 와 동일
const RAW_W = 4032
const MATCH_RADIUS_PCT_OF_W = 0.02 // 원본 도면 폭의 2%

const ALL_MODELS = [
  { id: '@cf/meta/llama-4-scout-17b-16e-instruct', short: 'scout', jsonMode: true, maxTokens: 1200 },
  // 🔴 실측(2026-10-29): json_schema 미지원이라 자유 생성 — max_tokens 1200 이면 완성까지
  //   40s+ 걸려 로컬 wrangler dev 프록시가 "internal error" 로 끊는다(디버그 로그: .tmp/ai-probe/debug_resp32.err, EXIT=28 40s 타임아웃).
  //   max_tokens=350 에서는 12.7s 로 안정적으로 응답(단, 완성 전 잘릴 수 있음 — 결과로 보고).
  { id: '@cf/meta/llama-3.2-11b-vision-instruct', short: 'llama32', jsonMode: false, maxTokens: 350 },
]
// MODEL_FILTER=scout 또는 llama32 로 재실행 시 한 모델만 — Neurons 재소모 최소화용.
const MODELS = process.env.MODEL_FILTER ? ALL_MODELS.filter((m) => m.short === process.env.MODEL_FILTER) : ALL_MODELS

fs.mkdirSync(OUT_DIR, { recursive: true })

/* ── 74_MarkupAlign.js 를 그대로 로드(재구현 금지, align.mjs 와 동일 방식) ───────── */
function loadAlign() {
  const src = fs.readFileSync(path.join(ROOT, 'public/js/modules/74_MarkupAlign.js'), 'utf8').replace(/\r\n/g, '\n')
  const sandbox = { console, State: { pins: [] } }
  vm.createContext(sandbox)
  vm.runInContext(src + '\n;globalThis.__MA = MarkupAlign;', sandbox)
  return vm.runInContext('__MA', sandbox)
}

async function getImageData(file) {
  const img = await loadImage(file)
  const c = createCanvas(img.width, img.height)
  const ctx = c.getContext('2d')
  ctx.drawImage(img, 0, 0)
  return { imgData: ctx.getImageData(0, 0, img.width, img.height), width: img.width, height: img.height }
}

/* ── RAW(4032x1816) → 90°CW 회전된 "브라우저 기준"(1816x4032, EXIF Orientation=6) 캔버스 ── */
async function buildRotatedCanvas() {
  const img = await loadImage(PHOTO_PATH)
  if (img.width !== RAW_W || img.height !== RAW_H) {
    console.error(`[경고] s5.jpg raw 크기가 ${img.width}x${img.height} — 예상(${RAW_W}x${RAW_H})과 다름. RAW_W/RAW_H 를 재확인하라.`)
  }
  const disp = createCanvas(img.height, img.width) // Wd=RAW_H, Hd=RAW_W
  const ctx = disp.getContext('2d')
  ctx.translate(img.height, 0)
  ctx.rotate(Math.PI / 2)
  ctx.drawImage(img, 0, 0)
  return disp // size: img.height x img.width = RAW_H x RAW_W
}

/** 디스플레이(회전됨) 좌표 → RAW 좌표. buildRotatedCanvas 의 정확한 역변환(회귀 테스트로 검증됨). */
function dispToRaw(xd, yd) {
  return { x: yd, y: RAW_H - 1 - xd }
}

/* ── 타일 분할: 3x3, 20% 겹침 ───────────────────────────────────────────────── */
function makeTiles(W, H, nx = 3, ny = 3, overlap = 0.2) {
  const tiles = []
  const stepX = W / nx, stepY = H / ny
  const overX = stepX * overlap, overY = stepY * overlap
  for (let iy = 0; iy < ny; iy++) {
    for (let ix = 0; ix < nx; ix++) {
      const x0 = Math.max(0, Math.round(ix * stepX - overX))
      const y0 = Math.max(0, Math.round(iy * stepY - overY))
      const x1 = Math.min(W, Math.round((ix + 1) * stepX + overX))
      const y1 = Math.min(H, Math.round((iy + 1) * stepY + overY))
      tiles.push({ ix, iy, x0, y0, w: x1 - x0, h: y1 - y0 })
    }
  }
  return tiles
}

function canvasToDataUrl(canvas) {
  const buf = canvas.toBuffer('image/jpeg', { quality: 0.85 })
  return 'data:image/jpeg;base64,' + buf.toString('base64')
}

function cropToDataUrl(srcCanvas, x0, y0, w, h) {
  const c = createCanvas(w, h)
  const ctx = c.getContext('2d')
  ctx.drawImage(srcCanvas, x0, y0, w, h, 0, 0, w, h)
  return canvasToDataUrl(c)
}

/* ── JSON 추출(모델이 코드펜스/설명을 덧붙여도 첫 { .. } 블록만 파싱) ───────────── */
function extractJson(text) {
  if (!text || typeof text !== 'string') return null
  const m = text.match(/\{[\s\S]*\}/)
  if (!m) return null
  try { return JSON.parse(m[0]) } catch { return null }
}

const MARKS_SCHEMA = {
  type: 'json_schema',
  json_schema: {
    type: 'object',
    properties: {
      marks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            number: { type: 'string' },
            x: { type: 'number' },
            y: { type: 'number' },
          },
          required: ['number', 'x', 'y'],
        },
      },
    },
    required: ['marks'],
  },
}

const PROMPT_TEXT =
  '이 이미지는 선박 도면 사진의 일부 타일이다. 사람이 손으로 쓴 숫자(마킹 번호, 보통 1~2자리, 원이나 점·지시선과 함께 있음)를 모두 찾아라. ' +
  '각 번호마다 그 번호가 "가리키는 지점"(원의 중심, 점, 또는 지시선이 가리키는 끝)의 타일 내 위치를 x,y 비율로 답하라(왼쪽위=0,0, 오른쪽아래=1,1). ' +
  '숫자가 전혀 없으면 marks 를 빈 배열로. JSON 만 출력하라(설명 금지): {"marks":[{"number":"17","x":0.42,"y":0.55}]}'

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

async function callModel(model, dataUrl) {
  const input = {
    messages: [
      { role: 'user', content: [{ type: 'text', text: PROMPT_TEXT }, { type: 'image_url', image_url: { url: dataUrl } }] },
    ],
    max_tokens: model.maxTokens || 400,
    temperature: 0.2,
  }
  if (model.jsonMode) input.response_format = MARKS_SCHEMA
  const t0 = Date.now()
  const { res, err } = await postProbe({ model: model.id, input }, 45000)
  const ms = Date.now() - t0
  if (!res) return { ok: false, error: 'fetch-failed: ' + err, ms }
  let body
  try { body = await res.json() } catch (e) { return { ok: false, error: 'bad-response-json: ' + String(e), ms } }
  if (!body.ok) return { ok: false, error: body.error || 'probe-error', ms }
  const out = body.out
  // json_schema 모드 성공 시 out.response 는 이미 파싱된 객체(문자열 아님) — extractJson(문자열 전용) 이전에 먼저 확인.
  const rawResp = out.response != null ? out.response : (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content)
  const parsed = (rawResp && typeof rawResp === 'object' && !Array.isArray(rawResp)) ? rawResp : extractJson(rawResp)
  const marks = parsed && Array.isArray(parsed.marks) ? parsed.marks : null
  const neurons = out.usage && typeof out.usage.neurons === 'number' ? out.usage.neurons : null
  if (!marks) return { ok: false, error: 'no-marks-json', raw: rawResp, ms, neurons }
  return { ok: true, marks, ms, neurons, rawText: rawResp }
}

async function callModelTitle(model, dataUrl) {
  const text = '이 사진은 선박 설계 도면이다. 도면 제목(데크명, 예: 2ND DECK, UPPER DECK, FLOOR 등)이 무엇으로 쓰여 있는지 보이는 글자 그대로 답하라. 설명 없이 글자만.'
  const input = { messages: [{ role: 'user', content: [{ type: 'text', text }, { type: 'image_url', image_url: { url: dataUrl } }] }], max_tokens: 60, temperature: 0.1 }
  const t0 = Date.now()
  const { res, err } = await postProbe({ model: model.id, input }, 45000)
  const ms = Date.now() - t0
  if (!res) return { ok: false, error: 'fetch-failed: ' + err, ms }
  const body = await res.json().catch(() => null)
  if (!body || !body.ok) return { ok: false, error: body ? body.error : 'bad-response', ms }
  const out = body.out
  const t = out.response != null ? out.response : (out.choices && out.choices[0] && out.choices[0].message && out.choices[0].message.content)
  return { ok: true, text: String(t || '').trim(), ms, neurons: out.usage && out.usage.neurons }
}

/* ── 매칭: 원본 좌표계에서 원 안의 최근접 하나만 매칭(그리디) ───────────────────── */
function matchDetections(truth, detections, radiusPx) {
  const usedDet = new Set()
  const matches = []
  for (const t of truth) {
    let best = -1, bestD = Infinity
    for (let i = 0; i < detections.length; i++) {
      if (usedDet.has(i)) continue
      const d = detections[i]
      const dist = Math.hypot(d.x - t.x, d.y - t.y)
      if (dist <= radiusPx && dist < bestD) { bestD = dist; best = i }
    }
    if (best >= 0) { usedDet.add(best); matches.push({ truth: t, det: detections[best], dist: bestD }) }
  }
  return { matches, unmatchedDetIdx: detections.map((_, i) => i).filter((i) => !usedDet.has(i)) }
}

function numbersEqual(aiNum, truthLabel) {
  const a = String(aiNum || '').replace(/[^0-9]/g, '')
  const t = String(truthLabel || '').replace(/[^0-9]/g, '')
  if (!a || !t) return false
  return a === t
}

/* ── 단순 좌표 중복 제거(겹치는 타일에서 같은 점이 여러 번 검출될 때, 원본좌표 반경 1% 안이면 병합) ── */
function dedupe(dets, W) {
  const radius = W * 0.01
  const out = []
  for (const d of dets) {
    const hit = out.find((o) => Math.hypot(o.x - d.x, o.y - d.y) <= radius && numbersEqual(o.number, d.number))
    if (hit) continue
    out.push(d)
  }
  return out
}

async function evalModel(model, rotCanvas, Align, H, origSize, truth) {
  const W = rotCanvas.width, Hh = rotCanvas.height
  const tiles = makeTiles(W, Hh, 3, 3, 0.2)
  const rawDets = []
  let calls = 0, totalMs = 0, totalNeurons = 0, failCount = 0
  const failSamples = []
  for (const tile of tiles) {
    const dataUrl = cropToDataUrl(rotCanvas, tile.x0, tile.y0, tile.w, tile.h)
    const r = await callModel(model, dataUrl)
    calls++
    totalMs += r.ms
    if (typeof r.neurons === 'number') totalNeurons += r.neurons
    if (!r.ok) { failCount++; failSamples.push({ tile: `${tile.ix},${tile.iy}`, error: r.error }); continue }
    for (const mk of r.marks) {
      if (typeof mk.x !== 'number' || typeof mk.y !== 'number') continue
      const xd = tile.x0 + mk.x * tile.w
      const yd = tile.y0 + mk.y * tile.h
      const raw = dispToRaw(xd, yd)
      const orig = Align.applyH(H, raw.x, raw.y)
      if (!orig) continue
      rawDets.push({ number: String(mk.number || '').trim(), x: orig.x, y: orig.y, tile: `${tile.ix},${tile.iy}` })
    }
  }
  const deduped = dedupe(rawDets, origSize.w)
  const radiusPx = origSize.w * MATCH_RADIUS_PCT_OF_W
  const { matches, unmatchedDetIdx } = matchDetections(truth, deduped, radiusPx)
  const recall = truth.length ? matches.length / truth.length : 0
  const precision = deduped.length ? matches.length / deduped.length : 0
  const numMatches = matches.filter((m) => numbersEqual(m.det.number, m.truth.label))
  const numberAccuracy = matches.length ? numMatches.length / matches.length : 0
  return {
    model: model.short, modelId: model.id, calls, failCount, failSamples, totalMs, totalNeurons,
    rawDetCount: rawDets.length, dedupedDetCount: deduped.length,
    recall, precision, numberAccuracy, matchedCount: matches.length, truthCount: truth.length,
    matches, deduped, unmatchedDetIdx,
  }
}

async function visualize(model, origImgData, origSize, truth, result, outPath) {
  const scale = Math.min(1, 1800 / origSize.w)
  const c = createCanvas(Math.round(origSize.w * scale), Math.round(origSize.h * scale))
  const ctx = c.getContext('2d')
  const origCanvas = createCanvas(origImgData.width, origImgData.height)
  origCanvas.getContext('2d').putImageData(origImgData.imgData, 0, 0)
  ctx.drawImage(origCanvas, 0, 0, c.width, c.height)
  ctx.lineWidth = 2
  ctx.font = '16px sans-serif'
  // 정답 = 초록
  for (const t of truth) {
    ctx.strokeStyle = '#00c000'
    ctx.beginPath(); ctx.arc(t.x * scale, t.y * scale, 10, 0, Math.PI * 2); ctx.stroke()
    ctx.fillStyle = '#00c000'
    ctx.fillText(String(t.label), t.x * scale + 11, t.y * scale - 11)
  }
  // AI 검출 = 빨강
  for (const d of result.deduped) {
    ctx.strokeStyle = '#ff0000'
    ctx.beginPath(); ctx.arc(d.x * scale, d.y * scale, 7, 0, Math.PI * 2); ctx.stroke()
    ctx.fillStyle = '#ff0000'
    ctx.fillText(String(d.number), d.x * scale + 8, d.y * scale + 16)
  }
  fs.writeFileSync(outPath, c.toBuffer('image/png'))
}

async function main() {
  console.log('[1/5] 호모그래피 로드(points.json, 74_MarkupAlign.js 그대로 재사용)')
  const Align = loadAlign()
  const pts = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'points.json'), 'utf8'))
  const photoPts = pts.pairs.map((p) => ({ x: p.photo[0], y: p.photo[1] }))
  const origPts = pts.pairs.map((p) => ({ x: p.orig[0], y: p.orig[1] }))
  const H = Align.computeHomography(photoPts, origPts)
  if (!H) throw new Error('호모그래피 계산 실패(4점 특이)')
  const origSize = pts.origSize

  // 회귀 테스트: dispToRaw 가 buildRotatedCanvas 의 정확한 역변환인지 4개 코너로 확인
  {
    const checks = [{ xd: 0, yd: 0 }, { xd: RAW_H - 1, yd: 0 }, { xd: 0, yd: RAW_W - 1 }, { xd: RAW_H - 1, yd: RAW_W - 1 }]
    for (const ch of checks) {
      const raw = dispToRaw(ch.xd, ch.yd)
      if (raw.x < 0 || raw.x > RAW_W - 1 || raw.y < 0 || raw.y > RAW_H - 1) throw new Error('dispToRaw 역변환 범위 이탈 — 회전 변환 오류: ' + JSON.stringify({ ch, raw }))
    }
    console.log('  dispToRaw 역변환 범위 체크 OK(4 코너)')
  }

  console.log('[2/5] s5.jpg 로드 + 90°CW 회전(브라우저 기준) 캔버스 생성')
  const rotCanvas = await buildRotatedCanvas()
  console.log(`  rotated size = ${rotCanvas.width}x${rotCanvas.height}`)

  console.log('[3/5] 정답 로드')
  const truth = JSON.parse(fs.readFileSync(path.join(EVAL_DIR, 'truth.json'), 'utf8'))
  console.log(`  truth count = ${truth.length}`)

  const origImgData = await getImageData(path.join(EVAL_DIR, 'orig_p1.png'))

  const results = []
  for (const model of MODELS) {
    console.log(`[4/5] 모델 ${model.short} (${model.id}) 평가 시작 — 9타일 호출`)
    const r = await evalModel(model, rotCanvas, Align, H, origSize, truth)
    console.log(`  calls=${r.calls} fail=${r.failCount} rawDet=${r.rawDetCount} deduped=${r.dedupedDetCount} recall=${r.recall.toFixed(3)} precision=${r.precision.toFixed(3)} numberAcc=${r.numberAccuracy.toFixed(3)} neurons=${r.totalNeurons.toFixed(2)} ms=${r.totalMs}`)
    await visualize(model, origImgData, origSize, truth, r, path.join(OUT_DIR, `result-${model.short}.png`))
    console.log(`  제목 판독 호출...`)
    const titleDataUrl = canvasToDataUrl(rotCanvas)
    const title = await callModelTitle(model, titleDataUrl)
    r.title = title
    results.push(r)
  }

  console.log('[5/5] 결과 저장')
  fs.writeFileSync(path.join(OUT_DIR, 'report.json'), JSON.stringify(results.map((r) => ({
    model: r.model, modelId: r.modelId, calls: r.calls, failCount: r.failCount, failSamples: r.failSamples,
    totalMs: r.totalMs, totalNeurons: r.totalNeurons, rawDetCount: r.rawDetCount, dedupedDetCount: r.dedupedDetCount,
    recall: r.recall, precision: r.precision, numberAccuracy: r.numberAccuracy, matchedCount: r.matchedCount, truthCount: r.truthCount,
    title: r.title,
  })), null, 2))

  console.log('\n=== 요약 ===')
  for (const r of results) {
    console.log(`${r.model}: recall=${(r.recall * 100).toFixed(1)}% precision=${(r.precision * 100).toFixed(1)}% numberAcc=${(r.numberAccuracy * 100).toFixed(1)}% title=${JSON.stringify(r.title.ok ? r.title.text : r.title.error)} calls=${r.calls} ms=${r.totalMs} neurons=${r.totalNeurons.toFixed(2)}`)
  }
}

main().catch((e) => { console.error(e); process.exit(1) })
