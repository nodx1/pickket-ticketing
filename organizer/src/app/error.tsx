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

export default function RootError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background text-foreground">
      <div className="text-center">
        <p className="text-5xl font-bold text-destructive">오류 발생</p>
        <h1 className="mt-4 text-xl font-semibold">문제가 발생했습니다</h1>
        <p className="mt-2 text-content-subtle">
          일시적인 오류가 발생했습니다. 잠시 후 다시 시도해주세요.
        </p>
        {error.digest ? <p className="mt-1 text-xs text-content-muted">오류 코드: {error.digest}</p> : null}
        <div className="mt-8 flex items-center justify-center gap-4">
          <button
            type="button"
            onClick={reset}
            className="btn-gradient px-6 py-3 text-sm font-semibold text-white transition hover:opacity-90"
          >
            다시 시도
          </button>
          {/*
            🔴 종전엔 `/dashboard` 였다. 이 파일은 **루트** 바운더리라 공개·구매자 페이지
               오류까지 받는다 — 티켓 사려던 사람을 주최자 대시보드로 보내는 막다른 길이었다.
               `(public)/error.tsx` 는 처음부터 `/` 로 보내고 있었다.
            ⚠️ `not-found.tsx:20` 에 **같은 결함이 남아 있다**(구매자에게 `/dashboard` 권유).
               404 는 오류가 아니라 정상 응답이라 문구·IA 판단이 필요해 별건으로 분리했다.
               같이 고치지 않으면 "같은 함정을 두 번째 자리에서 또" 가 된다.
          */}
          <Link
            href="/"
            className="rounded-full border border-border px-6 py-3 text-sm font-semibold transition hover:border-primary"
          >
            홈으로 이동
          </Link>
        </div>
      </div>
    </div>
  );
}
