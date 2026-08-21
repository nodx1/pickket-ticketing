// @vitest-environment jsdom
/**
 * 🔴 못 쓰는 티켓 화면 — **갈 곳이 있어야 한다.**
 *
 * 2026-08-02 대표 실사용 지적. 환불·취소된 티켓을 다시 열면 문의 메일 링크 하나뿐이었다.
 * 달력·지도·환불 링크는 전부 **사용 가능** 갈래에만 있다(early return 으로 갈라진다).
 *
 * 환불한 사람이 이 화면을 다시 여는 건 흔한 일이다 — 「내 티켓」에서 옛 티켓을 눌러본다.
 * 거기서 다른 날짜를 다시 사려 해도 갈 길이 없었다.
 *
 * ⚠️ 문구가 아니라 **href 값**을 단언한다. 버튼이 보여도 링크가 엉뚱하면 똑같이 막힌 길이다.
 */
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { TicketUnusableActions } from "./ticket-unusable-actions";

const SLUG = "bc카드한경-klpga-챔피언십";

function links() {
  return screen.getAllByRole("link").map((a) => ({
    text: (a.textContent ?? "").trim(),
    href: a.getAttribute("href"),
  }));
}

describe("못 쓰는 티켓에서 갈 곳", () => {
  it("🔴 행사 페이지로 갈 수 있다", () => {
    render(<TicketUnusableActions eventSlug={SLUG} />);
    const back = links().find((l) => l.text.includes("행사"));
    expect(back, "환불된 티켓 화면이 막다른 길이다").toBeDefined();
    expect(back?.href).toBe(`/e/${encodeURIComponent(SLUG)}`);
  });

  it("🔴 내 티켓 조회로 갈 수 있다", () => {
    render(<TicketUnusableActions eventSlug={SLUG} />);
    const mine = links().find((l) => l.text.includes("내 티켓"));
    expect(mine?.href).toBe("/my-tickets");
  });

  /**
   * 🔴 슬러그를 모르면 **버튼을 그리지 않는다.** `/e/undefined` 로 보내면
   *    404 로 떨어져 오히려 더 막힌다.
   */
  it("슬러그가 없으면 행사 버튼을 그리지 않는다 — 깨진 링크 금지", () => {
    for (const bad of [undefined, null, "", "  ", "undefined", "null"]) {
      const { unmount } = render(<TicketUnusableActions eventSlug={bad} />);
      const all = links();
      expect(all.every((l) => !(l.href ?? "").includes("undefined")), `깨진 링크: ${bad}`).toBe(true);
      expect(all.some((l) => l.href === "/my-tickets"), "내 티켓 조회까지 사라지면 안 된다").toBe(true);
      unmount();
    }
  });

  it("정상 슬러그면 링크가 둘 다 있다", () => {
    render(<TicketUnusableActions eventSlug={SLUG} />);
    expect(links().length).toBe(2);
  });
});
