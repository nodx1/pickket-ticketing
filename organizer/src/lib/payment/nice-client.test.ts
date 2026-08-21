// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NicePayProviderParams } from "@/lib/payment/nice-client";

const JS_URL = "https://pg-web.nicepay.co.kr/v3/common/js/nicepay-pgweb.js";

// 각 테스트가 nice-client.ts 의 모듈-프라이빗 SDK 상태(sdkPromise/loadedSdkUrl)에
// 오염되지 않도록 매번 새로 import 한다.
async function freshStartNicePayment() {
  vi.resetModules();
  const mod = await import("@/lib/payment/nice-client");
  return mod.startNicePayment;
}

function makeParams(
  overrides: Partial<Record<string, string>> = {},
): NicePayProviderParams {
  return {
    js_url: JS_URL,
    form: {
      MID: "nicepay00m",
      Moid: "ord_go_a1",
      Amt: "1004",
      EdiDate: "20260724120000",
      PayMethod: "CARD",
      SignData: "SIGN_ABC_DEF",
      GoodsName: "PICKKET",
      ReturnURL: "https://api.pickket.kr/api/v1/payments/nice/return",
      MallReserved: "go",
      ...overrides,
    },
  };
}

describe("nice-client.ts — organizer 나이스페이 구형(goPay) 결제창", () => {
  /**
   * 🔴 폼의 action — 승인이 **어디로 가는가**.
   *
   * SDK 는 폼 필드값으로 결제창을 열 뿐 action 을 세팅해주지 않는다. 미설정이면
   * nicepaySubmit() 의 제출이 **현재 URL(결제 페이지)** 로 가고, 승인이 안 된 채
   * 결제창 처음으로 되돌아온다(2026-08-08 실측).
   *
   * ⚠️ "action 이 있다" 로는 부족하다 — **서버가 준 ReturnURL 과 같은가**를 본다.
   *    우리가 URL 을 만들어 넣으면 서명 계약이 깨진다.
   */
  it("🔴 폼 action 이 서버가 준 ReturnURL 과 같다", async () => {
    const start = await freshStartNicePayment();
    const params = makeParams({ ReturnURL: "https://api.pickket.kr/api/v1/payments/nice/return" });
    await start(params);
    const form = goPay.mock.calls[0]?.[0] as HTMLFormElement;
    expect(form, "goPay 가 폼을 못 받았다").toBeTruthy();
    expect(
      form.getAttribute("action"),
      "🔴 action 이 없으면 승인이 현재 페이지로 가서 결제창이 처음으로 되돌아온다",
    ).toBe(params.form.ReturnURL);
  });

  it("🔴 ReturnURL 이 없으면 action 을 지어내지 않는다", async () => {
    const start = await freshStartNicePayment();
    const p = makeParams();
    delete (p.form as Record<string, string>).ReturnURL;
    await start(p);
    const form = goPay.mock.calls[0]?.[0] as HTMLFormElement;
    expect(form.getAttribute("action"), "없는 URL 을 만들어 넣으면 서명 계약이 깨진다").toBeNull();
  });

  let goPay: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    goPay = vi.fn();
    (window as unknown as { goPay: unknown }).goPay = goPay;
  });

  afterEach(() => {
    delete (window as unknown as { goPay?: unknown }).goPay;
  });

  it("provider_params.form 필드를 hidden payForm 에 무변형 주입하고 goPay(payForm) 호출", async () => {
    const startNicePayment = await freshStartNicePayment();
    await startNicePayment(makeParams());

    expect(goPay).toHaveBeenCalledTimes(1);
    const formEl = goPay.mock.calls[0][0] as HTMLFormElement;
    expect(formEl).toBeInstanceOf(HTMLFormElement);
    expect(formEl.name).toBe("payForm");
    expect(formEl.method).toBe("post");
    expect(formEl.getAttribute("accept-charset")).toBe("euc-kr");

    // 서버 생성값(SignData 등)이 무변형으로 hidden input 에 들어갔는지.
    const read = (name: string) =>
      formEl.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.value;
    expect(read("MID")).toBe("nicepay00m");
    expect(read("Moid")).toBe("ord_go_a1");
    expect(read("Amt")).toBe("1004");
    expect(read("PayMethod")).toBe("CARD");
    expect(read("SignData")).toBe("SIGN_ABC_DEF");
    expect(read("ReturnURL")).toBe(
      "https://api.pickket.kr/api/v1/payments/nice/return",
    );
    // organizer 는 MallReserved='go'(origin 센티넬)로 go 랜딩 라우팅 — 서버가 채운 값 무변형.
    expect(read("MallReserved")).toBe("go");
    const inputs = formEl.querySelectorAll("input");
    inputs.forEach((i) => expect((i as HTMLInputElement).type).toBe("hidden"));
    expect(document.body.querySelector('form[name="payForm"]')).toBe(formEl);
  });

  it("provider_params 누락 시 명확한 에러(조용한 실패 금지)", async () => {
    const startNicePayment = await freshStartNicePayment();
    await expect(startNicePayment(null)).rejects.toThrow(/provider_params/);
    await expect(startNicePayment(undefined)).rejects.toThrow(/provider_params/);
    expect(goPay).not.toHaveBeenCalled();
  });

  it("js_url 또는 form 누락 시 에러", async () => {
    const startNicePayment = await freshStartNicePayment();
    await expect(
      startNicePayment({ js_url: "", form: {} } as NicePayProviderParams),
    ).rejects.toThrow();
    await expect(
      startNicePayment({ js_url: JS_URL } as unknown as NicePayProviderParams),
    ).rejects.toThrow();
    expect(goPay).not.toHaveBeenCalled();
  });

  it("SDK 는 로드됐지만 goPay 가 등록되지 않았으면 에러(조용한 실패 금지)", async () => {
    const startNicePayment = await freshStartNicePayment();
    delete (window as unknown as { goPay?: unknown }).goPay;
    const script = document.createElement("script");
    script.src = JS_URL;
    document.head.appendChild(script);
    const p = startNicePayment(makeParams());
    await Promise.resolve();
    script.dispatchEvent(new Event("load"));
    await expect(p).rejects.toThrow(/초기화|다시 시도/);
    expect(goPay).not.toHaveBeenCalled();
  });

  it("SDK 로드 실패(error) 시 명확한 에러", async () => {
    const startNicePayment = await freshStartNicePayment();
    delete (window as unknown as { goPay?: unknown }).goPay;
    const script = document.createElement("script");
    script.src = JS_URL;
    document.head.appendChild(script);
    const p = startNicePayment(makeParams());
    await Promise.resolve();
    script.dispatchEvent(new Event("error"));
    await expect(p).rejects.toThrow(/로드/);
    expect(goPay).not.toHaveBeenCalled();
  });

  it("재시도 시 이전 payForm 을 제거하고 새로 주입(중복 폼 없음)", async () => {
    const startNicePayment = await freshStartNicePayment();
    await startNicePayment(makeParams({ Moid: "ord_1_a1" }));
    await startNicePayment(makeParams({ Moid: "ord_2_a1" }));
    const forms = document.body.querySelectorAll('form[name="payForm"]');
    expect(forms.length).toBe(1);
    const read = (name: string) =>
      forms[0].querySelector<HTMLInputElement>(`input[name="${name}"]`)?.value;
    expect(read("Moid")).toBe("ord_2_a1");
    expect(goPay).toHaveBeenCalledTimes(2);
  });

  it("mockNiceRedirectToSuccess — provider·reason·orderId 파라미터 부착", async () => {
    vi.resetModules();
    const mod = await import("@/lib/payment/nice-client");
    const assign = vi.fn();
    const orig = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...orig, assign },
    });
    mod.mockNiceRedirectToSuccess("go-order-uuid-1", "https://go.pickket.kr/checkout/nice/success");
    expect(assign).toHaveBeenCalledTimes(1);
    const url = new URL(assign.mock.calls[0][0] as string);
    expect(url.searchParams.get("provider")).toBe("nicepay");
    expect(url.searchParams.get("reason")).toBe("confirmed");
    expect(url.searchParams.get("orderId")).toBe("go-order-uuid-1");
    Object.defineProperty(window, "location", { configurable: true, value: orig });
  });
});

/**
 * 🔴 인증 결과 콜백 (2026-08-08 실장애 — 데스크탑 결제가 승인되지 않았다)
 *
 * 발주처 신고: *"데스크탑 크롬, 결제완료를 눌러도 승인되지 않음. 재시도하면 팝업이 다시 뜸"*
 *
 * 나이스 구형 SDK 는 인증 결과를 전역 콜백으로 **호출만** 하고 정의하지 않는다:
 * ```
 * 성공     nicepaySubmit();            ← try/catch 없는 하드콜. 미정의면 TypeError 로 중단
 *                                        ⟹ 폼이 ReturnURL 로 안 가고 **승인이 없다**
 * 취소/오류 try{ nicepayClose(); }catch{} ← 미정의여도 삼켜진다 ⟹ 조용히 화면만 멎는다
 * ```
 *
 * ⚠️ **"등록됐다" 를 재는 것으로는 부족하다.** `typeof window.nicepaySubmit === "function"`
 *    만 보면 핸들러가 아무 일도 안 해도 초록이다. **부작용**(폼 제출·취소 통지)을 센다.
 *
 * ⚠️ 모바일은 리다이렉트로 돌아 JS 콜백을 안 탄다 — 그래서 데스크탑에서만 터졌다.
 */
describe("🔴 나이스 인증 결과 콜백 — 등록이 없으면 승인이 일어나지 않는다", () => {
  let goPay: ReturnType<typeof vi.fn>;
  /** SDK 흉내 — goPay 가 불린 시점의 전역 콜백을 붙잡아 둔다. */
  let captured: { submit?: () => void; close?: () => void };

  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    captured = {};
    goPay = vi.fn(() => {
      // 🔴 진짜 SDK 와 같은 시점 — goPay 안에서 이미 콜백이 등록돼 있어야 한다.
      captured.submit = window.nicepaySubmit;
      captured.close = window.nicepayClose;
    });
    (window as unknown as { goPay: unknown }).goPay = goPay;
  });

  afterEach(() => {
    delete (window as unknown as { goPay?: unknown }).goPay;
    delete (window as unknown as { nicepaySubmit?: unknown }).nicepaySubmit;
    delete (window as unknown as { nicepayClose?: unknown }).nicepayClose;
  });

  function payFormEl(): HTMLFormElement {
    const el = document.querySelector<HTMLFormElement>('form[name="payForm"]');
    if (!el) throw new Error("payForm 이 없다");
    return el;
  }

  it("🔴 성공 콜백이 폼을 제출한다 — 여기서 승인이 일어난다", async () => {
    const startNicePayment = await freshStartNicePayment();
    await startNicePayment(makeParams());

    const submitSpy = vi.fn();
    payFormEl().submit = submitSpy;

    expect(captured.submit, "🔴 goPay 시점에 nicepaySubmit 이 등록돼 있어야 한다").toBeTypeOf(
      "function",
    );
    captured.submit!();
    // ⚠️ 등록 여부가 아니라 **부작용**을 센다
    expect(submitSpy, "🔴 폼이 ReturnURL 로 안 갔다 = 승인이 일어나지 않는다").toHaveBeenCalledTimes(1);
  });

  it("🔴 취소 콜백이 onCancel 을 부른다 — 모달 고착 탈출", async () => {
    const startNicePayment = await freshStartNicePayment();
    const onCancel = vi.fn();
    await startNicePayment(makeParams(), { onCancel });

    expect(captured.close).toBeTypeOf("function");
    captured.close!();
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("🔴 등록은 goPay **이전**이다 — 순서가 뒤바뀌면 인증 결과를 놓친다", async () => {
    const startNicePayment = await freshStartNicePayment();
    await startNicePayment(makeParams(), { onCancel: vi.fn() });
    // goPay 안에서 붙잡은 값이 함수라는 것 자체가 "등록이 먼저였다" 는 증거다.
    expect(captured.submit).toBeTypeOf("function");
    expect(captured.close).toBeTypeOf("function");
  });

  it("🔴 성공 뒤 close 가 오발화해도 onCancel 이 불리지 않는다", async () => {
    const startNicePayment = await freshStartNicePayment();
    const onCancel = vi.fn();
    await startNicePayment(makeParams(), { onCancel });
    payFormEl().submit = vi.fn();

    captured.submit!();
    captured.close!(); // SDK 가 뒤늦게 close 를 부르는 경우
    expect(onCancel, "이미 제출된 결제가 화면에서 '취소됨'으로 되돌아간다").not.toHaveBeenCalled();
  });

  it("🔴 우리가 등록한 것만 원복한다 — 남의 핸들러를 지우지 않는다", async () => {
    const startNicePayment = await freshStartNicePayment();
    await startNicePayment(makeParams(), { onCancel: vi.fn() });

    // 그 사이 다른 코드가 전역을 덮었다
    const foreign = vi.fn();
    window.nicepaySubmit = foreign;
    window.nicepayClose = foreign;

    captured.close!(); // 취소 → restore 가 돈다
    expect(window.nicepaySubmit, "🔴 남의 핸들러를 지웠다").toBe(foreign);
    expect(window.nicepayClose).toBe(foreign);
  });

  it("🔴 취소 후 재시도하면 이전 핸들러가 남지 않는다", async () => {
    // ⚠️ 여기서 startNicePayment 를 **한 번만** 가져온다. freshStartNicePayment 를 두 번
    //    부르면 모듈이 둘로 갈려(vi.resetModules) 회수 상태가 공유되지 않는다 —
    //    실제 앱에는 모듈 인스턴스가 하나뿐이다. 픽스처가 현실과 달라지면 검증이 아니다.
    const startNicePayment = await freshStartNicePayment();
    const first = vi.fn();
    await startNicePayment(makeParams(), { onCancel: first });
    const firstClose = captured.close!;

    const second = vi.fn();
    await startNicePayment(makeParams(), { onCancel: second });
    expect(captured.close, "재시도 후 전역은 새 핸들러여야 한다").not.toBe(firstClose);

    // 새 시도의 콜백만 살아 있어야 한다 — 옛 close 를 불러도 옛 화면이 깨어나면 안 된다
    firstClose();
    expect(first).not.toHaveBeenCalled();
    captured.close!();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("🔴 회수된 시도의 성공 콜백은 폼을 제출하지 않는다 — 옛 주문이 승인된다", async () => {
    const startNicePayment = await freshStartNicePayment();
    await startNicePayment(makeParams({ Moid: "ord_old" }), { onCancel: vi.fn() });
    const firstSubmit = captured.submit!;
    const firstSubmitSpy = vi.fn();
    payFormEl().submit = firstSubmitSpy; // 1차 시도의 폼

    // 재시도 — 1차가 회수되고 새 폼이 만들어진다
    await startNicePayment(makeParams({ Moid: "ord_new" }), { onCancel: vi.fn() });
    payFormEl().submit = vi.fn();

    firstSubmit(); // SDK 가 뒤늦게 옛 콜백을 부르는 경우
    expect(firstSubmitSpy, "🔴 옛 주문(ord_old)이 승인된다").not.toHaveBeenCalled();
  });

  it("onCancel 을 안 줘도 취소가 터지지 않는다 (옵션이다)", async () => {
    const startNicePayment = await freshStartNicePayment();
    await startNicePayment(makeParams());
    expect(() => captured.close!()).not.toThrow();
  });
});
