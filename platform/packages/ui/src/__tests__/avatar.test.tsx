import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  Avatar,
  AvatarFallback,
  AvatarBadge,
  AvatarGroup,
  AvatarGroupCount,
} from "../avatar";

describe("Avatar", () => {
  it("renders with data-slot='avatar'", () => {
    render(
      <Avatar data-testid="av">
        <AvatarFallback>JD</AvatarFallback>
      </Avatar>
    );
    expect(screen.getByTestId("av")).toHaveAttribute("data-slot", "avatar");
  });

  it("defaults to size='default'", () => {
    render(
      <Avatar data-testid="av">
        <AvatarFallback>A</AvatarFallback>
      </Avatar>
    );
    expect(screen.getByTestId("av")).toHaveAttribute("data-size", "default");
  });

  it("applies sm size", () => {
    render(
      <Avatar size="sm" data-testid="av">
        <AvatarFallback>S</AvatarFallback>
      </Avatar>
    );
    expect(screen.getByTestId("av")).toHaveAttribute("data-size", "sm");
  });

  it("applies lg size", () => {
    render(
      <Avatar size="lg" data-testid="av">
        <AvatarFallback>L</AvatarFallback>
      </Avatar>
    );
    expect(screen.getByTestId("av")).toHaveAttribute("data-size", "lg");
  });

  it("renders fallback text", () => {
    render(
      <Avatar>
        <AvatarFallback>JD</AvatarFallback>
      </Avatar>
    );
    expect(screen.getByText("JD")).toBeInTheDocument();
  });

  it("has rounded-full", () => {
    render(
      <Avatar data-testid="av">
        <AvatarFallback>X</AvatarFallback>
      </Avatar>
    );
    expect(screen.getByTestId("av").className).toContain("rounded-full");
  });

  it("merges custom className", () => {
    render(
      <Avatar className="ring-2" data-testid="av">
        <AvatarFallback>C</AvatarFallback>
      </Avatar>
    );
    expect(screen.getByTestId("av").className).toContain("ring-2");
  });
});

describe("AvatarFallback", () => {
  it("has data-slot='avatar-fallback'", () => {
    render(
      <Avatar>
        <AvatarFallback data-testid="fb">FB</AvatarFallback>
      </Avatar>
    );
    expect(screen.getByTestId("fb")).toHaveAttribute("data-slot", "avatar-fallback");
  });
});

describe("AvatarBadge", () => {
  it("has data-slot='avatar-badge'", () => {
    render(
      <Avatar>
        <AvatarFallback>X</AvatarFallback>
        <AvatarBadge data-testid="badge" />
      </Avatar>
    );
    expect(screen.getByTestId("badge")).toHaveAttribute("data-slot", "avatar-badge");
  });

  it("has absolute positioning", () => {
    render(
      <Avatar>
        <AvatarFallback>X</AvatarFallback>
        <AvatarBadge data-testid="badge" />
      </Avatar>
    );
    expect(screen.getByTestId("badge").className).toContain("absolute");
  });
});

describe("AvatarGroup", () => {
  it("has data-slot='avatar-group'", () => {
    render(
      <AvatarGroup data-testid="grp">
        <Avatar><AvatarFallback>A</AvatarFallback></Avatar>
        <Avatar><AvatarFallback>B</AvatarFallback></Avatar>
      </AvatarGroup>
    );
    expect(screen.getByTestId("grp")).toHaveAttribute("data-slot", "avatar-group");
  });

  it("has negative spacing for overlap", () => {
    render(
      <AvatarGroup data-testid="grp">
        <Avatar><AvatarFallback>A</AvatarFallback></Avatar>
      </AvatarGroup>
    );
    expect(screen.getByTestId("grp").className).toContain("-space-x-2");
  });
});

describe("AvatarGroupCount", () => {
  it("has data-slot='avatar-group-count'", () => {
    render(
      <AvatarGroup>
        <AvatarGroupCount data-testid="cnt">+5</AvatarGroupCount>
      </AvatarGroup>
    );
    expect(screen.getByTestId("cnt")).toHaveAttribute("data-slot", "avatar-group-count");
  });

  it("renders count text", () => {
    render(
      <AvatarGroup>
        <AvatarGroupCount>+99</AvatarGroupCount>
      </AvatarGroup>
    );
    expect(screen.getByText("+99")).toBeInTheDocument();
  });
});
