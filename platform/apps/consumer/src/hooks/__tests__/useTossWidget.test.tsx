import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";

const renderTossWidget = vi.fn();
const isTossLive = vi.fn();

vi.mock("@/lib/toss", () => ({
  renderTossWidget: (...args: unknown[]) => renderTossWidget(...args),
  isTossLive: () => isTossLive(),
}));

import { useTossWidget } from "@/hooks/useTossWidget";

describe("useTossWidget", () => {
  beforeEach(() => {
    renderTossWidget.mockReset();
    isTossLive.mockReset();
  });

  it("active + live + amount>0 → 위젯 렌더 + ready=true", async () => {
    isTossLive.mockReturnValue(true);
    const handle = { setAmount: vi.fn().mockResolvedValue(undefined), requestPayment: vi.fn() };
    renderTossWidget.mockResolvedValue(handle);

    const { result } = renderHook(() => useTossWidget(30000, true));

    await waitFor(() => expect(result.current.ready).toBe(true));
    expect(renderTossWidget).toHaveBeenCalledWith({
      amount: 30000,
      methodsSelector: "#toss-widget-methods",
      agreementSelector: "#toss-widget-agreement",
    });
    expect(result.current.widgetRef.current).toBe(handle);
  });

  it("inactive → 렌더 안 함, ready=false", async () => {
    isTossLive.mockReturnValue(true);
    const { result } = renderHook(() => useTossWidget(30000, false));
    // 짧게 대기 후에도 미호출
    await new Promise((r) => setTimeout(r, 20));
    expect(renderTossWidget).not.toHaveBeenCalled();
    expect(result.current.ready).toBe(false);
  });

  it("mock 모드(!isTossLive) → 렌더 안 함", async () => {
    isTossLive.mockReturnValue(false);
    const { result } = renderHook(() => useTossWidget(30000, true));
    await new Promise((r) => setTimeout(r, 20));
    expect(renderTossWidget).not.toHaveBeenCalled();
    expect(result.current.ready).toBe(false);
  });

  it("amount=0 → 렌더 안 함", async () => {
    isTossLive.mockReturnValue(true);
    const { result } = renderHook(() => useTossWidget(0, true));
    await new Promise((r) => setTimeout(r, 20));
    expect(renderTossWidget).not.toHaveBeenCalled();
    expect(result.current.ready).toBe(false);
  });

  it("렌더 후 amount 변경 → 핸들 setAmount 호출", async () => {
    isTossLive.mockReturnValue(true);
    const setAmount = vi.fn().mockResolvedValue(undefined);
    renderTossWidget.mockResolvedValue({ setAmount, requestPayment: vi.fn() });

    const { result, rerender } = renderHook(({ amt }) => useTossWidget(amt, true), {
      initialProps: { amt: 30000 },
    });
    await waitFor(() => expect(result.current.ready).toBe(true));

    rerender({ amt: 50000 });
    await waitFor(() => expect(setAmount).toHaveBeenCalledWith(50000));
  });
});
