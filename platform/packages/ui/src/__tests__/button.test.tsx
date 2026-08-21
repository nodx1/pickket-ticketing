import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Button } from "../button";

describe("Button", () => {
  it("renders with text content", () => {
    render(<Button>Click me</Button>);
    expect(screen.getByRole("button", { name: "Click me" })).toBeInTheDocument();
  });

  it("renders as a <button> element by default", () => {
    render(<Button>Btn</Button>);
    expect(screen.getByRole("button").tagName).toBe("BUTTON");
  });

  it("has data-slot='button'", () => {
    render(<Button>Slot</Button>);
    expect(screen.getByRole("button")).toHaveAttribute("data-slot", "button");
  });

  describe("variants", () => {
    const variants = ["default", "destructive", "outline", "secondary", "ghost", "link"] as const;
    for (const variant of variants) {
      it(`applies data-variant="${variant}"`, () => {
        render(<Button variant={variant}>{variant}</Button>);
        expect(screen.getByRole("button")).toHaveAttribute("data-variant", variant);
      });
    }

    it("applies destructive styles", () => {
      render(<Button variant="destructive">Del</Button>);
      expect(screen.getByRole("button").className).toContain("bg-destructive");
    });

    it("applies outline border", () => {
      render(<Button variant="outline">Outline</Button>);
      expect(screen.getByRole("button").className).toContain("border");
    });
  });

  describe("sizes", () => {
    it("applies data-size for each size", () => {
      const sizes = ["default", "sm", "lg", "icon", "xs"] as const;
      for (const size of sizes) {
        const { unmount } = render(<Button size={size}>{size}</Button>);
        expect(screen.getByRole("button")).toHaveAttribute("data-size", size);
        unmount();
      }
    });

    it("sm size includes h-8", () => {
      render(<Button size="sm">Small</Button>);
      expect(screen.getByRole("button").className).toContain("h-8");
    });

    it("lg size includes h-10", () => {
      render(<Button size="lg">Large</Button>);
      expect(screen.getByRole("button").className).toContain("h-10");
    });
  });

  describe("click events", () => {
    it("fires onClick once", () => {
      const handler = vi.fn();
      render(<Button onClick={handler}>Go</Button>);
      fireEvent.click(screen.getByRole("button"));
      expect(handler).toHaveBeenCalledTimes(1);
    });

    it("accumulates multiple clicks", () => {
      const handler = vi.fn();
      render(<Button onClick={handler}>Go</Button>);
      fireEvent.click(screen.getByRole("button"));
      fireEvent.click(screen.getByRole("button"));
      expect(handler).toHaveBeenCalledTimes(2);
    });
  });

  describe("disabled state", () => {
    it("is disabled when prop is set", () => {
      render(<Button disabled>Off</Button>);
      expect(screen.getByRole("button")).toBeDisabled();
    });

    it("does not fire onClick when disabled", () => {
      const handler = vi.fn();
      render(<Button disabled onClick={handler}>Off</Button>);
      fireEvent.click(screen.getByRole("button"));
      expect(handler).not.toHaveBeenCalled();
    });
  });

  describe("asChild", () => {
    it("renders child element when asChild is true", () => {
      render(
        <Button asChild>
          <a href="/test">Link</a>
        </Button>
      );
      const link = screen.getByRole("link", { name: "Link" });
      expect(link.tagName).toBe("A");
      expect(link).toHaveAttribute("href", "/test");
    });

    it("merges className onto child", () => {
      render(
        <Button asChild variant="destructive">
          <a href="/x">Styled</a>
        </Button>
      );
      expect(screen.getByRole("link").className).toContain("bg-destructive");
    });
  });

  it("merges custom className", () => {
    render(<Button className="my-cls">Custom</Button>);
    const btn = screen.getByRole("button");
    expect(btn.className).toContain("my-cls");
    expect(btn.className).toContain("inline-flex");
  });

  it("forwards native button props", () => {
    render(
      <Button type="submit" aria-label="Submit" data-testid="sub">
        Submit
      </Button>
    );
    const btn = screen.getByTestId("sub");
    expect(btn).toHaveAttribute("type", "submit");
    expect(btn).toHaveAttribute("aria-label", "Submit");
  });
});
