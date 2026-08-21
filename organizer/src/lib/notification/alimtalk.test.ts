import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 🔴 알림톡 **발송 성패 판정** 테스트.
 *
 * 왜 이 파일이 따로 필요한가 — `invitations.test.ts` 는 `sendAlimtalkBatch` 를 통째로
 * 모킹한다. 그래서 판정 로직(접수코드·전달코드 해석)에 테스트가 **닿지 않았고**,
 * 뮤테이션으로 확인해보니 "모든 수신자를 ok 로" 바꿔도 21건이 전부 초록불이었다.
 *
 * 판정을 뒤집는 뮤테이션이 여기서 죽어야 한다.
 *
 * 배경 실측(2026-07-28, 실계정 발송):
 *   버튼 링크가 승인 템플릿과 어긋난 발송 →
 *     requestStatusCode = "A000"  (접수 성공 — 옛 코드가 본 유일한 값)
 *     messageStatusCode  = "3027" (전달 실패 — 조회해야 보임)
 *   즉 **카톡이 도착하지 않았는데 원장에는 발송됨**으로 남았다.
 */

const h = vi.hoisted(() => ({ ncpJsonRequest: vi.fn() }));

vi.mock("@/lib/ncp/client", () => ({
  ncpJsonRequest: (...a: unknown[]) => h.ncpJsonRequest(...a),
  NCP_SENS_HOST: "https://sens.apigw.ntruss.com",
  getNcpCreds: () => ({ accessKey: "ak", secretKey: "sk" }),
}));

import {
  fetchAlimtalkDeliveryStatus,
  resolveRecipientResults,
  sendAlimtalk,
} from "./alimtalk";

beforeEach(() => {
  h.ncpJsonRequest.mockReset();
  process.env.SENS_ALIMTALK_SERVICE_ID = "svc";
  process.env.SENS_ALIMTALK_CHANNEL_ID = "@pickket";
  process.env.NCP_ACCESS_KEY = "ak";
  process.env.NCP_SECRET_KEY = "sk";
});

describe("resolveRecipientResults — 수신자별 접수 판정", () => {
  it("A000 은 접수 성공", () => {
    const [r] = resolveRecipientResults(["010-1111-2222"], [
      { to: "01011112222", requestStatusCode: "A000", requestStatusDesc: "성공" },
    ]);
    expect(r).toMatchObject({ to: "01011112222", ok: true, code: "A000" });
  });

  it("🔴 A000 이 아니면 실패 — 이 판정이 무너지면 미도달이 '발송됨'으로 기록된다", () => {
    const [r] = resolveRecipientResults(["01011112222"], [
      { to: "01011112222", requestStatusCode: "3027", requestStatusDesc: "버튼 내용이 템플릿과 일치 하지 않음" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.code).toBe("3027");
    expect(r.desc).toContain("버튼");
  });

  it("🔴 응답에 없는 수신자는 **성공으로 보지 않는다**(fail-closed)", () => {
    // SENS 가 일부만 돌려주는 경우를 "성공"으로 접으면 정확히 이 결함이 재발한다.
    const [r] = resolveRecipientResults(["01099998888"], [
      { to: "01011112222", requestStatusCode: "A000" },
    ]);
    expect(r.ok).toBe(false);
    expect(r.desc).toContain("수신자가 없습니다");
  });

  it("messages 자체가 없으면 전원 실패", () => {
    const rs = resolveRecipientResults(["01011112222", "01033334444"], undefined);
    expect(rs.every((r) => !r.ok)).toBe(true);
  });

  it("하이픈·공백이 섞인 번호도 같은 수신자로 매칭한다", () => {
    const [r] = resolveRecipientResults(["010 1111-2222"], [
      { to: "01011112222", requestStatusCode: "A000" },
    ]);
    expect(r.ok).toBe(true);
  });

  it("부분 실패 — 요청 순서를 유지한 채 개별 판정한다", () => {
    const rs = resolveRecipientResults(["01011112222", "01033334444"], [
      { to: "01011112222", requestStatusCode: "A000" },
      { to: "01033334444", requestStatusCode: "3027" },
    ]);
    expect(rs.map((r) => r.ok)).toEqual([true, false]);
  });
});

describe("sendAlimtalk — 단건 발송", () => {
  it("접수 성공이면 성공을 반환한다", async () => {
    h.ncpJsonRequest.mockResolvedValue({
      requestId: "req-1",
      messages: [{ to: "01011112222", requestStatusCode: "A000" }],
    });
    const res = await sendAlimtalk({ to: "01011112222", templateCode: "T1", message: "본문" });
    expect(res).toMatchObject({ success: true, simulated: false, messageId: "req-1" });
  });

  it("🔴 접수 거부면 **예외를 던진다** — 옛 코드는 HTTP 200 만 보고 성공을 반환했다", async () => {
    h.ncpJsonRequest.mockResolvedValue({
      requestId: "req-2",
      messages: [{ to: "01011112222", requestStatusCode: "3027", requestStatusDesc: "버튼 불일치" }],
    });
    await expect(
      sendAlimtalk({ to: "01011112222", templateCode: "T1", message: "본문" }),
    ).rejects.toThrow("3027");
  });

  it("🔴 응답에 수신자 결과가 없어도 성공으로 넘기지 않는다", async () => {
    h.ncpJsonRequest.mockResolvedValue({ requestId: "req-3" });
    await expect(
      sendAlimtalk({ to: "01011112222", templateCode: "T1", message: "본문" }),
    ).rejects.toThrow();
  });
});

describe("fetchAlimtalkDeliveryStatus — 전달 상태 대사", () => {
  it("0000 은 실제 도달", async () => {
    h.ncpJsonRequest.mockResolvedValue({
      messages: [{ to: "01011112222", messageStatusCode: "0000", messageStatusName: "success" }],
    });
    const [r] = await fetchAlimtalkDeliveryStatus("req-1");
    expect(r).toMatchObject({ to: "01011112222", delivered: true, code: "0000" });
  });

  it("🔴 3027 은 미도달 — 접수는 성공이었어도 카카오가 전달을 거부한 상태다", async () => {
    h.ncpJsonRequest.mockResolvedValue({
      messages: [{ to: "01011112222", messageStatusCode: "3027", messageStatusDesc: "버튼 내용이 템플릿과 일치 하지 않음" }],
    });
    const [r] = await fetchAlimtalkDeliveryStatus("req-1");
    expect(r.delivered).toBe(false);
    expect(r.desc).toContain("버튼");
  });

  it("🔴 전달코드가 없으면 도달로 보지 않는다(fail-closed)", async () => {
    h.ncpJsonRequest.mockResolvedValue({ messages: [{ to: "01011112222" }] });
    const [r] = await fetchAlimtalkDeliveryStatus("req-1");
    expect(r.delivered).toBe(false);
  });

  it("조회가 실패하면 예외를 올린다 — '모름'을 도달로 접지 않는다", async () => {
    h.ncpJsonRequest.mockRejectedValue(new Error("NCP API 500"));
    await expect(fetchAlimtalkDeliveryStatus("req-1")).rejects.toThrow();
  });
});
