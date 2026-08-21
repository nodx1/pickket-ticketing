import { describe, expect, it } from "vitest";

import { checkChannelId, normalizeChannelId } from "./channel-id";

/**
 * 🔴 실사고 재현 (2026-07-29)
 *
 * `SENS_ALIMTALK_CHANNEL_ID` 에 `.env` 감각으로 주석을 달았는데 CapRover env 는
 * 그 줄 전체가 값이다:
 *
 *     '@pickket  # 2026-07-21 카카오채널 연동 완료(정상)'
 *
 * 앱이 38글자를 plusFriendId 로 보내 NCP 가 404 로 거부했고, **초대권이 발권만 되고
 * 발송은 조용히 실패**했다(대표 번호로 시험 발권한 1건이 실제로 이렇게 죽었다).
 * 그런데 화면은 그 값을 **"연결됨"** 으로 보여줬다 — 초록불이 발견을 늦췄다.
 */
const REAL_BROKEN = "@pickket  # 2026-07-21 카카오채널 연동 완료(정상)";

describe("normalizeChannelId — NCP 에 보낼 값", () => {
  it("🔴 주석이 붙은 실사고 값에서 채널 ID만 뽑는다", () => {
    expect(normalizeChannelId(REAL_BROKEN)).toBe("@pickket");
  });

  it("정상값은 그대로", () => {
    expect(normalizeChannelId("@pickket")).toBe("@pickket");
  });

  it("앞뒤 공백·탭·줄바꿈을 걷어낸다", () => {
    expect(normalizeChannelId("  @pickket \n")).toBe("@pickket");
    expect(normalizeChannelId("@pickket\t뒤에뭔가")).toBe("@pickket");
  });

  it.each(["", "   ", null, undefined])("빈 값(%p)은 null", (v) => {
    expect(normalizeChannelId(v)).toBeNull();
  });

  it("🔴 형식이 끝내 어긋나면 null — 잘못된 값으로 발송을 시도하지 않는다", () => {
    // 보정해서라도 쏘면 NCP 404 가 나고 원장엔 '발송 실패' 만 남는다.
    expect(normalizeChannelId("pickket")).toBeNull(); // @ 없음
    expect(normalizeChannelId("@픽켓")).toBeNull(); // 한글
    expect(normalizeChannelId("# 주석만")).toBeNull();
  });

  it("허용 문자(영소문자·숫자·-·_)는 통과", () => {
    expect(normalizeChannelId("@pick-ket_2")).toBe("@pick-ket_2");
  });
});

describe("checkChannelId — 화면 초록/경고 판정", () => {
  it("🔴 주석이 붙어 있으면 **ok=false** — 보정해 보내더라도 초록불이 아니다", () => {
    const c = checkChannelId(REAL_BROKEN);
    expect(c.value).toBe("@pickket"); // 발송은 된다
    expect(c.ok).toBe(false); // 그러나 설정은 잘못됐다
    expect(c.problem).toBe("has_extra");
    expect(c.message).toContain("@pickket");
  });

  it("정상값만 ok=true", () => {
    expect(checkChannelId("@pickket")).toMatchObject({ value: "@pickket", ok: true, problem: null });
  });

  it("미설정 / @ 누락 / 허용 안 되는 문자 — 사유가 갈린다", () => {
    expect(checkChannelId("").problem).toBe("missing");
    expect(checkChannelId("pickket").problem).toBe("no_at_prefix");
    expect(checkChannelId("@픽켓").problem).toBe("bad_chars");
  });

  it("형식이 깨진 경우 value 는 null — 호출부가 실수로 못 쓴다", () => {
    expect(checkChannelId("pickket").value).toBeNull();
    expect(checkChannelId("@픽켓").value).toBeNull();
  });
});
