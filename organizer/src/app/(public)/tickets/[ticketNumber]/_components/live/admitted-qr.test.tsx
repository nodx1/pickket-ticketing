// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

import { AdmittedTicketPanel } from "./admitted-ticket-panel";

/**
 * 🔴 입장 후에도 티켓이 살아있어야 한다 (2026-08-19 대표 확정).
 *
 * 종전 전제는 "하루 1회 입장이라 QR 을 감춘다"였다. 실제 운영은 **종일 입장(재입장 자유)
 * + 경품추첨**이다. 감추면 점심 먹고 나갔다 온 손님이 게이트에서 QR 을 못 내민다.
 */
vi.mock("../rotating-ticket-qr", () => ({
  RotatingTicketQR: ({ initialImage }: { initialImage: string }) => (
    <img alt="입장 QR" src={initialImage} />
  ),
}));

const base = {
  ticketNumber: "TKT-0000AAAA1111",
  eventTitle: "BC카드·한경 제48회 KLPGA 챔피언십",
  attendeeName: "홍길동",
  gradeLabel: "주중권",
  scheduleText: null,
  venueText: null,
  raffleNumber: 500179,
};

describe("🔴 입장 후 화면", () => {
  it("🔴 QR 이 계속 보인다 — 재입장 때 다시 필요하다", () => {
    render(<AdmittedTicketPanel {...base} qrImage="data:image/png;base64,AAA" />);
    expect(screen.getByAltText("입장 QR"), "입장하면 QR 이 사라진다").toBeInTheDocument();
  });

  it("🔴 경품 응모번호가 크게 보인다 — 추첨 때 스태프가 육안 확인한다", () => {
    render(<AdmittedTicketPanel {...base} qrImage="data:image/png;base64,AAA" />);
    expect(screen.getByText("500179")).toBeInTheDocument();
  });

  it("입장 완료 배지는 남는다 — 사실은 알려야 한다", () => {
    render(<AdmittedTicketPanel {...base} qrImage="data:image/png;base64,AAA" />);
    expect(screen.getByText("입장 완료")).toBeInTheDocument();
  });

  it("종일 입장·재입장 안내가 있다", () => {
    render(<AdmittedTicketPanel {...base} qrImage="data:image/png;base64,AAA" />);
    expect(screen.getByText(/다시 들어오실 때도/)).toBeInTheDocument();
  });

  it("QR 이 없으면(사용 불가 티켓) 안 그린다 — 빈 상자를 만들지 않는다", () => {
    render(<AdmittedTicketPanel {...base} qrImage={null} />);
    expect(screen.queryByAltText("입장 QR")).toBeNull();
  });
});

/**
 * 🔴 배선 — 화면 컴포넌트가 옳아도 페이지가 안 넘기면 QR 은 안 뜬다 (2026-08-19 실측).
 *
 * 첫 배포 때 `AdmittedTicketPanel` 은 고쳤는데 **초대권 갈래에서 qrImage 를 안 넘겨**
 * 프로덕션 화면에 QR 이 없었다. 컴포넌트 테스트 5건은 전부 초록이었다.
 */
describe("🔴 페이지가 두 갈래 모두에 QR 을 넘긴다", () => {
  it("🔴 showLive 분기 전부에서 qrImage 를 전달한다", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      "src/app/(public)/tickets/[ticketNumber]/page.tsx",
      "utf8",
    );
    const panels = src.match(/<AdmittedTicketPanel[\s\S]*?\/>/g) ?? [];
    expect(panels.length, "패널 사용처를 못 찾았다").toBeGreaterThan(0);
    for (const p of panels) {
      expect(p, `qrImage 를 안 넘기는 갈래가 있다:\n${p}`).toMatch(/qrImage=/);
      expect(p, `qrAccessToken 을 안 넘기는 갈래가 있다`).toMatch(/qrAccessToken=/);
    }
  });
});

/**
 * 🔴 대회 첫날 현장 지적 (2026-08-20).
 *
 * ① 입장하면 라이브 화면 기본 탭이 「홈」이라 티켓이 5번째 탭에 숨었다.
 *    재입장 손님이 QR 을 못 찾아 게이트에 줄이 선다.
 * ② 주중권+주말권을 함께 산 손님이 한 장을 찍으면 이 패널로 바뀌는데,
 *    형제 전환 줄이 없어 **나머지 티켓으로 갈 길이 사라졌다**.
 */
describe("🔴 입장 후에도 형제 티켓으로 갈 수 있다", () => {
  const two = [
    { ticketNumber: "TKT-A", dayLabel: "주중권", href: "/tickets/TKT-A?t=x", isCurrent: true },
    { ticketNumber: "TKT-B", dayLabel: "주말권", href: "/tickets/TKT-B?t=y", isCurrent: false },
  ];

  it("🔴 2장 이상이면 전환 줄이 뜬다", () => {
    render(<AdmittedTicketPanel {...base} qrImage="data:image/png;base64,AAA" orderTickets={two} />);
    expect(screen.getByText(/이 주문의 티켓 2장/)).toBeInTheDocument();
  });

  it("1장뿐이면 안 뜬다 — 빈 줄을 만들지 않는다", () => {
    render(
      <AdmittedTicketPanel {...base} qrImage="data:image/png;base64,AAA"
        orderTickets={[two[0]]} />,
    );
    expect(screen.queryByText(/이 주문의 티켓/)).toBeNull();
  });
});

describe("🔴 페이지가 두 갈래 모두에 형제 티켓을 넘긴다", () => {
  it("AdmittedTicketPanel 사용처 전부가 orderTickets 를 전달한다", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile("src/app/(public)/tickets/[ticketNumber]/page.tsx", "utf8");
    const panels = src.match(/<AdmittedTicketPanel[\s\S]*?\/>/g) ?? [];
    expect(panels.length).toBeGreaterThan(0);
    for (const p of panels) {
      expect(p, `orderTickets 를 안 넘기는 갈래가 있다:\n${p}`).toMatch(/orderTickets=/);
    }
  });

  it("🔴 라이브 화면 기본 탭이 「티켓」이다 — 게이트에서 제일 급하다", async () => {
    const { readFile } = await import("node:fs/promises");
    const src = await readFile(
      "src/app/(public)/tickets/[ticketNumber]/_components/live/live-view.tsx", "utf8");
    expect(src).toMatch(/useState<TabId>\("ticket"\)/);
  });
});
