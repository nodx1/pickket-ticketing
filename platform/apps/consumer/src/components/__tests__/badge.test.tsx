import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge } from "@pickket/ui";

describe("Badge", () => {
  // ── 기본 렌더링 ──
  it("renders with text content", () => {
    render(<Badge>응모중</Badge>);
    expect(screen.getByText("응모중")).toBeInTheDocument();
  });

  it("renders as a <span> element by default", () => {
    render(<Badge>Label</Badge>);
    const badge = screen.getByText("Label");
    expect(badge.tagName).toBe("SPAN");
  });

  it("has data-slot='badge' attribute", () => {
    render(<Badge>Slot</Badge>);
    expect(screen.getByText("Slot")).toHaveAttribute("data-slot", "badge");
  });

  // ── variant 테스트 ──
  describe("variants", () => {
    it("applies default variant", () => {
      render(<Badge variant="default">Default</Badge>);
      const badge = screen.getByText("Default");
      expect(badge).toHaveAttribute("data-variant", "default");
      expect(badge.className).toContain("bg-primary");
    });

    it("applies secondary variant", () => {
      render(<Badge variant="secondary">Secondary</Badge>);
      const badge = screen.getByText("Secondary");
      expect(badge).toHaveAttribute("data-variant", "secondary");
      expect(badge.className).toContain("bg-secondary");
    });

    it("applies destructive variant", () => {
      render(<Badge variant="destructive">Destructive</Badge>);
      const badge = screen.getByText("Destructive");
      expect(badge).toHaveAttribute("data-variant", "destructive");
      expect(badge.className).toContain("bg-destructive");
    });

    it("applies outline variant", () => {
      render(<Badge variant="outline">Outline</Badge>);
      const badge = screen.getByText("Outline");
      expect(badge).toHaveAttribute("data-variant", "outline");
      expect(badge.className).toContain("border-border");
    });

    it("applies ghost variant", () => {
      render(<Badge variant="ghost">Ghost</Badge>);
      const badge = screen.getByText("Ghost");
      expect(badge).toHaveAttribute("data-variant", "ghost");
    });

    it("applies link variant", () => {
      render(<Badge variant="link">Link</Badge>);
      const badge = screen.getByText("Link");
      expect(badge).toHaveAttribute("data-variant", "link");
      expect(badge.className).toContain("underline-offset-4");
    });

    it("uses default variant when none specified", () => {
      render(<Badge>NoVariant</Badge>);
      const badge = screen.getByText("NoVariant");
      expect(badge).toHaveAttribute("data-variant", "default");
      expect(badge.className).toContain("bg-primary");
    });
  });

  // ── 커스텀 className ──
  describe("custom className", () => {
    it("merges custom className with default classes", () => {
      render(<Badge className="my-custom">Custom</Badge>);
      const badge = screen.getByText("Custom");
      expect(badge.className).toContain("my-custom");
      expect(badge.className).toContain("inline-flex");
    });

    it("preserves rounded-full base class with custom className", () => {
      render(<Badge className="text-lg">Big Badge</Badge>);
      const badge = screen.getByText("Big Badge");
      expect(badge.className).toContain("rounded-full");
      expect(badge.className).toContain("text-lg");
    });
  });

  // ── asChild ──
  describe("asChild prop", () => {
    it("renders child element directly when asChild is true", () => {
      render(
        <Badge asChild>
          <a href="/events">Event Badge</a>
        </Badge>
      );
      const link = screen.getByRole("link", { name: "Event Badge" });
      expect(link).toBeInTheDocument();
      expect(link.tagName).toBe("A");
      expect(link).toHaveAttribute("href", "/events");
    });

    it("applies badge styles to child element when asChild", () => {
      render(
        <Badge asChild variant="destructive">
          <a href="/danger">Danger</a>
        </Badge>
      );
      const link = screen.getByRole("link");
      expect(link.className).toContain("bg-destructive");
    });
  });

  // ── HTML 속성 전달 ──
  it("passes through native span props", () => {
    render(
      <Badge data-testid="test-badge" aria-label="상태 배지">
        Status
      </Badge>
    );
    const badge = screen.getByTestId("test-badge");
    expect(badge).toHaveAttribute("aria-label", "상태 배지");
  });

  // ── 여러 badge 동시 렌더링 ──
  it("renders multiple badges with different variants", () => {
    render(
      <div>
        <Badge variant="default">당첨</Badge>
        <Badge variant="destructive">취소</Badge>
        <Badge variant="secondary">종료</Badge>
      </div>
    );
    expect(screen.getByText("당첨")).toBeInTheDocument();
    expect(screen.getByText("취소")).toBeInTheDocument();
    expect(screen.getByText("종료")).toBeInTheDocument();
  });
});
