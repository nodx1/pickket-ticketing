import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import { CheckoutTokenExpiredError } from "@/lib/checkout/token-expired";

/**
 * 🔴 만료 토큰 복구 (2026-08-08 실장애 — 손님이 영구히 결제 불가)
 *
 * ```
 * 체크아웃 진입   토큰(UUID)이 localStorage 에 **영구** 저장된다
 * 결제 진행       결제창이 열리기 **전에** v2 주문이 생긴다 (external_ref = 그 토큰)
 * 이탈            PENDING 으로 남는다
 * 30분 뒤         EXPIRED (터미널)
 * 다시 방문       같은 토큰 → dedup 이 만료 주문을 돌려줌 → 결제 거절
 *                 🔴 새로고침해도 그대로. 같은 브라우저에서는 영영 결제 못 한다
 * ```
 *
 * 세 층이 다 있어야 풀린다: v2 가 코드를 내고 · go 가 4xx 로 전달하고 · 화면이 토큰을 버린다.
 * 한 층이라도 빠지면 손님 화면은 그대로다.
 */

/** 재시도 **횟수**를 센다 — "복구를 시도한다" 로는 무한 재시도를 못 잡는다. */
function makeInitiator(failTimes: number) {
  let calls = 0;
  return {
    calls: () => calls,
    async run() {
      calls += 1;
      if (calls <= failTimes) {
        throw new CheckoutTokenExpiredError("이전 주문이 만료되었습니다");
      }
      return { orderId: "o1", shortId: "s1" };
    },
  };
}

/** 화면의 래퍼와 **같은 규칙** — 실패 시 토큰을 버리고 딱 한 번 다시 시도한다. */
async function withTokenRecovery<T>(
  run: () => Promise<T>,
  invalidate: () => void,
): Promise<T> {
  try {
    return await run();
  } catch (err: unknown) {
    if (!(err instanceof CheckoutTokenExpiredError)) throw err;
    invalidate();
    return await run();
  }
}

describe("🔴 토큰 복구 — 1회만", () => {
  it("한 번 실패하면 토큰을 버리고 다시 시도해 성공한다", async () => {
    const it0 = makeInitiator(1);
    let invalidated = 0;
    const r = await withTokenRecovery(() => it0.run(), () => { invalidated += 1; });
    expect(r.orderId).toBe("o1");
    expect(it0.calls(), "재시도가 정확히 1회여야 한다").toBe(2);
    expect(invalidated).toBe(1);
  });

  it("🔴 두 번째도 실패하면 그대로 올린다 — 무한 재시도 금지", async () => {
    // 무한 재시도는 실패할 때마다 v2 에 **새 주문**을 만든다. 대시보드가 유령 주문으로
    // 덮이고 최악의 경우 재고를 갉는다.
    const it0 = makeInitiator(99);
    await expect(
      withTokenRecovery(() => it0.run(), () => {}),
    ).rejects.toBeInstanceOf(CheckoutTokenExpiredError);
    expect(it0.calls(), "🔴 2회를 넘겨 시도했다").toBe(2);
  });

  it("다른 오류는 재시도하지 않는다 (토큰 문제가 아니다)", async () => {
    let calls = 0;
    let invalidated = 0;
    await expect(
      withTokenRecovery(async () => {
        calls += 1;
        throw new Error("재고 부족");
      }, () => { invalidated += 1; }),
    ).rejects.toThrow("재고 부족");
    expect(calls).toBe(1);
    expect(invalidated, "엉뚱한 오류에 토큰을 버리면 dedup 보호가 사라진다").toBe(0);
  });
});

/**
 * 실제 화면·라우트가 이 규칙대로 배선돼 있는가 — **관계**로 본다.
 * ⚠️ 컴포넌트는 라우팅·주문 API·결제위젯이 딸려 와 단위 실행이 어렵다.
 */
async function source(rel: string): Promise<string> {
  const raw = await readFile(new URL(rel, import.meta.url), "utf8");
  return raw
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*"))
    .join("\n");
}

const STEP =
  "../../app/(public)/e/[eventSlug]/checkout/payment/_components/checkout-payment-step.tsx";
const ROUTE = "../../app/api/checkout/initiate/route.ts";

describe("🔴 go 라우트 — 4xx + 코드로 내려보낸다", () => {
  it("🔴 ORDER_NOT_REPLAYABLE 을 5xx 로 뭉개지 않는다", async () => {
    const s = await source(ROUTE);
    // 코드 판정 → 4xx + 코드. 셋이 한 덩어리로 맞아야 통과한다.
    expect(s).toMatch(
      /v2ErrorCode\(err\)\s*===\s*"ORDER_NOT_REPLAYABLE"[\s\S]{0,400}?errorResponse\(\s*[\s\S]{0,120}?,\s*4\d\d,\s*\n?\s*"ORDER_NOT_REPLAYABLE"/,
    );
  });

  it("나머지 prepare/생성 실패는 지금대로 5xx (그건 진짜 서버 문제)", async () => {
    expect(await source(ROUTE)).toMatch(/errorResponse\([\s\S]{0,120}?,\s*50\d\)/);
  });
});

describe("🔴 화면 — 코드를 받으면 토큰을 버리고 1회 재시도", () => {
  it("🔴 응답의 code 로 분기한다 (문구 파싱 금지)", async () => {
    const s = await source(STEP);
    expect(s).toMatch(/payload\.code\s*===\s*ORDER_NOT_REPLAYABLE/);
    expect(s).toMatch(/throw new CheckoutTokenExpiredError\(/);
  });

  it("🔴 복구 래퍼가 토큰을 버리고 **한 번만** 다시 부른다", async () => {
    const s = await source(STEP);
    const m = s.match(/async function initiateOrderWithTokenRecovery[\s\S]*?\n  \}/);
    expect(m, "복구 래퍼를 못 찾았다").not.toBeNull();
    const fn = m![0];
    expect(fn).toMatch(/invalidateCheckoutToken\(\)/);
    expect(fn).not.toMatch(/while|for\s*\(|retry\s*</); // 루프 금지
    // initiateOrder 호출이 정확히 두 번(최초 + 재시도 1회)
    expect(fn.match(/await initiateOrder\(/g) ?? []).toHaveLength(2);
  });

  it("🔴 실제 결제 경로가 래퍼를 쓴다 — 래퍼만 만들고 안 쓰면 아무 일도 안 일어난다", async () => {
    const s = await source(STEP);
    const direct = (s.match(/=\s*await initiateOrder\(/g) ?? []).length;
    const viaWrapper = (s.match(/await initiateOrderWithTokenRecovery\(/g) ?? []).length;
    expect(viaWrapper, "호출부가 래퍼를 안 쓴다").toBeGreaterThanOrEqual(2);
    expect(direct, "래퍼를 우회하는 직접 호출이 남아 있다").toBe(0);
  });
});
