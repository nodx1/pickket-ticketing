import { describe, expect, it } from "vitest";

import { buildCopyText, matchRoster, type RosterRow } from "./roster-lookup-panel";

/**
 * 🔴 현장 임시티켓 조회 (2026-08-19 업체 요청).
 *
 * 업체는 "이름·전화로 조회하는 현장 API"를 요청하려다 접었다 — 현장 API 는
 * **조회와 사용처리가 한 번에** 일어나 잘못 검색하면 남의 표가 사용처리된다.
 * 그래서 관리자 화면에서 **검색과 사용처리를 분리**한다.
 */
const rows: RosterRow[] = [
  { ticketNumber: "TKT-AAA", name: "홍길동", phone: "010-1234-5678",
    productName: "주중권", raffleNumber: 500179, status: "confirmed" },
  { ticketNumber: "TKT-BBB", name: "홍길순", phone: "01098765432",
    productName: "초대권", raffleNumber: null, status: "checked_in" },
];

describe("🔴 조회", () => {
  it("이름으로 찾는다", () => {
    expect(matchRoster(rows, "홍길동").map((r) => r.ticketNumber)).toEqual(["TKT-AAA"]);
  });

  it("🔴 전화번호로 찾는다 — QR 없는 손님을 처리하려면 이게 필요하다", () => {
    expect(matchRoster(rows, "9876").map((r) => r.ticketNumber)).toEqual(["TKT-BBB"]);
  });

  it("🔴 하이픈을 쳐도 찾는다 — 스태프가 010-1234 로 친다", () => {
    expect(matchRoster(rows, "010-1234").map((r) => r.ticketNumber)).toEqual(["TKT-AAA"]);
  });

  it("티켓번호로도 찾는다", () => {
    expect(matchRoster(rows, "tkt-bbb").map((r) => r.ticketNumber)).toEqual(["TKT-BBB"]);
  });

  it("🔴 빈 검색어는 전건을 쏟지 않는다 — 실수로 남의 표를 열지 않게", () => {
    expect(matchRoster(rows, "   ")).toEqual([]);
  });

  it("숫자 3자리 이하로는 전화 매칭을 하지 않는다(오탐 방지)", () => {
    expect(matchRoster(rows, "01").length).toBe(0);
  });
});

describe("🔴 복사값 — 임시티켓에 붙여넣는다", () => {
  it("이름·연락처·권종·경품번호 순서 (업체 요청)", () => {
    expect(buildCopyText(rows[0])).toBe("홍길동\t01012345678\t주중권\t500179");
  });

  it("🔴 연락처는 하이픈 없이 — 업체 파싱 기준과 같아야 한다", () => {
    expect(buildCopyText(rows[0])).not.toMatch(/-/);
  });

  it("경품번호가 없으면 빈칸으로 — '-' 같은 글자를 넣지 않는다", () => {
    expect(buildCopyText(rows[1])).toBe("홍길순\t01098765432\t초대권\t");
  });
});

/**
 * 🔴 배선 — 로직이 옳아도 값이 안 오면 화면은 빈칸이다 (2026-08-19).
 *
 * 같은 날 티켓 QR 건에서 컴포넌트만 고치고 **페이지가 안 넘겨** 프로덕션에 QR 이
 * 없었다. 그 실수를 여기서 반복하지 않는다.
 */
describe("🔴 API·화면 배선", () => {
  it("🔴 attendees API 가 경품번호를 내려준다", async () => {
    const { readFile } = await import("node:fs/promises");
    const s = await readFile("src/app/api/events/[eventId]/attendees/route.ts", "utf8");
    expect(s, "매핑이 빠지면 화면 경품번호가 영원히 빈칸이다").toMatch(
      /raffleNumber:\s*a\.raffle_number/,
    );
  });

  it("🔴 체크인 화면이 조회 패널에 명단을 넘긴다", async () => {
    const { readFile } = await import("node:fs/promises");
    const s = await readFile(
      "src/app/(dashboard)/events/[eventId]/check-in/_components/event-check-in-client.tsx",
      "utf8",
    );
    expect(s).toMatch(/<RosterLookupPanel[\s\S]*?rows=\{roster/);
    // 검색이 곧 체크인이 되면 안 된다 — 명시적 버튼으로만 처리한다.
    expect(s).toMatch(/onCheckIn=/);
  });

  it("훅이 명단 원본을 내보낸다 — 캐시 축약본에는 연락처가 없다", async () => {
    const { readFile } = await import("node:fs/promises");
    const s = await readFile(
      "src/app/(dashboard)/events/[eventId]/check-in/_components/use-check-in-data.ts",
      "utf8",
    );
    expect(s).toMatch(/setRoster\(rows\)/);
    expect(s).toMatch(/\broster,/);
  });
});
