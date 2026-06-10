import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  DB: D1Database
  ASSETS: { fetch: (req: Request) => Promise<Response> }
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/tables/*', cors())

/* ════════════════════════════════════════════
   유틸
════════════════════════════════════════════ */
function genId(prefix: string): string {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10)
}

// pano_images 행 → 프론트엔드 응답 형태
function mapImage(r: any) {
  return {
    id: r.id,
    name: r.name,
    image_data: r.image_data,
    width: r.width,
    height: r.height,
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted: !!r.deleted
  }
}

function mapDeployment(r: any) {
  return {
    id: r.id,
    title: r.title,
    file_name: r.file_name,
    drawing_data: r.drawing_data,
    pages_data: r.pages_data,
    pins: r.pins,
    created_at: r.created_at,
    updated_at: r.updated_at,
    deleted: !!r.deleted
  }
}

/* ════════════════════════════════════════════
   pano_images — 360° 그림 클라우드 저장
════════════════════════════════════════════ */

// 목록
app.get('/tables/pano_images', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') || 100), 1000)
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM pano_images WHERE deleted = 0 ORDER BY created_at DESC LIMIT ?'
  ).bind(limit).all()
  return c.json({ data: (results || []).map(mapImage), total: (results || []).length })
})

// 단건 조회
app.get('/tables/pano_images/:id', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT * FROM pano_images WHERE id = ?').bind(id).first()
  if (!row) return c.json({ error: 'not found' }, 404)
  return c.json(mapImage(row))
})

// 생성 (업로드)
app.post('/tables/pano_images', async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  if (!body || !body.image_data) return c.json({ error: 'image_data required' }, 400)

  const id = genId('img')
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO pano_images (id, name, image_data, width, height, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
  ).bind(
    id,
    body.name || '',
    body.image_data,
    body.width || null,
    body.height || null,
    now, now
  ).run()

  return c.json(mapImage({
    id, name: body.name || '', image_data: body.image_data,
    width: body.width || null, height: body.height || null,
    created_at: now, updated_at: now, deleted: 0
  }))
})

// 삭제 (soft delete)
app.delete('/tables/pano_images/:id', async (c) => {
  const id = c.req.param('id')
  await c.env.DB.prepare('UPDATE pano_images SET deleted = 1, updated_at = ? WHERE id = ?')
    .bind(Date.now(), id).run()
  return c.json({ success: true })
})

/* ════════════════════════════════════════════
   deployments — 배포 스냅샷
════════════════════════════════════════════ */

// 목록
app.get('/tables/deployments', async (c) => {
  const limit = Math.min(Number(c.req.query('limit') || 100), 1000)
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM deployments WHERE deleted = 0 ORDER BY created_at DESC LIMIT ?'
  ).bind(limit).all()
  return c.json({ data: (results || []).map(mapDeployment), total: (results || []).length })
})

// 단건 조회 (특정 배포본 고정 공유 — B1)
app.get('/tables/deployments/:id', async (c) => {
  const id = c.req.param('id')
  const row = await c.env.DB.prepare('SELECT * FROM deployments WHERE id = ?').bind(id).first()
  if (!row) return c.json({ error: 'not found' }, 404)
  return c.json(mapDeployment(row))
})

// 생성 (배포)
app.post('/tables/deployments', async (c) => {
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }

  const id = genId('dep')
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO deployments (id, title, file_name, drawing_data, pages_data, pins, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`
  ).bind(
    id,
    body.title || '',
    body.file_name || '',
    body.drawing_data || null,
    body.pages_data || null,
    body.pins || '[]',
    now, now
  ).run()

  return c.json(mapDeployment({
    id, title: body.title || '', file_name: body.file_name || '',
    drawing_data: body.drawing_data || null, pages_data: body.pages_data || null,
    pins: body.pins || '[]', created_at: now, updated_at: now, deleted: 0
  }))
})

// 삭제 (soft delete)
app.delete('/tables/deployments/:id', async (c) => {
  const id = c.req.param('id')
  await c.env.DB.prepare('UPDATE deployments SET deleted = 1, updated_at = ? WHERE id = ?')
    .bind(Date.now(), id).run()
  return c.json({ success: true })
})

/* ════════════════════════════════════════════
   정적 파일 서빙 — Cloudflare Pages 자산에 위임
   (css/js/images/static/index.html 은 _routes.json exclude로 자동 서빙되며,
    여기 도달하는 경로는 루트('/') 또는 알 수 없는 경로 → index.html 반환)
════════════════════════════════════════════ */
app.all('*', async (c) => {
  const assets = c.env.ASSETS
  if (assets && assets.fetch) {
    // 원 요청 경로의 자산을 시도, 없으면 index.html로 폴백(SPA 진입)
    const url = new URL(c.req.url)
    const direct = await assets.fetch(new Request(c.req.url, { method: 'GET' }))
    if (direct.status !== 404) return direct
    return assets.fetch(new Request(url.origin + '/index.html', { method: 'GET' }))
  }
  return c.text('Not Found', 404)
})

export default app
