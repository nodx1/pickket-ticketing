/**
 * 🔴 발송 상태 3분화 — 「대기」와 「누락」을 가른다 (2026-08-04).
 *
 * 종전엔 둘이 **같은 픽셀**이었다. `status='issued'` + `sent_at=null` 만으로는
 * 「큐에서 순서 기다리는 중」과 「큐에 아예 안 들어감」이 구분되지 않는다.
 * 그래서 23시간 멈춘 5건이 「발권됨」으로만 떴다.
 *
 * ## 🔴 이 파일이 지키는 가장 중요한 것
 * `dispatchStatus` 의 **세 값이 다 다르다**:
 * ```
 * undefined  v2 구버전 — 정보가 없다   → 누락으로 단정하면 전 행이 빨개진다
 * null       큐 행이 없다             → 영원히 안 나간다. 즉시 경고
 * "queued"   순서 대기 중              → 정상
 * ```
 */
import { describe, expect, it } from "vitest";
import { classifyDispatch, dispatchLabel, needsAttention } from "./dispatch-state";

describe("🔴 undefined 와 null 은 뜻이 다르다", () => {
  it("🔴 undefined(구버전 v2)는 누락이 아니다 — 정보가 없을 뿐이다", () => {
    // 여기서 누락으로 읽으면 큐 정보를 안 주는 v2 에서 **모든 행이 빨개진다.**
    expect(classifyDispatch({ status: "issued" })).toEqual({ kind: "waiting" });
  });

  it("🔴 null(큐 행 없음)은 누락이다 — 아무도 보낼 예정이 아니다", () => {
    expect(classifyDispatch({ status: "issued", dispatchStatus: null })).toEqual({
      kind: "missing",
      why: "not_queued",
    });
  });

  it("🔴 둘을 뭉개면 안 된다 — 판정이 정반대다", () => {
    const older = classifyDispatch({ status: "issued" });
    const noQueue = classifyDispatch({ status: "issued", dispatchStatus: null });
    expect(older.kind).not.toBe(noQueue.kind);
  });
});

describe("큐 상태별 판정", () => {
  it("queued 는 정상 대기", () => {
    expect(classifyDispatch({ status: "issued", dispatchStatus: "queued" }).kind).toBe("waiting");
  });

  it("sending 은 발송 중 — 손대면 안 되는 상태다", () => {
    expect(classifyDispatch({ status: "issued", dispatchStatus: "sending" }).kind).toBe("sending");
  });

  it("🔴 sent 인데 발송 기록이 없으면 누락 — 이번 5건이 이 모양", () => {
    expect(classifyDispatch({ status: "issued", dispatchStatus: "sent", sentAt: null })).toEqual({
      kind: "missing",
      why: "queue_done_but_unsent",
    });
  });

  it("큐 실패는 실패로 본다", () => {
    expect(
      classifyDispatch({ status: "issued", dispatchStatus: "failed", failureReason: "3019" }),
    ).toEqual({ kind: "failed", reason: "3019" });
  });

  it("모르는 큐 상태는 경보하지 않는다 — 근거 없는 빨강은 진짜 빨강을 무디게 한다", () => {
    expect(classifyDispatch({ status: "issued", dispatchStatus: "brand_new" }).kind).toBe("waiting");
  });
});

describe("🔴 판정 순서 — 원장이 큐보다 먼저다", () => {
  it("🔴 원장이 '발송됨' 이면 큐가 비어 있어도 나간 것이다", () => {
    expect(classifyDispatch({ status: "sent", dispatchStatus: null }).kind).toBe("delivered");
  });

  it("🔴 열람·입장은 큐와 무관하게 완료다", () => {
    expect(classifyDispatch({ status: "viewed", dispatchStatus: null }).kind).toBe("delivered");
    expect(classifyDispatch({ status: "checked_in", dispatchStatus: null }).kind).toBe("delivered");
  });

  it("🔴 발송 시각이 있으면 큐가 뭐라 하든 완료다", () => {
    expect(
      classifyDispatch({ status: "issued", sentAt: "2026-08-04T01:00:00Z", dispatchStatus: null })
        .kind,
    ).toBe("delivered");
  });

  it("회수는 무엇보다 먼저다", () => {
    expect(classifyDispatch({ status: "revoked", dispatchStatus: null }).kind).toBe("revoked");
  });

  it("원장 실패는 사유를 그대로 담는다", () => {
    expect(
      classifyDispatch({ status: "failed", failureReason: "알림톡 미도달(3019): 톡유저가 아님" }),
    ).toEqual({ kind: "failed", reason: "알림톡 미도달(3019): 톡유저가 아님" });
  });

  it("사유가 비어 있으면 null 로 — 빈 문자열을 화면에 흘리지 않는다", () => {
    expect(classifyDispatch({ status: "failed", failureReason: "   " })).toEqual({
      kind: "failed",
      reason: null,
    });
  });
});

describe("라벨과 강조", () => {
  it("🔴 「발권됨」 하나로 뭉개지 않는다", () => {
    expect(dispatchLabel(classifyDispatch({ status: "issued", dispatchStatus: "queued" }))).toBe("발송 대기");
    expect(dispatchLabel(classifyDispatch({ status: "issued", dispatchStatus: null }))).toBe("발송 누락");
    expect(dispatchLabel(classifyDispatch({ status: "issued", dispatchStatus: "sending" }))).toBe("발송 중");
    expect(dispatchLabel(classifyDispatch({ status: "failed" }))).toBe("발송 실패");
  });

  it("완료·회수는 원장 라벨을 쓰므로 빈 문자열", () => {
    expect(dispatchLabel(classifyDispatch({ status: "sent" }))).toBe("");
    expect(dispatchLabel(classifyDispatch({ status: "revoked" }))).toBe("");
  });

  it("🔴 개입이 필요한 것만 빨강이다 — 정상 대기는 빨강이 아니다", () => {
    expect(needsAttention(classifyDispatch({ status: "issued", dispatchStatus: "queued" }))).toBe(false);
    expect(needsAttention(classifyDispatch({ status: "issued", dispatchStatus: "sending" }))).toBe(false);
    expect(needsAttention(classifyDispatch({ status: "issued", dispatchStatus: null }))).toBe(true);
    expect(needsAttention(classifyDispatch({ status: "failed" }))).toBe(true);
  });
});
