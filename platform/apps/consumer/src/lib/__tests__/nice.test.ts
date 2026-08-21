import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { NicePayProviderParams } from "@pickket/lib/api";

const JS_URL = "https://pg-web.nicepay.co.kr/v3/common/js/nicepay-pgweb.js";

// 각 테스트가 nice.ts 의 모듈-프라이빗 SDK 상태(sdkPromise/loadedSdkUrl)에
// 오염되지 않도록 매번 새로 import 한다.
async function freshStartNicePayment() {
  vi.resetModules();
  const mod = await import("@/lib/nice");
  return mod.startNicePayment;
}

function makeParams(
  overrides: Partial<Record<string, string>> = {},
): NicePayProviderParams {
  return {
    js_url: JS_URL,
    form: {
      MID: "nicepay00m",
      Moid: "ord_abc_a1",
      Amt: "1004",
      EdiDate: "20260723120000",
      SignData: "SIGN_ABC_DEF",
      GoodsName: "PICKKET",
      ReturnURL: "https://api.pickket.kr/api/v1/payments/nice/return",
      MallReserved: "https://www.pickket.kr/ko/payment/success?order=uuid1",
      ...overrides,
    },
  };
}

describe("nice.ts — 나이스페이 구형(goPay) 결제창 클라이언트", () => {
  let goPay: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    document.head.innerHTML = "";
    document.body.innerHTML = "";
    goPay = vi.fn();
    (window as unknown as { goPay: unknown }).goPay = goPay;
  });

  afterEach(() => {
    delete (window as unknown as { goPay?: unknown }).goPay;
    // 전역 결제 콜백이 테스트 간 잔존하지 않게 정리(격리).
    delete (window as unknown as { nicepayClose?: unknown }).nicepayClose;
    delete (window as unknown as { nicepaySubmit?: unknown }).nicepaySubmit;
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

    // 서버 생성값(SignData 등)이 무변형으로 hidden input 에 들어갔는지
    const read = (name: string) =>
      formEl.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.value;
    expect(read("MID")).toBe("nicepay00m");
    expect(read("Moid")).toBe("ord_abc_a1");
    expect(read("Amt")).toBe("1004");
    expect(read("SignData")).toBe("SIGN_ABC_DEF");
    expect(read("ReturnURL")).toBe(
      "https://api.pickket.kr/api/v1/payments/nice/return",
    );
    expect(read("MallReserved")).toBe(
      "https://www.pickket.kr/ko/payment/success?order=uuid1",
    );
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
    // goPay 미등록 + 스크립트 태그 존재 → load 후에도 goPay 없으면 throw.
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

  it("성공 콜백: nicepaySubmit 을 goPay 전에 등록하고, 호출 시 payForm 을 제출한다", async () => {
    const startNicePayment = await freshStartNicePayment();
    await startNicePayment(makeParams());
    // SDK 가 인증성공 시 nicepaySubmit() 을 하드콜 → 반드시 등록돼 있어야 함(미등록=성공 깨짐).
    expect(goPay).toHaveBeenCalledTimes(1);
    const submit = (window as unknown as { nicepaySubmit?: () => void }).nicepaySubmit;
    expect(typeof submit).toBe("function");
    const formEl = goPay.mock.calls[0][0] as HTMLFormElement;
    const submitSpy = vi.spyOn(formEl, "submit").mockImplementation(() => {});
    submit!();
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it("payForm.action 이 ReturnURL 로 설정된다(성공 제출 목적지)", async () => {
    const startNicePayment = await freshStartNicePayment();
    await startNicePayment(makeParams());
    const formEl = goPay.mock.calls[0][0] as HTMLFormElement;
    expect(formEl.getAttribute("action")).toBe(makeParams().form.ReturnURL);
  });

  it("취소 콜백: onCancel 지정 시 nicepayClose 를 goPay 전에 등록, 닫힘 시 onCancel 발화 후 자기해제", async () => {
    const startNicePayment = await freshStartNicePayment();
    const onCancel = vi.fn();
    await startNicePayment(makeParams(), { onCancel });
    expect(goPay).toHaveBeenCalledTimes(1);
    expect(typeof (window as unknown as { nicepayClose?: unknown }).nicepayClose).toBe(
      "function",
    );
    // 팝업 닫힘/인증오류(SDK 는 둘 다 nicepayClose 로 라우팅) → onCancel 발화(고착 탈출).
    (window as unknown as { nicepayClose: () => void }).nicepayClose();
    expect(onCancel).toHaveBeenCalledTimes(1);
    // 첫 발화에서 자기해제 → 우리가 등록한 핸들러 원복(등록 전 undefined)로 전역 오염 없음.
    expect((window as unknown as { nicepayClose?: unknown }).nicepayClose).toBeUndefined();
  });

  it("onCancel 미지정이어도 nicepaySubmit 은 등록(성공 필수), nicepayClose 는 무해 no-op", async () => {
    const startNicePayment = await freshStartNicePayment();
    delete (window as unknown as { nicepayClose?: unknown }).nicepayClose;
    delete (window as unknown as { nicepaySubmit?: unknown }).nicepaySubmit;
    await startNicePayment(makeParams());
    // 성공 제출 콜백은 onCancel 유무와 무관하게 항상 등록.
    expect(typeof (window as unknown as { nicepaySubmit?: unknown }).nicepaySubmit).toBe(
      "function",
    );
    // nicepayClose 는 등록되나 onCancel 없으면 no-op(에러 없이 통과).
    const close = (window as unknown as { nicepayClose?: () => void }).nicepayClose;
    expect(typeof close).toBe("function");
    expect(() => close!()).not.toThrow();
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
});
