"use client";

/* ── 나이스페이(NICEPAY) 구형/정규 결제창 클라이언트 (organizer) ─────────────
 *
 * 결제창 방식: **nicepay-pgweb.js 의 goPay(폼 POST)** — 신형 AUTHNICE.requestPay 를 완전 폐기.
 * consumer(`platform/apps/consumer/src/lib/nice.ts`)의 구형 구현을 정본 템플릿으로 삼아
 * organizer 도 동일 패턴으로 맞춘다(구형이 확정 API — P4 샌드박스 실검증).
 *
 * 서버(v2)가 prepare 응답의 `provider_params` 로 결제창에 필요한 모든 값을 내려준다:
 *   provider_params = {
 *     js_url: "https://pg-web.nicepay.co.kr/v3/common/js/nicepay-pgweb.js",
 *     form: { MID, Moid, Amt, EdiDate, PayMethod, SignData, GoodsName, ReturnURL, MallReserved }
 *   }
 * 이 함수는 form.* 를 그대로 hidden <form name="payForm"> 에 주입하고 SDK 의 goPay(payForm) 를
 * 호출해 결제창을 띄운다. 인증 성공 시 나이스가 ReturnURL(=v2)로 인증결과를 POST →
 * v2 가 서버승인(4중검증) 후 302 redirect 로 organizer success/fail 에 착지시킨다.
 * organizer 결제개시는 MallReserved='go' 를 심어 v2 return 핸들러가 go 랜딩(NICEPAY_GO_SUCCESS_URL)
 * 으로 라우팅하게 한다 — 그 값은 서버(prepare)가 채우고, 클라는 무변형 소비만 한다.
 *
 * ⚠️ 불변식: SignData·EdiDate·MID·ReturnURL·MallReserved 등 **서버가 준 값은 절대 클라에서
 *    변형하지 않는다**(변형 시 서명 검증 실패). 값 그대로 폼에 넣어 제출만 한다.
 * 🔴 **인증 결과 콜백은 가맹점이 등록해야 한다** (2026-08-08 실장애).
 *    SDK 는 `nicepaySubmit()`·`nicepayClose()` 를 **호출만** 하고 정의하지 않는다.
 *    등록이 없으면 데스크탑에서 승인이 아예 일어나지 않는다 — 모바일은 리다이렉트라
 *    JS 콜백을 안 타서 멀쩡하다. 발주처 신고("데스크탑 크롬")가 정확히 그 모양이었다.
 *
 * ⚠️ 구형 결제창은 EUC-KR 전송이므로 form 에 accept-charset="euc-kr" 을 지정한다.
 * ⚠️ 승인·취소·서명은 전부 v2 backend 소유 — organizer 는 결제창 호출·분기·상태표시만 한다
 *    (NICE 승인/취소/웹훅/secretKey 코드 없음).
 */

/**
 * 나이스페이(구형) 결제창 파라미터 — provider="nicepay" 일 때만 서버가 채운다(토스면 null).
 * consumer 공유타입(@pickket/lib NicePayProviderParams)의 organizer 로컬 복사본
 * (organizer 는 @pickket/lib 를 임포트하지 않는 독립 앱).
 */
export interface NicePayProviderParams {
  /** nicepay-pgweb.js SDK URL(goPay 제공). */
  js_url: string;
  /** goPay 폼 필드 — 전부 문자열, 서버 생성값 그대로 hidden input 으로 주입. */
  form: Record<string, string>;
}

const FORM_NAME = "payForm";

declare global {
  interface Window {
    /** nicepay-pgweb.js 가 등록하는 전역 함수 — 결제창 팝업/리다이렉트를 개시. */
    goPay?: (form: HTMLFormElement) => void;
    /**
     * 🔴 **SDK 가 호출만 하고 정의하지 않는다 — 가맹점이 등록해야 한다.**
     *
     * 인증 성공 시 SDK 가 인증결과를 폼에 주입한 뒤 이걸 부른다. 여기서 폼을 ReturnURL 로
     * POST 해야 **승인이 일어난다**. SDK 실물에서 `nicepaySubmit();` 은 **try/catch 없는
     * 하드콜**이라, 미정의면 그 자리에서 TypeError 로 중단되고 폼이 ReturnURL 로 가지 않는다.
     * ⟹ 발주처 신고 그대로: *"결제완료를 눌러도 승인되지 않는다. 재시도하면 팝업이 다시 뜬다."*
     */
    nicepaySubmit?: () => void;
    /**
     * 취소·인증오류 시 SDK 가 부른다. 이쪽은 SDK 안에서 `try{ nicepayClose(); }catch(e){}` 로
     * 감싸여 있어 미정의여도 **에러가 안 난다** ⟹ 조용히 실패한다: 취소했는데 화면만 멎는다.
     */
    nicepayClose?: () => void;
  }
}

/** 결제창 개시 옵션 — 취소 통지를 화면으로 되돌리는 통로. */
export interface NicePaymentOptions {
  /**
   * 🔴 사용자가 결제창을 취소했거나 인증에 실패했을 때.
   *
   * 호출부는 `goPay` **이전** 오류만 `catch` 로 잡는다 — 취소는 그 catch 에 안 걸린다.
   * 이 통지를 안 받으면 processing 모달이 **영구 고착**해 결제 버튼을 다시 못 누른다.
   */
  onCancel?: () => void;
}

let sdkPromise: Promise<void> | null = null;
let loadedSdkUrl: string | null = null;

/**
 * 직전 시도가 남긴 콜백 회수기.
 *
 * 취소 후 재시도하면 이전 핸들러가 `window` 에 남는다 — 새 시도의 폼을 옛 핸들러가 잡거나,
 * 옛 화면의 `onCancel` 이 뒤늦게 불린다. 새 시도를 시작하기 전에 먼저 회수한다.
 */
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
  // 🔴 **action 을 반드시 ReturnURL 로 건다** (2026-08-08 실장애 2차).
  //    SDK 는 폼 *필드값*으로 결제창을 열 뿐 action 을 세팅해주지 않는다. 미설정이면
  //    nicepaySubmit() 의 제출이 **현재 URL(결제 페이지)로** 가고, 승인이 일어나지 않은 채
  //    결제창 처음으로 되돌아온다 — 발주처·대표 실측 증상이 정확히 그것이었다.
  //    ⚠️ 값은 서버가 준 것 그대로. 우리가 만들거나 가공하지 않는다(서명 입력값 계약).
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
  if (typeof window.goPay !== "function") {
    throw new Error("나이스 결제 모듈을 초기화하지 못했습니다. 잠시 후 다시 시도해주세요.");
  }

  const formEl = buildPayForm(providerParams.form);

  // ── 🔴 결제 콜백 등록 — **goPay 전에 반드시** ──
  //
  // 순서가 뒤바뀌면 안 된다. goPay 는 결제창을 여는 즉시 제어를 SDK 에 넘기고, 인증이
  // 끝나는 시점에 이 전역들을 부른다. 등록이 그 뒤에 오면 이미 늦다.
  if (activeNiceCancelDispose) {
    activeNiceCancelDispose();
    activeNiceCancelDispose = null;
  }

  const onCancel = options?.onCancel;
  let settled = false;
  // 🔴 이 시도가 회수됐는가. 재시도가 시작되면 참이 된다.
  //    회수는 window 전역을 되돌릴 뿐, **옛 클로저 자체를 없애지는 못한다** — 어딘가에
  //    옛 참조가 남아 나중에 불리면 **이미 떠난 화면의 onCancel 이 깨어난다**.
  //    (테스트가 정확히 그걸 잡았다: 재시도 뒤 옛 close 를 부르니 옛 onCancel 이 불렸다)
  let disposed = false;
  const prevSubmit = window.nicepaySubmit;
  const prevClose = window.nicepayClose;

  const restore = () => {
    disposed = true;
    // 🔴 **우리가 등록한 것만** 원복한다. 그 사이 다른 코드가 덮었다면 남의 핸들러를
    //    지우게 되고, 그쪽 결제가 조용히 깨진다.
    if (window.nicepaySubmit === submitHandler) window.nicepaySubmit = prevSubmit;
    if (window.nicepayClose === closeHandler) window.nicepayClose = prevClose;
    activeNiceCancelDispose = null;
  };

  const submitHandler = () => {
    // 회수된 시도의 폼을 제출하면 **옛 주문**이 승인된다.
    if (disposed) return;
    // 성공 — SDK 가 인증결과를 폼에 주입한 뒤 부른다. 여기서 ReturnURL 로 제출해야
    // v2 승인 핸들러에 닿는다(이후 페이지를 떠난다).
    // ⚠️ 폼을 우리가 인코딩·가공하지 않는다. SignData·EdiDate 무변형 원칙 그대로다.
    settled = true;
    formEl.submit();
  };

  const closeHandler = () => {
    // 🔴 성공 뒤 close 가 오발화할 수 있다. settled 없이 두면 이미 제출된 결제에 대해
    //    화면이 "취소됨"으로 되돌아간다.
    if (settled || disposed) return;
    settled = true;
    restore();
    onCancel?.();
  };

  window.nicepaySubmit = submitHandler;
  window.nicepayClose = closeHandler;
  activeNiceCancelDispose = restore;

  window.goPay(formEl);
}

/**
 * mock 리다이렉트 — 서버가 provider_params 를 내리지 않는 데모/E2E(mock 모드)에서
 * 결제창 없이 go 성공 착지 라우트로 리다이렉트한다. v2 승인이 없으므로 reason=confirmed 로
 * 착지시켜 실 경로(302 redirect)와 동일한 파라미터 계약(provider·reason·orderId)을 흉내낸다.
 * orderId = go order id(성공 페이지가 이벤트 slug 해석·완료링크에 사용).
 */
export function mockNiceRedirectToSuccess(orderId: string, successUrl: string): void {
  if (process.env.NODE_ENV === "production") {
    throw new Error("NICE mock 결제는 production에서 사용할 수 없습니다");
  }
  const url = new URL(successUrl);
  url.searchParams.set("provider", "nicepay");
  url.searchParams.set("reason", "confirmed");
  url.searchParams.set("orderId", orderId);
  window.location.assign(url.toString());
}
