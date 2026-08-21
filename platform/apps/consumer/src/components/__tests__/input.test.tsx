import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Input } from "@pickket/ui";

describe("Input", () => {
  // ── 기본 렌더링 ──
  it("renders an input element", () => {
    render(<Input />);
    expect(screen.getByRole("textbox")).toBeInTheDocument();
  });

  it("has data-slot='input' attribute", () => {
    render(<Input />);
    expect(screen.getByRole("textbox")).toHaveAttribute("data-slot", "input");
  });

  // ── placeholder 테스트 ──
  it("renders with placeholder text", () => {
    render(<Input placeholder="이메일을 입력하세요" />);
    expect(screen.getByPlaceholderText("이메일을 입력하세요")).toBeInTheDocument();
  });

  // ── 값 입력 테스트 (userEvent.type) ──
  describe("user input", () => {
    it("accepts typed text", async () => {
      const user = userEvent.setup();
      render(<Input placeholder="입력" />);
      const input = screen.getByPlaceholderText("입력");

      await user.type(input, "안녕하세요");
      expect(input).toHaveValue("안녕하세요");
    });

    it("handles sequential typing", async () => {
      const user = userEvent.setup();
      render(<Input />);
      const input = screen.getByRole("textbox");

      await user.type(input, "hello world");
      expect(input).toHaveValue("hello world");
    });

    it("calls onChange on each keystroke", async () => {
      const handleChange = vi.fn();
      const user = userEvent.setup();
      render(<Input onChange={handleChange} />);
      const input = screen.getByRole("textbox");

      await user.type(input, "abc");
      expect(handleChange).toHaveBeenCalledTimes(3);
    });
  });

  // ── type 속성 ──
  describe("type prop", () => {
    it("renders with type='email'", () => {
      render(<Input type="email" placeholder="email" />);
      const input = screen.getByPlaceholderText("email");
      expect(input).toHaveAttribute("type", "email");
    });

    it("renders with type='password'", () => {
      render(<Input type="password" data-testid="pw-input" />);
      const input = screen.getByTestId("pw-input");
      expect(input).toHaveAttribute("type", "password");
    });

    it("renders with type='number'", () => {
      render(<Input type="number" data-testid="num-input" />);
      const input = screen.getByTestId("num-input");
      expect(input).toHaveAttribute("type", "number");
    });
  });

  // ── disabled 상태 ──
  describe("disabled state", () => {
    it("renders as disabled when disabled prop is true", () => {
      render(<Input disabled placeholder="비활성" />);
      expect(screen.getByPlaceholderText("비활성")).toBeDisabled();
    });

    it("does not accept input when disabled", async () => {
      const user = userEvent.setup();
      render(<Input disabled placeholder="비활성" />);
      const input = screen.getByPlaceholderText("비활성");

      await user.type(input, "test");
      expect(input).toHaveValue("");
    });
  });

  // ── 커스텀 className ──
  it("merges custom className with default classes", () => {
    render(<Input className="my-custom-input" />);
    const input = screen.getByRole("textbox");
    expect(input.className).toContain("my-custom-input");
    expect(input.className).toContain("rounded-md");
  });

  // ── 포커스 ──
  it("can receive focus", async () => {
    const user = userEvent.setup();
    render(<Input placeholder="포커스 테스트" />);
    const input = screen.getByPlaceholderText("포커스 테스트");

    await user.click(input);
    expect(input).toHaveFocus();
  });

  // ── HTML 속성 전달 ──
  it("passes through native input props", () => {
    render(
      <Input
        aria-label="검색"
        data-testid="search-input"
        name="search"
        autoComplete="off"
        maxLength={100}
      />
    );
    const input = screen.getByTestId("search-input");
    expect(input).toHaveAttribute("aria-label", "검색");
    expect(input).toHaveAttribute("name", "search");
    expect(input).toHaveAttribute("autocomplete", "off");
    expect(input).toHaveAttribute("maxlength", "100");
  });

  // ── value + controlled 테스트 ──
  it("works as a controlled input", () => {
    const { rerender } = render(<Input value="초기값" readOnly />);
    expect(screen.getByRole("textbox")).toHaveValue("초기값");

    rerender(<Input value="변경값" readOnly />);
    expect(screen.getByRole("textbox")).toHaveValue("변경값");
  });

  // ── 클리어 (clear) ──
  it("can be cleared by user", async () => {
    const user = userEvent.setup();
    render(<Input placeholder="지우기" />);
    const input = screen.getByPlaceholderText("지우기");

    await user.type(input, "텍스트");
    expect(input).toHaveValue("텍스트");

    await user.clear(input);
    expect(input).toHaveValue("");
  });
});
