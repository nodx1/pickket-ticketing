import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { Switch } from "../switch";

describe("Switch", () => {
  it("renders with data-slot='switch'", () => {
    render(<Switch data-testid="sw" />);
    expect(screen.getByTestId("sw")).toHaveAttribute("data-slot", "switch");
  });

  it("has role='switch'", () => {
    render(<Switch />);
    expect(screen.getByRole("switch")).toBeInTheDocument();
  });

  it("is unchecked by default", () => {
    render(<Switch />);
    expect(screen.getByRole("switch")).toHaveAttribute("data-state", "unchecked");
  });

  it("reflects checked state", () => {
    render(<Switch checked onCheckedChange={() => {}} />);
    expect(screen.getByRole("switch")).toHaveAttribute("data-state", "checked");
  });

  it("calls onCheckedChange when toggled", () => {
    const handler = vi.fn();
    render(<Switch onCheckedChange={handler} />);
    fireEvent.click(screen.getByRole("switch"));
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("is disabled when prop is set", () => {
    render(<Switch disabled />);
    expect(screen.getByRole("switch")).toBeDisabled();
  });

  it("renders thumb element", () => {
    const { container } = render(<Switch />);
    const thumb = container.querySelector('[data-slot="switch-thumb"]');
    expect(thumb).toBeInTheDocument();
  });

  it("merges custom className", () => {
    render(<Switch className="extra" data-testid="sw" />);
    expect(screen.getByTestId("sw").className).toContain("extra");
  });

  it("has rounded-full style", () => {
    render(<Switch data-testid="sw" />);
    expect(screen.getByTestId("sw").className).toContain("rounded-full");
  });

  it("forwards aria-label", () => {
    render(<Switch aria-label="Dark mode" />);
    expect(screen.getByRole("switch")).toHaveAttribute("aria-label", "Dark mode");
  });
});
