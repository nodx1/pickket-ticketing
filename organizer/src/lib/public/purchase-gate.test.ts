/**
 * 🔴 구매 진입점이 잠기지 않는지 (2026-08-01 감사 P0-2).
 *
 * ⚠️ **이 파일이 증명하지 못하는 것**: 컴포넌트가 이 판정을 실제로 쓰는지.
 *    `@testing-library/react` 가 없어 렌더 검사를 못 한다(vitest include 도 `.ts` 뿐).
 *    배선은 아래 가드 테스트가 "부르고는 있는지" 까지만 보고, 실제 화면 동작은
 *    **배포 후 prod 에서 join POST 를 차단한 채 크롤해** 확인한다(요청서 §검증).
 */
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canEnterPurchase, purchaseGateLabel, shouldJoinQueue } from "./purchase-gate";

describe("대기열을 쓰지 않는 행사", () => {
  const off = { queueEnabled: false, soldOut: false };

  it("🔴 대기열 왕복을 보내지 않는다 — 실패할 요청이 없어야 한다", () => {
    expect(shouldJoinQueue(off)).toBe(false);
  });

  it("🔴 버튼이 처음부터 열려 있다 (admitted 가 없어도)", () => {
    expect(canEnterPurchase(off)).toBe(true);
    expect(canEnterPurchase({ ...off, admitted: false })).toBe(true);
  });

  it("잠금 문구가 없다 — '대기열 확인 중' 은 확인할 대기열이 없을 때 거짓말이다", () => {
    expect(purchaseGateLabel(off)).toBeNull();
  });
});

describe("대기열을 쓰는 행사 — 게이트는 그대로다", () => {
  const on = { queueEnabled: true, soldOut: false };

  it("🔴 입장 전에는 잠겨 있다 (게이트를 무력화한 것이 아니다)", () => {
    expect(canEnterPurchase(on)).toBe(false);
    expect(canEnterPurchase({ ...on, admitted: false })).toBe(false);
    expect(purchaseGateLabel(on)).toBe("구매 대기열 확인 중...");
  });

  it("왕복을 보낸다", () => {
    expect(shouldJoinQueue(on)).toBe(true);
  });

  it("입장(active)하면 열린다", () => {
    expect(canEnterPurchase({ ...on, admitted: true })).toBe(true);
    expect(purchaseGateLabel({ ...on, admitted: true })).toBeNull();
  });
});

describe("매진이 가장 강한 조건", () => {
  it("대기열 사용/입장 여부와 무관하게 잠긴다", () => {
    for (const queueEnabled of [true, false]) {
      for (const admitted of [true, false]) {
        expect(canEnterPurchase({ queueEnabled, soldOut: true, admitted })).toBe(false);
        expect(purchaseGateLabel({ queueEnabled, soldOut: true, admitted })).toBe("매진되었습니다");
      }
    }
  });

  it("매진이면 대기열 왕복도 보내지 않는다", () => {
    expect(shouldJoinQueue({ queueEnabled: true, soldOut: true })).toBe(false);
  });
});

/**
 * 배선 가드 — 두 컴포넌트가 `queueEnabled` 를 **받아서 쓰는지**.
 *
 * ⚠️ 이건 "부르고 있다" 까지만 본다. 렌더 결과는 보지 못한다(위 주석 참조).
 *    그래도 누가 prop 을 지우면 여기서 걸린다 — 그게 바로 이번 결함의 모양이었다.
 */
describe("배선 가드", () => {
  const DIR = path.join(__dirname, "..", "..", "app", "(public)", "e", "[eventSlug]", "_components");
  const read = (f: string) => fs.readFileSync(path.join(DIR, f), "utf8");

  it("§0 대상 파일을 실제로 읽었다 (경로 오타로 조용히 통과 방지)", () => {
    expect(read("queue-purchase-gate.tsx").length).toBeGreaterThan(500);
    expect(read("sticky-cta-bar.tsx").length).toBeGreaterThan(500);
  });

  it("🔴 두 구매 버튼 모두 이 판정 모듈을 실제로 쓴다", () => {
    // ⚠️ "파일에 queueEnabled 라는 글자가 있다" 로는 부족하다 — prop 선언만 남기고
    //    본문에서 무시해도 통과한다(실측: 그렇게 만들었더니 뮤테이션이 생존했다).
    //    **판정 함수를 부르는지**를 본다.
    for (const f of ["queue-purchase-gate.tsx", "sticky-cta-bar.tsx"]) {
      const src = read(f);
      expect(src, `${f} 가 판정 모듈을 import 하지 않는다`).toMatch(
        /from "@\/lib\/public\/purchase-gate"/,
      );
      expect(src, `${f} 가 queueEnabled 를 넘기지 않는다 — 대기열 미사용 행사에서 영구 잠긴다`).toMatch(
        /shouldJoinQueue\(\{[^}]*queueEnabled/,
      );
    }
  });

  it("🔴 대기열을 안 쓰면 QueueWaiting 을 렌더하지 않는다 (요청 자체를 막는다)", () => {
    const src = read("queue-purchase-gate.tsx");
    // `shouldJoinQueue(...)` 가 앞을 막고 있어야 한다 — 조건 없이 렌더하면 왕복이 되살아난다.
    expect(src, "조건 없이 렌더하면 왕복이 다시 살아난다").toMatch(
      /shouldJoinQueue\([^)]*\)[^]{0,80}?<QueueWaiting/,
    );
  });

  it("🔴 참여 실패 시 다시 시도할 수 있다", () => {
    const src = read("queue-waiting.tsx");
    expect(src, "재시도 수단이 없으면 손님은 구매를 포기하는 것 말고 할 게 없다").toContain("다시 시도");
    expect(src).toMatch(/onClick=\{retry\}/);
  });
});

/**
 * v2 → 뷰 매핑. 이 한 줄이 틀리면 위 판정이 전부 무의미해진다
 * (예: 항상 true 면 대기열이 켜진 행사에서도 왕복을 건너뛴다).
 */
describe("toGoEventView — queueEnabled 매핑", () => {
  it("🔴 v2 값을 그대로 따른다 — 없거나 null 이면 꺼진 것으로 본다", async () => {
    const { toGoEventView } = await import("@/lib/v2/event-view");
    type Ev = Parameters<typeof toGoEventView>[0];
    const base = { event_id: "e1", title: "t", slug: "s", status: "published" } as unknown as Ev;
    expect(toGoEventView({ ...base, queue_enabled: true }).queueEnabled).toBe(true);
    expect(toGoEventView({ ...base, queue_enabled: false }).queueEnabled).toBe(false);
    // v2 가 null 을 내려도 꺼진 것으로 본다 — 타입은 optional 이지만 실제 응답에 null 이 온다.
    expect(toGoEventView({ ...base, queue_enabled: null } as unknown as Ev).queueEnabled).toBe(false);
    expect(toGoEventView(base).queueEnabled, "미지정을 켜진 것으로 보면 안 된다").toBe(false);
  });
});
