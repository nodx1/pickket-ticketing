import { describe, it, expect, vi, beforeEach } from "vitest";
import React from "react";
import { render, screen, fireEvent, within } from "@testing-library/react";
import AdminSidebar from "../AdminSidebar";

let mockPathname = "/";
vi.mock("next/navigation", () => ({
  usePathname: () => mockPathname,
}));

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    onClick,
    className,
  }: {
    href: string;
    children: React.ReactNode;
    onClick?: () => void;
    className?: string;
  }) => (
    <a href={href} onClick={onClick} className={className}>
      {children}
    </a>
  ),
}));

const mockLogout = vi.fn();
vi.mock("@pickket/store", () => ({
  useAuthStore: () => ({
    user: { name: "관리자", email: "admin@pickket.kr", admin_role: "super_admin" },
    logout: mockLogout,
  }),
}));

// AlertDialog 계열은 내부 open state를 직접 관리하도록 stub 구현
let _dialogOpen = false;
vi.mock("@pickket/ui", () => ({
  AlertDialog: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogTrigger: ({
    children,
    asChild,
  }: {
    children?: React.ReactNode;
    asChild?: boolean;
  }) => {
    if (asChild && React.isValidElement(children)) {
      // asChild: 자식에게 onClick을 주입하여 다이얼로그 open 트리거
      return React.cloneElement(
        children as React.ReactElement<{ onClick?: () => void }>,
        {
          onClick: () => {
            _dialogOpen = true;
          },
        },
      );
    }
    return (
      <button
        type="button"
        onClick={() => {
          _dialogOpen = true;
        }}
      >
        {children}
      </button>
    );
  },
  AlertDialogContent: ({ children }: { children?: React.ReactNode }) => (
    <div role="alertdialog">{children}</div>
  ),
  AlertDialogDescription: ({ children }: { children?: React.ReactNode }) => (
    <p>{children}</p>
  ),
  AlertDialogFooter: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogHeader: ({ children }: { children?: React.ReactNode }) => (
    <div>{children}</div>
  ),
  AlertDialogTitle: ({ children }: { children?: React.ReactNode }) => (
    <h2>{children}</h2>
  ),
  AlertDialogAction: ({
    children,
    onClick,
  }: {
    children?: React.ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
  AlertDialogCancel: ({ children }: { children?: React.ReactNode }) => (
    <button type="button">{children}</button>
  ),
}));

describe("AdminSidebar", () => {
  beforeEach(() => {
    mockPathname = "/";
    mockLogout.mockClear();
  });

  it("renders Pickket Admin branding", () => {
    render(<AdminSidebar />);
    expect(screen.getByText("Pickket Admin")).toBeInTheDocument();
  });

  it("renders all visible nav items for super admin", () => {
    render(<AdminSidebar />);
    const expectedLabels = [
      "대시보드",
      "사용자",
      "이벤트",
      "주최자 관리",
      "매출/정산",
      "주문 관리",
      "알림 센터",
      "커뮤니티",
      "도메인 설정",
      "감사 로그",
      "시스템",
    ];
    for (const label of expectedLabels) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
  });

  it("highlights active nav item for root path", () => {
    mockPathname = "/";
    render(<AdminSidebar />);
    const dashboardLink = screen.getByText("대시보드").closest("a");
    expect(dashboardLink?.className).toContain("text-foreground");
    expect(dashboardLink?.className).toContain("bg-sidebar-accent");
  });

  it("highlights active nav item for /users path", () => {
    mockPathname = "/users";
    render(<AdminSidebar />);
    const usersLink = screen.getByText("사용자").closest("a");
    expect(usersLink?.className).toContain("text-foreground");
    expect(usersLink?.className).toContain("bg-sidebar-accent");
  });

  it("renders separator between nav groups", () => {
    const { container } = render(<AdminSidebar />);
    const separators = container.querySelectorAll(
      ".bg-sidebar-border.mx-4.my-2",
    );
    expect(separators.length).toBe(3);
  });

  it("renders user avatar and info", () => {
    render(<AdminSidebar />);
    // 아바타: 이름 첫 글자
    expect(screen.getByText("관")).toBeInTheDocument();
    // 이름
    expect(screen.getByText("관리자")).toBeInTheDocument();
    // 이메일은 maskEmail()로 마스킹 처리됨: admin@pickket.kr → a***@pickket.kr
    expect(screen.getByText("a***@pickket.kr")).toBeInTheDocument();
  });

  it("calls logout when logout is confirmed in dialog", () => {
    // AdminSidebar는 onLogout prop으로 로그아웃 핸들러를 받음
    render(<AdminSidebar onLogout={mockLogout} />);
    const logoutBtn = screen.getByLabelText("로그아웃");
    fireEvent.click(logoutBtn);
    // AlertDialogContent는 항상 렌더됨 (stub 구현)
    const dialog = screen.getByRole("alertdialog");
    // useTranslations stub은 키를 그대로 반환: t("confirm") → "confirm"
    const confirmButton = within(dialog).getByRole("button", {
      name: "confirm",
    });
    fireEvent.click(confirmButton);
    expect(mockLogout).toHaveBeenCalledTimes(1);
  });

  it("applies mobile mode classes when mode=mobile", () => {
    const { container } = render(<AdminSidebar mode="mobile" />);
    const aside = container.querySelector("aside");
    expect(aside?.className).toContain("h-full");
    expect(aside?.className).not.toContain("fixed");
    expect(aside?.className).not.toContain("hidden");
  });

  it("calls onNavigate when a nav link is clicked", () => {
    const onNavigate = vi.fn();
    render(<AdminSidebar onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText("이벤트"));
    expect(onNavigate).toHaveBeenCalledTimes(1);
  });
});
