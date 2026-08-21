import { describe, expect, it } from "vitest";

import {
  auditClientIp,
  isIpLiteral,
  isPrivateIp,
  isUnproxiedInternalPath,
  LOCAL_RATE_LIMIT_KEY,
  rateLimitKey,
  resolveClientIp,
} from "./request-ip";

/** `Headers` 대신 주입 — 순수 함수로 검사하기 위해. */
function h(map: Record<string, string>) {
  return {
    get(name: string) {
      return map[name.toLowerCase()] ?? null;
    },
  };
}

describe("isIpLiteral", () => {
  it.each(["1.2.3.4", "203.0.113.9", "255.255.255.255", "0.0.0.0", "::1", "2001:db8::1", "fe80::1"])(
    "IP 리터럴 (%s)",
    (v) => expect(isIpLiteral(v)).toBe(true),
  );

  it.each([
    ["빈 문자열", ""],
    ["옥텟 초과", "256.1.1.1"],
    ["옥텟 부족", "1.2.3"],
    ["문자 포함", "a.b.c.d"],
    ["🔴 선행 0 — 8진수로 해석하는 파서와 값이 갈린다", "01.2.3.4"],
    ["공백 포함", "1.2.3.4 "],
    ["호스트명", "example.com"],
    ["CIDR", "1.2.3.4/32"],
    ["압축 두 번", "2001::db8::1"],
  ])("IP 아님 — %s", (_label, v) => expect(isIpLiteral(v)).toBe(false));
});

describe("isPrivateIp — XFF 체인의 인프라 홉을 건너뛰기 위한 판정", () => {
  it.each(["10.0.0.1", "127.0.0.1", "172.18.0.1", "192.168.0.9", "169.254.1.1", "100.64.0.1", "::1", "fd00::1", "fe80::1"])(
    "사설·루프백·링크로컬 (%s)",
    (v) => expect(isPrivateIp(v)).toBe(true),
  );

  it.each(["1.2.3.4", "203.0.113.9", "172.32.0.1", "192.169.0.1", "2001:db8::1"])(
    "공인 (%s)",
    (v) => expect(isPrivateIp(v)).toBe(false),
  );
});

describe("resolveClientIp", () => {
  it("CF-Connecting-IP 가 있으면 그것을 쓴다 — 프로덕션의 정답", () => {
    expect(resolveClientIp(h({ "cf-connecting-ip": "203.0.113.9" }))).toEqual({
      ip: "203.0.113.9",
      source: "cf",
    });
  });

  /**
   * 🔴 이 배치의 핵심 — 실제 프로덕션 체인 모양이다.
   *
   *   XFF: <공격자가 붙인 값>, <CF 가 본 실제 IP>, <CF 엣지 IP(nginx 가 append)>
   *
   * 왼쪽을 집으면 위조값이고, 오른쪽을 집으면 CF 엣지다. **둘 다 틀린다.**
   * CF 헤더가 이기지 않으면 이 테스트가 죽는다.
   */
  it("🔴 XFF 에 무엇이 있어도 CF 헤더가 이긴다 — 우→좌만으로는 CF 엣지를 집는다", () => {
    const resolved = resolveClientIp(
      h({
        "cf-connecting-ip": "203.0.113.9",
        "x-forwarded-for": "1.2.3.4, 203.0.113.9, 198.41.128.5",
      }),
    );
    expect(resolved).toEqual({ ip: "203.0.113.9", source: "cf" });
  });

  it.each([
    ["형식 불량", "not-an-ip"],
    ["옥텟 초과", "999.1.1.1"],
    ["빈 값", "   "],
  ])("CF 헤더가 %s 이면 채택하지 않고 XFF 로 내려간다", (_label, cf) => {
    const resolved = resolveClientIp(
      h({ "cf-connecting-ip": cf, "x-forwarded-for": "203.0.113.9, 172.18.0.1" }),
    );
    expect(resolved).toEqual({ ip: "203.0.113.9", source: "xff" });
  });

  it("🔴 XFF 는 우→좌로 훑어 사설 홉을 건너뛴다 — 스푸핑 프리픽스를 집으면 안 된다", () => {
    const resolved = resolveClientIp(h({ "x-forwarded-for": "1.2.3.4, 203.0.113.9, 172.18.0.1" }));
    expect(resolved).toEqual({ ip: "203.0.113.9", source: "xff" });
  });

  it("체인이 전부 사설이면 null — 식별 실패를 숨기지 않는다", () => {
    expect(resolveClientIp(h({ "x-forwarded-for": "10.0.0.1, 172.18.0.1" }))).toBeNull();
  });

  it("헤더가 없으면 null", () => {
    expect(resolveClientIp(h({}))).toBeNull();
  });

  it("🔴 X-Real-IP 는 쓰지 않는다 — 우리 nginx 설정에서 CF 엣지 IP 다", () => {
    expect(resolveClientIp(h({ "x-real-ip": "198.41.128.5" }))).toBeNull();
  });

  it("형식 불량 항목은 건너뛰고 다음 후보로 간다", () => {
    const resolved = resolveClientIp(h({ "x-forwarded-for": "203.0.113.9, garbage" }));
    expect(resolved).toEqual({ ip: "203.0.113.9", source: "xff" });
  });

  it("같은 클라이언트가 프리픽스를 바꿔 보내도 결과가 같다 — 버킷이 갈리면 한도가 무한이 된다", () => {
    const a = resolveClientIp(h({ "x-forwarded-for": "9.9.9.9, 203.0.113.9, 172.18.0.1" }));
    const b = resolveClientIp(h({ "x-forwarded-for": "8.8.8.8, 203.0.113.9, 172.18.0.1" }));
    expect(a).toEqual(b);
  });
});

describe("auditClientIp", () => {
  it("해석되면 문자열", () => {
    expect(auditClientIp(h({ "cf-connecting-ip": "203.0.113.9" }))).toBe("203.0.113.9");
  });

  it('🔴 실패하면 null — "unknown" 문자열을 만들지 않는다', () => {
    expect(auditClientIp(h({}))).toBeNull();
  });
});

describe("isUnproxiedInternalPath — CF 를 거치지 않는 경로", () => {
  /**
   * 🔴 실측: prod backend env `GO_INTERNAL_BASE_URL` = `http://srv-captain--pickket-organizer:3003`
   *    v2 는 go 를 도커 내부망으로 부른다 — 프록시 헤더가 없다.
   *    이 예외를 빼고 "식별 실패 = 거부" 를 켜면 주문 상태 전파·심사 결과 수신이 전부 죽는다.
   */
  it.each([
    "/api/health",
    "/api/health/ready",
    "/api/health/live",
    "/api/internal/orders/state-changed",
    "/api/internal/business-verifications",
    "/api/v2-webhook/events/abc/review-result",
  ])("예외 (%s)", (p) => expect(isUnproxiedInternalPath(p)).toBe(true));

  /** ⚠️ 크론은 예외가 아니다 — install-crontab.sh:45 가 https://go.pickket.kr/api/cron 을 쓴다(CF 경유). */
  it.each([
    "/api/cron/reminders",
    "/api/cron/dispatch-invitations",
    "/api/public/inquiries",
    "/api/events/abc/orders/1/refund",
    "/api/auth/login",
    "/api/healthz",
    "/api/internalx/foo",
  ])("예외 아님 (%s)", (p) => expect(isUnproxiedInternalPath(p)).toBe(false));
});

describe("rateLimitKey", () => {
  it("해석되면 그 IP 가 키다", () => {
    expect(rateLimitKey(h({ "cf-connecting-ip": "203.0.113.9" }), true)).toBe("203.0.113.9");
  });

  it("🔴 프로덕션에서 해석 실패면 null — 호출측이 거부해야 한다", () => {
    expect(rateLimitKey(h({}), true)).toBeNull();
  });

  it("비프로덕션(로컬·테스트)에서는 고정 키로 떨어진다 — 개발이 죽으면 안 된다", () => {
    expect(rateLimitKey(h({}), false)).toBe(LOCAL_RATE_LIMIT_KEY);
  });

  it("🔴 XFF 앞머리를 바꿔도 같은 키 — 갈리면 한도가 무한이 된다", () => {
    const a = rateLimitKey(h({ "x-forwarded-for": "9.9.9.9, 203.0.113.9, 172.18.0.1" }), true);
    const b = rateLimitKey(h({ "x-forwarded-for": "8.8.8.8, 203.0.113.9, 172.18.0.1" }), true);
    expect(a).toBe("203.0.113.9");
    expect(a).toBe(b);
  });

  it("🔴 전원이 한 버킷을 공유하는 폴백이 없다 — 문의 폼이 실제로 그 상태였다", () => {
    const x = rateLimitKey(h({ "cf-connecting-ip": "1.1.1.1" }), true);
    const y = rateLimitKey(h({ "cf-connecting-ip": "2.2.2.2" }), true);
    expect(x).not.toBe(y);
  });
});
