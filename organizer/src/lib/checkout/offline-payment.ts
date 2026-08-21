/**
 * 무통장입금(직접입금) 정책 — **기한과 계좌 안내의 단일 출처**.
 *
 * ## 🔴 왜 한 곳에 모으는가 (2026-07-30 실사고)
 * 구매자 화면은 `"입금 기한: 결제일로부터 3일 이내"` 라고 안내했고,
 * 서버는 `initiate/route.ts` 에서 **결제수단 분기 이전에 무조건 15분**을 계산했다.
 * 만료 스윕(`internal_commerce.py` — `status=PAYMENT_REQUIRED AND payment_deadline < now`)은
 * **payment_method 를 보지 않는다** ⟹ 무통장 주문이 **15분 뒤 만료**됐다.
 *
 * 실측(prod `517ed296`): `10:49 생성 → 11:04 기한` = 15분.
 * 대표가 6분 만에 입금확정해서 안 걸렸을 뿐이다.
 *
 * 은행 이체는 영업시간·이체한도·앱 로그인에 걸려 분 단위로 끝나지 않는다.
 * 만료되면 **주문은 사라졌는데 돈은 나중에 들어온다** — 주문 없는 입금을 손으로 붙여야 하고,
 * 화면이 3일이라 안내했으므로 분쟁에서 우리가 불리하다.
 *
 * ⟹ 문구와 계산을 **같은 상수에서** 파생시킨다. 아래 `offline-payment.test.ts` 가
 *   둘의 일치를 단언하므로, 한쪽만 고치면 테스트가 죽는다.
 *
 * **대회 급하므로 1일로 확정**(2026-07-30 대표 결정). 3일은 재고를 오래 묶는다.
 */

/** PG(카드·간편결제 등) 결제 대기 — 결제창을 띄운 채 방치되는 시간만 흡수한다. */
export const PG_PAYMENT_DEADLINE_MINUTES = 15;

/** 무통장입금 기한. 🔴 이 값을 바꾸면 아래 표시 문구도 같이 바꿔야 한다(테스트가 강제). */
export const OFFLINE_PAYMENT_DEADLINE_HOURS = 24;

/** 구매자에게 보여주는 기한 문구 — 위 상수와 **반드시 일치**해야 한다. */
export const OFFLINE_PAYMENT_DEADLINE_TEXT = "입금 기한: 주문일로부터 1일(24시간) 이내";

/**
 * 주문의 결제 기한을 계산한다.
 *
 * @param now 기준 시각
 * @param offline 무통장입금 주문인가
 */
export function paymentDeadlineISO(now: Date, offline: boolean): string {
  const ms = offline
    ? OFFLINE_PAYMENT_DEADLINE_HOURS * 60 * 60 * 1000
    : PG_PAYMENT_DEADLINE_MINUTES * 60 * 1000;
  return new Date(now.getTime() + ms).toISOString();
}

/** 무통장 입금 계좌 안내. */
export interface BankInfo {
  bankName: string;
  account: string;
  holder: string;
}

/**
 * 입금 계좌 안내를 해석한다.
 *
 * ## 🔴 왜 빈 문자열을 "없음" 으로 보는가 (2026-07-30 실측)
 * 종전 코드는 `process.env.NEXT_PUBLIC_BANK_ACCOUNT ?? "123-456-789012"` 였다.
 * `??` 는 **null/undefined 만** 막는다 — prod 는 이 값들이 **빈 문자열**이어서
 * 폴백도 걸리지 않고 화면에 **은행명·계좌번호·예금주가 전부 빈칸**으로 나갔다.
 * 즉 **입금할 계좌 없이 무통장입금을 팔고 있었다.**
 *
 * 폴백 자리값(`국민은행 123-456-789012 픽켓`)은 더 위험하다 — 그대로 노출되면
 * 구매자가 **남의 계좌로 송금**할 수 있다. ⟹ 자리값을 없애고 **없으면 없다고 답한다.**
 *
 * @returns 세 값이 모두 채워졌을 때만 `{ ok: true }`
 */
export function resolveBankInfo(
  env: Partial<Record<"bankName" | "account" | "holder", string | undefined>>,
): { ok: true; info: BankInfo } | { ok: false; missing: string[] } {
  const bankName = (env.bankName ?? "").trim();
  const account = (env.account ?? "").trim();
  const holder = (env.holder ?? "").trim();
  const missing: string[] = [];
  if (!bankName) missing.push("은행명");
  if (!account) missing.push("계좌번호");
  if (!holder) missing.push("예금주");
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, info: { bankName, account, holder } };
}

/**
 * 입금 계좌 **정본** (2026-07-30 대표 지정).
 *
 * ## 왜 env 가 아니라 코드에 두는가
 * env 로만 두었더니 prod 에서 **빈 문자열**이라 화면에 빈칸이 나갔다(위 주석 참조).
 * `NEXT_PUBLIC_*` 은 **빌드 시각에 인라인**되므로, 배포 때 env 를 빠뜨리면 그 빌드는
 * 영구히 빈 계좌를 들고 돌아간다 — 런타임 수정으로 못 고친다.
 * 이 값은 구매자에게 **공개 표시되는 정보**이므로 비밀이 아니고, 코드에 두면
 * 배포 절차 실수와 무관하게 항상 옳다.
 *
 * ⚠️ 계좌가 바뀌면 이 상수를 고쳐 **배포**해야 한다(env 로 임시 덮어쓸 수는 있다).
 * 🔴 오타는 곧 **남의 계좌로 송금**이다. 변경 시 대표 확인 없이 손대지 말 것.
 */
export const DEFAULT_BANK_INFO: BankInfo = {
  bankName: "신한은행",
  account: "140-016-400872",
  holder: "(주)노드엑스",
};

/**
 * 현재 환경의 입금 계좌 안내 — env 가 있으면 그것을, 없거나 비었으면 정본을 쓴다.
 *
 * ⚠️ `NEXT_PUBLIC_*` 은 빌드 시각에 인라인되므로 **정적 참조**여야 한다
 * (`process.env[key]` 같은 동적 접근은 번들에 값이 박히지 않는다).
 */
export function bankInfoFromEnv() {
  // 🔴 `||` 를 쓴다(`??` 아님) — prod 가 **빈 문자열**이었고 `??` 는 그걸 통과시켰다.
  return resolveBankInfo({
    bankName: process.env.NEXT_PUBLIC_BANK_NAME || DEFAULT_BANK_INFO.bankName,
    account: process.env.NEXT_PUBLIC_BANK_ACCOUNT || DEFAULT_BANK_INFO.account,
    holder: process.env.NEXT_PUBLIC_BANK_HOLDER || DEFAULT_BANK_INFO.holder,
  });
}

/**
 * 무통장입금을 제공할 수 있는 상태인가.
 *
 * 🔴 **fail-closed**: 계좌 안내가 없으면 제공하지 않는다. 계좌 없이 무통장을 팔면
 *    구매자는 돈을 보낼 곳이 없고, 주문은 기한 만료로 사라진다.
 */
export function isOfflinePaymentAvailable(): boolean {
  return bankInfoFromEnv().ok;
}
