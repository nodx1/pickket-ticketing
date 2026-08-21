"use client";

/**
 * ⚠️ 이 파일은 **앱 컴포넌트를 import 하지 않는다.** `next/link` 와 CSS 유틸(`btn-gradient`)만 쓴다.
 *
 * 이미 뭔가 깨진 뒤에 그려지는 화면이다. 디자인 시스템이 터진 상황에서도 그려져야 하므로
 * 의존 사슬을 늘리지 않는다. 여기서 렌더 중에 던지면 상위 바운더리로 올라가고,
 * 라우트 그룹 바운더리의 상위는 `global-error.tsx` 이며 **그것마저 던지면 백화면**이다.
 * (기억이 아니라 기계로 지킨다 — `src/app/error-boundary-imports.guard.test.ts`)
 */

import Link from "next/link";

export default function DashboardError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-[60vh] items-center justify-center text-foreground">
      <div className="text-center">
        <p className="text-4xl font-bold text-destructive">오류 발생</p>
        <h1 className="mt-4 text-lg font-semibold">페이지를 불러오는 중 문제가 발생했습니다</h1>
        <p className="mt-2 text-sm text-muted-foreground">
          잠시 후 다시 시도해주세요.
        </p>
        {error.digest ? (
          <p className="mt-1 text-xs text-content-muted">오류 코드: {error.digest}</p>
        ) : null}
        <div className="mt-6 flex items-center justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            // 🔴 종전엔 직접 만든 그라디언트에 `text-foreground`(#1A1D2E) 였다 — 보라 배경 위 어두운 글자.
            //    형제 바운더리 4개와 같은 공용 유틸로 맞춘다.
            className="btn-gradient px-5 py-2.5 text-sm font-semibold text-white transition hover:opacity-90"
          >
            다시 시도
          </button>
          <Link
            href="/dashboard"
            className="rounded-full border border-border px-5 py-2.5 text-sm font-semibold transition hover:border-primary"
          >
            대시보드
          </Link>
        </div>
      </div>
    </div>
  );
}
