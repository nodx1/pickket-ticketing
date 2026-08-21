// ---------------------------------------------------------------------------
// Pickket Service Worker — PWA 오프라인 + 캐시 전략 + 오프라인 티켓 (P2-5)
// ---------------------------------------------------------------------------
// 캐시 버전: 배포할 때마다 이 값을 변경하면 이전 캐시가 자동 삭제됨
// Dockerfile/CI에서 빌드 시 sed로 교체하거나, 수동으로 올려도 됨
const CACHE_VERSION = "__BUILD_HASH__";
const CACHE_NAME = `pickket-v2-${CACHE_VERSION}`;
const API_CACHE_NAME = `pickket-api-${CACHE_VERSION}`;

// 프리캐시할 정적 자산
// 주의: `/` (메인페이지)는 ISR(revalidate=60)과 충돌하므로 프리캐시하지 않음
const PRECACHE_URLS = ["/offline", "/fonts/PretendardVariable-latin.woff2", "/fonts/PretendardVariable-korean.woff2"];

// API 캐시 설정
const _API_CACHE_MAX_AGE = 5 * 60 * 1000; // 5분 (미사용 — 향후 TTL 체크용 예약)
const _API_CACHE_MAX_ENTRIES = 100; // 미사용 — 향후 캐시 크기 제한용 예약

// 이벤트 상세 캐시 설정 (stale-while-revalidate)
const EVENT_CACHE_NAME = `pickket-events-${CACHE_VERSION}`;

// Background sync 큐 이름
const BG_SYNC_QUEUE = "pickket-bg-sync";

// ---------------------------------------------------------------------------
// Install — 프리캐시 자산 저장
// ---------------------------------------------------------------------------
self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting())
  );
});

// ---------------------------------------------------------------------------
// Activate — 이전 버전 캐시 정리
// ---------------------------------------------------------------------------
self.addEventListener("activate", (event) => {
  const currentCaches = [CACHE_NAME, API_CACHE_NAME, EVENT_CACHE_NAME];
  event.waitUntil(
    caches
      .keys()
      .then((cacheNames) =>
        Promise.all(
          cacheNames
            .filter((name) => !currentCaches.includes(name))
            .map((name) => caches.delete(name))
        )
      )
      .then(() => self.clients.claim())
  );
});

// ---------------------------------------------------------------------------
// Fetch — 요청 유형별 캐시 전략
// ---------------------------------------------------------------------------
self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // POST 요청 등 non-GET은 캐시하지 않음 (background sync 대상일 수 있음)
  if (request.method !== "GET") {
    // 오프라인 상태에서의 POST 요청은 background sync 큐에 추가
    if (!navigator.onLine && request.method === "POST") {
      event.respondWith(queueForBackgroundSync(request));
    }
    return;
  }

  // 이벤트 상세 API → Network-first (응모 시간/CTA/마감 실시간 반영 필수)
  // 옛: stale-while-revalidate 였는데 Chrome 에서 첫 진입 시 옛 데이터 보이고
  // 강제 새로고침해야 갱신되는 버그 → network-first 로 변경
  if (url.pathname.match(/^\/api\/v1\/events\/[^/]+$/)) {
    event.respondWith(networkFirstWithCache(request, EVENT_CACHE_NAME));
    return;
  }

  // 사용자별(인증) API → 절대 캐시하지 않음 (네트워크 전용).
  // 티켓/유저 응답은 사용자 고유 데이터이므로 URL-only 캐시 키로 저장하면
  // 공용 기기에서 다른 사용자에게 노출되는 cross-user leak 위험이 있다.
  if (
    url.pathname.startsWith("/api/v1/tickets/") ||
    url.pathname.startsWith("/api/v1/users/")
  ) {
    return; // 네트워크 직접 통과, 캐시 사용/저장 안 함
  }

  // 기타 API 요청 → 캐시하지 않음 (네트워크 직접 통과)
  if (url.pathname.startsWith("/api/")) return;

  // 정적 자산 (_next/static, icons, fonts) → Cache-first 전략
  // _next/static은 파일명에 해시가 포함되어 있어 캐시해도 안전
  if (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname.startsWith("/fonts/") ||
    url.pathname.endsWith(".woff2")
  ) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // 이미지 자산 → Cache-first (긴 TTL)
  if (
    url.pathname.startsWith("/images/") ||
    url.pathname.endsWith(".svg") ||
    url.pathname.endsWith(".png") ||
    url.pathname.endsWith(".jpg") ||
    url.pathname.endsWith(".webp") ||
    url.pathname.endsWith(".avif")
  ) {
    event.respondWith(cacheFirst(request));
    return;
  }

  // HTML 페이지 → 네트워크만 사용, 오프라인일 때만 폴백
  // 페이지를 캐시하지 않아 배포 후 이전 버전이 깜빡이는 문제 방지
  if (request.mode === "navigate") {
    event.respondWith(networkOnlyWithOfflineFallback(request));
    return;
  }

  // 나머지 → 네트워크 직접 통과
});

// ---------------------------------------------------------------------------
// Background Sync — 오프라인 상태에서 실패한 요청 큐잉 & 재전송
// ---------------------------------------------------------------------------
self.addEventListener("sync", (event) => {
  if (event.tag === BG_SYNC_QUEUE) {
    event.waitUntil(replayQueuedRequests());
  }
});

async function queueForBackgroundSync(request) {
  try {
    // 요청 정보를 IndexedDB에 저장
    const body = await request.text();
    const queueItem = {
      url: request.url,
      method: request.method,
      headers: Object.fromEntries(request.headers.entries()),
      body,
      timestamp: Date.now(),
    };

    const db = await openSyncDB();
    const tx = db.transaction("queue", "readwrite");
    tx.objectStore("queue").add(queueItem);
    await promisifyTransaction(tx);
    db.close();

    // Background sync 등록
    if ("sync" in self.registration) {
      await self.registration.sync.register(BG_SYNC_QUEUE);
    }

    return new Response(JSON.stringify({ queued: true }), {
      status: 202,
      headers: { "Content-Type": "application/json" },
    });
  } catch {
    return new Response(JSON.stringify({ error: "Failed to queue request" }), {
      status: 503,
      headers: { "Content-Type": "application/json" },
    });
  }
}

async function replayQueuedRequests() {
  const db = await openSyncDB();
  const tx = db.transaction("queue", "readonly");
  const items = await promisifyRequest(tx.objectStore("queue").getAll());
  db.close();

  for (const item of items) {
    // 결제/구매/확정 계열 엔드포인트는 background sync로 재전송하지 않는다.
    // 오프라인 동안 큐잉된 결제 요청을 자동 replay 하면 사용자가 이미
    // (온라인 복귀 후 수동으로) 결제를 완료한 경우 이중 청구 위험이 있다.
    // 이런 위험 요청은 큐에서 제거만 하고 재전송은 생략한다.
    // charge를 실제로 일으키는 경로만 replay 금지(이중청구 방지). 이전 `\b`
    // 패턴은 /payment-status·/payment-methods·/payment/prepare 같은 비-charge
    // 경로까지 잘못 드롭했다. prepare/status/methods는 안전하게 replay 허용.
    const isUnsafeReplay =
      /\/purchase(\/|\?|$)/.test(item.url) ||
      /\/(pay|confirm)(\/|\?|$)/.test(item.url) ||
      /\/payment\/(confirm|complete|approve)(\/|\?|$)/.test(item.url);
    if (isUnsafeReplay) {
      const delDB = await openSyncDB();
      const delTx = delDB.transaction("queue", "readwrite");
      delTx.objectStore("queue").delete(item.id);
      await promisifyTransaction(delTx);
      delDB.close();
      continue;
    }

    try {
      await fetch(item.url, {
        method: item.method,
        headers: item.headers,
        body: item.body || undefined,
        credentials: "include", // 인증 쿠키 포함하여 재전송
      });

      // 성공하면 큐에서 제거
      const delDB = await openSyncDB();
      const delTx = delDB.transaction("queue", "readwrite");
      delTx.objectStore("queue").delete(item.id);
      await promisifyTransaction(delTx);
      delDB.close();
    } catch {
      // 아직 오프라인이면 다음 sync에서 재시도
      break;
    }
  }
}

function openSyncDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open("pickket-bg-sync-db", 1);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains("queue")) {
        db.createObjectStore("queue", { keyPath: "id", autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function promisifyRequest(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function promisifyTransaction(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ---------------------------------------------------------------------------
// Cache-first 전략 (정적 자산 — 해시된 파일명이라 안전)
// ---------------------------------------------------------------------------
async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    if (response.ok) {
      const cache = await caches.open(CACHE_NAME);
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    return new Response("", { status: 408, statusText: "Offline" });
  }
}

// ---------------------------------------------------------------------------
// Stale-while-revalidate (이벤트 상세 페이지)
// 캐시에서 즉시 반환하면서 백그라운드에서 네트워크 업데이트
// ---------------------------------------------------------------------------
async function _staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);

  const networkPromise = fetch(request)
    .then((response) => {
      if (response.ok) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch(() => null);

  // 캐시가 있으면 즉시 반환하고, 백그라운드에서 네트워크 업데이트
  if (cached) {
    // 백그라운드 업데이트 (결과를 기다리지 않음) — void로 floating promise 명시
    void networkPromise;
    return cached;
  }

  // 캐시가 없으면 네트워크 응답을 기다림
  const networkResponse = await networkPromise;
  if (networkResponse) return networkResponse;

  return new Response(
    JSON.stringify({ error: "오프라인 상태입니다." }),
    {
      status: 503,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    }
  );
}

// ---------------------------------------------------------------------------
// Network-only + 오프라인 폴백 (페이지 네비게이션)
// 네트워크 성공 시 캐시에 저장하지 않음 → 이전 배포 버전 깜빡임 방지
// ---------------------------------------------------------------------------
async function networkOnlyWithOfflineFallback(request) {
  try {
    return await fetch(request);
  } catch {
    // 오프라인: 프리캐시된 오프라인 페이지 반환
    const offlinePage = await caches.match("/offline");
    if (offlinePage) return offlinePage;

    return new Response(
      `<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>오프라인 - Pickket</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      margin: 0;
      background: #f9fafb;
      color: #374151;
      text-align: center;
    }
    .container { max-width: 400px; padding: 2rem; }
    h1 { font-size: 1.5rem; margin-bottom: 0.5rem; }
    p { color: #6b7280; line-height: 1.6; }
    button {
      margin-top: 1rem;
      padding: 0.75rem 1.5rem;
      background: #6366f1;
      color: white;
      border: none;
      border-radius: 0.5rem;
      cursor: pointer;
      font-size: 1rem;
    }
    button:hover { background: #4f46e5; }
  </style>
</head>
<body>
  <div class="container">
    <h1>오프라인 상태입니다</h1>
    <p>인터넷 연결을 확인한 후 다시 시도해주세요.</p>
    <button onclick="window.location.reload()">다시 시도</button>
  </div>
</body>
</html>`,
      {
        status: 200,
        headers: { "Content-Type": "text/html; charset=utf-8" },
      }
    );
  }
}

// ---------------------------------------------------------------------------
// 클라이언트로부터의 메시지 처리 (오프라인 티켓 캐시 트리거 등)
// ---------------------------------------------------------------------------
self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") {
    self.skipWaiting();
  }
});
