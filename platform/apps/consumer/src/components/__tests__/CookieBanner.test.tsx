import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";

// --- Mocks ---
vi.mock("motion/react", () => ({
  motion: {
    div: ({ children, ...props }: any) => {
      const {
        initial: _initial,
        animate: _animate,
        exit: _exit,
        transition: _transition,
        ...validProps
      } = props;
      return <div {...validProps}>{children}</div>;
    },
  },
  AnimatePresence: ({ children }: any) => <>{children}</>,
}));

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}));

vi.mock("@pickket/store", () => ({
  useAuthStore: () => ({ user: null }),
}));

vi.mock("@pickket/lib/api", () => ({
  updateConsent: vi.fn().mockResolvedValue({}),
}));

import CookieBanner from "../consent/CookieBanner";

const STORAGE_KEY = "pickket_cookie_consent";

describe("CookieBanner", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.clearAllMocks();
  });

  describe("initial visibility", () => {
    it("shows banner when no consent stored", () => {
      render(<CookieBanner />);
      expect(screen.getByText("쿠키 사용 안내")).toBeInTheDocument();
    });

    it("hides banner when consent already stored", () => {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          essential: true,
          analytics: true,
          marketing: true,
          timestamp: new Date().toISOString(),
        }),
      );
      render(<CookieBanner />);
      expect(screen.queryByText("쿠키 사용 안내")).not.toBeInTheDocument();
    });
  });

  describe("accept all", () => {
    it('hides banner after clicking "모두 수락"', async () => {
      render(<CookieBanner />);
      expect(screen.getByText("쿠키 사용 안내")).toBeInTheDocument();

      fireEvent.click(screen.getByText("모두 수락"));

      await waitFor(() => {
        expect(screen.queryByText("쿠키 사용 안내")).not.toBeInTheDocument();
      });
    });

    it("stores full consent in localStorage", () => {
      render(<CookieBanner />);
      fireEvent.click(screen.getByText("모두 수락"));

      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored.essential).toBe(true);
      expect(stored.analytics).toBe(true);
      expect(stored.marketing).toBe(true);
      expect(stored.timestamp).toBeDefined();
    });
  });

  describe("essential only", () => {
    it('hides banner after clicking "필수만"', async () => {
      render(<CookieBanner />);
      fireEvent.click(screen.getByText("필수만"));

      await waitFor(() => {
        expect(screen.queryByText("쿠키 사용 안내")).not.toBeInTheDocument();
      });
    });

    it("stores essential-only consent", () => {
      render(<CookieBanner />);
      fireEvent.click(screen.getByText("필수만"));

      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored.essential).toBe(true);
      expect(stored.analytics).toBe(false);
      expect(stored.marketing).toBe(false);
    });
  });

  describe("settings panel", () => {
    it('shows settings when "설정" is clicked', async () => {
      render(<CookieBanner />);
      fireEvent.click(screen.getByText("설정"));

      await waitFor(() => {
        expect(screen.getByText("필수 쿠키")).toBeInTheDocument();
        expect(screen.getByText("분석 쿠키")).toBeInTheDocument();
        expect(screen.getByText("마케팅 쿠키")).toBeInTheDocument();
      });
    });

    it('shows "설정 저장" button after opening settings', async () => {
      render(<CookieBanner />);
      fireEvent.click(screen.getByText("설정"));

      await waitFor(() => {
        expect(screen.getByText("설정 저장")).toBeInTheDocument();
      });
    });

    it("essential cookie is always active (not toggleable)", async () => {
      render(<CookieBanner />);
      fireEvent.click(screen.getByText("설정"));

      await waitFor(() => {
        expect(screen.getByText("항상 활성")).toBeInTheDocument();
      });
    });

    it("saves custom settings with analytics enabled", async () => {
      render(<CookieBanner />);
      fireEvent.click(screen.getByText("설정"));

      await waitFor(() => {
        expect(screen.getByText("분석 쿠키")).toBeInTheDocument();
      });

      // Find analytics checkbox
      const checkboxes = screen.getAllByRole("checkbox");
      // First checkbox is analytics, second is marketing
      fireEvent.click(checkboxes[0]); // enable analytics

      fireEvent.click(screen.getByText("설정 저장"));

      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored.essential).toBe(true);
      expect(stored.analytics).toBe(true);
      expect(stored.marketing).toBe(false);
    });

    it("saves custom settings with both analytics and marketing", async () => {
      render(<CookieBanner />);
      fireEvent.click(screen.getByText("설정"));

      await waitFor(() => {
        expect(screen.getByText("마케팅 쿠키")).toBeInTheDocument();
      });

      const checkboxes = screen.getAllByRole("checkbox");
      fireEvent.click(checkboxes[0]); // enable analytics
      fireEvent.click(checkboxes[1]); // enable marketing

      fireEvent.click(screen.getByText("설정 저장"));

      const stored = JSON.parse(localStorage.getItem(STORAGE_KEY)!);
      expect(stored.analytics).toBe(true);
      expect(stored.marketing).toBe(true);
    });

    it("hides banner after saving settings", async () => {
      render(<CookieBanner />);
      fireEvent.click(screen.getByText("설정"));

      await waitFor(() => {
        expect(screen.getByText("설정 저장")).toBeInTheDocument();
      });

      fireEvent.click(screen.getByText("설정 저장"));

      await waitFor(() => {
        expect(screen.queryByText("쿠키 사용 안내")).not.toBeInTheDocument();
      });
    });
  });

  describe("content", () => {
    it("shows description text", () => {
      render(<CookieBanner />);
      expect(
        screen.getByText(/서비스 개선과 맞춤형 경험을 위해/),
      ).toBeInTheDocument();
    });

    it("mentions essential cookies", () => {
      render(<CookieBanner />);
      expect(
        screen.getByText(/필수 쿠키는 서비스 운영에 필요/),
      ).toBeInTheDocument();
    });
  });

  describe("fixed positioning", () => {
    it("is fixed at bottom", () => {
      const { container } = render(<CookieBanner />);
      const outerDiv = container.firstChild as HTMLElement;
      if (outerDiv) {
        expect(outerDiv.className).toContain("fixed");
        expect(outerDiv.className).toContain("bottom-0");
      }
    });
  });
});
