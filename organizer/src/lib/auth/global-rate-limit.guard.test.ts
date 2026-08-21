import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * 🔴 전역 API 레이트리밋의 **숫자가 한 곳에서만 나오게** 고정한다 (2026-07-31).
 *
 * ## 무슨 일이 있었나
 * `proxy.ts` 가 `max: 60` 으로 한도를 걸면서, 429 응답 헤더에는 `"X-RateLimit-Limit": "60"`
 * 을 **문자열로 따로** 적고 있었다. 한쪽만 고치면 **응답이 거짓말을 한다** — 클라이언트는
 * 헤더를 믿고 재시도 간격을 잡는다.
 *
 * ## 왜 한도를 올렸나 (실측)
 * 키가 **IP 뿐**이라 같은 네트워크의 모든 사용자가 한 버킷을 공유한다. 대시보드는
 * 화면당 평균 9회를 부르므로 60 이면 혼자서도 1분에 6~7화면이면 막힌다.
 * 대회 현장에서 스태프가 같은 와이파이를 쓰면 더 빨리 닿는다.
 *
 * ⚠️ 이 가드는 **숫자가 옳은지**를 검증하지 않는다(그건 운영 판단이다).
 *    검증하는 것은 **두 곳이 어긋나지 않는가** 와 **민감 경로가 자기 한도를 유지하는가** 다.
 */
const PROXY = path.join(process.cwd(), "src/proxy.ts");

describe("전역 레이트리밋", () => {
  const src = readFileSync(PROXY, "utf8");

  it("🔴 한도를 상수 하나에서만 읽는다 — 숫자를 직접 박지 않는다", () => {
    expect(src).toMatch(/const GLOBAL_API_RATE_LIMIT = \d+;/);
    expect(src).toMatch(/checkRateLimit\(key, \{ max: GLOBAL_API_RATE_LIMIT/);
  });

  it("🔴 429 응답 헤더가 같은 상수를 쓴다 — 어긋나면 응답이 거짓말한다", () => {
    expect(src).toMatch(/"X-RateLimit-Limit": String\(GLOBAL_API_RATE_LIMIT\)/);
    expect(src, "헤더에 숫자를 직접 박지 말 것").not.toMatch(/"X-RateLimit-Limit": "\d+"/);
  });

  it("Retry-After 를 함께 준다 — 없으면 클라이언트가 언제 재시도할지 모른다", () => {
    expect(src).toMatch(/"Retry-After"/);
  });
});

/**
 * 🔴 전역을 느슨하게 한 대신, **민감 경로는 자기 한도를 반드시 유지**해야 한다.
 * 전역만 믿고 라우트 한도를 지우면 무차별 대입·중복 결제가 열린다.
 */
describe("민감 경로는 자기 한도를 갖는다", () => {
  const ROOT = path.join(process.cwd(), "src/app/api");
  /**
   * 🔴 **돈이 나가는 경로는 올리지 않았다** (2026-08-01 오픈일 조정).
   *
   * 계정 진입(가입·로그인·조회·본인확인)은 10 으로 올렸다 — 키가 **IP 뿐**이라
   * 모바일 통신사 NAT·공용 와이파이에서 **남의 시도가 내 한도를 먹는다.**
   * 오픈 첫날 "회원가입이 안 된다" 신고가 실제로 그것이었다(3회/분).
   *
   * ⚠️ 무차별 대입 방어는 10 에서도 유효하다 — 10/분 = 14,400/일이라
   *    8자 이상 비밀번호에는 무의미한 속도다. 반면 **정상 사용자 차단은 즉시 이탈**이다.
   *
   * ⚠️ 그러나 **환불·결제확정·체크아웃 완료는 그대로 둔다.** 이쪽은 느슨해지면
   *    중복 집행·중복 청구가 되고, 한 번 나간 돈은 되돌리는 비용이 다르다.
   */
  const CASES: Array<[string, string, number]> = [
    // 계정 진입 — 상향(공유 IP 에서 정상 사용자가 막히던 것)
    ["로그인", "auth/login/route.ts", 10],
    ["회원가입", "auth/register/route.ts", 10],
    ["티켓 조회", "public/my-tickets/route.ts", 10],
    // 🔴 올리지 않는다 — 돈이 나가거나 후보공간이 좁은 경로
    //    본인확인(`public/lookup/verify-contact`)은 **전화번호 후보공간이 좁아**
    //    (01X-XXXX-XXXX) 한도가 풀리면 링크만 가진 사람이 번호를 긁을 수 있다.
    //    그 경로는 자기 파일에 전용 가드가 있다(`route.test.ts` — 5회/분·60초창).
    //    올리려다 그 가드가 잡아서 되돌렸다. **공유 IP 불편보다 열거가 더 비싸다.**
    ["공개 환불 신청", "public/refund/route.ts", 5],
    ["결제 확정", "payment/toss/confirm/route.ts", 10],
    ["체크아웃 시작", "checkout/initiate/route.ts", 10],
    ["체크아웃 완료", "checkout/complete/route.ts", 10],
    ["MFA 챌린지", "auth/mfa/challenge/route.ts", 10],
  ];

  it.each(CASES)("%s — max %i 이하", (_name, rel, limit) => {
    const src = readFileSync(path.join(ROOT, rel), "utf8");
    const m = /withRateLimit\(\{[\s\S]{0,120}?max:\s*(\d+)/.exec(src);
    expect(m, `withRateLimit 이 없다: ${rel}`).not.toBeNull();
    expect(Number(m![1]), `${rel} 의 한도가 느슨해졌다`).toBeLessThanOrEqual(limit);
  });
});

/**
 * 🔴 **429 는 "언제 다시 되는지" 를 말해야 한다** (2026-08-01 오픈일).
 *
 * 종전 문구는 "요청이 너무 많습니다. 잠시 후 다시 시도해주세요" 뿐이었다.
 * 막힌 사용자는 대기 시간을 모르니 5초 뒤에 또 누르고 또 막힌다 — 그러다 이탈한다.
 * 키가 **IP 뿐**이라 모바일 NAT 에서는 **처음 누른 사람도 막힌다.** 그때 아무 설명이
 * 없으면 "이 사이트 고장났다" 로 읽힌다.
 */
describe("429 응답이 대기 시간을 알려준다", () => {
  const src = readFileSync(path.join(process.cwd(), "src/lib/auth/withRateLimit.ts"), "utf8");

  it("🔴 본문 문구에 남은 초를 담는다 — 헤더만으론 사용자가 못 본다", () => {
    expect(src).toMatch(/약 \$\{retryAfterSec\}초 후 가능합니다/);
  });

  it("Retry-After 헤더와 문구가 **같은 값**을 쓴다 — 갈리면 응답이 거짓말한다", () => {
    expect(src).toMatch(/const retryAfterSec = Math\.max\(1, Math\.ceil\(/);
    expect(src).toMatch(/"Retry-After": String\(retryAfterSec\)/);
    expect(src, "헤더에 계산식을 다시 적지 말 것").not.toMatch(
      /"Retry-After": String\(Math\.ceil/,
    );
  });

  it("0초로 안내하지 않는다 — 최소 1초", () => {
    expect(src).toMatch(/Math\.max\(1,/);
  });
});
