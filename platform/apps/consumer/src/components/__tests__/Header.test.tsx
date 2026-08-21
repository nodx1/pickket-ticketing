import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ReactElement } from "react";
import {
  render as rtlRender,
  screen,
  type RenderOptions,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// Header 는 로그아웃 시 RQ 캐시를 비우려 useQueryClient 를 사용한다(공유기기 PII 정리, P2-C20/C22).
// 따라서 테스트도 QueryClientProvider 로 감싸야 한다(런타임은 layout 이 감쌈).
const testQueryClient = new QueryClient();
function render(ui: ReactElement, options?: Omit<RenderOptions, "wrapper">) {
  return rtlRender(ui, {
    wrapper: ({ children }) => (
      <QueryClientProvider client={testQueryClient}>
        {children}
      </QueryClientProvider>
    ),
    ...options,
  });
}

// --- Mocks ---
const mockPush = vi.fn();
const mockRouterRefresh = vi.fn();

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    push: mockPush,
    refresh: mockRouterRefresh,
    back: vi.fn(),
    replace: vi.fn(),
    forward: vi.fn(),
    prefetch: vi.fn(),
  }),
  usePathname: () => "/",
  useSearchParams: () => new URLSearchParams(),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: any) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@pickket/store", () => ({
  useAuthStore: vi.fn(),
}));

vi.mock("@/components/nav/NavLinks", () => ({
  DesktopNavLinks: () => <nav data-testid="desktop-nav-links">Links</nav>,
}));

vi.mock("@/components/nav/SearchBar", () => ({
  default: () => <div data-testid="navbar-search">Search</div>,
}));

// ThemeToggle は現在 Header から削除済み (라이트모드 고정)
// DesktopNav は Header から削除済み — DesktopNavLinks + 인라인 버튼으로 교체됨

vi.mock("@/components/nav/MobileNav", () => ({
  default: ({ open, onOpenChange: _onOpenChange, onLogout }: any) => (
    <div data-testid="mobile-nav" data-open={open}>
      <button data-testid="mobile-logout-btn" onClick={onLogout}>
        Mobile Logout
      </button>
    </div>
  ),
}));

import Header from "../common/Header";
import { useAuthStore } from "@pickket/store";

const mockUseAuthStore = vi.mocked(useAuthStore) as any;

describe("Header", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseAuthStore.mockReturnValue({ logout: vi.fn() });
  });

  it("renders the Pickket logo link", () => {
    render(<Header />);
    const logo = screen.getByLabelText("Pickket Home");
    expect(logo).toBeInTheDocument();
    expect(logo).toHaveAttribute("href", "/");
  });

  it("renders header element", () => {
    const { container } = render(<Header />);
    const header = container.querySelector("header");
    expect(header).toBeInTheDocument();
  });

  it("renders nav element", () => {
    const { container } = render(<Header />);
    const nav = container.querySelector("nav");
    expect(nav).toBeInTheDocument();
  });

  it("renders DesktopNavLinks", () => {
    render(<Header />);
    expect(screen.getByTestId("desktop-nav-links")).toBeInTheDocument();
  });

  // ThemeToggle은 라이트모드 고정으로 Header에서 제거됨 — 테스트 삭제

  it("renders SearchBar", () => {
    render(<Header />);
    expect(screen.getByTestId("navbar-search")).toBeInTheDocument();
  });

  // DesktopNav 컴포넌트는 DesktopNavLinks + 인라인 버튼으로 교체됨 — 테스트 삭제

  it("renders MobileNav", () => {
    render(<Header />);
    expect(screen.getByTestId("mobile-nav")).toBeInTheDocument();
  });

  it("has sticky positioning", () => {
    const { container } = render(<Header />);
    const header = container.querySelector("header");
    expect(header?.className).toContain("fixed");
    expect(header?.className).toContain("top-0");
  });

  it("has high z-index", () => {
    const { container } = render(<Header />);
    const header = container.querySelector("header");
    expect(header?.className).toContain("z-50");
  });

  describe("logout flow", () => {
    // 데스크톱 전용 로그아웃 버튼은 제거됨 — MobileNav의 onLogout 핸들러로 통합

    it("calls logout and navigates to home on mobile logout", () => {
      const mockLogoutFn = vi.fn();
      mockUseAuthStore.mockReturnValue({ logout: mockLogoutFn });

      render(<Header />);
      const mobileLogoutBtn = screen.getByTestId("mobile-logout-btn");
      mobileLogoutBtn.click();

      expect(mockLogoutFn).toHaveBeenCalledTimes(1);
      expect(mockPush).toHaveBeenCalledWith("/");
    });
  });

  describe("logo", () => {
    it("shows pickket brand text in logo", () => {
      render(<Header />);
      // 로고는 gradient 아이콘 없이 텍스트 스팬으로 구성됨
      const brandText = screen.getAllByText(/pickket/i);
      expect(brandText.length).toBeGreaterThan(0);
    });

    it("logo link has correct aria-label", () => {
      render(<Header />);
      const logo = screen.getByLabelText("Pickket Home");
      expect(logo).toBeInTheDocument();
      expect(logo).toHaveAttribute("href", "/");
    });
  });
});
