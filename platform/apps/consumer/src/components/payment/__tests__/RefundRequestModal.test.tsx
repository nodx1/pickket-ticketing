/**
 * 🔴 환불 신청 모달 — **돈이 걸린 화면**이라 코드는 안 건드리고 동작만 고정한다.
 *
 * ## 왜 이 화면인가
 * 환불 신청은 손님이 **한 번 누르고 기다리는** 자리다. 여기서 두 가지가 치명적이다:
 *
 * ```
 * 중복 제출   같은 신청이 두 번 들어가면 원장이 어긋난다
 * 막다른 실패 실패했는데 다음 행동이 없으면 손님은 고객센터로 간다
 * ```
 *
 * ⚠️ 실패 경로를 안 태우면 검증이 아니다 — 성공만 보는 테스트는 이 화면의
 *    절반만 본다. 그래서 성공·실패·중복·검증실패를 모두 태운다.
 *
 * ⚠️ 이 파일은 **테스트만 추가한다.** 환불 계산·API 계약은 다른 세션 영역이라
 *    지금 동작을 있는 그대로 고정할 뿐, 옳고 그름을 판정하지 않는다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import RefundRequestModal from "../RefundRequestModal";

const h = vi.hoisted(() => ({
  refundOrder: vi.fn(),
  toastSuccess: vi.fn(),
}));

vi.mock("@pickket/lib/api", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  refundOrder: h.refundOrder,
}));
vi.mock("sonner", () => ({ toast: { success: h.toastSuccess, error: vi.fn() } }));

const order = {
  id: "ord-1",
  total_amount: 25000,
  status: "CONFIRMED",
} as never;

function renderModal(overrides: Partial<Record<string, unknown>> = {}) {
  const onClose = vi.fn();
  const onSuccess = vi.fn();
  const utils = render(
    <RefundRequestModal open order={order} onClose={onClose} onSuccess={onSuccess} {...overrides} />,
  );
  return { ...utils, onClose, onSuccess };
}

/** 사유 입력칸 — 라벨이 i18n 이라 역할로 잡는다. */
function reasonBox() {
  return screen.getByRole("textbox");
}

/**
 * 제출 버튼.
 * ⚠️ 라벨이 모달 제목과 **같은 문자열**(`t("title")` = "환불 신청")이다 —
 *    heading 과 겹치므로 반드시 role 로 좁혀야 한다. 처음에 "비활성인 버튼" 이라는
 *    휴리스틱으로 집었다가 취소 버튼을 눌렀다.
 */
function submitButton() {
  return screen.getByRole("button", { name: "환불 신청" }) as HTMLButtonElement;
}

beforeEach(() => {
  h.refundOrder.mockReset();
  h.toastSuccess.mockReset();
});
afterEach(() => vi.clearAllMocks());

describe("환불 신청 모달", () => {
  it("open=false 면 아무것도 그리지 않는다", () => {
    render(<RefundRequestModal open={false} order={order} onClose={vi.fn()} onSuccess={vi.fn()} />);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
  });

  it("결제 금액을 보여준다", () => {
    renderModal();
    expect(screen.getByText(/25,000/)).toBeInTheDocument();
  });

  it("🔴 사유가 비면 제출이 막혀 있다 — 빈 신청이 들어가지 않는다", () => {
    renderModal();
    expect(submitButton(), "빈 사유로 제출할 수 있다").toBeDisabled();
  });

  it("🔴 사유를 채우면 제출이 열린다 — 도달 가능성 증명", async () => {
    const user = userEvent.setup();
    renderModal();
    await user.type(reasonBox(), "일정이 변경되어 참석이 어렵습니다");
    await waitFor(() =>
      expect(submitButton(), "채워도 계속 잠겨 있다면 신청 자체가 불가능하다").toBeEnabled(),
    );
  });

  it("공백만 넣으면 여전히 막혀 있다", async () => {
    const user = userEvent.setup();
    renderModal();
    await user.type(reasonBox(), "          ");
    expect(submitButton(), "공백으로 신청이 통과한다").toBeDisabled();
  });
});

describe("제출 — 성공과 실패를 모두 태운다", () => {
  async function fillAndSubmit() {
    const user = userEvent.setup();
    const ctx = renderModal();
    await user.type(reasonBox(), "일정이 변경되어 참석이 어렵습니다");
    await waitFor(() => expect(submitButton()).toBeEnabled());
    await user.click(submitButton());
    return { ...ctx, user };
  }

  it("🔴 성공하면 주문 id 와 다듬은 사유가 그대로 전달된다", async () => {
    h.refundOrder.mockResolvedValue({});
    const { onSuccess } = await fillAndSubmit();
    await waitFor(() => expect(h.refundOrder).toHaveBeenCalledTimes(1));
    expect(h.refundOrder).toHaveBeenCalledWith("ord-1", {
      reason: "일정이 변경되어 참석이 어렵습니다",
    });
    await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
  });

  /**
   * 🔴 실패했을 때 **서버가 준 이유**를 보여줘야 한다.
   *    일반 문구로 뭉개면 손님은 왜 안 되는지 모른 채 고객센터로 간다.
   */
  it("🔴 실패 사유를 화면에 보여준다", async () => {
    h.refundOrder.mockRejectedValue({
      response: { data: { detail: "행사 당일에는 환불이 불가합니다" } },
    });
    await fillAndSubmit();
    expect(await screen.findByText("행사 당일에는 환불이 불가합니다")).toBeInTheDocument();
  });

  it("🔴 실패해도 onSuccess 를 부르지 않는다 — 안 된 걸 됐다고 하면 안 된다", async () => {
    h.refundOrder.mockRejectedValue(new Error("network"));
    const { onSuccess } = await fillAndSubmit();
    await waitFor(() => expect(h.refundOrder).toHaveBeenCalled());
    expect(onSuccess).not.toHaveBeenCalled();
  });

  /**
   * 🔴 중복 제출 — 이 화면에서 가장 비싼 실수다.
   *    응답이 늦을 때 손님은 한 번 더 누른다. 두 번 들어가면 원장이 어긋난다.
   *
   * ## 방어가 **둘**이다 — 하나만 지워서는 이 테스트가 안 깨진다
   * ```
   * disabled={!valid || submitting}          버튼 잠금   (:182)
   * if (!valid || submitting) return;        핸들러 가드 (:54)
   * ```
   * 실측: 하나씩 제거하면 나머지 하나가 막아 **11개 전부 통과**한다.
   * **둘을 동시에 제거해야** 이 테스트가 실패한다(확인함).
   *
   * ⚠️ 즉 「뮤테이션이 생존했다」가 곧 「검증이 없다」는 아니다. 다만 한쪽만 지운
   *    변경은 이 테스트가 못 잡으니, 둘 중 하나를 걷어낼 때는 나머지가 남아 있는지
   *    사람이 확인해야 한다.
   */
  it("🔴 응답이 오기 전에 두 번 눌러도 한 번만 나간다", async () => {
    let resolve!: (v: unknown) => void;
    h.refundOrder.mockReturnValue(new Promise((r) => (resolve = r)));

    const user = userEvent.setup();
    renderModal();
    await user.type(reasonBox(), "일정이 변경되어 참석이 어렵습니다");
    await waitFor(() => expect(submitButton()).toBeEnabled());

    // ⚠️ 버튼 라벨이 전송 중 "신청 중..." 으로 바뀌므로 이름으로 다시 찾으면 못 찾는다.
    //    **같은 DOM 요소를 붙잡아** 연타한다 — 손님이 실제로 하는 행동이 그것이다.
    const btn = submitButton();
    await user.click(btn);
    fireEvent.click(btn);
    fireEvent.click(btn);

    expect(h.refundOrder.mock.calls.length, "같은 환불 신청이 여러 번 들어간다").toBe(1);
    resolve({});
  });

  it("전송 중에는 취소도 막는다 — 중간에 닫아 상태를 잃지 않게", async () => {
    h.refundOrder.mockReturnValue(new Promise(() => {}));
    const user = userEvent.setup();
    const { onClose } = renderModal();
    await user.type(reasonBox(), "일정이 변경되어 참석이 어렵습니다");
    await waitFor(() => expect(submitButton()).toBeEnabled());
    await user.click(submitButton());

    await waitFor(() => expect(screen.getByRole("button", { name: "취소" })).toBeDisabled());
    expect(onClose).not.toHaveBeenCalled();
  });

  it("🔴 실패 후 다시 시도할 수 있다 — 막다른 상태가 아니다", async () => {
    h.refundOrder.mockRejectedValue(new Error("network"));
    const { user } = await fillAndSubmit();
    await waitFor(() => expect(h.refundOrder).toHaveBeenCalledTimes(1));

    await waitFor(() => expect(submitButton(), "실패 후 버튼이 잠긴 채다").toBeEnabled());
    await user.click(submitButton());
    await waitFor(() =>
      expect(h.refundOrder.mock.calls.length, "버튼이 죽어 재시도가 불가능하다").toBeGreaterThan(1),
    );
  });
});
