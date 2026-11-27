/* ── 나이스페이(구형) 결제수단 선택 (consumer) ───────────────────────────────
 *
 * 나이스 구형 결제창은 서버(v2)가 payForm 을 생성하므로, 사용자가 고른 결제수단은
 * **prepare 요청의 `pay_method`** 로 서버에 전달돼 결제창이 해당 수단으로 열린다.
 * (토스는 위젯이 수단을 집약하므로 이 선택 UI 를 쓰지 않는다 — provider 분기.)
 *
 * 백엔드 계약(Track1): pay_method ∈ {CARD·BANK·VBANK·CELLPHONE·EASYPAY·CARDANDEASYPAY}.
 *   미지정=CARD. 서버가 화이트리스트로 정규화(오염값→CARD)하므로 클라는 선택+전달만 한다.
 *
 * provider 판정: consumer 는 서버 prepare 응답(provider)으로 실제 결제창을 분기하지만,
 *   pay_method 는 prepare **요청 시점**에 필요하므로 결제창 UI 렌더는 env 기본 provider 로
 *   결정한다(organizer 와 동일 패턴). toss 면 위젯이 렌더되어 이 선택 UI 는 숨는다.
 */

/** 나이스 결제수단 코드(백엔드 pay_method 화이트리스트와 1:1). */
export type NicePayMethod =
  | "CARD"
  | "EASYPAY"
  | "BANK"
  | "VBANK"
  | "CELLPHONE";

/** 기본 결제수단(미선택 시). 백엔드 기본값과 정합. */
export const DEFAULT_NICE_METHOD: NicePayMethod = "CARD";

/**
 * 결제수단 노출 순서(카드 우선) — **실배선된 수단만**.
 * ⚠️ VBANK(가상계좌)는 Wave3 미실배선이라 노출 목록에서 제외한다(선택 시 미구현 흐름 진입 방지).
 *    allowed_pay_methods 로 VBANK 가 명시돼도 이 목록으로 필터링돼 노출되지 않는다.
 *    Wave3 에서 가상계좌 입금대기·웹훅 실배선 완료 시 아래에 "VBANK" 를 복원한다.
 */
export const NICE_METHOD_ORDER: readonly NicePayMethod[] = [
  "CARD",
  "EASYPAY",
  "BANK",
  "CELLPHONE",
];

/**
 * 나이스 상점 계약(MID)에서 실제로 열린 결제수단 — `NEXT_PUBLIC_NICE_PAY_METHODS`(쉼표 구분, 예 "CARD,BANK").
 * 계약에 없는 수단을 고르면 나이스 결제창이 `[W004] 결제수단이 유효하지 않습니다` 로 멈추므로
 * 아예 노출하지 않는다. 미설정·빈 값·전부 무효면 NICE_METHOD_ORDER 전체(현행 그대로).
 * 나이스에서 간편결제·휴대폰 결제가 열리면 이 값에 EASYPAY·CELLPHONE 을 더하고 다시 빌드한다.
 */
export function platformNiceMethods(): NicePayMethod[] {
  const raw = process.env.NEXT_PUBLIC_NICE_PAY_METHODS || "";
  const enabled = new Set(
    raw.split(",").map((s) => s.trim().toUpperCase()).filter(Boolean),
  );
  const out = NICE_METHOD_ORDER.filter((m) => enabled.has(m));
  return out.length > 0 ? out : [...NICE_METHOD_ORDER];
}

/** 각 수단의 i18n 라벨 키(payment.niceMethod.*). */
export const NICE_METHOD_LABEL_KEYS: Record<NicePayMethod, string> = {
  CARD: "niceMethod.card",
  EASYPAY: "niceMethod.easypay",
  BANK: "niceMethod.bank",
  VBANK: "niceMethod.vbank",
  CELLPHONE: "niceMethod.cellphone",
};

/**
 * 이벤트의 `allowed_pay_methods`(백엔드 대문자 코드 리스트)를 선택 UI 수단으로 정규화한다.
 * 백엔드 코드 ⊇ UI 수단: CARDANDEASYPAY → 카드+간편결제 두 UI 수단으로 확장한다.
 * NULL/미제공/빈 배열 → null(=전체 허용, 게이팅 없음). 값이 있으면 대소문자·공백 무시 파싱.
 * 알 수 없는 코드는 무시(값 정규화는 서버 소유 — 프론트는 표시만).
 *
 * @param raw 이벤트의 allowed_pay_methods(문자열 리스트) 또는 NicePayMethod 리스트.
 * @returns 게이팅 목록(UI 수단) 또는 null(=게이팅 없음, 전체 노출).
 */
export function normalizeAllowedNiceMethods(
  raw?: readonly string[] | null,
): NicePayMethod[] | null {
  if (!raw || raw.length === 0) {
    return null;
  }
  const out = new Set<NicePayMethod>();
  for (const code of raw) {
    const upper = String(code).trim().toUpperCase();
    switch (upper) {
      case "CARD":
        out.add("CARD");
        break;
      case "EASYPAY":
        out.add("EASYPAY");
        break;
      case "CARDANDEASYPAY":
        // 백엔드 통합코드 → UI 는 카드·간편결제 두 수단으로 노출.
        out.add("CARD");
        out.add("EASYPAY");
        break;
      case "BANK":
        out.add("BANK");
        break;
      case "VBANK":
        out.add("VBANK");
        break;
      case "CELLPHONE":
        out.add("CELLPHONE");
        break;
      default:
        // 알 수 없는 코드 무시(서버가 최종 강제).
        break;
    }
  }
  // 유효 코드가 하나도 없으면 게이팅 없음으로 간주(안전: 결제 진입 보장, 서버가 강제).
  return out.size > 0 ? [...out] : null;
}

/**
 * 노출할 결제수단 목록을 계산한다.
 * @param allowed 허용목록(카드전용 게이팅 등). 미지정/null/빈 배열이면 전체 노출.
 *   `allowed_pay_methods`(대문자 문자열 코드)와 `NicePayMethod` 둘 다 수용한다.
 *   오염값은 화이트리스트로 걸러지고, 전부 무효면 CARD 로 폴백(결제 진입 보장).
 */
export function getNiceMethods(
  allowed?: readonly string[] | null,
): NicePayMethod[] {
  const base = platformNiceMethods();
  const normalized = normalizeAllowedNiceMethods(allowed);
  if (!normalized) {
    return base;
  }
  const allowSet = new Set(normalized);
  const filtered = base.filter((m) => allowSet.has(m));
  return filtered.length > 0 ? filtered : [DEFAULT_NICE_METHOD];
}

/** 카드전용 게이팅 여부(허용목록이 CARD 하나로 좁혀졌는지) — UI 를 숨기고 카드 고정. */
export function isNiceCardOnly(allowed?: readonly string[] | null): boolean {
  const methods = getNiceMethods(allowed);
  return methods.length === 1 && methods[0] === "CARD";
}

/** consumer 결제 provider 판정(env 폴백) — 미상/토스는 "toss". */
export type ConsumerPaymentProvider = "toss" | "nicepay";

/**
 * consumer 결제 provider(env 기본값). 실제 결제창 분기는 서버 prepare.provider 우선이지만,
 * pay_method 선택 UI 노출 여부는 요청 전에 정해야 하므로 env 로 판정한다.
 * NEXT_PUBLIC_* 는 빈 문자열 주입 가능 → `||` 폴백(아키맵 함정3, `??` 금지).
 */
export function resolveConsumerPaymentProvider(): ConsumerPaymentProvider {
  // 🔴 폴백 "toss" → "nicepay" (2026-07-28 대표 결정: 나이스 **구형/정규**로만 간다. 토스는 dormant(기존 주문 라우팅용).)
  //    이 값이 나이스 결제수단 선택 UI 노출 여부를 정한다 — toss 로 떨어지면 env 미설정 prod 에서
  //    나이스 UI 가 통째로 숨는다.
  const raw = (process.env.NEXT_PUBLIC_PAYMENT_PROVIDER || "nicepay").toLowerCase();
  return raw === "nicepay" || raw === "nice" ? "nicepay" : "toss";
}

/** 나이스 결제수단 선택 UI 를 노출할지(=env provider 가 nicepay 인지). */
export function isNicePayMethodSelectable(): boolean {
  return resolveConsumerPaymentProvider() === "nicepay";
}
