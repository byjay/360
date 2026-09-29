/* ════════════════════════════════════════════
   Service Worker — PWA 앱 셸 오프라인 캐시
   · 정적 자산(HTML/JS/CSS/폰트/CDN 라이브러리)만 캐시한다.
   · API(/api/*, /tables/*) 요청은 절대 가로채지 않는다.
     → 데이터 동기화는 클라이언트의 IndexedDB 큐(SyncQueue)가 책임진다.
   · 전략: 셸은 stale-while-revalidate (오프라인에서도 즉시 로드).
════════════════════════════════════════════ */
const CACHE = 'wm-shell-v18';   // [AC-2] 미디어(R2 객체) 캐시를 별도(MEDIA_CACHE)로 분리 → 구버전(v16)에
                                 //   섞여있던 대용량 360사진/도면을 activate 시 통째로 정리하기 위해 버전 상승
                                 // [P89] v18: index.html 자산 참조에 ?v=<해시> 캐시버스팅 도입(빌드 stamp 단계) →
                                 //   구 캐시(v17, 무쿼리 키)를 activate 시 통째로 정리해 이후 오프라인 매칭 혼선을 방지.
const SHELL = [
  './',
  'index.html',
  'css/style.css',
  'css/seastar-family-tokens.css', // [P89] 패밀리룩 헬퍼 — 빠져 있어 오프라인 1회차엔 미적용이었음(정리)
  'css/seastar-3d-skin.css',       // [P89] 3D 스킨 오버레이 — 위와 동일 사유로 프리캐시 목록에 추가
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
      // 'wm-shared'(공유 임시저장)·MEDIA_CACHE(미디어, 상한은 trimMediaCache가 관리)는 유지
      Promise.all(keys.filter((k) => k !== CACHE && k !== 'wm-shared' && k !== MEDIA_CACHE).map((k) => caches.delete(k)))
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

// ═══ [AC-2] 미디어(R2 객체) 캐시 — 앱셸(CACHE)과 분리 + 용량 상한 자동 정리 ═══
// 배경: 360 사진/도면은 장당 수 MB — cache-first로 무한히 쌓이면 모바일 저장공간이 찬다.
// 🔴 이 캐시는 CACHE(wm-shell-v17)·'wm-shared'와 완전히 다른 저장소이며, "오프라인 프로젝트
//   다운로드"(Offline.Bundle.download, 32_Offline.js)가 쓰는 IndexedDB(SyncQueue)와도 무관하다.
//   확인: 32_Offline.js는 /tables/pano_images/* 를 fetch하고, isApi()는 '/tables/'로 시작하는
//   경로를 가로채지 않는다(위 isApi 참조) → 이 요청은 애초에 이 SW를 거쳐 캐시에 들어가지 않는다.
//   즉 이 미디어 캐시를 아무리 비워도 사용자가 명시적으로 받은 오프라인 데이터는 유실되지 않는다.
const MEDIA_CACHE = 'wm-media-v1';
const MEDIA_CACHE_MAX_ENTRIES = 60;             // 근거: 360사진 평균 3~5MB 기준 최대 ~300MB 유지
const MEDIA_CACHE_MAX_ENTRIES_LOW_STORAGE = 20; // 기기 저장공간 여유가 적을 때 더 공격적으로 축소
const STORAGE_LOW_RATIO = 0.2;                  // navigator.storage.estimate() 여유비율 <20% → 공격 모드

// ponytail: Cache Storage API는 항목별 삽입 시각을 노출하지 않는다. cache.keys() 반환 순서
//   (=삽입 순서, 주요 브라우저 구현상 보장되나 스펙이 명시하진 않음)를 "오래된 순"으로 취급하는
//   단순 FIFO로 구현한다(LRU보다 구현이 단순, 근거: 이 캐시는 cache-first 불변 R2 객체의
//   재조회용일 뿐이라 순서가 다소 어긋나도 "가끔 최근 것도 같이 지워진다" 정도의 사소한 저하에
//   그친다 — 오프라인 원본은 IndexedDB에 별도 보관되므로 데이터 유실이 아니다).
// entries: [{ key, order, protected }] — order 오름차순 = 오래된 것.
//   protected=true 항목은 상한 초과여도 절대 삭제 후보에 넣지 않는다(방어적 이중 안전장치 — 이
//   함수가 장차 다른 캐시에도 재사용되더라도 앱셸/공유/오프라인 항목이 섞여 들어오면 보호한다).
function selectEvictions(entries, limit) {
  const trimmable = entries.filter((e) => !e.protected);
  const overflow = trimmable.length - limit;
  if (overflow <= 0) return [];
  return trimmable.slice().sort((a, b) => a.order - b.order).slice(0, overflow).map((e) => e.key);
}

async function trimMediaCache() {
  try {
    const cache = await caches.open(MEDIA_CACHE);
    const keys = await cache.keys();
    const entries = keys.map((req, i) => ({ key: req, order: i, protected: false }));
    let limit = MEDIA_CACHE_MAX_ENTRIES;
    try {
      const storage = self.navigator && self.navigator.storage;
      if (storage && storage.estimate) {
        const est = await storage.estimate();
        if (est && est.quota > 0 && (est.quota - (est.usage || 0)) / est.quota < STORAGE_LOW_RATIO) {
          limit = MEDIA_CACHE_MAX_ENTRIES_LOW_STORAGE; // 저장공간 여유 부족 → 공격적 정리(폴백: estimate 미지원 시 기본 상한 유지)
        }
      }
    } catch (e) {}
    const toEvict = selectEvictions(entries, limit);
    await Promise.all(toEvict.map((req) => cache.delete(req)));
  } catch (e) {}
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
      caches.open(MEDIA_CACHE).then((cache) =>
        cache.match(req).then((cached) => {
          if (cached) return cached;            // 캐시 히트 → 오프라인에서도 즉시 표시
          return fetch(req).then((res) => {
            if (res && res.status === 200) {
              // [AC-2] 저장 후 용량 상한 정리 — SW가 일찍 종료되지 않도록 waitUntil로 생명 연장
              const persistAndTrim = cache.put(req, res.clone()).then(() => trimMediaCache()).catch(() => {});
              e.waitUntil(persistAndTrim);
            }
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
        // [P89] ignoreSearch:true — 빌드가 매번 ?v=<해시>를 바꿔 박으므로(캐시버스팅),
        //   정확한 쿼리로 매칭하면 오프라인일 때 "방금 그 버전"만 찾다가 못 찾을 수 있다.
        //   같은 pathname의 캐시된 셸(직전에 성공한 어떤 버전이든)을 찾아 앱이 뜨는 것이 우선.
        caches.open(CACHE).then((c) => c.match(req, { ignoreSearch: true })).then((cached) => cached || caches.match('index.html'))
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
