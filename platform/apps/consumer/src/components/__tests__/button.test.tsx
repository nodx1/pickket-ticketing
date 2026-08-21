import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Button } from "@pickket/ui";

describe("Button", () => {
  // ── 기본 렌더링 ──
  it("renders with text content", () => {
    render(<Button>클릭하세요</Button>);
    expect(screen.getByRole("button", { name: "클릭하세요" })).toBeInTheDocument();
  });

  it("renders as a <button> element by default", () => {
    render(<Button>버튼</Button>);
    const btn = screen.getByRole("button");
    expect(btn.tagName).toBe("BUTTON");
  });

  // ── variant 테스트 ──
  describe("variants", () => {
    it("applies default variant data attribute", () => {
      render(<Button variant="default">Default</Button>);
      expect(screen.getByRole("button")).toHaveAttribute("data-variant", "default");
    });

    it("applies destructive variant", () => {
      render(<Button variant="destructive">Delete</Button>);
      const btn = screen.getByRole("button");
      expect(btn).toHaveAttribute("data-variant", "destructive");
      expect(btn.className).toContain("bg-destructive");
    });

    it("applies outline variant", () => {
      render(<Button variant="outline">Outline</Button>);
      const btn = screen.getByRole("button");
      expect(btn).toHaveAttribute("data-variant", "outline");
      expect(btn.className).toContain("border");
    });

    it("applies secondary variant", () => {
      render(<Button variant="secondary">Secondary</Button>);
      const btn = screen.getByRole("button");
      expect(btn).toHaveAttribute("data-variant", "secondary");
      expect(btn.className).toContain("bg-secondary");
    });

    it("applies ghost variant", () => {
      render(<Button variant="ghost">Ghost</Button>);
      expect(screen.getByRole("button")).toHaveAttribute("data-variant", "ghost");
    });

    it("applies link variant", () => {
      render(<Button variant="link">Link</Button>);
      const btn = screen.getByRole("button");
      expect(btn).toHaveAttribute("data-variant", "link");
      expect(btn.className).toContain("underline-offset-4");
    });
  });

  // ── size 테스트 ──
  describe("sizes", () => {
    it("applies default size data attribute", () => {
      render(<Button size="default">Default</Button>);
      expect(screen.getByRole("button")).toHaveAttribute("data-size", "default");
    });

    it("applies sm size", () => {
      render(<Button size="sm">Small</Button>);
      const btn = screen.getByRole("button");
      expect(btn).toHaveAttribute("data-size", "sm");
      expect(btn.className).toContain("h-8");
    });

    it("applies lg size", () => {
      render(<Button size="lg">Large</Button>);
      const btn = screen.getByRole("button");
      expect(btn).toHaveAttribute("data-size", "lg");
      expect(btn.className).toContain("h-10");
    });

    it("applies icon size", () => {
      render(<Button size="icon">I</Button>);
      const btn = screen.getByRole("button");
      expect(btn).toHaveAttribute("data-size", "icon");
      expect(btn.className).toContain("size-9");
    });

    it("applies xs size", () => {
      render(<Button size="xs">XS</Button>);
      const btn = screen.getByRole("button");
      expect(btn).toHaveAttribute("data-size", "xs");
      expect(btn.className).toContain("h-6");
    });
  });

  // ── 클릭 이벤트 핸들러 ──
  describe("click events", () => {
    it("calls onClick handler when clicked", () => {
      const handleClick = vi.fn();
      render(<Button onClick={handleClick}>Click Me</Button>);
      fireEvent.click(screen.getByRole("button"));
      expect(handleClick).toHaveBeenCalledTimes(1);
    });

    it("calls onClick multiple times on multiple clicks", () => {
      const handleClick = vi.fn();
      render(<Button onClick={handleClick}>Click</Button>);
      const btn = screen.getByRole("button");
      fireEvent.click(btn);
      fireEvent.click(btn);
      fireEvent.click(btn);
      expect(handleClick).toHaveBeenCalledTimes(3);
    });
  });

  // ── disabled 상태 ──
  describe("disabled state", () => {
    it("renders as disabled when disabled prop is true", () => {
      render(<Button disabled>Disabled</Button>);
      expect(screen.getByRole("button")).toBeDisabled();
    });

    it("has disabled styling (opacity-50)", () => {
      render(<Button disabled>Disabled</Button>);
      expect(screen.getByRole("button").className).toContain("disabled:opacity-50");
    });

    it("does not call onClick when disabled", () => {
      const handleClick = vi.fn();
      render(
        <Button disabled onClick={handleClick}>
          Disabled
        </Button>
      );
      fireEvent.click(screen.getByRole("button"));
      expect(handleClick).not.toHaveBeenCalled();
    });
  });

  // ── asChild prop ──
  describe("asChild prop", () => {
    it("renders children element directly when asChild is true", () => {
      render(
        <Button asChild>
          <a href="/test">Link Button</a>
        </Button>
      );
      const link = screen.getByRole("link", { name: "Link Button" });
      expect(link).toBeInTheDocument();
      expect(link.tagName).toBe("A");
      expect(link).toHaveAttribute("href", "/test");
    });

    it("merges button className onto child when asChild is true", () => {
      render(
        <Button asChild variant="destructive">
          <a href="/test">Styled Link</a>
        </Button>
      );
      const link = screen.getByRole("link");
      expect(link.className).toContain("bg-destructive");
    });
  });

  // ── 커스텀 className ──
  it("merges custom className with default classes", () => {
    render(<Button className="my-custom-class">Custom</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("my-custom-class");
    expect(btn.className).toContain("inline-flex");
  });

  // ── data-slot 속성 ──
  it("has data-slot='button' attribute", () => {
    render(<Button>Slot</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("data-slot", "button");
  });

  // ── HTML button 속성 전달 ──
  it("passes through native button props", () => {
    render(
      <Button type="submit" aria-label="제출 버튼" data-testid="submit-btn">
        Submit
      </Button>
    );
    const btn = screen.getByTestId("submit-btn");
    expect(btn).toHaveAttribute("type", "submit");
    expect(btn).toHaveAttribute("aria-label", "제출 버튼");
  });
});
