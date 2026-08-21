import { describe, expect, it } from "vitest";

import {
  INVITATION_ADMISSION_NOTICE,
  INVITATION_REQUIRES_ADMISSION_DAY,
  stripAdmissionDay,
} from "./admission-policy";

/**
 * 🔴 요건 (2026-07-30 대표 확정)
 * > 하루에 한 장만 사용 가능하지만 **날짜를 지정해서 보내면 안 됨**
 *
 * 종전엔 행사가 `admission_mode = daypass` 면 화면이 수신자마다 날짜를 요구하고
 * 그대로 박아 넣었다 — prod 초대권 3건이 전부 `2026-08-20` 고정 상태였다.
 *
 * 이 테스트는 **정책이 행사 설정에 다시 끌려가지 않도록** 고정한다.
 */
describe("초대권 입장일 정책", () => {
  it("🔴 입장일을 요구하지 않는다 — 행사 설정과 무관하다", () => {
    // 이 값이 true 로 바뀌면 "날짜 지정해서 보내면 안 됨" 요건이 깨진다.
    expect(INVITATION_REQUIRES_ADMISSION_DAY).toBe(false);
  });

  it("주최자 안내 문구가 '지정하지 않는다'와 '하루 1회'를 모두 말한다", () => {
    // 날짜 칸이 없는 것이 결함처럼 보이면 주최자가 문의하거나 우회한다.
    expect(INVITATION_ADMISSION_NOTICE).toContain("지정하지 않습니다");
    expect(INVITATION_ADMISSION_NOTICE).toMatch(/하루/);
  });
});

describe("stripAdmissionDay — 서버 최종 관문", () => {
  it("🔴 요청에 실려온 입장일을 제거하고 건수를 센다", () => {
    // 낡은 클라이언트·직접 API 호출이 날짜를 보내는 경로.
    const { recipients, stripped } = stripAdmissionDay([
      { name: "가", phone: "01011112222", admissionDay: "2026-08-20" },
      { name: "나", phone: "01033334444", admissionDay: "2026-08-21" },
      { name: "다", phone: "01055556666" },
    ]);
    expect(stripped).toBe(2);
    expect(recipients.map((r) => r.admissionDay)).toEqual([null, null, null]);
  });

  it("다른 필드는 보존한다 — 이름·전화번호가 유실되면 발송이 깨진다", () => {
    const { recipients } = stripAdmissionDay([
      { name: "홍길동", phone: "01011112222", admissionDay: "2026-08-20" },
    ]);
    expect(recipients[0].name).toBe("홍길동");
    expect(recipients[0].phone).toBe("01011112222");
  });

  it("원본을 변형하지 않는다 — 호출부가 원본으로 집계할 수 있다", () => {
    const input = [{ name: "가", phone: "01011112222", admissionDay: "2026-08-20" }];
    stripAdmissionDay(input);
    expect(input[0].admissionDay).toBe("2026-08-20");
  });

  it("빈 목록도 안전하다", () => {
    const { recipients, stripped } = stripAdmissionDay([]);
    expect(recipients).toEqual([]);
    expect(stripped).toBe(0);
  });

  it("null·undefined 는 제거 대상으로 세지 않는다 — 경고 로그가 매번 뜨면 안 된다", () => {
    const { stripped } = stripAdmissionDay([
      { name: "가", phone: "01011112222", admissionDay: null },
      { name: "나", phone: "01033334444", admissionDay: undefined },
    ]);
    expect(stripped).toBe(0);
  });
});
