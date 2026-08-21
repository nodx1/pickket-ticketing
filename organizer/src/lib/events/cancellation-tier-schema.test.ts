import { describe, expect, it } from "vitest";

import { cancellationTiersSchema, MAX_CANCELLATION_TIERS } from "./cancellation-tier-schema";

/**
 * 🔴 환불 단계 **서버 검증**을 고정한다 (2026-07-31, 추가/삭제 UI 를 열면서).
 *
 * 이 화면은 `PATCH /api/events/{id}` 를 그냥 호출한다. UI 에서 버튼을 잠가도 요청은
 * 누구나 만들 수 있고, 아래 셋은 전부 **돈으로 이어진다**.
 *
 * ⚠️ 라우트가 쓰는 **바로 그 스키마 객체**를 import 한다 — 규칙을 여기서 다시 만들면
 *    라우트를 고쳐도 이 테스트는 자기 복제본을 보고 계속 초록이다.
 */
describe("환불 단계 서버 검증", () => {
  it("1단계는 통과 — KLPGA 가 이 형태다(0일 전/100%)", () => {
    expect(cancellationTiersSchema.safeParse([{ daysBefore: 0, feePct: 100 }]).success).toBe(true);
  });

  it("🔴 빈 배열 거부 — v2 가 NULL 로 바꾸고 플랫폼 기본단계가 조용히 적용된다", () => {
    const r = cancellationTiersSchema.safeParse([]);
    expect(r.success).toBe(false);
    expect(r.success === false && r.error.issues[0]?.message).toMatch(/최소 1단계/);
  });

  /**
   * 🔴 상한은 **숫자를 박아서** 확인한다.
   * 처음엔 `MAX_CANCELLATION_TIERS ± 1` 로 썼는데, 상수를 6→60 으로 바꾸는 뮤테이션이
   * **살아남았다** — 기대값이 상수를 따라 같이 움직였기 때문이다.
   * 상한은 "화면이 감당하는 줄 수" 라는 **외부 사실**이므로 테스트가 그 값을 알아야 한다.
   */
  const make = (n: number) => Array.from({ length: n }, (_, i) => ({ daysBefore: i, feePct: 10 }));

  it("상수가 6이다 — 늘리려면 공개 환불 카드 레이아웃을 먼저 확인할 것", () => {
    expect(MAX_CANCELLATION_TIERS).toBe(6);
  });

  it("6단계는 통과", () => {
    expect(cancellationTiersSchema.safeParse(make(6)).success).toBe(true);
  });

  it("🔴 7단계는 거부 — 환불 카드가 무너져 구매자가 규정을 못 읽는다", () => {
    expect(cancellationTiersSchema.safeParse(make(7)).success).toBe(false);
  });

  it("🔴 같은 daysBefore 두 번은 거부 — 어느 쪽이 약속인지 알 수 없고 React key 도 충돌한다", () => {
    const r = cancellationTiersSchema.safeParse([
      { daysBefore: 3, feePct: 50 },
      { daysBefore: 3, feePct: 80 },
    ]);
    expect(r.success).toBe(false);
    expect(r.success === false && r.error.issues[0]?.message).toMatch(/두 번/);
  });

  it("서로 다른 daysBefore 는 통과", () => {
    expect(
      cancellationTiersSchema.safeParse([
        { daysBefore: 7, feePct: 30 },
        { daysBefore: 0, feePct: 100 },
      ]).success,
    ).toBe(true);
  });

  it.each([
    [{ daysBefore: 0, feePct: 130 }, "수수료 100 초과"],
    [{ daysBefore: 0, feePct: -1 }, "수수료 음수"],
    [{ daysBefore: -1, feePct: 10 }, "일수 음수"],
    [{ daysBefore: 1.5, feePct: 10 }, "일수 소수"],
  ])("범위를 벗어나면 거부 — %o (%s)", (tier) => {
    expect(cancellationTiersSchema.safeParse([tier]).success).toBe(false);
  });
});

describe("라우트 배선", () => {
  it("🔴 PATCH 라우트가 이 스키마를 쓴다 — 규칙만 만들고 안 붙이면 소용없다", async () => {
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(
        new URL("../../app/api/events/[eventId]/route.ts", import.meta.url).pathname,
        "utf8",
      ),
    );
    expect(src).toMatch(/cancellationPolicy:\s*cancellationTiersSchema/);
  });
});
