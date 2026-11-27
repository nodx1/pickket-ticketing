// @vitest-environment jsdom
import { describe, expect, it, afterEach } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { FloatingSaveBar } from "./floating-save-bar";

afterEach(() => cleanup());

describe("떠 있는 저장 막대", () => {
  it("보일 때는 body 에 띄우고, 양식 밖에서도 그 양식을 제출한다", () => {
    render(
      <>
        <form id="f1" />
        <FloatingSaveBar show formId="f1" message="기본 정보에 저장 안 된 변경이 있어요" label="기본 정보 저장" saving={false} />
      </>,
    );
    const button = screen.getByRole("button", { name: "기본 정보 저장" });
    expect(button.getAttribute("form")).toBe("f1");
    expect(button.getAttribute("type")).toBe("submit");
    expect(screen.getByText("기본 정보에 저장 안 된 변경이 있어요")).toBeTruthy();
    expect(button.closest("[role=region]")?.parentElement).toBe(document.body);
  });

  it("고친 게 없으면(show=false) 아무것도 없다", () => {
    render(<FloatingSaveBar show={false} formId="f1" message="m" label="기본 정보 저장" saving={false} />);
    expect(screen.queryByRole("button", { name: "기본 정보 저장" })).toBeNull();
  });

  it("저장 중에는 누를 수 없다", () => {
    render(<FloatingSaveBar show formId="f1" message="m" label="기본 정보 저장" saving />);
    expect((screen.getByRole("button", { name: "저장 중..." }) as HTMLButtonElement).disabled).toBe(true);
  });
});
