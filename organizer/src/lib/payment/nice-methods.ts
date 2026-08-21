/* ── 나이스페이(구형) 결제수단 선택 (organizer) ──────────────────────────────
 *
 * 나이스 구형 결제창은 서버(v2)가 payForm 을 생성하므로, 사용자가 고른 결제수단은
 * **prepare 요청의 `pay_method`** 로 서버에 전달돼 결제창이 해당 수단으로 열린다
 * (신형 AUTHNICE.requestPay 의 클라 `method` 직접전달을 폐기 — 서버 pay_method 배선).
 * consumer(`platform/apps/consumer/src/lib/nicepay-methods.ts`)와 동일 계약을 따른다.
 *
 * 백엔드 계약(Track1): pay_method ∈ {CARD·EASYPAY·BANK·VBANK·CELLPHONE}.
 *   미지정=CARD. 서버가 화이트리스트로 정규화(오염값→CARD)하므로 클라는 선택+전달만 한다.
 *   (서버 normalize_nice_pay_method — PayMethod 는 SignData 입력이 아님.)
 *
 * ⚠️ 라벨은 organizer 관례(전 UI 한국어)에 따라 한국어 상수로 둔다(next-intl 미도입 앱).
 */

/** 나이스 결제수단 코드(백엔드 pay_method 화이트리스트와 1:1). */
export type NiceMethod = "CARD" | "EASYPAY" | "BANK" | "VBANK" | "CELLPHONE";

/** 기본 결제수단(미선택 시). 백엔드 기본값과 정합. */
export const DEFAULT_NICE_METHOD: NiceMethod = "CARD";

/** 노출 순서(카드 우선). */
export const NICE_METHOD_ORDER: readonly NiceMethod[] = [
  "CARD",
  "EASYPAY",
  "BANK",
  "VBANK",
  "CELLPHONE",
];

/** 결제수단 한국어 라벨. */
export const NICE_METHOD_LABELS: Record<NiceMethod, string> = {
  CARD: "신용·체크카드",
  EASYPAY: "간편결제",
  BANK: "계좌이체",
  VBANK: "가상계좌",
  CELLPHONE: "휴대폰 결제",
};

/**
 * 이벤트의 allowed_pay_methods(백엔드 대문자 코드 리스트)를 선택 UI 수단으로 정규화한다.
 * CARDANDEASYPAY → 카드+간편결제 두 UI 수단으로 확장. NULL/미제공/빈 배열 → null(=게이팅 없음).
 * 대소문자·공백 무시. 알 수 없는 코드는 무시(값 정규화는 서버 소유 — 프론트는 표시만).
 * consumer(`platform/apps/consumer/src/lib/nicepay-methods.ts`)와 동일 계약.
 */
export function normalizeAllowedNiceMethods(
  raw?: readonly string[] | null,
): NiceMethod[] | null {
  if (!raw || raw.length === 0) return null;
  const out = new Set<NiceMethod>();
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
        break;
    }
  }
  return out.size > 0 ? [...out] : null;
}

/**
 * 노출할 결제수단 목록.
 * @param allowed 허용목록(카드전용 게이팅 등). 미지정/null/빈 배열이면 전체 노출.
 *   `allowed_pay_methods`(대문자 문자열 코드)와 `NiceMethod` 둘 다 수용한다.
 *   오염값은 화이트리스트로 걸러지고, 전부 무효면 전체 노출(서버가 강제).
 */
export function getNiceMethods(allowed?: readonly string[] | null): NiceMethod[] {
  const normalized = normalizeAllowedNiceMethods(allowed);
  if (!normalized) return [...NICE_METHOD_ORDER];
  const allowSet = new Set(normalized);
  const filtered = NICE_METHOD_ORDER.filter((m) => allowSet.has(m));
  return filtered.length > 0 ? filtered : [DEFAULT_NICE_METHOD];
}

/** 카드전용 게이팅 여부(허용목록이 CARD 하나로 좁혀졌는지) — UI 를 숨기고 카드 고정. */
export function isNiceCardOnly(allowed?: readonly string[] | null): boolean {
  const methods = getNiceMethods(allowed);
  return methods.length === 1 && methods[0] === "CARD";
}
