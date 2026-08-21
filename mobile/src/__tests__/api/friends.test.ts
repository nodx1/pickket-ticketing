/**
 * Friends API 계약 테스트 (Phase C.1)
 *
 * backend(app/api/v1/friendships.py) 실제 경로/필드와 일치하는지 검증.
 *   GET    /friends?status_filter=...     → list[FriendUserRead]
 *   POST   /friends/request {friend_id}    → FriendshipRead
 *   POST   /friends/{friendship_id}/accept
 *   DELETE /friends/{friendship_id}
 * 미존재 엔드포인트(유저 검색)는 404-swallow 없이 명시적으로 throw.
 */
jest.mock("axios", () => {
  const get = jest.fn();
  const post = jest.fn();
  const del = jest.fn();
  const use = jest.fn();
  const instance = {
    get,
    post,
    delete: del,
    interceptors: {
      request: { use },
      response: { use },
    },
  };
  const isAxiosError = (e: unknown): e is { response?: { status: number } } =>
    !!e && typeof e === "object" && "isAxiosError" in (e as Record<string, unknown>);
  return {
    __esModule: true,
    default: { create: jest.fn(() => instance), isAxiosError },
    isAxiosError,
  };
});

import axios from "axios";

const mockInstance = (axios.create as jest.Mock)();
const mockGet = mockInstance.get as jest.Mock;
const mockPost = mockInstance.post as jest.Mock;
const mockDelete = mockInstance.delete as jest.Mock;

import {
  getFriendsList,
  searchUsers,
  requestFriend,
  acceptFriend,
  removeFriend,
  FeatureNotImplementedError,
} from "@/config/api";

beforeEach(() => {
  mockGet.mockReset();
  mockPost.mockReset();
  mockDelete.mockReset();
});

describe("Friends API contract", () => {
  it("getFriendsList: accepted/pending_incoming 2회 조회 후 병합", async () => {
    mockGet
      .mockResolvedValueOnce({
        data: [
          { id: "u1", name: "철수", profile_image_url: null, friendship_status: "accepted" },
        ],
      })
      .mockResolvedValueOnce({ data: [] });
    const r = await getFriendsList();
    expect(mockGet).toHaveBeenCalledWith("/friends", {
      params: { status_filter: "accepted" },
    });
    expect(mockGet).toHaveBeenCalledWith("/friends", {
      params: { status_filter: "pending_incoming" },
    });
    expect(r.friends).toHaveLength(1);
    expect(r.friends[0].name).toBe("철수");
    expect(r.pending).toEqual([]);
  });

  it("searchUsers: 빈 문자열은 빈 배열(호출 없음)", async () => {
    const r = await searchUsers("  ");
    expect(r).toEqual([]);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("searchUsers: 미구현 엔드포인트 → FeatureNotImplementedError throw", async () => {
    await expect(searchUsers("철수")).rejects.toBeInstanceOf(FeatureNotImplementedError);
    expect(mockGet).not.toHaveBeenCalled();
  });

  it("requestFriend: friend_id body로 POST /friends/request", async () => {
    mockPost.mockResolvedValueOnce({ data: { friend_id: "u1", status: "pending" } });
    const r = await requestFriend("u1");
    expect(mockPost).toHaveBeenCalledWith("/friends/request", { friend_id: "u1" });
    expect(r.id).toBe("u1");
    expect(r.friendship_status).toBe("pending");
  });

  it("acceptFriend: POST /friends/{friendshipId}/accept", async () => {
    mockPost.mockResolvedValueOnce({ data: {} });
    const r = await acceptFriend("fs1");
    expect(mockPost).toHaveBeenCalledWith("/friends/fs1/accept", {});
    expect(r.ok).toBe(true);
  });

  it("removeFriend: DELETE /friends/{friendshipId}", async () => {
    mockDelete.mockResolvedValueOnce({ data: undefined });
    const r = await removeFriend("fs1");
    expect(mockDelete).toHaveBeenCalledWith("/friends/fs1");
    expect(r.ok).toBe(true);
  });

  it("getFriendsList: 서버 에러는 throw", async () => {
    mockGet.mockRejectedValueOnce(new Error("boom"));
    await expect(getFriendsList()).rejects.toBeTruthy();
  });
});
