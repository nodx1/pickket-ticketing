import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Textarea } from "../textarea";

describe("Textarea", () => {
  it("renders a textarea element", () => {
    render(<Textarea data-testid="ta" />);
    expect(screen.getByTestId("ta").tagName).toBe("TEXTAREA");
  });

  it("has data-slot='textarea'", () => {
    render(<Textarea data-testid="ta" />);
    expect(screen.getByTestId("ta")).toHaveAttribute("data-slot", "textarea");
  });

  it("renders with placeholder", () => {
    render(<Textarea placeholder="Write here..." />);
    expect(screen.getByPlaceholderText("Write here...")).toBeInTheDocument();
  });

  it("calls onChange when text is entered", async () => {
    const handler = vi.fn();
    render(<Textarea onChange={handler} data-testid="ta" />);
    await userEvent.type(screen.getByTestId("ta"), "abc");
    expect(handler).toHaveBeenCalled();
  });

  it("reflects value prop", () => {
    render(<Textarea value="existing" onChange={() => {}} data-testid="ta" />);
    expect(screen.getByTestId("ta")).toHaveValue("existing");
  });

  it("is disabled when prop is set", () => {
    render(<Textarea disabled data-testid="ta" />);
    expect(screen.getByTestId("ta")).toBeDisabled();
  });

  it("merges custom className", () => {
    render(<Textarea className="custom" data-testid="ta" />);
    const el = screen.getByTestId("ta");
    expect(el.className).toContain("custom");
    expect(el.className).toContain("rounded-md");
  });

  it("forwards rows prop", () => {
    render(<Textarea rows={5} data-testid="ta" />);
    expect(screen.getByTestId("ta")).toHaveAttribute("rows", "5");
  });

  it("forwards aria-label", () => {
    render(<Textarea aria-label="Message" data-testid="ta" />);
    expect(screen.getByTestId("ta")).toHaveAttribute("aria-label", "Message");
  });
});
