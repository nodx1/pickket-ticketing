import { describe, expect, it } from "vitest";
import { projectToGoEventStatus, goToV2WriteEventStatus } from "./domain-model";

/**
 * 🔴 2026-07-27 prod 실검증에서 잡은 결함 회귀.
 *
 * 레벨2 컷오버로 **v2 가 이벤트 상태의 유일한 출처**가 됐는데, v2→go 투영이
 * `pending_review`/`under_review`/`revision_requested` 를 전부 `draft` 로 뭉개고 있었다.
 * 증상:
 *   · 심사 요청이 v2 에 정상 저장돼도(200 success) 화면 상태는 계속 `draft`
 *     → 주최자는 요청이 접수됐는지 알 수 없고 버튼을 반복해 누른다(실제 재현).
 *   · 반려도 `draft` 로 보여 **반려 사실 자체가 화면에서 사라진다**.
 * go 상태머신·EVENT_STATUS 는 애초에 6-상태라, 투영만 4-상태였던 것이 불일치였다.
 */
describe("projectToGoEventStatus — 심사 상태가 draft 로 뭉개지지 않는다", () => {
  it("심사 요청은 pending_review 로 보존된다", () => {
    expect(projectToGoEventStatus("pending_review")).toBe("pending_review");
  });

  it("심사 진행중(under_review)도 주최자에겐 pending_review — '요청 접수됨'으로 동일", () => {
    expect(projectToGoEventStatus("under_review")).toBe("pending_review");
  });

  it("반려(revision_requested)는 rejected 로 보존된다 — draft 로 숨기지 않는다", () => {
    expect(projectToGoEventStatus("revision_requested")).toBe("rejected");
  });

  it("승인 계열은 live", () => {
    for (const s of ["approved", "bidding_open", "bidding_closed", "allocating", "allocated"] as const) {
      expect(projectToGoEventStatus(s)).toBe("live");
    }
  });

  it("종료 계열은 archived", () => {
    expect(projectToGoEventStatus("completed")).toBe("archived");
    expect(projectToGoEventStatus("cancelled")).toBe("archived");
  });

  it("draft 는 draft", () => {
    expect(projectToGoEventStatus("draft")).toBe("draft");
  });
});

describe("goToV2WriteEventStatus — write 매핑은 왕복 가능해야 한다", () => {
  it("심사 요청/반려가 v2 값으로 왕복된다", () => {
    expect(goToV2WriteEventStatus("pending_review")).toBe("pending_review");
    expect(projectToGoEventStatus("pending_review")).toBe("pending_review");
    expect(goToV2WriteEventStatus("rejected")).toBe("revision_requested");
    expect(projectToGoEventStatus("revision_requested")).toBe("rejected");
  });

  it("paused 는 v2 미구현이라 null(=status 필드 생략)", () => {
    expect(goToV2WriteEventStatus("paused")).toBeNull();
  });
});
