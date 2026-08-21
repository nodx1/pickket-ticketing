import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import DemandBadge from "@/components/ui/DemandBadge";

describe("DemandBadge", () => {
  // ── HIGH 수요 (bidCount/totalSeats >= 2) ──
  describe("HIGH demand", () => {
    it('shows "경쟁 치열" when ratio >= 2', () => {
      render(<DemandBadge bidCount={200} totalSeats={100} />);
      expect(screen.getByText("경쟁 치열")).toBeInTheDocument();
    });

    it("applies red background for HIGH demand", () => {
      render(<DemandBadge bidCount={500} totalSeats={100} />);
      const badge = screen.getByText("경쟁 치열").closest("span");
      expect(badge?.className).toContain("bg-red-500");
    });

    it("has pulse animation for HIGH demand", () => {
      render(<DemandBadge bidCount={300} totalSeats={100} />);
      const badge = screen.getByText("경쟁 치열").closest("span");
      expect(badge?.className).toContain("animate-pulse");
    });
  });

  // ── MEDIUM 수요 (1 <= ratio < 2) ──
  describe("MEDIUM demand", () => {
    it('shows "인기" when ratio >= 1 and < 2', () => {
      render(<DemandBadge bidCount={150} totalSeats={100} />);
      expect(screen.getByText("인기")).toBeInTheDocument();
    });

    it("applies orange background for MEDIUM demand", () => {
      render(<DemandBadge bidCount={100} totalSeats={100} />);
      const badge = screen.getByText("인기").closest("span");
      expect(badge?.className).toContain("bg-orange-500");
    });

    it("does not have pulse animation for MEDIUM", () => {
      render(<DemandBadge bidCount={100} totalSeats={100} />);
      const badge = screen.getByText("인기").closest("span");
      expect(badge?.className).not.toContain("animate-pulse");
    });
  });

  // ── LOW 수요 (ratio >= 0.3 또는 bidCount === 0) ──
  describe("LOW demand", () => {
    it('shows "여유" when ratio >= 0.3 and < 1', () => {
      render(<DemandBadge bidCount={50} totalSeats={100} />);
      expect(screen.getByText("여유")).toBeInTheDocument();
    });

    it("applies green background for LOW demand", () => {
      render(<DemandBadge bidCount={50} totalSeats={100} />);
      const badge = screen.getByText("여유").closest("span");
      expect(badge?.className).toContain("bg-green-500");
    });

    it('shows "여유" when bidCount is 0', () => {
      render(<DemandBadge bidCount={0} totalSeats={100} />);
      expect(screen.getByText("여유")).toBeInTheDocument();
    });
  });

  // ── HIDDEN_GEM (ratio < 0.3, bidCount > 0) ──
  describe("HIDDEN_GEM demand", () => {
    it('shows "숨은 명작" when ratio < 0.3 and bidCount > 0', () => {
      render(<DemandBadge bidCount={10} totalSeats={100} />);
      expect(screen.getByText("숨은 명작")).toBeInTheDocument();
    });

    it("applies purple background for HIDDEN_GEM", () => {
      render(<DemandBadge bidCount={5} totalSeats={100} />);
      const badge = screen.getByText("숨은 명작").closest("span");
      expect(badge?.className).toContain("bg-purple-600");
    });
  });

  // ── 엣지 케이스 ──
  describe("edge cases", () => {
    it("handles totalSeats = 0 gracefully", () => {
      render(<DemandBadge bidCount={10} totalSeats={0} />);
      // ratio = 0 when totalSeats is 0, bidCount > 0 but ratio < 0.3
      // getDemandLevel: ratio = 0, bidCount > 0 => HIDDEN_GEM
      expect(screen.getByText("숨은 명작")).toBeInTheDocument();
    });

    it("handles exact boundary ratio = 2", () => {
      render(<DemandBadge bidCount={200} totalSeats={100} />);
      expect(screen.getByText("경쟁 치열")).toBeInTheDocument();
    });

    it("handles exact boundary ratio = 1", () => {
      render(<DemandBadge bidCount={100} totalSeats={100} />);
      expect(screen.getByText("인기")).toBeInTheDocument();
    });
  });

  // ── 커스텀 className ──
  it("merges custom className", () => {
    render(
      <DemandBadge bidCount={50} totalSeats={100} className="extra-class" />,
    );
    const badge = screen.getByText("여유").closest("span");
    expect(badge?.className).toContain("extra-class");
  });

  // ── 공통 스타일 ──
  it("has base styling (text-white, rounded-full)", () => {
    render(<DemandBadge bidCount={50} totalSeats={100} />);
    const badge = screen.getByText("여유").closest("span");
    expect(badge?.className).toContain("text-white");
    expect(badge?.className).toContain("rounded-full");
  });

  // ── 점(dot) indicator 확인 ──
  it("renders a dot indicator inside the badge", () => {
    const { container } = render(
      <DemandBadge bidCount={50} totalSeats={100} />,
    );
    const dot = container.querySelector(".w-1\\.5.h-1\\.5.rounded-full");
    expect(dot).toBeInTheDocument();
  });
});
