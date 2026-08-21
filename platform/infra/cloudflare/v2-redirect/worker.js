export default {
  async fetch(request) {
    const url = new URL(request.url);
    const host = url.hostname;

    const redirectMap = {
      'v2.pickket.kr': 'www.pickket.kr',
      'api-v2.pickket.kr': 'api.pickket.kr',
      'studio-v2.pickket.kr': 'go.pickket.kr',
      'admin-v2.pickket.kr': 'admin.pickket.kr',
    };

    const target = redirectMap[host];
    if (target) {
      url.hostname = target;
      return Response.redirect(url.toString(), 301);
    }

    // 상세통합 U5/U6: go 공개 랜딩(/e/*) 폐기 → consumer(www)로 301.
    // ⚠️ go 대시보드(/dashboard 등)는 유지하므로 /e/ 경로만 이전.
    // ⚠️ 활성화 = U6 컷오버(결제 consumer 이전 완료 + "주문 0" 게이트 후). 그 전까지 dormant.
    const GO_LANDING_CUTOVER = false; // U6 컷오버 시 true로 배포
    if (GO_LANDING_CUTOVER && host === 'go.pickket.kr' && url.pathname.startsWith('/e/')) {
      url.hostname = 'www.pickket.kr';
      return Response.redirect(url.toString(), 301);
    }

    return fetch(request);
  },
};
