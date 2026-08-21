import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
  CardFooter,
  CardAction,
} from "../card";

describe("Card", () => {
  it("renders as a div", () => {
    render(<Card data-testid="card">Content</Card>);
    expect(screen.getByTestId("card").tagName).toBe("DIV");
  });

  it("has data-slot='card'", () => {
    render(<Card data-testid="card">Content</Card>);
    expect(screen.getByTestId("card")).toHaveAttribute("data-slot", "card");
  });

  it("renders children", () => {
    render(<Card>Card body</Card>);
    expect(screen.getByText("Card body")).toBeInTheDocument();
  });

  it("merges custom className", () => {
    render(<Card className="extra" data-testid="card">X</Card>);
    expect(screen.getByTestId("card").className).toContain("extra");
    expect(screen.getByTestId("card").className).toContain("rounded-xl");
  });
});

describe("CardHeader", () => {
  it("has data-slot='card-header'", () => {
    render(<CardHeader data-testid="h">Header</CardHeader>);
    expect(screen.getByTestId("h")).toHaveAttribute("data-slot", "card-header");
  });

  it("renders children", () => {
    render(<CardHeader>My Header</CardHeader>);
    expect(screen.getByText("My Header")).toBeInTheDocument();
  });
});

describe("CardTitle", () => {
  it("has data-slot='card-title'", () => {
    render(<CardTitle data-testid="t">Title</CardTitle>);
    expect(screen.getByTestId("t")).toHaveAttribute("data-slot", "card-title");
  });

  it("renders text", () => {
    render(<CardTitle>My Title</CardTitle>);
    expect(screen.getByText("My Title")).toBeInTheDocument();
  });

  it("applies font-semibold", () => {
    render(<CardTitle data-testid="t">T</CardTitle>);
    expect(screen.getByTestId("t").className).toContain("font-semibold");
  });
});

describe("CardDescription", () => {
  it("has data-slot='card-description'", () => {
    render(<CardDescription data-testid="d">Desc</CardDescription>);
    expect(screen.getByTestId("d")).toHaveAttribute("data-slot", "card-description");
  });

  it("applies muted text", () => {
    render(<CardDescription data-testid="d">D</CardDescription>);
    expect(screen.getByTestId("d").className).toContain("text-muted-foreground");
  });
});

describe("CardContent", () => {
  it("has data-slot='card-content'", () => {
    render(<CardContent data-testid="c">Body</CardContent>);
    expect(screen.getByTestId("c")).toHaveAttribute("data-slot", "card-content");
  });

  it("has horizontal padding", () => {
    render(<CardContent data-testid="c">B</CardContent>);
    expect(screen.getByTestId("c").className).toContain("px-6");
  });
});

describe("CardFooter", () => {
  it("has data-slot='card-footer'", () => {
    render(<CardFooter data-testid="f">Footer</CardFooter>);
    expect(screen.getByTestId("f")).toHaveAttribute("data-slot", "card-footer");
  });

  it("uses flex layout", () => {
    render(<CardFooter data-testid="f">F</CardFooter>);
    expect(screen.getByTestId("f").className).toContain("flex");
  });
});

describe("CardAction", () => {
  it("has data-slot='card-action'", () => {
    render(<CardAction data-testid="a">Action</CardAction>);
    expect(screen.getByTestId("a")).toHaveAttribute("data-slot", "card-action");
  });
});

describe("Full Card composition", () => {
  it("renders all sub-components together", () => {
    render(
      <Card>
        <CardHeader>
          <CardTitle>Event</CardTitle>
          <CardDescription>Details here</CardDescription>
          <CardAction>Btn</CardAction>
        </CardHeader>
        <CardContent>Main content</CardContent>
        <CardFooter>Footer info</CardFooter>
      </Card>
    );
    expect(screen.getByText("Event")).toBeInTheDocument();
    expect(screen.getByText("Details here")).toBeInTheDocument();
    expect(screen.getByText("Btn")).toBeInTheDocument();
    expect(screen.getByText("Main content")).toBeInTheDocument();
    expect(screen.getByText("Footer info")).toBeInTheDocument();
  });
});
