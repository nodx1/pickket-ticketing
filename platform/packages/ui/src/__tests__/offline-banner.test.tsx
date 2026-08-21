import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock the useNetworkStatus hook before importing the component
vi.mock("@pickket/lib/hooks", () => ({
  useNetworkStatus: vi.fn(),
}));

import { OfflineBanner } from "../offline-banner";
import { useNetworkStatus } from "@pickket/lib/hooks";

const mockUseNetworkStatus = vi.mocked(useNetworkStatus);

describe("OfflineBanner", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not render when online", () => {
    mockUseNetworkStatus.mockReturnValue({ isOnline: true });
    const { container } = render(<OfflineBanner />);
    expect(container.firstChild).toBeNull();
  });

  it("renders warning when offline", () => {
    mockUseNetworkStatus.mockReturnValue({ isOnline: false });
    render(<OfflineBanner />);
    expect(screen.getByText("인터넷 연결이 끊어졌습니다")).toBeInTheDocument();
  });

  it("has role='alert' for accessibility", () => {
    mockUseNetworkStatus.mockReturnValue({ isOnline: false });
    render(<OfflineBanner />);
    expect(screen.getByRole("alert")).toBeInTheDocument();
  });

  it("has destructive background when offline", () => {
    mockUseNetworkStatus.mockReturnValue({ isOnline: false });
    render(<OfflineBanner />);
    const alert = screen.getByRole("alert");
    expect(alert.className).toContain("bg-destructive");
  });

  it("is fixed position at top", () => {
    mockUseNetworkStatus.mockReturnValue({ isOnline: false });
    render(<OfflineBanner />);
    const alert = screen.getByRole("alert");
    expect(alert.className).toContain("fixed");
    expect(alert.className).toContain("top-0");
  });

  it("has high z-index", () => {
    mockUseNetworkStatus.mockReturnValue({ isOnline: false });
    render(<OfflineBanner />);
    expect(screen.getByRole("alert").className).toContain("z-[100]");
  });
});
