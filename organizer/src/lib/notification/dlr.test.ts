/**
 * W5-MSG DLR 브리지 회귀 — provider 조회는 go, 원장 read/write 는 v2.
 *
 * 고정하는 것:
 *   ① go DB 를 전혀 쓰지 않는다(원장 v2 단일 정본).
 *   ② provider 가 확정한 도달/실패만 v2 로 되돌린다. 응답을 못 받으면 **아무것도 보내지 않는다**
 *      — 추측으로 failed 를 쓰면 실제 도달한 건이 실패로 기록된다.
 *   ③ unknown 은 자동 재발송하지 않는다. 확정 불가면 `unresolved` + 사유만 보내고 backoff /
 *      manual_review 승격 판정은 v2 가 소유한다.
 *   ④ 원장 호출 실패는 throw(fail-closed) — "대사할 게 없다"로 위장하지 않는다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  fetchDlrPending: vi.fn(),
  applyDlrResults: vi.fn(),
  claimUnknownDeliveries: vi.fn(),
  applyUnknownResults: vi.fn(),
  provider: vi.fn(),
  getPool: vi.fn(),
}));

vi.mock("@/lib/v2/messaging-ledger-client", () => ({
  fetchDlrPending: h.fetchDlrPending,
  applyDlrResults: h.applyDlrResults,
  claimUnknownDeliveries: h.claimUnknownDeliveries,
  applyUnknownResults: h.applyUnknownResults,
}));
vi.mock("@/lib/db/pool", () => ({ getPool: h.getPool }));
vi.mock("@/lib/env.runtime", () => ({ getRuntimeEnv: () => "svc-1" }));
vi.mock("@/lib/ncp/client", () => ({
  getNcpCreds: () => ({ accessKey: "a", secretKey: "s" }),
  ncpJsonRequest: h.provider,
  NCP_MAILER_HOST: "https://mailer.test",
  NCP_SENS_HOST: "https://sens.test",
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { reconcileDeliveries, reconcileUnknownDeliveries } from "./dlr";

beforeEach(() => {
  vi.clearAllMocks();
  h.applyDlrResults.mockResolvedValue({ delivered: 0, failed: 0 });
  h.applyUnknownResults.mockResolvedValue({
    checked: 0,
    resolved: 0,
    manual_review: 0,
    remaining: 0,
  });
});

afterEach(() => {
  h.provider.mockReset();
});

describe("reconcileDeliveries — DLR 브리지", () => {
  it("① go DB 를 잡지 않고 provider 확정분만 v2 로 반영한다", async () => {
    h.fetchDlrPending.mockResolvedValue([{ request_id: "req-1", channel: "sms" }]);
    h.provider.mockResolvedValue({
      messages: [
        { to: "010-1234-5678", status: "COMPLETED" },
        { to: "010-9999-0000", status: "FAILED", statusName: "차단" },
      ],
    });
    h.applyDlrResults.mockResolvedValue({ delivered: 1, failed: 1 });

    const result = await reconcileDeliveries(50);

    expect(h.getPool).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, delivered: 1, failed: 1 });
    expect(h.applyDlrResults).toHaveBeenCalledWith([
      { request_id: "req-1", contact: "01012345678", channel: "sms", state: "delivered" },
      {
        request_id: "req-1",
        contact: "01099990000",
        channel: "sms",
        state: "failed",
        detail: "차단",
      },
    ]);
  });

  it("② provider 응답을 못 받으면 원장에 아무것도 쓰지 않는다(추측 금지)", async () => {
    h.fetchDlrPending.mockResolvedValue([{ request_id: "req-1", channel: "kakao" }]);
    h.provider.mockRejectedValue(new Error("SENS 5xx"));

    const result = await reconcileDeliveries(50);

    expect(h.applyDlrResults).not.toHaveBeenCalled();
    expect(result).toEqual({ checked: 1, delivered: 0, failed: 0 });
  });

  it("아직 진행중(SENDING)인 건은 확정하지 않는다", async () => {
    h.fetchDlrPending.mockResolvedValue([{ request_id: "req-1", channel: "sms" }]);
    h.provider.mockResolvedValue({ messages: [{ to: "01011112222", status: "SENDING" }] });

    await reconcileDeliveries(50);
    expect(h.applyDlrResults).not.toHaveBeenCalled();
  });

  it("④ 원장 조회 실패는 throw — 빈 결과로 위장하지 않는다", async () => {
    h.fetchDlrPending.mockRejectedValue(new Error("ledger unreachable"));
    await expect(reconcileDeliveries(50)).rejects.toThrow("ledger unreachable");
  });
});

describe("reconcileUnknownDeliveries — unknown 대사", () => {
  it("③ 수신자까지 정확히 일치할 때만 확정하고, 아니면 unresolved + 사유", async () => {
    h.claimUnknownDeliveries.mockResolvedValue([
      {
        id: "d1",
        message_id: "m1",
        channel: "sms",
        contact: "01011112222",
        request_id: "req-1",
        reconcile_attempts: 0,
        created_at: new Date().toISOString(),
      },
      {
        id: "d2",
        message_id: "m1",
        channel: "sms",
        contact: "01033334444",
        request_id: "req-2",
        reconcile_attempts: 0,
        created_at: new Date().toISOString(),
      },
    ]);
    h.provider.mockImplementation(async (_host: string, _m: string, uri: string) =>
      uri.includes("req-1")
        ? { messages: [{ to: "01011112222", status: "COMPLETED" }] }
        : { messages: [{ to: "01099998888", status: "COMPLETED" }] },
    );
    h.applyUnknownResults.mockResolvedValue({
      checked: 2,
      resolved: 1,
      manual_review: 0,
      remaining: 1,
    });

    const summary = await reconcileUnknownDeliveries(50);

    expect(h.getPool).not.toHaveBeenCalled();
    expect(h.applyUnknownResults).toHaveBeenCalledWith([
      { delivery_id: "d1", outcome: "delivered", reason: null },
      // 수신자 불일치 → 확정 금지. 자동 재발송도 없다(이미 나갔을 수 있다).
      { delivery_id: "d2", outcome: "unresolved", reason: "sens_recipient_not_exactly_matched" },
    ]);
    expect(summary).toEqual({ checked: 2, resolved: 1, manualReview: 0, remaining: 1 });
  });

  it("request_id 가 없으면 provider 를 부르지 않고 사유만 남긴다", async () => {
    h.claimUnknownDeliveries.mockResolvedValue([
      {
        id: "d3",
        message_id: "m1",
        channel: "email",
        contact: "a@b.test",
        request_id: null,
        reconcile_attempts: 2,
        created_at: new Date().toISOString(),
      },
    ]);

    await reconcileUnknownDeliveries(50);

    expect(h.provider).not.toHaveBeenCalled();
    expect(h.applyUnknownResults).toHaveBeenCalledWith([
      { delivery_id: "d3", outcome: "unresolved", reason: "provider_request_id_missing" },
    ]);
  });

  it("claim 이 비면 v2 write 없이 종료(불필요한 왕복 금지)", async () => {
    h.claimUnknownDeliveries.mockResolvedValue([]);
    const summary = await reconcileUnknownDeliveries(50);
    expect(summary).toEqual({ checked: 0, resolved: 0, manualReview: 0, remaining: 0 });
    expect(h.applyUnknownResults).not.toHaveBeenCalled();
  });

  it("④ claim 실패는 throw — 조용히 0건으로 끝내지 않는다", async () => {
    h.claimUnknownDeliveries.mockRejectedValue(new Error("ledger down"));
    await expect(reconcileUnknownDeliveries(50)).rejects.toThrow("ledger down");
  });
});
