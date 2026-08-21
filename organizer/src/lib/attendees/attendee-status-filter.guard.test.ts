import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { goAttendeeStatusToV2Tickets, projectToGoAttendeeStatus } from "@/lib/domain-model";

/**
 * 🔴 참석자 **상태 필터가 화면 표시와 어긋나지 않게** 고정한다 (2026-08-01 prod 실측).
 *
 * ## 무슨 일이 있었나
 * 참석자 화면은 상태를 이렇게 그린다:
 *
 *     checked_in_at 이 있으면 「체크인」, 없으면 v2 ticket status 투영(expired→취소됨)
 *
 * 그런데 목록 필터는 이 라우트에서 go→v2 로 **한 번 더 번역**해 넘겼고, 그 표가 1:1 이었다:
 *
 *     GO_TO_V2_TICKET_STATUS = { confirmed: "active", pending: "pending", cancelled: "cancelled" }
 *
 * 투영은 `cancelled` 와 `expired` 를 **둘 다** 「취소됨」으로 보내는 N:1 인데 역방향만 1:1 이라,
 * KLPGA prod 에서 **화면엔 「취소됨」 3건인데 취소 필터는 0건**이었다(expired 3건).
 * 「취소됨」 통계 카드도 같은 필터를 호출하므로 함께 0 이었다.
 *
 * 대회 당일에는 더 크게 걸린다 — 입장 처리가 티켓을 `used` 로 바꾸므로,
 * 「확정」 필터가 `active` 만 보면 **입장한 사람이 확정 목록에서 사라진다.**
 *
 * ## 이 가드가 지키는 것
 * 번역표를 손으로 두 벌 관리하지 않는다는 것. 어휘 해석은 v2 한 곳에 있고,
 * go 는 자기 어휘를 **그대로** 넘긴다.
 */
const ROUTE = path.join(process.cwd(), "src/app/api/events/[eventId]/attendees/route.ts");

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("참석자 상태 필터 — go 어휘를 그대로 넘긴다", () => {
  const code = stripComments(readFileSync(ROUTE, "utf8"));

  it("🔴 go→v2 번역표를 라우트에 두지 않는다 — 두 벌이 되면 언젠가 어긋난다", () => {
    expect(
      code,
      "어휘 해석은 v2(`attendee_go_to_v2_list`)가 투영표에서 **계산**한다. " +
        "여기서 다시 번역하면 표가 두 벌이 되고, 그게 취소 필터 0건의 원인이었다.",
    ).not.toMatch(/GO_TO_V2_TICKET_STATUS/);
    expect(code, 'v2 어휘("active")를 go 라우트가 직접 만들어 보내지 않는다').not.toMatch(/"active"/);
  });

  it("🔴 checked_in 을 전량 로드 후 클라이언트 필터링하지 않는다", () => {
    // 옛 우회: limit 10000 으로 전부 가져와 서버에서 걸렀다. 참석자가 늘면 느려지고,
    // 무엇보다 **표시 규칙이 두 곳에 갈라져 있던 원인**이었다.
    expect(code, "전량 로드 우회가 되살아났다").not.toMatch(/10000/);
    expect(code).toMatch(/listAttendees\(v2EventId, \{ status, q, limit, offset \}\)/);
  });

  it("아는 어휘만 v2 로 보낸다 — 모르는 값을 넘기면 v2 가 400 을 주고 화면이 통째로 깨진다", () => {
    expect(code).toMatch(/GO_ATTENDEE_STATUSES\.has\(goStatus\)/);
  });
});

/**
 * 🔴 역방향은 **투영표에서 계산**해야 한다. 손으로 뒤집으면 N:1 을 놓친다.
 *
 * ⚠️ 아래 기대값에 상수/함수를 참조하지 않는다 — 표를 통째로 갈아엎어도 여기서 걸리게 한다.
 */
describe("goAttendeeStatusToV2Tickets — 투영의 역상", () => {
  it("🔴 취소됨은 cancelled 와 expired 를 **둘 다** 포함한다", () => {
    expect(goAttendeeStatusToV2Tickets("cancelled").sort()).toEqual(["cancelled", "expired"]);
  });

  it("🔴 확정은 입장 완료(used)·양도(transferred)까지 포함한다 — 대회 당일 목록에서 사라지던 것", () => {
    expect(goAttendeeStatusToV2Tickets("confirmed").sort()).toEqual(["active", "transferred", "used"]);
  });

  it("대기는 pending 하나", () => {
    expect(goAttendeeStatusToV2Tickets("pending")).toEqual(["pending"]);
  });

  it("checked_in 은 status 가 아니라 checked_in_at 파생 — 역상이 비어야 한다", () => {
    expect(goAttendeeStatusToV2Tickets("checked_in")).toEqual([]);
  });

  it("🔴 v2 TicketStatus 6종이 빠짐없이 어딘가에 속한다 — 남으면 조용히 「대기」로 떨어진다", () => {
    const v2Statuses = ["pending", "active", "used", "transferred", "cancelled", "expired"];
    const covered = new Set(
      ["pending", "confirmed", "cancelled"].flatMap((go) => goAttendeeStatusToV2Tickets(go)),
    );
    const missing = v2Statuses.filter((s) => !covered.has(s));
    expect(missing, `투영표에 없는 v2 상태: ${missing.join(", ")}`).toEqual([]);
  });

  it("왕복이 일치한다 — 어느 상태를 투영해도 그 역상에 자기가 들어 있다", () => {
    for (const v2 of ["pending", "active", "used", "transferred", "cancelled", "expired"]) {
      expect(goAttendeeStatusToV2Tickets(projectToGoAttendeeStatus(v2))).toContain(v2);
    }
  });
});
