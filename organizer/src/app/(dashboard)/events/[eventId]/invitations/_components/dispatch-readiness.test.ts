import { describe, expect, it } from "vitest";

import { detectStalledDispatch } from "./dispatch-readiness";

/**
 * 🔴 발송 멈춤 감지.
 *
 * 실측 사고(2026-07-28): 발송은 1분 주기 크론이 대기열을 비우며 일어나는데 그 크론이
 * 서버 crontab 에 **등록돼 있지 않았다**(14줄 중 dispatch-invitations 0건).
 * 화면은 "발권 완료 · 잠시 후 순차 발송" 이라고만 안내해서, 주최자는 보냈다고 믿고
 * 수신자는 아무것도 못 받는 상태가 무기한 유지된다.
 *
 * ## 🔴 2026-08-04 — 두 갈래를 가른다
 * 종전엔 `status === "issued"` 를 전부 「멈춤」으로 셌다. 큐에서 **정상 대기 중**인 건까지
 * 멈춤으로 보였다. 이제 v2 가 큐 상태를 주므로 나눈다:
 * ```
 * 누락  큐에 없다 / 큐는 끝났는데 발송 기록이 없다   → 시간 무관 즉시 경고
 * 대기  큐에서 순서를 기다린다                      → 10분 넘을 때만 경고
 * ```
 *
 * ⚠️ 좁히면서 **정상 대기가 오래 걸리는 경우를 놓치면 안 된다.** 아래 「구버전 v2」
 *    블록이 그 방어선이다 — 큐 정보가 없어도 옛 동작이 그대로 살아 있어야 한다.
 */

const now = Date.parse("2026-07-29T12:00:00Z");
const ago = (minutes: number) => new Date(now - minutes * 60_000).toISOString();

describe("구버전 v2 — 큐 정보가 없어도 옛 방어선이 산다", () => {
  // 🔴 dispatchStatus 를 **안 준다**(undefined). 2026-07-28 사고 당시의 응답 모양이다.
  it("대기 건이 없으면 정상", () => {
    const r = detectStalledDispatch(
      [{ status: "sent", createdAt: ago(120) }, { status: "viewed", createdAt: ago(90) }],
      now,
    );
    expect(r.stalled).toBe(false);
    expect(r.waitingCount).toBe(0);
    expect(r.missingCount).toBe(0);
  });

  it("방금 발권한 건은 멈춘 게 아니다 — 크론 주기를 기다리는 정상 상태", () => {
    const r = detectStalledDispatch([{ status: "issued", createdAt: ago(1) }], now);
    expect(r.stalled).toBe(false);
    expect(r.waitingCount).toBe(1);
  });

  it("🔴 10분 넘게 미발송이면 멈춘 것으로 본다", () => {
    const r = detectStalledDispatch([{ status: "issued", createdAt: ago(35) }], now);
    expect(r.stalled).toBe(true);
    expect(r.waitingStalled).toBe(true);
    expect(r.waitingOldestMinutes).toBe(35);
  });

  it("🔴 가장 오래된 건을 기준으로 판정한다 — 최근 건에 가려지면 안 된다", () => {
    const r = detectStalledDispatch(
      [
        { status: "issued", createdAt: ago(1) },
        { status: "issued", createdAt: ago(600) },
        { status: "sent", createdAt: ago(900) },
      ],
      now,
    );
    expect(r.stalled).toBe(true);
    expect(r.waitingCount).toBe(2);
    expect(r.waitingOldestMinutes).toBe(600);
  });

  it("발송·열람·입장·회수 완료분은 대기로 세지 않는다", () => {
    const r = detectStalledDispatch(
      [
        { status: "sent", createdAt: ago(500) },
        { status: "viewed", createdAt: ago(500) },
        { status: "checked_in", createdAt: ago(500) },
        { status: "revoked", createdAt: ago(500) },
      ],
      now,
    );
    expect(r.waitingCount).toBe(0);
    expect(r.stalled).toBe(false);
  });

  it("날짜가 깨진 행이 섞여도 판정이 죽지 않는다", () => {
    const r = detectStalledDispatch(
      [
        { status: "issued", createdAt: "not-a-date" },
        { status: "issued", createdAt: ago(30) },
      ],
      now,
    );
    expect(r.stalled).toBe(true);
    expect(r.waitingOldestMinutes).toBe(30);
  });

  it("모든 대기 건의 날짜가 깨졌으면 멈춤으로 단정하지 않는다", () => {
    // 근거가 없으면 경고하지 않는다 — 거짓 경보는 진짜 경보를 무디게 만든다.
    const r = detectStalledDispatch([{ status: "issued", createdAt: "" }], now);
    expect(r.stalled).toBe(false);
    expect(r.waitingCount).toBe(1);
  });
});

describe("🔴 큐 정보가 오면 — 누락과 대기를 가른다", () => {
  it("🔴 큐 행이 아예 없으면 즉시 누락이다 — 방금 발권했어도", () => {
    // 기다린다고 나가지 않는다. 시간 조건을 걸면 영영 안 보인다.
    const r = detectStalledDispatch(
      [{ status: "issued", createdAt: ago(1), dispatchStatus: null }],
      now,
    );
    expect(r.missingCount).toBe(1);
    expect(r.stalled).toBe(true);
    expect(r.waitingCount).toBe(0);
  });

  it("🔴 큐는 '보냈다' 는데 발송 기록이 없으면 누락이다 — 이번 5건이 이 모양", () => {
    const r = detectStalledDispatch(
      [{ status: "issued", createdAt: ago(1370), dispatchStatus: "sent", sentAt: null }],
      now,
    );
    expect(r.missingCount).toBe(1);
    expect(r.stalled).toBe(true);
  });

  it("🔴 큐에서 정상 대기 중인 건은 누락이 아니다 — 종전엔 이것까지 멈춤으로 셌다", () => {
    const r = detectStalledDispatch(
      [{ status: "issued", createdAt: ago(2), dispatchStatus: "queued" }],
      now,
    );
    expect(r.missingCount).toBe(0);
    expect(r.waitingCount).toBe(1);
    expect(r.stalled).toBe(false);
  });

  it("🔴 대기가 오래되면 여전히 경고한다 — 좁히면서 이걸 잃으면 안 된다", () => {
    const r = detectStalledDispatch(
      [{ status: "issued", createdAt: ago(200), dispatchStatus: "queued" }],
      now,
    );
    expect(r.missingCount).toBe(0);
    expect(r.waitingStalled).toBe(true);
    expect(r.stalled).toBe(true);
  });

  it("발송 중(sending)은 대기로 본다 — 손댈 상태가 아니다", () => {
    const r = detectStalledDispatch(
      [{ status: "issued", createdAt: ago(1), dispatchStatus: "sending" }],
      now,
    );
    expect(r.missingCount).toBe(0);
    expect(r.stalled).toBe(false);
  });

  it("큐 실패는 누락이 아니라 실패다 — 사유를 보여주는 경로가 따로 있다", () => {
    const r = detectStalledDispatch(
      [{ status: "issued", createdAt: ago(100), dispatchStatus: "failed" }],
      now,
    );
    expect(r.missingCount).toBe(0);
    expect(r.waitingCount).toBe(0);
  });

  it("🔴 섞여 있으면 각자 자기 칸으로 센다", () => {
    const r = detectStalledDispatch(
      [
        { status: "issued", createdAt: ago(1370), dispatchStatus: "sent", sentAt: null }, // 누락
        { status: "issued", createdAt: ago(1370), dispatchStatus: null }, // 누락
        { status: "issued", createdAt: ago(200), dispatchStatus: "queued" }, // 오래 대기
        { status: "issued", createdAt: ago(1), dispatchStatus: "queued" }, // 정상 대기
        { status: "sent", createdAt: ago(900), dispatchStatus: "sent", sentAt: ago(890) }, // 완료
      ],
      now,
    );
    expect(r.missingCount).toBe(2);
    expect(r.waitingCount).toBe(2);
    expect(r.waitingStalled).toBe(true);
    expect(r.waitingOldestMinutes).toBe(200);
  });

  it("🔴 이미 발송된 행은 큐 상태와 무관하게 누락이 아니다", () => {
    // 큐에 옛 흔적이 남아 있어도 원장이 "나갔다" 고 하면 나간 것이다.
    const r = detectStalledDispatch(
      [{ status: "sent", createdAt: ago(500), dispatchStatus: null, sentAt: ago(490) }],
      now,
    );
    expect(r.missingCount).toBe(0);
    expect(r.stalled).toBe(false);
  });
});

/**
 * 🔴 2026-08-04 실사고 — **재발송했는데 경보가 안 꺼졌다.**
 *
 * 발주처 초대권 5건이 23시간 막혀 있었다. 재발송 버튼을 눌러 **실제로 발송까지 됐는데**
 * (큐 queued→sent · epoch 0→1 · 14:02 발송 완료) 배너는 「1470분째 대기」 그대로였다.
 * 대기 경과를 **초대권 생성 시각**으로 재고 있었기 때문이다.
 *
 * ⚠️ 왜 위험한가: 주최자는 "안 먹혔나" 하고 **한 번 더 누른다.**
 *    그러면 손님이 초대권을 두 장 받는다. 알림톡은 회수할 수 없다.
 */
describe("🔴 대기 경과는 큐 시각으로 잰다 — 초대권 생성 시각이 아니다", () => {
  it("🔴 어제 발급된 건을 방금 큐에 넣었으면 대기 0분이다 (재발송 직후)", () => {
    const r = detectStalledDispatch(
      [
        {
          status: "issued",
          createdAt: ago(1470), // 어제 발급 — 종전엔 이 값으로 쟀다
          dispatchStatus: "queued",
          dispatchUpdatedAt: ago(1), // 방금 다시 큐에 들어갔다
        },
      ],
      now,
    );
    expect(r.waitingOldestMinutes).toBe(1);
    expect(r.waitingStalled).toBe(false);
    expect(r.stalled, "재발송했는데 경보가 남으면 주최자가 또 누른다").toBe(false);
  });

  it("큐에 들어간 지 오래면 여전히 경고한다 — 발급이 방금이어도", () => {
    const r = detectStalledDispatch(
      [
        {
          status: "issued",
          createdAt: ago(1), // 발급은 방금
          dispatchStatus: "queued",
          dispatchUpdatedAt: ago(200), // 🔴 큐에서 200분째 안 나감
        },
      ],
      now,
    );
    expect(r.waitingOldestMinutes).toBe(200);
    expect(r.waitingStalled, "큐가 멈춘 것을 놓치면 안 된다").toBe(true);
  });

  it("⚠️ 큐 시각이 없으면 종전대로 초대권 생성 시각으로 잰다 (구버전 v2 방어선)", () => {
    const r = detectStalledDispatch(
      [{ status: "issued", createdAt: ago(200), dispatchStatus: "queued" }],
      now,
    );
    expect(r.waitingOldestMinutes).toBe(200);
    expect(r.waitingStalled).toBe(true);
  });

  it("큐 시각이 빈 문자열이어도 생성 시각으로 되돌아간다", () => {
    const r = detectStalledDispatch(
      [
        {
          status: "issued",
          createdAt: ago(200),
          dispatchStatus: "queued",
          dispatchUpdatedAt: "   ",
        },
      ],
      now,
    );
    expect(r.waitingOldestMinutes).toBe(200);
    expect(r.waitingStalled).toBe(true);
  });
});
