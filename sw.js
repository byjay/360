/* ════════════════════════════════════════════
   Service Worker — PWA 앱 셸 오프라인 캐시
   · 정적 자산(HTML/JS/CSS/폰트/CDN 라이브러리)만 캐시한다.
   · API(/api/*, /tables/*) 요청은 절대 가로채지 않는다.
     → 데이터 동기화는 클라이언트의 IndexedDB 큐(SyncQueue)가 책임진다.
   · 전략: 셸은 stale-while-revalidate (오프라인에서도 즉시 로드).
════════════════════════════════════════════ */
const CACHE = 'wm-shell-v6';
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'js/main.js',
  'manifest.webmanifest',
  'vendor/pdf.worker.min.js',                 // ★ 오프라인 PDF 로드 핵심 — 로컬 워커(1MB) 반드시 캐시
  'images/logo.png',
  'images/icon-64.png',
  'images/icon-192.png',
  'images/icon-512.png',
  'images/icon-maskable-192.png',
  'images/icon-maskable-512.png',
  'samples/seastar-fsru.ply',                 // ★ 오프라인 샘플 3D 로드용 포인트클라우드
  'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js',
  'https://cdn.jsdelivr.net/npm/three@0.147.0/build/three.min.js',
  'https://fonts.googleapis.com/css2?family=Share+Tech+Mono&family=Inter:wght@400;600;700&display=swap'
];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(
    caches.open(CACHE).then((c) =>
      Promise.allSettled(SHELL.map((u) => c.add(u))) // 일부 실패해도 설치 진행
    )
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
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
  if (req.method !== 'GET') return; // 쓰기 요청은 패스(네트워크 직행)
  let url;
  try { url = new URL(req.url); } catch { return; }

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
    e.respondWith(
      fetch(req).then((res) => {
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
