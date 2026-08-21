/**
 * 🔴 초대권 화면의 날짜 표기 — **한 표 안에서 형식이 갈리면 안 된다.**
 *
 * ## 왜 생겼나
 * 2026-08-03 지적: 같은 표에 세 형식이 섞여 있었다.
 * ```
 * 발권일시       2026년 8월 3일 … 08:19        ← 화면 전용 로컬 포맷터
 * 대회일정       2026년 8월 20일 ~ 2026년 8월 23일  ← lib/format
 * 입장 가능 일자  2026-08-20 ~ 08-23 중 1일       ← 여기(숫자 그대로)
 * ```
 *
 * ⚠️ **시간대 가드(`datetime.guard.test.ts`)는 이걸 못 잡는다.** 그 가드는
 *    `timeZone` 이 빠졌는지만 본다. 여기는 `Asia/Seoul` 을 제대로 넘기고 있었다 —
 *    틀린 건 시간대가 아니라 형식이었다. **검사 축이 달랐다.**
 *    그래서 형식은 이 파일이 따로 고정한다.
 *
 * ## 🔴 문구는 그대로 둔다
 * 「중 1일 · 첫 입장일 확정」은 데이패스 규칙을 정확히 전달하는 문장이다.
 * 형식만 바꾸고 **말은 건드리지 않는다.**
 */
import { describe, expect, it } from "vitest";
import { deriveAdmissionWindow } from "./admission-window";

const START = "2026-08-20T00:00:00+09:00";
const END = "2026-08-23T00:00:00+09:00";

describe("표시 형식 — 다른 줄과 같은 한국어 날짜", () => {
  it("🔴 숫자 형식(YYYY-MM-DD)이 화면에 나오지 않는다", () => {
    const { label } = deriveAdmissionWindow({
      mode: "daypass",
      admissionDay: null,
      startsAt: START,
      endsAt: END,
    });
    expect(label, "옛 숫자 형식이 남아 있다").not.toMatch(/\d{4}-\d{2}-\d{2}/);
    expect(label, "월-일 단축(08-23)이 남아 있다").not.toMatch(/~\s*\d{2}-\d{2}/);
  });

  it("🔴 양끝 모두 「2026년 8월 20일」 형식이다", () => {
    const { label } = deriveAdmissionWindow({
      mode: "daypass",
      admissionDay: null,
      startsAt: START,
      endsAt: END,
    });
    expect(label).toContain("2026년 8월 20일");
    expect(label).toContain("2026년 8월 23일");
  });

  it("🔴 「중 1일 · 첫 입장일 확정」 문구는 그대로다", () => {
    const { label } = deriveAdmissionWindow({
      mode: "daypass",
      admissionDay: null,
      startsAt: START,
      endsAt: END,
    });
    expect(label, "데이패스 규칙 문장이 사라졌다").toContain("중 1일 · 첫 입장일 확정");
  });

  it("지정일도 같은 형식", () => {
    const { label } = deriveAdmissionWindow({
      mode: "daypass",
      admissionDay: "2026-08-21",
      startsAt: START,
      endsAt: END,
    });
    expect(label).toContain("2026년 8월 21일");
    expect(label).toContain("(지정일)");
    expect(label).not.toMatch(/\d{4}-\d{2}-\d{2}/);
  });

  it("전일권도 같은 형식 + 문구 유지", () => {
    const { label } = deriveAdmissionWindow({
      mode: "allpass",
      admissionDay: null,
      startsAt: START,
      endsAt: END,
    });
    expect(label).toContain("2026년 8월 20일");
    expect(label).toContain("기간 내 매일 입장 가능");
  });

  it("단일일이면 한 날짜만", () => {
    const { label } = deriveAdmissionWindow({
      mode: "single",
      admissionDay: null,
      startsAt: START,
      endsAt: START,
    });
    expect(label).toContain("2026년 8월 20일");
    expect(label).not.toContain("~");
  });
});

describe("경계 — 표시가 깨지지 않는다", () => {
  it("일정이 없으면 「일정 미정」", () => {
    const { label } = deriveAdmissionWindow({
      mode: "single",
      admissionDay: null,
      startsAt: null,
      endsAt: null,
    });
    expect(label).toBe("일정 미정");
  });

  /**
   * ⚠️ 이 테스트의 **주장을 한 번 고쳤다.**
   *
   * 처음엔 "`displayDay` 의 `|| day` 폴백이 빈칸을 막는다" 로 적었는데,
   * 뮤테이션(폴백 제거)이 **생존**해서 다시 봤다. 이유:
   * ```
   * toDayKST("말이 안 되는 값")  →  null      ← displayDay 에 도달하지 않는다
   * toDayKST 가 값을 주면 항상 YYYY-MM-DD    ← formatDate 가 실패할 수 없다
   * ```
   * ⟹ `displayDay` 의 폴백은 **오늘 기준 도달 불가**다(방어로만 남긴다).
   *    그래서 이 테스트는 실제로 도는 경로 — 파싱 실패 시 「일정 미정」 — 만 단언한다.
   *    없는 것을 검증한다고 적어두면 다음 사람이 속는다.
   */
  it("못 읽는 날짜는 「일정 미정」이 된다 — 빈칸이 아니다", () => {
    const { label } = deriveAdmissionWindow({
      mode: "single",
      admissionDay: null,
      startsAt: "말이 안 되는 값",
      endsAt: null,
    });
    expect(label.trim().length, "칸이 비었다").toBeGreaterThan(0);
    expect(label).toBe("일정 미정");
  });

  /**
   * 🔴 내부 판정은 계속 `YYYY-MM-DD` 로 해야 한다.
   *    표시를 한국어로 바꾸면서 비교까지 바꾸면 시작=종료 판정이 깨진다.
   */
  it("시작=종료를 여전히 같은 날로 본다 — 비교는 표시와 별개다", () => {
    const same = deriveAdmissionWindow({
      mode: "allpass",
      admissionDay: null,
      startsAt: "2026-08-20T01:00:00+09:00",
      endsAt: "2026-08-20T23:00:00+09:00",
    });
    expect(same.label, "같은 날인데 범위로 표시됐다").not.toContain("~");
  });
});
