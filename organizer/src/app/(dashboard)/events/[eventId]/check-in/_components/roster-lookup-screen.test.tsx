// @vitest-environment jsdom
/**
 * 🔴 화면을 **실제로 눌러본다** (2026-08-19).
 *
 * 같은 날 티켓 QR 건에서 컴포넌트 단위 테스트 5건이 전부 초록인 채
 * 프로덕션 화면에는 QR 이 없었다. "함수가 옳다"와 "화면이 그렇게 동작한다"는 다르다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { RosterLookupPanel, type RosterRow } from "./roster-lookup-panel";

const writeText = vi.fn();
const rows: RosterRow[] = [
  { ticketNumber: "TKT-AAA", name: "홍길동", phone: "010-1234-5678",
    productName: "주중권 (목 1R ~ 금 2R)", raffleNumber: 500179, status: "confirmed" },
  { ticketNumber: "TKT-BBB", name: "김철수", phone: "01098765432",
    productName: "초대권", raffleNumber: null, status: "checked_in" },
];

beforeEach(() => {
  writeText.mockReset().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText } });
});

describe("🔴 현장 조회 화면", () => {
  it("🔴 이름을 치면 그 사람만 나온다", async () => {
    render(<RosterLookupPanel rows={rows} onCheckIn={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/이름 · 연락처 · 티켓번호/), "홍길동");
    expect(screen.getByText("홍길동")).toBeInTheDocument();
    expect(screen.queryByText("김철수")).toBeNull();
  });

  it("🔴 전화 뒷자리로도 찾는다 — QR 없는 손님 처리의 핵심이다", async () => {
    render(<RosterLookupPanel rows={rows} onCheckIn={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/이름 · 연락처 · 티켓번호/), "9876");
    expect(screen.getByText("김철수")).toBeInTheDocument();
  });

  it("🔴 검색만으로는 입장 처리되지 않는다 — 업체가 우려한 바로 그 지점", async () => {
    const onCheckIn = vi.fn();
    render(<RosterLookupPanel rows={rows} onCheckIn={onCheckIn} />);
    await userEvent.type(screen.getByLabelText(/이름 · 연락처 · 티켓번호/), "홍길동");
    expect(onCheckIn, "검색이 곧 사용처리가 되면 남의 표가 탄다").not.toHaveBeenCalled();
  });

  it("🔴 「입장 처리」를 눌러야 그 티켓으로 체크인된다", async () => {
    const onCheckIn = vi.fn();
    render(<RosterLookupPanel rows={rows} onCheckIn={onCheckIn} />);
    await userEvent.type(screen.getByLabelText(/이름 · 연락처 · 티켓번호/), "홍길동");
    await userEvent.click(screen.getByRole("button", { name: "입장 처리" }));
    expect(onCheckIn).toHaveBeenCalledWith("TKT-AAA");
  });

  it("🔴 전체 복사가 임시티켓 양식대로 클립보드에 들어간다", async () => {
    render(<RosterLookupPanel rows={rows} onCheckIn={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/이름 · 연락처 · 티켓번호/), "홍길동");
    await userEvent.click(screen.getByRole("button", { name: "전체 복사" }));
    expect(writeText).toHaveBeenCalledWith("홍길동\t01012345678\t주중권 (목 1R ~ 금 2R)\t500179");
  });

  it("🔴 연락처 복사는 하이픈 없이 — 업체 파싱 기준", async () => {
    render(<RosterLookupPanel rows={rows} onCheckIn={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/이름 · 연락처 · 티켓번호/), "홍길동");
    await userEvent.click(screen.getByRole("button", { name: "연락처 복사" }));
    expect(writeText).toHaveBeenCalledWith("01012345678");
  });

  it("경품번호가 화면에 보인다 — 추첨 연락의 기준", async () => {
    render(<RosterLookupPanel rows={rows} onCheckIn={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/이름 · 연락처 · 티켓번호/), "홍길동");
    expect(screen.getByText("500179")).toBeInTheDocument();
  });

  it("이미 입장한 사람은 배지로 구분된다 — 중복 발급을 막는다", async () => {
    render(<RosterLookupPanel rows={rows} onCheckIn={vi.fn()} />);
    await userEvent.type(screen.getByLabelText(/이름 · 연락처 · 티켓번호/), "김철수");
    expect(screen.getByText("입장 완료")).toBeInTheDocument();
  });

  it("🔴 빈 검색어에 전건이 쏟아지지 않는다", () => {
    render(<RosterLookupPanel rows={rows} onCheckIn={vi.fn()} />);
    expect(screen.queryByText("홍길동")).toBeNull();
    expect(screen.queryByText("김철수")).toBeNull();
  });
});
