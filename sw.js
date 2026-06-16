/* ════════════════════════════════════════════
   Service Worker — PWA 앱 셸 오프라인 캐시
   · 정적 자산(HTML/JS/CSS/폰트/CDN 라이브러리)만 캐시한다.
   · API(/api/*, /tables/*) 요청은 절대 가로채지 않는다.
     → 데이터 동기화는 클라이언트의 IndexedDB 큐(SyncQueue)가 책임진다.
   · 전략: 셸은 stale-while-revalidate (오프라인에서도 즉시 로드).
════════════════════════════════════════════ */
const CACHE = 'wm-shell-v3';
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

function isApi(url) {
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

  // 구글 OAuth 스크립트는 캐시하지 않음(인증 관련)
  if (url.hostname.indexOf('accounts.google.com') !== -1) return;
  // 폰트(googleapis/gstatic)는 오프라인을 위해 cache-first 허용 — 아래 공통 전략으로 처리

  // 셸/정적자산: stale-while-revalidate
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
