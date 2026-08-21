"use client";

/**
 * ⚠️ 이 파일은 **앱 컴포넌트도 CSS 클래스도 쓰지 않는다.** 인라인 style 만 쓴다.
 *
 * 루트 레이아웃이 터졌을 때 유일하게 남는 화면이고, 그 상황에서는 CSS 가 안 실렸을 수 있다.
 * **이 파일이 던지면 백화면이다** — 더 갈 상위 바운더리가 없다.
 * `<html><body>` 를 직접 내는 것도 그래서다(layout 을 못 쓴다).
 * (기억이 아니라 기계로 지킨다 — `src/app/error-boundary-imports.guard.test.ts`)
 */

import * as Sentry from "@sentry/nextjs";
import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    Sentry.captureException(error);
  }, [error]);

  return (
    <html lang="ko">
      <body>
        <div style={{ padding: "2rem", textAlign: "center" }}>
          <h2 style={{ marginBottom: "1rem" }}>문제가 발생했습니다</h2>
          <p style={{ color: "#666", marginBottom: "1.5rem" }}>
            잠시 후 다시 시도해주세요.
          </p>
          {/*
            digest 는 문의 대응에 필수다 — 이게 없으면 사용자가 "오류가 났다"고 알려도
            우리가 **그 오류를 특정할 수 없다**(Sentry 이벤트와 이어붙일 키가 없다).
            여기가 최악 경로라(루트 레이아웃이 터졌을 때 유일하게 남는 화면) 더 그렇다.
          */}
          {error.digest ? (
            <p style={{ color: "#999", fontSize: "0.75rem", marginBottom: "1.5rem" }}>
              오류 코드: {error.digest}
            </p>
          ) : null}
          <button
            onClick={reset}
            style={{
              padding: "0.75rem 1.5rem",
              background: "#6C5CE7",
              color: "#fff",
              border: "none",
              borderRadius: "100px",
              cursor: "pointer",
            }}
          >
            다시 시도
          </button>
        </div>
      </body>
    </html>
  );
}
