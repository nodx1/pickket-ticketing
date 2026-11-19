// ---------------------------------------------------------------------------
// Pickket Service Worker — 홈 화면 앱(PWA)용
// ---------------------------------------------------------------------------
// 원칙
// - 페이지(HTML)와 API 는 캐시하지 않는다. 응모 마감·추첨 결과·좌석/결제 상태는 항상 최신이어야 한다.
//   (사용자별 데이터를 캐시하면 공용 기기에서 다른 사람에게 보일 위험도 있다.)
// - 오프라인일 때 페이지 이동은 미리 저장한 /offline.html 로 대신한다.
// - 해시가 붙은 정적 파일(_next/static)·글꼴·아이콘만 캐시 우선으로 쓴다.
// - 오프라인 중 보낸 요청을 나중에 몰래 재전송하지 않는다(응모·결제 중복 방지).
// - 웹 푸시 처리기는 sw-push.js 를 함께 불러온다(같은 범위에 서비스 워커는 하나만 둘 수 있음).
//
// 캐시 버전: Dockerfile 이 빌드 때 __BUILD_HASH__ 를 바꿔 넣는다. 바뀌면 이전 캐시는 지워진다.
const CACHE_VERSION = "__BUILD_HASH__";
const STATIC_CACHE = `pickket-static-${CACHE_VERSION}`;
const OFFLINE_URL = "/offline.html";
const PRECACHE_URLS = [OFFLINE_URL, "/icons/icon-192.png", "/icons/icon-512.png"];

importScripts("/sw-push.js");

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(STATIC_CACHE)
      .then((cache) => cache.addAll(PRECACHE_URLS))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((names) =>
        Promise.all(
          names
            .filter((name) => name.startsWith("pickket-") && name !== STATIC_CACHE)
            .map((name) => caches.delete(name)),
        ),
      )
      .then(() => self.clients.claim()),
  );
});

function isStaticAsset(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/fonts/") ||
    url.pathname.startsWith("/icons/")
  );
}

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // 페이지 이동: 네트워크만 쓰고, 끊겼을 때만 오프라인 안내
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request).catch(async () => (await caches.match(OFFLINE_URL)) ?? Response.error()),
    );
    return;
  }

  if (isStaticAsset(url)) {
    event.respondWith(cacheFirst(request));
  }
  // 그 밖의 요청(API·이미지·데이터)은 브라우저 기본 동작 그대로
});

async function cacheFirst(request) {
  const cached = await caches.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok && response.type === "basic") {
    const cache = await caches.open(STATIC_CACHE);
    cache.put(request, response.clone());
  }
  return response;
}

self.addEventListener("message", (event) => {
  if (event.data && event.data.type === "SKIP_WAITING") self.skipWaiting();
});
