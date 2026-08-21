import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";

import { V2CommerceError } from "@/lib/v2/commerce-client";
import { resendConflictMessage, v2ErrorCode } from "./error-code";

/**
 * 🔴 재발송 409 가 두 가지가 됐다 (2026-08-04).
 *
 *   INVITATION_REVOKED   회수된 초대
 *   DISPATCH_IN_FLIGHT   워커가 지금 보내는 중 (v2 가 새로 막는다)
 *
 * 종전 라우트는 **409 를 전부 "회수된 초대"** 로 표시했다. 그대로 두면 회수되지도
 * 않은 초대에 "회수됨" 이 뜨고, 주최자는 있지도 않은 문제를 쫓는다.
 */
describe("v2 오류 코드 추출", () => {
  it("봉투가 error 객체 자체다 — 한 겹 더 벗기면 안 된다", () => {
    const err = new V2CommerceError(
      "dispatch in flight",
      409,
      JSON.stringify({ code: "DISPATCH_IN_FLIGHT", message: "dispatch in flight" }),
    );
    expect(v2ErrorCode(err)).toBe("DISPATCH_IN_FLIGHT");
  });

  /**
   * 🔴 2026-08-09 정정 — 이 단언이 **틀렸었다.**
   *
   * `body` 는 던지는 자리마다 모양이 다르다:
   *   commerce-client.ts:146  HTTP 200 + {ok:false} → `JSON.stringify(env.error)`  평면
   *   commerce-client.ts:158  HTTP 4xx/5xx          → 응답 원문                     중첩
   *
   * v2 가 409 를 내면 `:158` 로 가므로 **중첩이 온다**. "중첩은 우리 계약이 아니다"
   * 라고 못박아 둔 탓에 `ORDER_NOT_REPLAYABLE` 분기가 통째로 죽었고, 만료 토큰
   * 자동복구가 안 돌아 손님 화면에 기계 코드가 그대로 나갔다.
   */
  it("🔴 4xx 원문 봉투({ok:false,error:{code}})에서도 코드를 꺼낸다", () => {
    const err = new V2CommerceError(
      "ORDER_NOT_REPLAYABLE: 이전 주문이 만료되었습니다",
      409,
      JSON.stringify({ ok: false, error: { code: "ORDER_NOT_REPLAYABLE", message: "…" } }),
    );
    expect(v2ErrorCode(err)).toBe("ORDER_NOT_REPLAYABLE");
  });

  it("두 봉투가 같은 코드를 준다 — 상태코드에 따라 갈리지 않는다", () => {
    const flat = new V2CommerceError("x", 200, JSON.stringify({ code: "C" }));
    const nested = new V2CommerceError("x", 409, JSON.stringify({ ok: false, error: { code: "C" } }));
    expect(v2ErrorCode(flat)).toBe(v2ErrorCode(nested));
  });

  it.each([
    ["body 없음", undefined],
    ["JSON 아님", "<html>502</html>"],
    ["code 가 문자열이 아님", JSON.stringify({ code: 409 })],
  ])("%s → null (터지지 않는다)", (_label, body) => {
    expect(v2ErrorCode(new V2CommerceError("x", 409, body))).toBeNull();
  });
});

describe("재발송 409 문구", () => {
  it("🔴 발송 중은 '발송 중' 이라고 말한다", () => {
    const msg = resendConflictMessage("DISPATCH_IN_FLIGHT");
    expect(msg).toContain("발송 중");
    expect(msg).not.toContain("회수");
  });

  it("회수됨은 종전 문구 그대로", () => {
    expect(resendConflictMessage("INVITATION_REVOKED")).toBe(
      "회수된 초대는 재발송할 수 없습니다",
    );
  });

  it.each([null, "SOMETHING_NEW"])(
    "🔴 모르는 코드(%s)를 '회수됨' 으로 단정하지 않는다",
    (code) => {
      expect(resendConflictMessage(code)).not.toContain("회수");
    },
  );
});

describe("라우트 배선", () => {
  it("초대 라이프사이클 라우트가 이 매핑을 실제로 쓴다", async () => {
    const src = await readFile(
      new URL(
        "../../app/api/events/[eventId]/invitations/[invitationId]/route.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const body = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    expect(body).toMatch(/resendConflictMessage\(v2ErrorCode\(err\)\)/);
    // 옛 하드코딩 분기가 남아 있으면 매핑을 우회한다
    expect(body).not.toMatch(/errorResponse\("회수된 초대는 재발송할 수 없습니다"/);
  });
});

/**
 * 🔴 2026-08-09 실사고 — **두 번째 판**이 조용히 null 을 내고 있었다.
 *
 * `commerce-client.ts` 안에 같은 이름의 함수가 따로 있었고 그쪽은 `parsed.error.code`
 * 를 읽었다. 위 "한 겹 더 벗기면 안 된다" 가 이미 계약을 못박고 있었는데도, **다른
 * 파일의 두 번째 구현**은 그 계약 밖이라 아무도 못 봤다. 그래서 그 판을 쓰던 분기가
 * 한 번도 실행되지 않았다:
 *
 * ```
 * server/invitations.ts   INVITATION_LIMIT      초대권 상한 종료조건
 * checkout/initiate       ORDER_NOT_REPLAYABLE  만료 토큰 자동복구
 * ```
 *
 * ⟹ 정본 하나로 접고(재수출), **접혀 있다는 것 자체**를 여기서 고정한다.
 */
describe("🔴 구현이 한 벌인가", () => {
  it("commerce-client 의 v2ErrorCode 가 정본과 **같은 함수**다", async () => {
    const cc = await import("@/lib/v2/commerce-client");
    const ec = await import("./error-code");
    expect(
      cc.v2ErrorCode,
      "두 벌로 갈라지면 한쪽만 고쳐지고, 그 순간 분기가 조용히 죽는다",
    ).toBe(ec.v2ErrorCode);
  });

  it("catch 절의 unknown 을 그대로 받는다", () => {
    // 좁은 타입만 받으면 호출부가 캐스팅으로 우회하고, V2 아닌 오류도 코드로 읽힌다.
    expect(v2ErrorCode(new Error("그냥 오류"))).toBeNull();
    expect(v2ErrorCode(undefined)).toBeNull();
    expect(v2ErrorCode({ body: '{"code":"X"}' })).toBeNull();
  });
});

/**
 * 🔴 회수 409 — 영구 거절을 "잠시 후 다시" 로 내보내면 주최자가 영원히 누른다.
 */
describe("회수 배선", () => {
  it("라우트가 INVITATION_ALREADY_CHECKED_IN 을 409 로 갈라 안내한다", async () => {
    const src = await readFile(
      new URL(
        "../../app/api/events/[eventId]/invitations/[invitationId]/route.ts",
        import.meta.url,
      ),
      "utf8",
    );
    const body = src
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .join("\n");
    // 🔴 코드 판정 → 409 안내가 **503 폴백보다 먼저** 와야 한다.
    const iCode = body.indexOf("INVITATION_ALREADY_CHECKED_IN");
    const iFallback = body.indexOf("잠시 후 다시 시도해주세요");
    expect(iCode, "회수 409 분기가 없다").toBeGreaterThan(-1);
    expect(iFallback, "503 폴백이 없다").toBeGreaterThan(-1);
    expect(iCode, "🔴 폴백이 먼저면 영구 거절이 재시도 문구로 나간다").toBeLessThan(iFallback);
    expect(body).toMatch(/이미 입장한 초대권은 회수할 수 없습니다/);
  });
});
