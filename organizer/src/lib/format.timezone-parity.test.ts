/**
 * 🔴 시간대를 붙이면서 **표기까지 바꾸지 않았는지** (2026-08-01 검수에서 발견).
 *
 * 이번 작업의 목적은 `timeZone` 명시다. 그런데 처음에 포맷터를 새로 만들면서
 * **17곳 중 10곳의 표시가 함께 바뀌었다** — 가장 큰 차이는 `toLocaleString("ko-KR")`
 * 기본값에 있던 **초가 사라진 것**이다:
 *
 *     옛  "2026. 8. 20. 오전 7:04:33"      ← 기본값(초 포함)
 *     새  "2026년 8월 20일 오전 7:04"       ← 내가 만든 포맷(초 없음)
 *
 * 감사 로그·체크인 기록에서 초는 의미가 있고(같은 분에 여러 건),
 * `waitlist` 만료 표기는 **고객 메일·문자에 그대로 실린다.**
 * 표기를 바꾸려면 별건으로 판단받아야 하므로 **원래 모양으로 되돌렸다.**
 *
 * 이 테스트는 그 되돌림이 **정확한지**를 고정한다 — 종전 호출과 문자열이 같아야 한다.
 * (서버 TZ 가 KST 인 지금은 두 값이 같다. TZ 가 달라지면 이 테스트는 의미를 잃으므로
 *  아래에서 **KST 기준 기대 문자열**도 함께 못박는다.)
 */
import { describe, expect, it } from "vitest";
import {
  formatDateKst,
  formatDateShortKst,
  formatDateTime2DigitKst,
  formatDateTimeSecKst,
  formatTimeSecKst,
} from "@/lib/format";

const SAMPLES = [
  "2026-08-19T22:04:33Z", // KST 2026-08-20 07:04:33 — 주중권/주말권 경계일
  "2026-01-01T15:00:00Z", // KST 다음날 00:00 — 날짜 경계
  "2026-12-31T14:59:59Z",
  "2026-03-01T00:00:05Z",
];

describe("종전 표기와 완전히 같은가", () => {
  it("🔴 기본 date+time (초 포함) — 감사로그·승인일·추첨일 등", () => {
    for (const s of SAMPLES) {
      const d = new Date(s);
      expect(formatDateTimeSecKst(d), `${s} 에서 표기가 달라졌다`).toBe(d.toLocaleString("ko-KR"));
    }
  });

  it("🔴 기본 time (초 포함) — 체크인 기록", () => {
    for (const s of SAMPLES) {
      const d = new Date(s);
      expect(formatTimeSecKst(d), `${s} 에서 표기가 달라졌다`).toBe(d.toLocaleTimeString("ko-KR"));
    }
  });

  it("🔴 2자리 고정 — 판매 개시/마감 · 대기열 만료(고객 메일)", () => {
    for (const s of SAMPLES) {
      const d = new Date(s);
      expect(formatDateTime2DigitKst(d), `${s} 에서 표기가 달라졌다`).toBe(
        d.toLocaleString("ko-KR", {
          year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit",
        }),
      );
    }
  });

  it("짧은 날짜 · 긴 날짜도 그대로", () => {
    for (const s of SAMPLES) {
      const d = new Date(s);
      expect(formatDateShortKst(d)).toBe(d.toLocaleDateString("ko-KR"));
      expect(formatDateKst(d)).toBe(
        d.toLocaleDateString("ko-KR", { year: "numeric", month: "long", day: "numeric" }),
      );
    }
  });

  /**
   * ⚠️ 위 네 검사는 **지금 서버가 KST 라서** 통과한다(양쪽이 같은 시간대를 본다).
   *    TZ 가 바뀌면 좌변만 KST 로 남고 우변이 밀리므로 저절로 깨진다 — 그때는 이 검사를
   *    지우고 아래 고정 문자열만 남기면 된다.
   */
  it("🔴 KST 기준 기대 문자열 (시간대가 바뀌어도 이 값이어야 한다)", () => {
    const d = new Date("2026-08-19T22:04:33Z"); // KST 2026-08-20 07:04:33
    expect(formatDateTimeSecKst(d)).toBe("2026. 8. 20. 오전 7:04:33");
    expect(formatTimeSecKst(d)).toBe("오전 7:04:33");
    expect(formatDateTime2DigitKst(d)).toBe("2026. 08. 20. 오전 07:04");
    expect(formatDateShortKst(d)).toBe("2026. 8. 20.");
    expect(formatDateKst(d)).toBe("2026년 8월 20일");
  });
});
