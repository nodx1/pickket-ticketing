import { describe, expect, it } from "vitest";

import { createTicketLinkToken, verifyTicketLinkToken } from "@/lib/ticket-link-token";

/**
 * 🔴 대회 둘째 날 아침에 이미 나간 링크가 전부 죽었다 (2026-08-21 실사고).
 *
 * 발급 시 만료를 `event_date + 1일` 로 잡았는데 `event_date` 는 **행사 시작일**이다.
 * 8/20~23 대회에서 8/21 07시에 만료 → 손님이 카톡 링크를 눌러도 접근권이 없어
 * 티켓 조회 화면으로 튕겼다.
 *
 * ⚠️ 이미 나간 링크는 토큰을 바꿀 수 없다. **검증 쪽 유예**가 유일한 복구 경로다.
 */
const DAY = 24 * 60 * 60 * 1000;

describe("🔴 이미 나간 링크를 살린다", () => {
  it("🔴 만료 직후 링크가 여전히 열린다 — 대회 중 손님이 갇히면 안 된다", () => {
    const t = createTicketLinkToken({ ticketNumber: "TKT-A", expiresAt: Date.now() - 2 * DAY });
    expect(verifyTicketLinkToken(t), "이미 나간 링크가 죽어 있다").not.toBeNull();
  });

  it("아직 안 지난 링크는 당연히 열린다", () => {
    const t = createTicketLinkToken({ ticketNumber: "TKT-A", expiresAt: Date.now() + DAY });
    expect(verifyTicketLinkToken(t)).not.toBeNull();
  });

  it("🔴 유예가 무제한은 아니다 — 대회가 끝나면 닫힌다", () => {
    const t = createTicketLinkToken({ ticketNumber: "TKT-A", expiresAt: Date.now() - 30 * DAY });
    expect(verifyTicketLinkToken(t), "옛 링크가 영원히 열려 있다").toBeNull();
  });

  it("서명이 틀리면 유예와 무관하게 거부한다", () => {
    const t = createTicketLinkToken({ ticketNumber: "TKT-A", expiresAt: Date.now() - DAY });
    const [enc] = t.split(".");
    expect(verifyTicketLinkToken(`${enc}.forged`)).toBeNull();
  });

  it("발급 만료는 **종료일** 기준이다 — 시작일로 잡으면 둘째 날에 죽는다", async () => {
    const { readFile } = await import("node:fs/promises");
    const s = await readFile("src/lib/notification/purchase-confirm-sender.ts", "utf8");
    expect(s).toMatch(/linkExpiresAt:\s*\(ev\.event_date_end/);
  });
});
