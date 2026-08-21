/**
 * getDiscoverFeed 단위 테스트 (Phase A.1)
 *
 * 검증:
 * 1. /events/feed 가 정상 응답 시 그대로 반환
 * 2. /events/feed 가 실패하면 /events/search?sort=trending 으로 폴백
 * 3. 폴백 시 next_cursor 계산 정확성
 */
jest.mock("axios", () => {
  const get = jest.fn();
  const post = jest.fn();
  const use = jest.fn();
  const instance = {
    get,
    post,
    interceptors: {
      request: { use },
      response: { use },
    },
  };
  return {
    __esModule: true,
    default: {
      create: jest.fn(() => instance),
      isAxiosError: jest.fn(),
    },
    isAxiosError: jest.fn(),
  };
});

import axios from "axios";
const mockInstance = (axios.create as jest.Mock)();
const mockGet = mockInstance.get as jest.Mock;

jest.mock("@/lib/storage", () => ({
  storage: {
    getAccessToken: jest.fn().mockResolvedValue(null),
    getRefreshToken: jest.fn().mockResolvedValue(null),
    setAccessToken: jest.fn(),
    setRefreshToken: jest.fn(),
    clearAuth: jest.fn(),
  },
}));

jest.mock("@/lib/ssl-pinning", () => ({
  assertTrustedHost: jest.fn(),
}));

jest.mock("@/config/env", () => ({
  env: {
    API_URL: "http://localhost:8021",
    IS_DEV: true,
  },
}));

import { getDiscoverFeed, type Event } from "@/config/api";

const mockEvent = (id: string): Event => ({
  id,
  title: `Event ${id}`,
  event_date: "2030-01-01",
  status: "on_sale",
});

describe("getDiscoverFeed", () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it("/events/feed 정상 응답 시 그대로 반환", async () => {
    const expected = {
      events: [mockEvent("a"), mockEvent("b")],
      next_cursor: "next-token",
    };
    mockGet.mockResolvedValueOnce({ data: expected });

    const result = await getDiscoverFeed();

    expect(mockGet).toHaveBeenCalledWith("/events/feed", {
      params: { cursor: undefined, limit: 10 },
    });
    expect(result).toEqual(expected);
  });

  it("/events/feed 실패 시 /events/search 폴백", async () => {
    mockGet
      .mockRejectedValueOnce(new Error("404"))
      .mockResolvedValueOnce({
        data: {
          events: [mockEvent("a"), mockEvent("b"), mockEvent("c")],
          total: 25,
        },
      });

    const result = await getDiscoverFeed(undefined, 10);

    expect(mockGet).toHaveBeenNthCalledWith(2, "/events/search", {
      params: { limit: 10, skip: 0, sort: "trending" },
    });
    expect(result.events).toHaveLength(3);
    expect(result.next_cursor).toBe("3");
  });

  it("폴백 마지막 페이지 next_cursor=null", async () => {
    mockGet
      .mockRejectedValueOnce(new Error("fail"))
      .mockResolvedValueOnce({
        data: { events: [mockEvent("z")], total: 21 },
      });

    const result = await getDiscoverFeed("20", 10);

    expect(mockGet).toHaveBeenNthCalledWith(2, "/events/search", {
      params: { limit: 10, skip: 20, sort: "trending" },
    });
    expect(result.next_cursor).toBeNull();
  });
});
