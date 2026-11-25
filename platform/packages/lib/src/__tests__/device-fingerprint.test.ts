import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  DEVICE_FINGERPRINT_HEADER,
  DEVICE_FINGERPRINT_STORAGE_KEY,
  getDeviceFingerprint,
} from "../device-fingerprint";

vi.mock("@pickket/store", () => ({
  useAuthStore: Object.assign(() => ({}), {
    getState: () => ({ token: null, user: null, setAuth: vi.fn(), logout: vi.fn(), hydrate: vi.fn() }),
  }),
}));
vi.mock("../api-config", () => ({
  getApiConfig: () => ({ baseURL: "http://localhost:8001", getToken: () => null, onTokenExpired: vi.fn() }),
}));

describe("getDeviceFingerprint (과업 1-3 계정 복제 차단)", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("처음 부르면 값을 만들어 저장하고, 다음에도 같은 값을 돌려준다", () => {
    const first = getDeviceFingerprint();
    expect(first).toMatch(/^[A-Za-z0-9-]{16,64}$/);
    expect(window.localStorage.getItem(DEVICE_FINGERPRINT_STORAGE_KEY)).toBe(first);
    expect(getDeviceFingerprint()).toBe(first);
  });

  it("이미 저장된 올바른 값은 그대로 쓴다(계정을 바꿔 로그인해도 같은 브라우저면 같은 값)", () => {
    window.localStorage.setItem(DEVICE_FINGERPRINT_STORAGE_KEY, "abcdef0123456789abcdef");
    expect(getDeviceFingerprint()).toBe("abcdef0123456789abcdef");
  });

  it("저장값이 형식에 안 맞으면 새로 만든다", () => {
    window.localStorage.setItem(DEVICE_FINGERPRINT_STORAGE_KEY, "<script>");
    const id = getDeviceFingerprint();
    expect(id).not.toBe("<script>");
    expect(id).toMatch(/^[A-Za-z0-9-]{16,64}$/);
  });

  it("저장소를 못 쓰면 null(응모는 막지 않고 서버가 기기 검사만 건너뜀)", () => {
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(getDeviceFingerprint()).toBeNull();
  });
});

describe("applyLottery 가 기기 식별값을 싣는다", () => {
  beforeEach(() => window.localStorage.clear());
  afterEach(() => vi.restoreAllMocks());

  it("X-Device-Fingerprint 헤더로 저장된 값을 보낸다", async () => {
    const { applyLottery, default: api } = await import("../api");
    const post = vi.spyOn(api, "post").mockResolvedValue({ data: {} } as never);
    const fp = getDeviceFingerprint();
    await applyLottery("ev-1", "tier-1", { group_size: 1, invested_ap: 100 });
    expect(post).toHaveBeenCalledWith(
      "/events/ev-1/tiers/tier-1/lottery/apply",
      { group_size: 1, invested_ap: 100 },
      { headers: { [DEVICE_FINGERPRINT_HEADER]: fp } },
    );
  });

  it("저장소를 못 쓰면 헤더 없이 보낸다", async () => {
    const { applyLottery, default: api } = await import("../api");
    const post = vi.spyOn(api, "post").mockResolvedValue({ data: {} } as never);
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    await applyLottery("ev-1", "tier-1", { group_size: 1 });
    expect(post).toHaveBeenCalledWith("/events/ev-1/tiers/tier-1/lottery/apply", { group_size: 1 }, undefined);
  });
});
