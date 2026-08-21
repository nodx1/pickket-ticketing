import { describe, expect, it } from "vitest";

import { judgeCancellation } from "./cancellation-fee";
import { toRefundPolicyLines, toRefundPolicySummary } from "./policy-display";

/**
 * 🔴 화면 문구와 **실제 지급**이 갈리지 않게 한다.
 *
 * 두 번 갈렸다:
 *   2026-07-31 오전 — 하드코딩 문구(화면 80% / 실지급 50%)
 *   2026-07-31 오후 — **내가 판정 규칙만 바꾸고 라벨을 그대로 뒀다**(코덱스 감사에서 확정).
 *                     `daysBefore:7` 을 "D-7 이전" 으로 표시했는데 실제는 "D-7 **이내**" 였다.
 *                     금액은 맞아도 **적용 구간이 반대**면 틀린 고지다.
 *
 * ⟹ 아래 "라벨 ↔ 판정 일치" 블록이 핵심이다. 라벨을 사람이 읽어 검사하는 게 아니라,
 *    **각 구간의 대표 시각을 실제 판정 함수에 넣어** 라벨이 약속한 환불율이 나오는지 본다.
 */

const TIERS = [
  { daysBefore: 30, feePct: 0 },
  { daysBefore: 7, feePct: 30 },
  { daysBefore: 3, feePct: 50 },
  { daysBefore: 1, feePct: 80 },
  { daysBefore: 0, feePct: 100 },
];

describe("toRefundPolicyLines — 실제 적용 구간을 라벨로", () => {
  it("🔴 구간이 겹치지 않게 이어 붙는다", () => {
    expect(toRefundPolicyLines(TIERS).map((l) => `${l.label} ${l.refundPct}%`)).toEqual([
      "D-8 이전 100%",
      "D-7 ~ D-4 70%",
      "D-3 ~ D-2 50%",
      "D-1 20%",
      "행사 당일 0%",
    ]);
  });

  it("가장 바깥 구간이 전액이 아니면 '그 이전' 줄을 앞에 붙인다", () => {
    // D-7 이내 30% 수수료만 있으면, D-8 이전은 어느 단계에도 안 걸려 **전액 환불**이다.
    // 그 줄이 없으면 구매자는 "언제부터 전액인지" 를 알 수 없다.
    expect(toRefundPolicyLines([{ daysBefore: 7, feePct: 30 }]).map((l) => `${l.label} ${l.refundPct}%`)).toEqual([
      "D-8 이전 100%",
      "D-7 이내 70%",
    ]);
  });

  /**
   * 🔴 바깥 단계가 이미 전액이면 **그 위쪽도 전액**이다(어느 단계에도 안 걸리면 100%).
   *    `D-30 ~ D-8` 로 끊어 적으면 "D-40 은 다르다" 로 읽힌다 — 실제로는 같다.
   *    (2026-07-31 자체 전수대조에서 발견: [30:0, 2:60, 0:100] 의 남은 31일이
   *     어떤 라벨 구간에도 안 속했다)
   */
  it("가장 바깥이 전액이면 상한을 열어 둔다 — 중복 줄도 안 붙인다", () => {
    expect(toRefundPolicyLines(TIERS)[0]!.label).toBe("D-8 이전");
    expect(toRefundPolicyLines(TIERS).filter((l) => l.refundPct === 100)).toHaveLength(1);
  });

  it("단계가 하나이고 전액이면 '언제든'", () => {
    expect(toRefundPolicyLines([{ daysBefore: 30, feePct: 0 }]).map((l) => l.label)).toEqual(["언제든"]);
  });

  it("KLPGA 현재 값 — 한 단계", () => {
    expect(toRefundPolicyLines([{ daysBefore: 0, feePct: 100 }]).map((l) => `${l.label} ${l.refundPct}%`)).toEqual([
      "D-1 이전 100%",
      "행사 당일 0%",
    ]);
  });

  it("입력 순서를 신뢰하지 않는다", () => {
    const shuffled = [TIERS[3]!, TIERS[0]!, TIERS[4]!, TIERS[2]!, TIERS[1]!];
    expect(toRefundPolicyLines(shuffled).map((l) => l.label)).toEqual(
      toRefundPolicyLines(TIERS).map((l) => l.label),
    );
  });
});

/**
 * 🔴 여기가 이 파일의 존재 이유다. 라벨이 약속한 환불율을, **실제 판정 함수**에
 * 그 구간의 시각을 넣어 확인한다. 라벨만 바꾸거나 판정만 바꾸면 여기서 깨진다.
 */
describe("라벨 ↔ 판정 일치", () => {
  const EVENT = "2026-08-19T22:00:00.000Z"; // 8/20 07:00 KST → 기준은 8/20 00:00 KST
  /** 행사일 00시로부터 `daysLeft` 일 남은 시각(그 구간 한가운데). */
  const at = (daysLeft: number) => new Date(Date.UTC(2026, 7, 19, 15) - (daysLeft - 0.5) * 86400000);

  it.each([
    [40, 100, "어느 단계에도 안 걸림"],
    [20, 100, "D-30 ~ D-8"],
    [8, 100, "D-30 ~ D-8 하단"],
    [7, 70, "D-7 ~ D-4 상단"],
    [4, 70, "D-7 ~ D-4 하단"],
    [3, 50, "D-3 ~ D-2 상단"],
    [2, 50, "D-3 ~ D-2 하단"],
    [1, 20, "D-1"],
    [0, 0, "행사 당일"],
  ])("남은 %i일 → 환불 %i%% (%s)", (daysLeft, expected) => {
    expect(judgeCancellation(TIERS, EVENT, at(daysLeft)).refundPct).toBe(expected);
  });

  it("🔴 표시 목록의 환불율 집합이 실제 판정에서 나오는 값들과 같다", () => {
    const shown = new Set(toRefundPolicyLines(TIERS).map((l) => l.refundPct));
    const actual = new Set([40, 20, 8, 7, 4, 3, 2, 1, 0].map((d) => judgeCancellation(TIERS, EVENT, at(d)).refundPct));
    expect([...shown].sort((a, b) => a - b)).toEqual([...actual].sort((a, b) => a - b));
  });
});

describe("경계·방어", () => {
  it.each([null, undefined, []])("규정이 없으면(%o) 빈 목록 — 기본값을 지어내지 않는다", (v) => {
    expect(toRefundPolicyLines(v as null)).toEqual([]);
    expect(toRefundPolicySummary(v as null)).toBe("환불 규정 미설정");
  });

  it("깨진 원소는 버린다", () => {
    const lines = toRefundPolicyLines([
      { daysBefore: 7, feePct: 30 },
      { daysBefore: Number.NaN, feePct: 10 },
    ] as never);
    expect(lines.map((l) => l.label)).toEqual(["D-8 이전", "D-7 이내"]);
  });

  it("범위를 벗어난 수수료율은 0~100 으로 가둔다", () => {
    expect(toRefundPolicyLines([{ daysBefore: 1, feePct: 130 }]).at(-1)!.refundPct).toBe(0);
    expect(toRefundPolicyLines([{ daysBefore: 1, feePct: -20 }]).at(-1)!.refundPct).toBe(100);
  });

  it("신호등 — 100%는 초록, 중간은 경고, 0%는 위험", () => {
    const lines = toRefundPolicyLines(TIERS);
    expect(lines[0]!.tone).toBe("success");
    expect(lines[1]!.tone).toBe("warning");
    expect(lines.at(-1)!.tone).toBe("danger");
  });

  it("한 줄 요약", () => {
    // 2026-08-01: 숫자만 있으면 수수료율로 정반대로 읽혀 「환불」을 붙였다.
    expect(toRefundPolicySummary([{ daysBefore: 0, feePct: 0 }])).toBe("언제든 환불 100%");
  });

  /**
   * 🔴 무엇의 %인지 반드시 붙는다 (감사 P1-⑤).
   *
   * DB 는 **수수료율**을 담고 화면은 **환불률**을 보여준다 — 뒤집힌 두 값이 같은 자리에
   * 오므로 라벨이 없으면 정반대로 읽힌다. 돈 화면에서 모호함은 분쟁이 된다.
   */
  it("🔴 모든 줄에 「환불」이 붙고 숫자가 환불률과 일치한다", () => {
    const lines = toRefundPolicyLines([
      { daysBefore: 0, feePct: 100 },
      { daysBefore: 7, feePct: 30 },
    ]);
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) {
      expect(l.refundLabel, `"${l.label}" 에 무엇의 %인지가 없다`).toBe(`환불 ${l.refundPct}%`);
      expect(l.refundLabel).toMatch(/^환불 \d{1,3}%$/);
    }
    // 수수료 100% = 환불 0% — 뒤집기가 살아 있는지 확인
    expect(lines.at(-1)!.refundLabel).toBe("환불 0%");
  });

  it("🔴 화면이 숫자만 그리지 않는다 — refundLabel 을 쓴다", async () => {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const src = fs.readFileSync(
      path.join(__dirname, "..", "..", "app", "(public)", "e", "[eventSlug]", "page.tsx"),
      "utf8",
    );
    expect(src, "숫자만 그리면 수수료율로 읽힌다").not.toMatch(/\{line\.refundPct\}%/);
    expect(src).toContain("line.refundLabel");
  });
});
