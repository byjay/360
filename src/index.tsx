import { Hono } from 'hono'
import { cors } from 'hono/cors'

type Bindings = {
  DB: D1Database
  ASSETS: { fetch: (req: Request) => Promise<Response> }
}

const app = new Hono<{ Bindings: Bindings }>()

app.use('/tables/*', cors())
app.use('/api/*', cors())

/* ════════════════════════════════════════════
   인증/권한 — Google Identity (JWT) 검증
   · 슈퍼관리자: SUPER_ADMIN (디자이너 지정 + 모든 권한)
   · 디자이너:   designers 테이블에 등록된 이메일
   · 그 외:      뷰어
════════════════════════════════════════════ */
const SUPER_ADMIN = 'designssir@gmail.com'

// 구글 공개키 캐시 (JWKS)
let _googleKeys: { keys: any[]; exp: number } | null = null

async function getGoogleKeys(): Promise<any[]> {
  const now = Date.now()
  if (_googleKeys && _googleKeys.exp > now) return _googleKeys.keys
  const res = await fetch('https://www.googleapis.com/oauth2/v3/certs')
  const json: any = await res.json()
  // Cache-Control max-age 사용, 없으면 1시간
  const cc = res.headers.get('cache-control') || ''
  const m = cc.match(/max-age=(\d+)/)
  const ttl = m ? Number(m[1]) * 1000 : 3600_000
  _googleKeys = { keys: json.keys || [], exp: now + ttl }
  return _googleKeys.keys
}

function b64urlToUint8(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(b64url.length / 4) * 4, '=')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

function decodeJwtPart(part: string): any {
  const json = new TextDecoder().decode(b64urlToUint8(part))
  return JSON.parse(json)
}

/**
 * 구글 ID 토큰(JWT) 검증. 성공 시 payload(이메일 등) 반환, 실패 시 null.
 * audience(clientId)는 선택적으로 검증 (설정돼 있으면).
 */
async function verifyGoogleToken(token: string): Promise<any | null> {
  try {
    const [h, p, s] = token.split('.')
    if (!h || !p || !s) return null
    const header = decodeJwtPart(h)
    const payload = decodeJwtPart(p)

    // 발급자/만료 검증
    const iss = payload.iss
    if (iss !== 'accounts.google.com' && iss !== 'https://accounts.google.com') return null
    if (payload.exp && Date.now() / 1000 > payload.exp) return null
    if (!payload.email || payload.email_verified === false) return null

    // 서명 검증 (RS256)
    const keys = await getGoogleKeys()
    const jwk = keys.find((k: any) => k.kid === header.kid)
    if (!jwk) return null
    const key = await crypto.subtle.importKey(
      'jwk', jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false, ['verify']
    )
    const data = new TextEncoder().encode(h + '.' + p)
    const sig = b64urlToUint8(s)
    const valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, sig, data)
    if (!valid) return null
    return payload
  } catch {
    return null
  }
}

/** Authorization: Bearer <idToken> 에서 검증된 사용자 반환 (없으면 null) */
async function getUser(c: any): Promise<any | null> {
  const auth = c.req.header('Authorization') || ''
  const m = auth.match(/^Bearer\s+(.+)$/i)
  if (!m) return null
  const payload = await verifyGoogleToken(m[1])
  if (!payload) return null
  return { email: String(payload.email).toLowerCase(), name: payload.name || '', picture: payload.picture || '' }
}

async function isDesigner(c: any, email: string): Promise<boolean> {
  if (email === SUPER_ADMIN) return true
  const row = await c.env.DB.prepare(
    'SELECT email FROM designers WHERE email = ? AND deleted = 0'
  ).bind(email).first()
  return !!row
}

function roleOf(email: string, designer: boolean): 'super' | 'designer' | 'viewer' {
  if (email === SUPER_ADMIN) return 'super'
  if (designer) return 'designer'
  return 'viewer'
}

/* ── 현재 로그인 사용자 + 권한 ── */
app.get('/api/auth/me', async (c) => {
  const user = await getUser(c)
  if (!user) return c.json({ authenticated: false, role: 'viewer' })
  const designer = await isDesigner(c, user.email)
  const role = roleOf(user.email, designer)
  // 로그인 시 디자이너의 표시 이름 갱신(존재 시)
  if (role === 'designer') {
    await c.env.DB.prepare('UPDATE designers SET name = ?, updated_at = ? WHERE email = ?')
      .bind(user.name, Date.now(), user.email).run()
  }
  return c.json({ authenticated: true, email: user.email, name: user.name, picture: user.picture, role })
})

/* ════════════════════════════════════════════
   designers — 디자이너 지정(슈퍼관리자 전용)
════════════════════════════════════════════ */
async function requireSuper(c: any): Promise<any | null> {
  const user = await getUser(c)
  if (!user || user.email !== SUPER_ADMIN) return null
  return user
}

app.get('/api/designers', async (c) => {
  const user = await getUser(c)
  if (!user || user.email !== SUPER_ADMIN) return c.json({ error: 'forbidden' }, 403)
  const { results } = await c.env.DB.prepare(
    'SELECT email, name, added_by, created_at FROM designers WHERE deleted = 0 ORDER BY created_at DESC'
  ).all()
  return c.json({ data: results || [], super_admin: SUPER_ADMIN })
})

app.post('/api/designers', async (c) => {
  const su = await requireSuper(c)
  if (!su) return c.json({ error: 'forbidden' }, 403)
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const email = String(body.email || '').trim().toLowerCase()
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return c.json({ error: 'invalid email' }, 400)
  if (email === SUPER_ADMIN) return c.json({ error: 'super admin is always designer' }, 400)
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO designers (email, name, added_by, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, 0)
     ON CONFLICT(email) DO UPDATE SET deleted = 0, added_by = excluded.added_by, updated_at = excluded.updated_at`
  ).bind(email, body.name || '', su.email, now, now).run()
  return c.json({ success: true, email })
})

app.delete('/api/designers/:email', async (c) => {
  const su = await requireSuper(c)
  if (!su) return c.json({ error: 'forbidden' }, 403)
  const email = decodeURIComponent(c.req.param('email')).toLowerCase()
  await c.env.DB.prepare('UPDATE designers SET deleted = 1, updated_at = ? WHERE email = ?')
    .bind(Date.now(), email).run()
  return c.json({ success: true })
})

/* ════════════════════════════════════════════
   projects / decks — 디자이너 전용 생성/관리
════════════════════════════════════════════ */
async function requireDesigner(c: any): Promise<any | null> {
  const user = await getUser(c)
  if (!user) return null
  const designer = await isDesigner(c, user.email)
  if (!designer) return null
  return user
}

function mapProject(r: any) {
  return { id: r.id, name: r.name, description: r.description, owner: r.owner, created_at: r.created_at, updated_at: r.updated_at }
}
function mapDeck(r: any) {
  return { id: r.id, project_id: r.project_id, name: r.name, level_no: r.level_no, deployment_id: r.deployment_id, created_at: r.created_at, updated_at: r.updated_at }
}

// 프로젝트 목록 (누구나 조회 가능 — 뷰어도 탐색)
app.get('/api/projects', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM projects WHERE deleted = 0 ORDER BY created_at DESC'
  ).all()
  return c.json({ data: (results || []).map(mapProject) })
})

// 프로젝트 생성 (디자이너)
app.post('/api/projects', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden' }, 403)
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const name = String(body.name || '').trim()
  if (!name) return c.json({ error: 'name required' }, 400)
  const id = genId('prj')
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO projects (id, name, description, owner, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, 0)`
  ).bind(id, name, body.description || '', user.email, now, now).run()
  return c.json(mapProject({ id, name, description: body.description || '', owner: user.email, created_at: now, updated_at: now }))
})

// 프로젝트 삭제 (디자이너)
app.delete('/api/projects/:id', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden' }, 403)
  const id = c.req.param('id')
  const now = Date.now()
  await c.env.DB.prepare('UPDATE projects SET deleted = 1, updated_at = ? WHERE id = ?').bind(now, id).run()
  await c.env.DB.prepare('UPDATE decks SET deleted = 1, updated_at = ? WHERE project_id = ?').bind(now, id).run()
  return c.json({ success: true })
})

// 데크 목록 (프로젝트별, 누구나)
app.get('/api/projects/:id/decks', async (c) => {
  const pid = c.req.param('id')
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM decks WHERE project_id = ? AND deleted = 0 ORDER BY COALESCE(level_no, 999999), created_at'
  ).bind(pid).all()
  return c.json({ data: (results || []).map(mapDeck) })
})

// 데크 생성 (디자이너)
app.post('/api/projects/:id/decks', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden' }, 403)
  const pid = c.req.param('id')
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const name = String(body.name || '').trim()
  if (!name) return c.json({ error: 'name required' }, 400)
  const id = genId('dck')
  const now = Date.now()
  await c.env.DB.prepare(
    `INSERT INTO decks (id, project_id, name, level_no, deployment_id, created_at, updated_at, deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, 0)`
  ).bind(id, pid, name, body.level_no ?? null, body.deployment_id || null, now, now).run()
  return c.json(mapDeck({ id, project_id: pid, name, level_no: body.level_no ?? null, deployment_id: body.deployment_id || null, created_at: now, updated_at: now }))
})

// 데크 수정 (디자이너) — 배포본 연결/이름/층번호
app.put('/api/decks/:id', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden' }, 403)
  const id = c.req.param('id')
  let body: any
  try { body = await c.req.json() } catch { return c.json({ error: 'invalid json' }, 400) }
  const row: any = await c.env.DB.prepare('SELECT * FROM decks WHERE id = ?').bind(id).first()
  if (!row) return c.json({ error: 'not found' }, 404)
  const name = body.name !== undefined ? String(body.name) : row.name
  const level = body.level_no !== undefined ? body.level_no : row.level_no
  const dep = body.deployment_id !== undefined ? body.deployment_id : row.deployment_id
  await c.env.DB.prepare(
    'UPDATE decks SET name = ?, level_no = ?, deployment_id = ?, updated_at = ? WHERE id = ?'
  ).bind(name, level, dep, Date.now(), id).run()
  return c.json(mapDeck({ ...row, name, level_no: level, deployment_id: dep }))
})

// 데크 삭제 (디자이너)
app.delete('/api/decks/:id', async (c) => {
  const user = await requireDesigner(c)
  if (!user) return c.json({ error: 'forbidden' }, 403)
  const id = c.req.param('id')
  await c.env.DB.prepare('UPDATE decks SET deleted = 1, updated_at = ? WHERE id = ?').bind(Date.now(), id).run()
  return c.json({ success: true })
})

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
