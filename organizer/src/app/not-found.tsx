import Link from "next/link";

/**
 * 공개 404.
 *
 * 🔴 **구매자에게 주최자 대시보드를 권하지 않는다** (2026-08-01 감사).
 *    종전 두 번째 버튼이 `/dashboard` 였다. 티켓을 찾다 잘못 들어온 손님에게
 *    그건 로그인 벽이고, 거기서 할 수 있는 일이 없다 — 막다른 길이다.
 *    이 자리에 필요한 건 **「내 티켓 조회」** 다.
 *
 * ⚠️ 티켓 딥링크(만료·취소·토큰 누락)는 여기로 오지 않는다. 그쪽은
 *    `/my-tickets?reason=…` 으로 **이유를 달아** 따로 보낸다.
 */
export default function NotFound() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
      <div className="text-center">
        <p className="text-7xl font-bold text-primary">404</p>
        <h1 className="mt-4 text-2xl font-semibold">페이지를 찾을 수 없습니다</h1>
        <p className="mt-2 text-content-subtle">
          요청하신 페이지가 존재하지 않거나 이동되었을 수 있습니다.
        </p>
        <div className="mt-8 flex items-center justify-center gap-4">
          <Link
            href="/"
            className="btn-gradient px-6 py-3 text-sm font-semibold text-white transition hover:opacity-90"
          >
            홈으로 이동
          </Link>
          <Link
            href="/my-tickets"
            className="rounded-full border border-border px-6 py-3 text-sm font-semibold transition hover:border-primary"
          >
            내 티켓 조회
          </Link>
        </div>
      </div>
    </div>
  );
}
