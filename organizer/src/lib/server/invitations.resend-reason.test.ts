/**
 * 🔴 재발송 실패 **사유를 삼키지 않는다** (2026-08-04).
 *
 * 종전엔 v2 응답에서 `requeued` 만 읽고 `reason` 을 버렸다. 그래서 어떤 이유로 막혔든
 * 화면에는 "재발송할 수 없습니다(발권 미완)" 한 줄만 떴다.
 *
 * ⚠️ 사유가 다르면 **조치가 다르다** — 발권이 안 된 것이면 기다릴 일이고,
 *    수신자가 톡유저가 아니면 문자로 대체할 일이다. 뭉개면 주최자가 고를 수 없다.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";

const resendInvitationV2 = vi.fn();

vi.mock("@/lib/v2/commerce-client", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resendInvitationV2: (...args: unknown[]) => resendInvitationV2(...args),
}));

import { resendInvitation } from "./invitations";

const input = { accountId: "acc-1", eventId: "ev-1", invitationId: "inv-1" };

beforeEach(() => resendInvitationV2.mockReset());

describe("재발송 결과 전달", () => {
  it("성공하면 requeued 가 참이다", async () => {
    resendInvitationV2.mockResolvedValue({ requeued: true });
    await expect(resendInvitation(input)).resolves.toEqual({ requeued: true, reason: undefined });
  });

  it("🔴 v2 가 준 사유를 그대로 올린다 — 여기서 버리면 화면이 뭉갠다", async () => {
    resendInvitationV2.mockResolvedValue({ requeued: false, reason: "회수된 초대입니다" });
    await expect(resendInvitation(input)).resolves.toEqual({
      requeued: false,
      reason: "회수된 초대입니다",
    });
  });

  it("사유가 없으면 없는 대로 넘긴다 — 지어내지 않는다", async () => {
    resendInvitationV2.mockResolvedValue({ requeued: false });
    const r = await resendInvitation(input);
    expect(r.requeued).toBe(false);
    expect(r.reason).toBeUndefined();
  });

  it("초대 id 와 계정을 그대로 넘긴다", async () => {
    resendInvitationV2.mockResolvedValue({ requeued: true });
    await resendInvitation(input);
    expect(resendInvitationV2).toHaveBeenCalledWith("inv-1", "acc-1");
  });
});
