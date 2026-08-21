import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { Progress } from "../progress";

describe("Progress", () => {
  it("renders with data-slot='progress'", () => {
    render(<Progress value={50} data-testid="prog" />);
    expect(screen.getByTestId("prog")).toHaveAttribute("data-slot", "progress");
  });

  it("has role='progressbar'", () => {
    render(<Progress value={50} />);
    expect(screen.getByRole("progressbar")).toBeInTheDocument();
  });

  it("renders indicator with correct transform for 50%", () => {
    const { container } = render(<Progress value={50} />);
    const indicator = container.querySelector('[data-slot="progress-indicator"]');
    expect(indicator).toBeInTheDocument();
    expect(indicator).toHaveStyle({ transform: "translateX(-50%)" });
  });

  it("renders indicator with 0% transform when value is 100", () => {
    const { container } = render(<Progress value={100} />);
    const indicator = container.querySelector('[data-slot="progress-indicator"]');
    expect(indicator).toHaveStyle({ transform: "translateX(-0%)" });
  });

  it("renders indicator with -100% transform when value is 0", () => {
    const { container } = render(<Progress value={0} />);
    const indicator = container.querySelector('[data-slot="progress-indicator"]');
    expect(indicator).toHaveStyle({ transform: "translateX(-100%)" });
  });

  it("handles undefined value as 0", () => {
    const { container } = render(<Progress />);
    const indicator = container.querySelector('[data-slot="progress-indicator"]');
    expect(indicator).toHaveStyle({ transform: "translateX(-100%)" });
  });

  it("merges custom className", () => {
    render(<Progress value={25} className="my-prog" data-testid="prog" />);
    expect(screen.getByTestId("prog").className).toContain("my-prog");
  });

  it("has rounded-full styling", () => {
    render(<Progress value={75} data-testid="prog" />);
    expect(screen.getByTestId("prog").className).toContain("rounded-full");
  });
});
