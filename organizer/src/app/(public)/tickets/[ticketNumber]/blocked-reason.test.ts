import { describe, expect, it } from "vitest";

import { resolveBlockedReason } from "./blocked-reason";

/**
 * 🔴 티켓을 못 연 이유 판정 — 고객이 보는 안내가 여기서 갈린다.
 *
 * 옛 동작은 이유 없이 `/my-tickets` 로 307 했다. 링크 만료·초대권 회수·토큰 누락·
 * 다른 기기 열람이 전부 같은 화면으로 떨어져 고객은 "티켓이 사라졌다" 로 읽었고,
 * 그 화면의 매직링크 메일마저 발신주소 미설정으로 나가지 않아 거기서 막혔다.
 */
describe("resolveBlockedReason", () => {
  it("링크를 들고 왔는데 안 열렸다 = 만료·회수 → 재발송 안내", () => {
    expect(resolveBlockedReason({ hasToken: true, status: "active" })).toBe("link_expired");
  });

  it("링크 없이 티켓 주소로만 들어왔다 → 본인확인 안내", () => {
    expect(resolveBlockedReason({ hasToken: false, status: "active" })).toBe("verify_required");
  });

  it.each(["cancelled", "expired", "transferred"])(
    "🔴 %s 티켓은 링크 유무와 무관하게 '사용할 수 없음' 이다",
    (status) => {
      // 환불된 티켓에 "재발송을 요청하세요" 라고 안내하면 고객이 주최자에게 헛걸음한다.
      expect(resolveBlockedReason({ hasToken: true, status })).toBe("ticket_unavailable");
      expect(resolveBlockedReason({ hasToken: false, status })).toBe("ticket_unavailable");
    },
  );

  it("대소문자가 달라도 상태 판정이 흔들리지 않는다", () => {
    expect(resolveBlockedReason({ hasToken: true, status: "CANCELLED" })).toBe("ticket_unavailable");
  });

  it("상태를 모르면 티켓 문제로 단정하지 않는다 — 본인확인/재발송으로 안내", () => {
    expect(resolveBlockedReason({ hasToken: false, status: null })).toBe("verify_required");
    expect(resolveBlockedReason({ hasToken: true, status: undefined })).toBe("link_expired");
  });
});
