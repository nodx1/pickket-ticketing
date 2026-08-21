/**
 * PR-U6 갭 감사 B-3 — _retry 플래그 회귀 테스트
 *
 * 검증: 401 → refresh 성공 → 재시도된 요청이 또 401을 받아도
 *        refresh 는 재호출되지 않는다 (무한루프 방지).
 *
 * 근거: docs/v2-team-requests/2026-04-10-pr-u6-gap-audit.md §B-3
 */

jest.mock("axios", () => {
  // 인스턴스를 호출 가능한 함수로 만들어 api(originalRequest) 재시도를 시뮬레이션
  const callable: jest.Mock & Record<string, unknown> = jest.fn() as unknown as jest.Mock & Record<string, unknown>;
  callable.get = jest.fn();
  callable.post = jest.fn();
  callable.request = jest.fn();
  callable.interceptors = {
    request: { use: jest.fn() },
    response: { use: jest.fn() },
  };
  return {
    __esModule: true,
    default: {
      create: jest.fn(() => callable),
      post: jest.fn(),
      isAxiosError: jest.fn(() => false),
    },
    isAxiosError: jest.fn(() => false),
  };
});

jest.mock("@/lib/storage", () => ({
  storage: {
    getAccessToken: jest.fn().mockResolvedValue("old-access"),
    getRefreshToken: jest.fn().mockResolvedValue("refresh-xyz"),
    setAccessToken: jest.fn().mockResolvedValue(undefined),
    setRefreshToken: jest.fn().mockResolvedValue(undefined),
    clearAuth: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock("@/lib/ssl-pinning", () => ({
  assertTrustedHost: jest.fn(),
}));

jest.mock("@/config/env", () => ({
  env: {
    API_URL: "http://localhost:8021",
    IS_DEV: true,
    APP_VERSION: "test",
  },
}));

import axios from "axios";
import "@/config/api";

const mockedAxios = axios as unknown as {
  create: jest.Mock;
  post: jest.Mock;
};
const mockInstance = mockedAxios.create.mock.results[0].value as jest.Mock & {
  interceptors: { response: { use: jest.Mock } };
};

function getResponseErrorHandler(): (err: unknown) => Promise<unknown> {
  const calls = mockInstance.interceptors.response.use.mock.calls;
  const responseCall = calls.find((c) => c.length === 2);
  if (!responseCall) throw new Error("response interceptor not registered");
  return responseCall[1] as (err: unknown) => Promise<unknown>;
}

describe("api interceptor · _retry flag", () => {
  beforeEach(() => {
    mockedAxios.post.mockReset();
    mockInstance.mockReset();
  });

  it("refresh 성공 후 재시도된 요청이 다시 401을 받아도 refresh 를 재호출하지 않는다", async () => {
    const errorHandler = getResponseErrorHandler();

    // refresh HTTP 호출 1회 성공 응답
    mockedAxios.post.mockResolvedValueOnce({
      data: { access_token: "new-access", refresh_token: "new-refresh" },
    });

    // api(originalRequest) 재시도 시 다시 401 → errorHandler 재귀 호출
    mockInstance.mockImplementation(async (cfg: Record<string, unknown>) => {
      const err = {
        config: cfg,
        response: { status: 401, data: {} },
        isAxiosError: true,
      };
      return errorHandler(err);
    });

    const originalRequest = {
      url: "/events/1",
      headers: { Authorization: "Bearer old-access" },
    };
    const firstError = {
      config: originalRequest,
      response: { status: 401, data: {} },
      isAxiosError: true,
    };

    await expect(errorHandler(firstError)).rejects.toBeDefined();

    // refresh 엔드포인트는 정확히 1회만 호출
    expect(mockedAxios.post).toHaveBeenCalledTimes(1);
    expect(mockedAxios.post).toHaveBeenCalledWith(
      "http://localhost:8021/api/v1/auth/refresh",
      { refresh_token: "refresh-xyz" },
      expect.any(Object),
    );

    // 재시도된 요청에 _retry 플래그가 설정되어 있어야 함
    expect((originalRequest as unknown as { _retry?: boolean })._retry).toBe(true);
  });
});
