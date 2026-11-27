import { describe, expect, it } from "vitest";

import { ticketQrRefetchMs } from "@/lib/ticket-qr";

describe("내 티켓 QR 갱신 주기", () => {
  it("서버가 준 주기(30초)를 따른다 — 1초마다 받지 않는다", () => {
    expect(ticketQrRefetchMs({ expires_in_seconds: 60, refresh_in_seconds: 30 })).toBe(30_000);
  });

  it("주기가 없는 옛 서버는 만료 5초 전에 받는다", () => {
    expect(ticketQrRefetchMs({ expires_in_seconds: 15 })).toBe(10_000);
    expect(ticketQrRefetchMs({ expires_in_seconds: 5 })).toBe(1_000);
  });

  it("데이터가 없거나 만료 0이면 받지 않는다", () => {
    expect(ticketQrRefetchMs(null)).toBe(false);
    expect(ticketQrRefetchMs({ expires_in_seconds: 0 })).toBe(false);
  });
});
