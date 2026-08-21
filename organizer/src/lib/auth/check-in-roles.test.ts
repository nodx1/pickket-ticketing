import { describe, expect, it } from "vitest";

import { hasPermission } from "./permissions";

/**
 * 🔴 게이트 화면이 실제로 열리는지를 권한 레벨로 고정한다.
 *
 * 실사고: 스캔 API(`POST /check-in`)는 `staff` 를 요구하는데, 그 화면이 로드하는
 * `GET /check-in-lists` 가 `organizer` 를 요구하고 있었다. staff 계정은 스캔 권한이
 * 있는데도 **리스트가 비어 화면이 먹통**이 됐고, UI 는 "체크인 리스트가 없습니다
 * (먼저 만드세요)" 라는 틀린 안내를 띄웠다. 대회 나흘간 게이트 인력이 전부 이 상태면
 * 주최자 슈퍼계정 없이는 아무도 입장 처리를 못 한다.
 *
 * → 스캔에 필요한 **읽기 권한은 스캔 권한과 같거나 낮아야** 한다. 이 불변식을 고정한다.
 */

/** 실제 라우트가 요구하는 역할 — 라우트를 바꾸면 이 표도 같이 바꿔야 한다. */
const REQUIRED = {
  /** POST /api/events/[eventId]/check-in — 스캔·수동 체크인 */
  scan: "staff",
  /** DELETE /api/events/[eventId]/check-in — 입장 취소 */
  revoke: "staff",
  /** GET /api/events/[eventId]/check-in-lists — 화면 로드에 **필수** */
  readLists: "staff",
  /** POST/PATCH/DELETE /check-in-lists — 리스트 편집(스태프에게 열면 안 된다) */
  writeLists: "organizer",
} as const;

describe("게이트 권한 경계", () => {
  it("🔴 스캔할 수 있는 역할은 체크인 리스트도 읽을 수 있어야 한다", () => {
    // 이게 깨지면 게이트 화면이 조용히 먹통이 된다(리스트 빈 배열 → 스캐너 미렌더).
    for (const role of ["owner", "admin", "organizer", "staff"] as const) {
      const canScan = hasPermission(role, REQUIRED.scan);
      const canReadLists = hasPermission(role, REQUIRED.readLists);
      expect(
        !canScan || canReadLists,
        `${role} 은 스캔은 되는데 리스트를 못 읽는다 — 화면이 열리지 않는다`,
      ).toBe(true);
    }
  });

  it("운영스태프(staff)는 게이트를 운영할 수 있다", () => {
    expect(hasPermission("staff", REQUIRED.scan)).toBe(true);
    expect(hasPermission("staff", REQUIRED.revoke)).toBe(true);
    expect(hasPermission("staff", REQUIRED.readLists)).toBe(true);
  });

  it("운영스태프는 리스트를 편집할 수 없다 — 읽기만 열었지 쓰기는 아니다", () => {
    expect(hasPermission("staff", REQUIRED.writeLists)).toBe(false);
  });

  it("주최자 이상은 전부 가능", () => {
    for (const role of ["owner", "admin", "organizer"] as const) {
      expect(hasPermission(role, REQUIRED.scan)).toBe(true);
      expect(hasPermission(role, REQUIRED.readLists)).toBe(true);
      expect(hasPermission(role, REQUIRED.writeLists)).toBe(true);
    }
  });

  it("⚠️ check_in 역할은 현재 스캔조차 못 한다 — 이름과 실제가 어긋나 있다", () => {
    // 이건 정책 결정 대기 항목이다(역할을 올릴지, 역할을 없앨지).
    // 지금 상태를 **명시적으로 고정**해 두어, 바뀌면 의식적으로 이 테스트를 고치게 한다.
    expect(hasPermission("check_in", REQUIRED.scan)).toBe(false);
    expect(hasPermission("check_in", REQUIRED.readLists)).toBe(false);
  });
});
