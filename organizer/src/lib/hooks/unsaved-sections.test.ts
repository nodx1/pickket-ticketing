// @vitest-environment jsdom
import { describe, expect, it, beforeEach, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import {
  __resetUnsavedSectionsForTest,
  getUnsavedSectionLabels,
  unsavedSectionsMessage,
  UnsavedSectionsGuard,
  useUnsavedSection,
  useUnsavedSectionLabels,
} from "./unsaved-sections";

describe("저장 버튼이 여러 개인 화면의 미저장 구획 모음", () => {
  beforeEach(() => __resetUnsavedSectionsForTest());

  it("고친 구획만 고친 순서대로 모으고, 저장하면 빠진다", () => {
    const basic = renderHook(({ dirty }) => useUnsavedSection("basic", "기본 정보", dirty), { initialProps: { dirty: false } });
    const policy = renderHook(({ dirty }) => useUnsavedSection("policy", "취소 정책", dirty), { initialProps: { dirty: false } });
    expect(getUnsavedSectionLabels()).toEqual([]);

    act(() => policy.rerender({ dirty: true }));
    act(() => basic.rerender({ dirty: true }));
    expect(getUnsavedSectionLabels()).toEqual(["취소 정책", "기본 정보"]);

    act(() => policy.rerender({ dirty: false }));
    expect(getUnsavedSectionLabels()).toEqual(["기본 정보"]);
  });

  it("구획이 화면에서 사라지면 같이 빠진다", () => {
    const basic = renderHook(() => useUnsavedSection("basic", "기본 정보", true));
    expect(getUnsavedSectionLabels()).toEqual(["기본 정보"]);
    basic.unmount();
    expect(getUnsavedSectionLabels()).toEqual([]);
  });

  it("모은 목록이 바뀌면 구독한 화면도 다시 그린다", () => {
    const labels = renderHook(() => useUnsavedSectionLabels());
    const section = renderHook(({ dirty }) => useUnsavedSection("channels", "판매 채널", dirty), { initialProps: { dirty: false } });
    expect(labels.result.current).toEqual([]);
    act(() => section.rerender({ dirty: true }));
    expect(labels.result.current).toEqual(["판매 채널"]);
  });

  it("확인 문구에 저장 안 된 구획 이름을 넣는다", () => {
    expect(unsavedSectionsMessage(["기본 정보", "취소 정책"])).toBe(
      "저장하지 않은 변경이 있어요(기본 정보, 취소 정책). 이 화면을 떠날까요?",
    );
  });

  it("구획 두 개가 미저장이어도 링크 이동 확인창은 한 번만 뜬다", () => {
    renderHook(() => useUnsavedSection("basic", "기본 정보", true));
    renderHook(() => useUnsavedSection("policy", "취소 정책", true));
    renderHook(() => UnsavedSectionsGuard());
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const a = document.createElement("a");
    a.href = "/events/e1/dashboard";
    document.body.appendChild(a);
    a.click();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith("저장하지 않은 변경이 있어요(기본 정보, 취소 정책). 이 화면을 떠날까요?");
    a.remove();
    confirm.mockRestore();
  });
});
