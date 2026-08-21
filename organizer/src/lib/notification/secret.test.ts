import { afterEach, describe, expect, it, vi } from "vitest";

import { resolveNotificationSecret } from "./secret";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("resolveNotificationSecret (H-05 fail-close)", () => {
  it("설정된 env 값을 우선순위대로 반환한다", () => {
    vi.stubEnv("__TEST_SECRET_B", "second");
    expect(
      resolveNotificationSecret(["__TEST_SECRET_A", "__TEST_SECRET_B"], "fallback", "라벨"),
    ).toBe("second");
  });

  it("비프로덕션에서 env 미설정 시 dev 폴백을 반환한다", () => {
    vi.stubEnv("NODE_ENV", "development");
    expect(resolveNotificationSecret(["__TEST_SECRET_A"], "dev-fallback", "라벨")).toBe(
      "dev-fallback",
    );
  });

  it("프로덕션에서 전용 시크릿 미설정이면 throw 한다(dev 상수로 서명 금지)", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("__TEST_SECRET_A", "");
    vi.stubEnv("__TEST_SECRET_B", "");
    expect(() =>
      resolveNotificationSecret(["__TEST_SECRET_A", "__TEST_SECRET_B"], "dev-fallback", "라벨"),
    ).toThrow(/시크릿이 설정되지 않았습니다/);
  });

  it("프로덕션이라도 env 가 설정돼 있으면 그 값을 쓴다", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("__TEST_SECRET_A", "prod-secret");
    expect(resolveNotificationSecret(["__TEST_SECRET_A"], "dev-fallback", "라벨")).toBe(
      "prod-secret",
    );
  });
});
