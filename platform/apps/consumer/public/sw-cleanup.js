// 이전 배포에서 등록된 Service Worker 자동 해제
// + bfcache(back-forward cache) 복원 시 강제 리로드
(function () {
  // SW 전부 해제
  if ("serviceWorker" in navigator) {
    navigator.serviceWorker.getRegistrations().then(function (regs) {
      regs.forEach(function (r) {
        r.unregister();
      });
    });
  }

  // bfcache 복원 시 최신 페이지 보장 — dev에서는 HMR과 충돌하므로 비활성화
  if (window.location.hostname !== "localhost") {
    window.addEventListener("pageshow", function (e) {
      if (e.persisted) {
        window.location.reload();
      }
    });
  }
})();
