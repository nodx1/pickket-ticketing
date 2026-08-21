import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge } from "../badge";

describe("Badge", () => {
  it("renders with text content", () => {
    render(<Badge>New</Badge>);
    expect(screen.getByText("New")).toBeInTheDocument();
  });

  it("renders as a <span> by default", () => {
    render(<Badge data-testid="b">Tag</Badge>);
    expect(screen.getByTestId("b").tagName).toBe("SPAN");
  });

  it("has data-slot='badge'", () => {
    render(<Badge data-testid="b">B</Badge>);
    expect(screen.getByTestId("b")).toHaveAttribute("data-slot", "badge");
  });

  describe("variants", () => {
    it("applies default variant", () => {
      render(<Badge variant="default" data-testid="b">D</Badge>);
      const el = screen.getByTestId("b");
      expect(el).toHaveAttribute("data-variant", "default");
      expect(el.className).toContain("bg-primary");
    });

    it("applies secondary variant", () => {
      render(<Badge variant="secondary" data-testid="b">S</Badge>);
      const el = screen.getByTestId("b");
      expect(el).toHaveAttribute("data-variant", "secondary");
      expect(el.className).toContain("bg-secondary");
    });

    it("applies destructive variant", () => {
      render(<Badge variant="destructive" data-testid="b">X</Badge>);
      const el = screen.getByTestId("b");
      expect(el).toHaveAttribute("data-variant", "destructive");
      expect(el.className).toContain("bg-destructive");
    });

    it("applies outline variant", () => {
      render(<Badge variant="outline" data-testid="b">O</Badge>);
      const el = screen.getByTestId("b");
      expect(el).toHaveAttribute("data-variant", "outline");
      expect(el.className).toContain("border-border");
    });

    it("applies ghost variant", () => {
      render(<Badge variant="ghost" data-testid="b">G</Badge>);
      expect(screen.getByTestId("b")).toHaveAttribute("data-variant", "ghost");
    });

    it("applies link variant", () => {
      render(<Badge variant="link" data-testid="b">L</Badge>);
      expect(screen.getByTestId("b")).toHaveAttribute("data-variant", "link");
    });
  });

  it("merges custom className", () => {
    render(<Badge className="extra-cls" data-testid="b">C</Badge>);
    const el = screen.getByTestId("b");
    expect(el.className).toContain("extra-cls");
    expect(el.className).toContain("rounded-full");
  });

  describe("asChild", () => {
    it("renders child element when asChild is true", () => {
      render(
        <Badge asChild>
          <a href="/tag">Tag Link</a>
        </Badge>
      );
      const link = screen.getByRole("link", { name: "Tag Link" });
      expect(link.tagName).toBe("A");
      expect(link).toHaveAttribute("href", "/tag");
    });
  });

  it("is inline-flex", () => {
    render(<Badge data-testid="b">I</Badge>);
    expect(screen.getByTestId("b").className).toContain("inline-flex");
  });
});
