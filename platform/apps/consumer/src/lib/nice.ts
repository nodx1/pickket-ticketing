/* ── 나이스페이(NICEPAY) 구형/정규 결제창 클라이언트 (consumer) ───────────────
 *
 * 결제창 방식: **nicepay-pgweb.js 의 goPay(폼 POST)** — 신형 AUTHNICE.requestPay 를 완전 폐기.
 *
 * 서버(v2)가 prepare 응답의 `provider_params` 로 결제창에 필요한 모든 값을 내려준다:
 *   provider_params = {
 *     js_url: "https://pg-web.nicepay.co.kr/v3/common/js/nicepay-pgweb.js",
 *     form: { MID, Moid, Amt, EdiDate, SignData, GoodsName, ReturnURL, MallReserved, ... }
 *   }
 * 이 함수는 form.* 를 그대로 hidden <form name="payForm"> 에 주입하고 SDK 의 goPay(payForm) 를
 * 호출해 결제창을 띄운다. 인증 성공 시 SDK 가 **nicepaySubmit() 전역 콜백을 호출**해 (인증결과가
 * 주입된) 폼을 ReturnURL(=v2)로 POST → v2 가 서버승인(4중검증) 후 302 redirect 로 consumer
 * success/fail 에 착지시킨다. 취소/인증오류 시엔 nicepayClose() 를 호출한다.
 *   ⚠️ nicepaySubmit·nicepayClose 는 SDK 가 **호출만** 하고 정의하지 않는다(SDK 소스 확인,
 *      nicepay-pgweb.js). 가맹점이 반드시 정의해야 하며, 특히 nicepaySubmit 은 try/catch 없는
 *      하드콜이라 미정의 시 성공 제출이 ReferenceError 로 깨진다.
 *
 * ⚠️ 불변식: SignData·EdiDate·MID·ReturnURL 등 **서버가 준 값은 절대 클라에서 변형하지 않는다**
 *    (변형 시 서명 검증 실패). 값 그대로 폼에 넣어 제출만 한다.
 * ⚠️ 구형 결제창은 EUC-KR 전송이므로 form 에 accept-charset="euc-kr" 을 지정한다.
 */

import type { NicePayProviderParams } from "@pickket/lib/api";

const FORM_NAME = "payForm";

declare global {
  interface Window {
    /** nicepay-pgweb.js 가 등록하는 전역 함수 — 결제창 팝업/리다이렉트를 개시. */
    goPay?: (form: HTMLFormElement) => void;
    /**
     * 구형 pgweb SDK 가 **팝업 닫힘(PC 결제창 X/취소)** 시 호출하는 전역 콜백.
     * SDK 소유의 훅이므로 우리가 등록해두면 팝업이 닫힐 때 발화한다(P4 하네스서 관측).
     * 미등록 시 SDK 는 no-op → 이 함수를 등록해 processing 고착을 탈출한다.
     */
    nicepayClose?: () => void;
    /**
     * 구형 pgweb SDK 가 **인증 성공** 시 호출하는 전역 콜백 — (인증결과가 주입된) 결제폼을
     * ReturnURL 로 제출한다. SDK 는 호출만 하고 정의하지 않으므로(try/catch 없는 하드콜)
     * 가맹점이 반드시 정의해야 한다. 미정의 시 성공 제출이 ReferenceError 로 깨진다.
     * (SDK 소스 확인: nicepay-pgweb.js case "0" → nicepaySubmit())
     */
    nicepaySubmit?: () => void;
  }
}

/** startNicePayment 옵션 — 팝업 닫힘/오류 시 상위(락 해제)로 통지. */
export interface NicePaymentOptions {
  /**
   * PC goPay 팝업이 사용자에 의해 닫히거나 SDK 가 인증오류를 통지할 때 호출된다.
   * goPay 는 예외를 throw 하지 않으므로(팝업 흐름) 이 콜백이 processing 고착 탈출의 유일 경로다.
   * 여러 번 발화하지 않도록 첫 호출에서만 통지한다.
   */
  onCancel?: (message?: string) => void;
}

let sdkPromise: Promise<void> | null = null;
let loadedSdkUrl: string | null = null;

// 우리가 마지막으로 등록한 팝업-닫힘 전역 핸들러(자기해제 못한 경우 다음 호출이 회수).
// 사용자가 '취소하고 닫기'(수동 탈출구)로 processing 을 빠져나가면 SDK 콜백이 발화하지
// 않아 우리가 등록한 nicepaySubmit/nicepayClose 가 window 에 잔존한다. 재시도 시 이 잔존
// 핸들러를 먼저 회수해 스테일 콜백 발화·전역 오염을 막는다(edge ①).
let activeNiceCancelDispose: (() => void) | null = null;

/**
 * 나이스 구형 SDK(nicepay-pgweb.js) 동적 로드 — 중복로드 방지.
 * js_url 은 서버가 내려주므로 상수화하지 않고 인자로 받는다(sandbox/live 전환 서버 소유).
 */
function loadNiceSdk(jsUrl: string): Promise<void> {
  if (typeof window === "undefined") {
    return Promise.reject(new Error("나이스 SDK 는 브라우저에서만 로드할 수 있습니다"));
  }
  // goPay 가 이미 등록돼 있으면 로드 완료로 간주(중복로드 방지).
  if (typeof window.goPay === "function") {
    loadedSdkUrl = jsUrl;
    return Promise.resolve();
  }
  if (sdkPromise && loadedSdkUrl === jsUrl) return sdkPromise;

  sdkPromise = new Promise<void>((resolve, reject) => {
    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${jsUrl}"]`,
    );
    if (existing) {
      existing.addEventListener("load", () => {
        loadedSdkUrl = jsUrl;
        resolve();
      });
      existing.addEventListener("error", () => {
        sdkPromise = null;
        reject(new Error("나이스 결제 모듈(nicepay-pgweb.js) 로드에 실패했습니다"));
      });
      return;
    }
    const script = document.createElement("script");
    script.src = jsUrl;
    script.async = true;
    script.onload = () => {
      loadedSdkUrl = jsUrl;
      resolve();
    };
    script.onerror = () => {
      sdkPromise = null;
      reject(new Error("나이스 결제 모듈(nicepay-pgweb.js) 로드에 실패했습니다"));
    };
    document.head.appendChild(script);
  });
  loadedSdkUrl = jsUrl;
  return sdkPromise;
}

/**
 * provider_params.form 필드를 담은 hidden <form name="payForm" method="post"> 을
 * DOM 에 주입한다(EUC-KR). 이전 주입 폼이 있으면 제거 후 재생성(재시도 안전).
 * 서버가 준 값을 무변형으로 input value 에 넣는다.
 */
function buildPayForm(form: Record<string, string>): HTMLFormElement {
  const prev = document.querySelector<HTMLFormElement>(`form[name="${FORM_NAME}"]`);
  if (prev) prev.remove();

  const el = document.createElement("form");
  el.name = FORM_NAME;
  el.method = "post";
  // 성공 인증 시 nicepaySubmit() 이 이 폼을 ReturnURL 로 POST 한다(SDK 소스 확인). goPay 는
  // 폼을 action 으로 제출하지 않고 필드값으로 결제창을 열므로 action=ReturnURL 이 안전하다.
  // action 미설정 시 성공 제출이 현재 URL 로 가 승인이 깨진다.
  if (form.ReturnURL) el.action = form.ReturnURL;
  // 구형 결제창 EUC-KR 전송(속성명 소문자 표기가 브라우저 호환).
  el.setAttribute("accept-charset", "euc-kr");
  el.style.display = "none";

  for (const [key, value] of Object.entries(form)) {
    const input = document.createElement("input");
    input.type = "hidden";
    input.name = key;
    // 서버 생성값(SignData 등) 무변형 주입 — 절대 인코딩/트리밍하지 않는다.
    input.value = value ?? "";
    el.appendChild(input);
  }
  document.body.appendChild(el);
  return el;
}

/**
 * 나이스 구형 결제창 개시 — provider_params(js_url + form)를 받아 goPay 로 제출한다.
 * 정상 흐름에서 goPay 는 결제창 팝업/리다이렉트로 넘어가므로 이 함수는 반환 전에 화면을 떠난다.
 * @throws provider_params 누락/형식오류·SDK 로드 실패·goPay 미정의 시 명확한 에러(조용한 실패 금지).
 */
/**
 * 나이스 결제창 레이어를 우리 모달보다 위로 올린다.
 *
 * SDK 가 만드는 `#nice_layer`(z 9999)·`#bg_layer`(z 9998)는 인라인 z-index 다. 그런데 결제 전에 띄우는
 * 주문서 확인 모달은 z 99999 라서, 결제창이 열려도 모달이 그 위를 덮어 **카드 입력을 할 수 없었다**
 * (2026-11-24 운영 상점 1,000원 실결제 시험에서 발견). 인라인 값은 스타일시트의 `!important` 가
 * 이기므로, 규칙 하나를 한 번만 넣어 어느 화면에서 결제창을 열어도 맨 위에 오게 한다.
 */
function ensureNiceLayerOnTop(): void {
  if (typeof document === "undefined" || document.getElementById("nice-layer-on-top")) return;
  const style = document.createElement("style");
  style.id = "nice-layer-on-top";
  style.textContent =
    "#nice_layer{z-index:100001 !important}#bg_layer{z-index:100000 !important}";
  document.head.appendChild(style);
}

export async function startNicePayment(
  providerParams: NicePayProviderParams | null | undefined,
  options?: NicePaymentOptions,
): Promise<void> {
  if (typeof window === "undefined") {
    throw new Error("나이스 결제는 브라우저에서만 개시할 수 있습니다");
  }
  if (!providerParams || !providerParams.js_url || !providerParams.form) {
    throw new Error(
      "나이스 결제창 파라미터(provider_params)가 없습니다. 잠시 후 다시 시도해주세요.",
    );
  }

  await loadNiceSdk(providerParams.js_url);
  ensureNiceLayerOnTop();
  if (typeof window.goPay !== "function") {
    throw new Error("나이스 결제 모듈을 초기화하지 못했습니다. 잠시 후 다시 시도해주세요.");
  }

  // ── 결제 콜백 등록 (SDK 소스 nicepay-pgweb.js 확인) — goPay 전에 반드시 ──
  // SDK 는 인증 결과를 전역 콜백으로 통지하되 **호출만** 하고 정의하지 않는다:
  //   · 성공     → nicepaySubmit() : (인증결과 주입된) 폼을 ReturnURL 로 POST. try/catch 없는
  //                하드콜 → 미정의 시 성공 제출이 ReferenceError 로 깨진다(반드시 등록).
  //   · 취소/오류 → nicepayClose()  : AuthResultMsg 세팅 후 호출(취소·인증실패 공통). 미등록 시
  //                processing 모달이 영구 고착 → onCancel 로 통지해 탈출.
  // 이전 시도에서 자기해제 못한 핸들러가 잔존하면(수동 탈출구로 나간 경우) 먼저 회수한다.
  const formEl = buildPayForm(providerParams.form);

  if (activeNiceCancelDispose) {
    activeNiceCancelDispose();
    activeNiceCancelDispose = null;
  }
  const onCancel = options?.onCancel;
  let settled = false;
  const prevSubmit = window.nicepaySubmit;
  const prevClose = window.nicepayClose;
  const restore = () => {
    // 우리가 등록한 것만 원복(다른 코드가 덮어썼으면 건드리지 않음).
    if (window.nicepaySubmit === submitHandler) window.nicepaySubmit = prevSubmit;
    if (window.nicepayClose === closeHandler) window.nicepayClose = prevClose;
    activeNiceCancelDispose = null;
  };
  const submitHandler = () => {
    // 성공: SDK 가 인증결과를 폼에 주입한 뒤 호출 → ReturnURL 로 제출(이후 페이지 이탈).
    settled = true;
    formEl.submit();
  };
  const closeHandler = () => {
    if (settled) return; // 성공 후 오발화/중복 방지
    settled = true;
    restore();
    onCancel?.();
  };
  window.nicepaySubmit = submitHandler;
  window.nicepayClose = closeHandler;
  activeNiceCancelDispose = restore;

  window.goPay(formEl);
}
