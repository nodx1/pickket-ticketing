import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Input } from "../input";

describe("Input", () => {
  it("renders an input element", () => {
    render(<Input data-testid="inp" />);
    expect(screen.getByTestId("inp").tagName).toBe("INPUT");
  });

  it("has data-slot='input'", () => {
    render(<Input data-testid="inp" />);
    expect(screen.getByTestId("inp")).toHaveAttribute("data-slot", "input");
  });

  it("applies the type prop", () => {
    render(<Input type="email" data-testid="inp" />);
    expect(screen.getByTestId("inp")).toHaveAttribute("type", "email");
  });

  it("renders with placeholder", () => {
    render(<Input placeholder="Enter email" />);
    expect(screen.getByPlaceholderText("Enter email")).toBeInTheDocument();
  });

  it("calls onChange when text is typed", async () => {
    const handler = vi.fn();
    render(<Input onChange={handler} data-testid="inp" />);
    await userEvent.type(screen.getByTestId("inp"), "hello");
    expect(handler).toHaveBeenCalled();
  });

  it("reflects value prop", () => {
    render(<Input value="test" onChange={() => {}} data-testid="inp" />);
    expect(screen.getByTestId("inp")).toHaveValue("test");
  });

  it("is disabled when disabled prop is set", () => {
    render(<Input disabled data-testid="inp" />);
    expect(screen.getByTestId("inp")).toBeDisabled();
  });

  it("merges custom className", () => {
    render(<Input className="my-class" data-testid="inp" />);
    const inp = screen.getByTestId("inp");
    expect(inp.className).toContain("my-class");
    expect(inp.className).toContain("rounded-md");
  });

  it("forwards aria-label for accessibility", () => {
    render(<Input aria-label="Username" data-testid="inp" />);
    expect(screen.getByTestId("inp")).toHaveAttribute("aria-label", "Username");
  });

  it("supports required prop", () => {
    render(<Input required data-testid="inp" />);
    expect(screen.getByTestId("inp")).toBeRequired();
  });

  it("supports readOnly prop", () => {
    render(<Input readOnly value="locked" data-testid="inp" />);
    expect(screen.getByTestId("inp")).toHaveAttribute("readonly");
  });

  it("renders as password type", () => {
    render(<Input type="password" data-testid="inp" />);
    expect(screen.getByTestId("inp")).toHaveAttribute("type", "password");
  });
});
