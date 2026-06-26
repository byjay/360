/* ════════════════════════════════════════════
   Service Worker — PWA 앱 셸 오프라인 캐시
   · 정적 자산(HTML/JS/CSS/폰트/CDN 라이브러리)만 캐시한다.
   · API(/api/*, /tables/*) 요청은 절대 가로채지 않는다.
     → 데이터 동기화는 클라이언트의 IndexedDB 큐(SyncQueue)가 책임진다.
   · 전략: 셸은 stale-while-revalidate (오프라인에서도 즉시 로드).
════════════════════════════════════════════ */
const CACHE = 'wm-shell-v16';   // [아이콘 견고화] FontAwesome(CSS+웹폰트) 셸 프리캐시 추가 → 오프라인/CDN차단서도 아이콘 유지
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/main.js',
  'manifest.webmanifest',
  'vendor/pdf.worker.min.js',                 // ★ 오프라인 PDF 로드 핵심 — 로컬 워커(1MB) 반드시 캐시
  'images/logo.png',
  'images/favicon.svg',
  'images/icon-64.png',
  'images/icon-192.png',
  'images/icon-512.png',
  'images/icon-maskable-192.png',
  'images/icon-maskable-512.png',
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js',
  'https://cdn.jsdelivr.net/gh/orioncactus/pretendard@v1.3.9/dist/web/static/pretendard.min.css',
  'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;700&display=swap',
  // ★[아이콘 누락 방지] FontAwesome CSS + 웹폰트 — 어떤 상황(오프라인/CDN차단)에서도 fa-* 아이콘 유지
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-solid-900.woff2',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/webfonts/fa-regular-400.woff2'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      // [자가치유] cache:'reload' = 브라우저 HTTP 캐시 우회 → 항상 "최신" 셸을 캐시.
      //   (마스터가 강제 새로고침 안 해도, 새 SW 설치 시 옛 4시간 캐시 대신 최신을 받음)
      Promise.allSettled(SHELL.map((u) => c.add(new Request(u, { cache: 'reload' }))))
    )
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      // 'wm-shared'(공유 임시저장)는 유지 — 공유 직후 클라가 읽어가야 함
      Promise.all(keys.filter((k) => k !== CACHE && k !== 'wm-shared').map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 클라이언트(index.html)가 새 버전을 즉시 적용하라고 보내는 신호 처리
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});

// R2 객체(도면/360 이미지 등)는 불변(immutable) 바이너리 — 오프라인을 위해 캐시 대상.
//  키가 내용 기반이라 한번 받은 URL의 내용은 절대 바뀌지 않으므로 cache-first 안전.
function isR2Object(url) {
  return url.pathname.indexOf('/api/r2/object/') !== -1;
}

function isApi(url) {
  // ★[오프라인 도면연동] R2 객체는 '데이터 API'가 아니라 '정적 자산'으로 취급 → 캐시 허용
  if (isR2Object(url)) return false;
  return url.pathname.startsWith('/api/') ||
         url.pathname.startsWith('/tables/') ||
         url.pathname.includes('/api/') ||
         url.pathname.includes('/tables/');
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  let url;
  try { url = new URL(req.url); } catch { return; }

  // ── [마스터: 사진 파일이 들어오면 트리거] Web Share Target ──
  //   폰에서 THETA 360 촬영 → 갤러리/THETA앱 "공유 → SEASTAR" → 이 POST 로 파일이 들어옴.
  //   파일을 임시 캐시에 저장하고 ?shared=1 로 앱을 열면, 클라(ThetaIntake)가 자동 인입한다.
  if (req.method === 'POST' && /(^|\/)share-target$/.test(url.pathname)) {
    e.respondWith((async () => {
      try {
        const form = await req.formData();
        const files = form.getAll('photos').filter((f) => f && f.type && f.type.indexOf('image/') === 0);
        const cache = await caches.open('wm-shared');
        const ids = [], names = [];
        for (let i = 0; i < files.length; i++) {
          const key = '/__shared__/' + Date.now() + '-' + i;
          await cache.put(new Request(key), new Response(files[i], { headers: { 'Content-Type': files[i].type || 'image/jpeg' } }));
          ids.push(key); names.push(files[i].name || ('shared-' + i + '.jpg'));
        }
        await cache.put(new Request('/__shared__/index'),
          new Response(JSON.stringify({ ids, names, at: Date.now() }), { headers: { 'Content-Type': 'application/json' } }));
      } catch (err) { /* 무시 — 빈 손으로라도 앱은 열어줌 */ }
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }

  if (req.method !== 'GET') return; // 그 외 쓰기 요청은 패스(네트워크 직행)

  // ── [오프라인 모바일 핵심] 네비게이션 요청은 항상 앱 셸로 폴백 ──
  //   모바일 PWA를 오프라인으로 처음 열거나, /projects 등 라우트로 진입할 때
  //   navigation 요청(mode:'navigate')이 네트워크 실패하면 캐시된 index.html을 돌려준다.
  //   → 오프라인에서도 앱이 '하얀 화면' 없이 즉시 부팅된다.
  if (req.mode === 'navigate') {
    e.respondWith(
      fetch(req).then((res) => {
        if (res && res.status === 200) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put('index.html', clone)).catch(() => {});
        }
        return res;
      }).catch(() =>
        caches.open(CACHE).then((c) => c.match('index.html'))
          .then((cached) => cached || caches.match('./'))
      )
    );
    return;
  }

  // API/데이터는 절대 캐시·가로채지 않음 → 항상 네트워크
  if (isApi(url)) return;

  // ── [오프라인 도면연동] R2 객체(불변 도면/이미지)는 CACHE-FIRST ──
  //   한번 받은 도면은 캐시에 보관 → 오프라인에서도 '이미 업로드된 도면'을 그대로 표시.
  //   (R2 키는 내용 기반이라 내용이 바뀌면 URL 자체가 달라지므로 stale 위험 없음)
  if (isR2Object(url)) {
    e.respondWith(
      caches.open(CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          if (cached) return cached;            // 캐시 히트 → 오프라인에서도 즉시 표시
          return fetch(req).then((res) => {
            if (res && res.status === 200) cache.put(req, res.clone()).catch(() => {});
            return res;
          });
        })
      )
    );
    return;
  }

  // 구글 OAuth 스크립트는 캐시하지 않음(인증 관련)
  if (url.hostname.indexOf('accounts.google.com') !== -1) return;
  // 폰트(googleapis/gstatic)는 오프라인을 위해 cache-first 허용 — 아래 공통 전략으로 처리

  // ── [근본수정] 앱 셸 핵심(HTML/CSS/JS)은 NETWORK-FIRST ──
  //   기존 stale-while-revalidate는 "캐시 즉시 반환"이라 코드를 바꿔도
  //   사용자가 옛 화면을 계속 보는 문제가 있었다(아이콘/스타일 개선 미반영).
  //   → 같은 출처의 .html/.css/.js 는 항상 네트워크 최신을 먼저 쓰고,
  //     오프라인일 때만 캐시로 폴백한다. (오프라인 동작은 그대로 유지)
  const sameOrigin = (url.origin === self.location.origin);
  const isShellCode = sameOrigin && /\.(html|css|js)$/i.test(url.pathname) || url.pathname === '/' ;
  if (isShellCode) {
    // [자가치유] 셸 코드는 HTTP 캐시 우회(reload)로 항상 서버 최신을 우선 → 옛 4시간 캐시 무력화
    const freshReq = new Request(req, { cache: 'reload' });
    e.respondWith(
      fetch(freshReq).then((res) => {
        if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
          const clone = res.clone();
          caches.open(CACHE).then((c) => c.put(req, clone)).catch(() => {});
        }
        return res;
      }).catch(() =>
        caches.open(CACHE).then((c) => c.match(req)).then((cached) => cached || caches.match('index.html'))
      )
    );
    return;
  }

  // 그 외 정적자산(폰트/라이브러리/이미지/PDF워커/3D): stale-while-revalidate
  e.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req).then((cached) => {
        const network = fetch(req).then((res) => {
          if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) {
            cache.put(req, res.clone()).catch(() => {});
          }
          return res;
        }).catch(() => cached);
        return cached || network;
      })
    )
  );
});
