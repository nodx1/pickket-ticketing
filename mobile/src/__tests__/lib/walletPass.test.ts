/**
 * wallet-pass 단위 테스트 (Phase D.4)
 */
const mockGet = jest.fn();
const mockOpenBrowser = jest.fn();

jest.mock("@/config/api", () => ({
  api: { get: (...args: unknown[]) => mockGet(...args) },
}));

jest.mock("expo-web-browser", () => ({
  openBrowserAsync: (...args: unknown[]) => mockOpenBrowser(...args),
}));

jest.mock("react-native", () => ({
  Platform: { OS: "ios" },
}));

jest.mock("axios", () => {
  const mod: {
    isAxiosError: (e: unknown) => boolean;
  } = {
    isAxiosError: (e: unknown) =>
      typeof e === "object" && e !== null && (e as { isAxiosError?: boolean }).isAxiosError === true,
  };
  return { __esModule: true, default: mod, ...mod };
});

import { addTicketToWallet, fetchWalletPassUrl } from "@/lib/wallet-pass";

const notImpl = (status: number) => ({
  isAxiosError: true,
  response: { status },
});

describe("wallet-pass", () => {
  beforeEach(() => {
    mockGet.mockReset();
    mockOpenBrowser.mockReset();
  });

  it("fetchWalletPassUrl: 404 → null", async () => {
    mockGet.mockRejectedValue(notImpl(404));
    expect(await fetchWalletPassUrl("t1")).toBeNull();
  });

  it("fetchWalletPassUrl: 501 → null", async () => {
    mockGet.mockRejectedValue(notImpl(501));
    expect(await fetchWalletPassUrl("t1")).toBeNull();
  });

  it("fetchWalletPassUrl: 500 → throws", async () => {
    mockGet.mockRejectedValue(notImpl(500));
    await expect(fetchWalletPassUrl("t1")).rejects.toBeTruthy();
  });

  it("fetchWalletPassUrl: 정상 응답 반환", async () => {
    mockGet.mockResolvedValue({ data: { url: "https://x/p.pkpass", platform: "apple" } });
    const r = await fetchWalletPassUrl("t1");
    expect(r).toEqual({ url: "https://x/p.pkpass", platform: "apple" });
  });

  it("addTicketToWallet: 백엔드 미구현 → unsupported", async () => {
    mockGet.mockRejectedValue(notImpl(404));
    const r = await addTicketToWallet("t1");
    expect(r.status).toBe("unsupported");
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  it("addTicketToWallet: 브라우저 열기 성공 → added", async () => {
    mockGet.mockResolvedValue({ data: { url: "https://x/p.pkpass", platform: "apple" } });
    mockOpenBrowser.mockResolvedValue({ type: "opened" });
    const r = await addTicketToWallet("t1");
    expect(r.status).toBe("added");
    expect(mockOpenBrowser).toHaveBeenCalledWith("https://x/p.pkpass", expect.any(Object));
  });

  it("addTicketToWallet: 사용자 취소 → cancelled", async () => {
    mockGet.mockResolvedValue({ data: { url: "https://x/p.pkpass", platform: "apple" } });
    mockOpenBrowser.mockResolvedValue({ type: "cancel" });
    const r = await addTicketToWallet("t1");
    expect(r.status).toBe("cancelled");
  });
});
