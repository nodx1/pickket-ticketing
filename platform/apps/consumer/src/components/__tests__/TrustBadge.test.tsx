import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import TrustBadge from "../marketing/TrustBadge";

describe("TrustBadge", () => {
  it("renders safe_payment variant", () => {
    render(<TrustBadge variant="safe_payment" />);
    expect(screen.getByText("안전결제 보호")).toBeInTheDocument();
  });

  it("renders fair_price variant", () => {
    render(<TrustBadge variant="fair_price" />);
    expect(screen.getByText("공정 가격 보장")).toBeInTheDocument();
  });

  it("renders verified_organizer variant", () => {
    render(<TrustBadge variant="verified_organizer" />);
    expect(screen.getByText("인증된 주최자")).toBeInTheDocument();
  });

  it("renders anti_scalping variant", () => {
    render(<TrustBadge variant="anti_scalping" />);
    expect(screen.getByText("암표 차단")).toBeInTheDocument();
  });

  it("has inline-flex and rounded-full classes", () => {
    const { container } = render(<TrustBadge variant="safe_payment" />);
    const badge = container.querySelector("span");
    expect(badge?.className).toContain("inline-flex");
    expect(badge?.className).toContain("rounded-full");
  });

  it("applies green color classes for safe_payment", () => {
    const { container } = render(<TrustBadge variant="safe_payment" />);
    const badge = container.querySelector("span");
    expect(badge?.className).toContain("bg-green-100");
    expect(badge?.className).toContain("text-green-700");
  });

  it("applies blue color classes for fair_price", () => {
    const { container } = render(<TrustBadge variant="fair_price" />);
    const badge = container.querySelector("span");
    expect(badge?.className).toContain("bg-blue-100");
    expect(badge?.className).toContain("text-blue-700");
  });

  it("applies purple color classes for verified_organizer", () => {
    const { container } = render(<TrustBadge variant="verified_organizer" />);
    const badge = container.querySelector("span");
    expect(badge?.className).toContain("bg-purple-100");
    expect(badge?.className).toContain("text-purple-700");
  });

  it("applies red color classes for anti_scalping", () => {
    const { container } = render(<TrustBadge variant="anti_scalping" />);
    const badge = container.querySelector("span");
    expect(badge?.className).toContain("bg-red-100");
    expect(badge?.className).toContain("text-red-700");
  });

  it("renders an icon element inside the badge", () => {
    const { container } = render(<TrustBadge variant="safe_payment" />);
    const svg = container.querySelector("svg");
    expect(svg).toBeInTheDocument();
  });
});
