/**
 * 테스트 공통 setup.
 *
 * ⚠️ **node 환경 테스트에서도 이 파일이 돈다.** jsdom 전용 코드를 최상위에서 실행하면
 *    기존 241개가 깨진다 — `document` 존재를 보고 갈라야 한다.
 */
import { afterEach } from "vitest";

if (typeof document !== "undefined") {
  // jsdom 환경일 때만 — `toBeInTheDocument` 같은 DOM matcher 와 자동 cleanup.
  await import("@testing-library/jest-dom/vitest");
  const { cleanup } = await import("@testing-library/react");
  afterEach(() => cleanup());
}
