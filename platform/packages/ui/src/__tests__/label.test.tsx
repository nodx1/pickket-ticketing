import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Label } from "../label";

describe("Label", () => {
  it("renders text content", () => {
    render(<Label>Name</Label>);
    expect(screen.getByText("Name")).toBeInTheDocument();
  });

  it("has data-slot='label'", () => {
    render(<Label data-testid="l">L</Label>);
    expect(screen.getByTestId("l")).toHaveAttribute("data-slot", "label");
  });

  it("renders as a label element", () => {
    render(<Label data-testid="l">L</Label>);
    expect(screen.getByTestId("l").tagName).toBe("LABEL");
  });

  it("applies htmlFor via radix", () => {
    render(<Label htmlFor="email-input">Email</Label>);
    const label = screen.getByText("Email");
    expect(label).toHaveAttribute("for", "email-input");
  });

  it("merges custom className", () => {
    render(<Label className="bold" data-testid="l">L</Label>);
    const el = screen.getByTestId("l");
    expect(el.className).toContain("bold");
    expect(el.className).toContain("text-sm");
  });

  it("has font-medium styling", () => {
    render(<Label data-testid="l">L</Label>);
    expect(screen.getByTestId("l").className).toContain("font-medium");
  });

  it("has select-none for UX", () => {
    render(<Label data-testid="l">L</Label>);
    expect(screen.getByTestId("l").className).toContain("select-none");
  });
});
