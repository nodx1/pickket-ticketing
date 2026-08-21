import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  DEFAULT_BANK_INFO,
  OFFLINE_PAYMENT_DEADLINE_HOURS,
  OFFLINE_PAYMENT_DEADLINE_TEXT,
  PG_PAYMENT_DEADLINE_MINUTES,
  bankInfoFromEnv,
  paymentDeadlineISO,
  resolveBankInfo,
} from "./offline-payment";

/**
 * 🔴 이 테스트의 존재 이유 (2026-07-30 실사고)
 *
 * 화면은 "3일 이내" 라고 안내하고 서버는 15분에 만료시켰다. 두 값이 **서로 다른 파일에
 * 각각 하드코딩**돼 있었기 때문이다. 어느 쪽도 틀린 코드가 아니어서 리뷰로 안 잡힌다.
 * ⟹ 문구와 계산의 **일치 자체를 단언**한다. 한쪽만 고치면 여기서 죽는다.
 */
describe("무통장 기한 — 문구와 계산의 일치", () => {
  it("🔴 표시 문구의 일수가 실제 기한 시간과 같다", () => {
    // 문구에서 "N일" 을 뽑아 상수와 비교한다.
    const m = /(\d+)\s*일/.exec(OFFLINE_PAYMENT_DEADLINE_TEXT);
    expect(m, `문구에 "N일" 이 없다: ${OFFLINE_PAYMENT_DEADLINE_TEXT}`).not.toBeNull();
    const days = Number(m![1]);
    expect(days * 24).toBe(OFFLINE_PAYMENT_DEADLINE_HOURS);
  });

  it("문구에 적힌 시간수도 상수와 같다", () => {
    // "1일(24시간)" 처럼 시간이 병기되면 그것도 검사한다 — 괄호 안이 낡는 것도 사고다.
    const h = /(\d+)\s*시간/.exec(OFFLINE_PAYMENT_DEADLINE_TEXT);
    if (h) expect(Number(h[1])).toBe(OFFLINE_PAYMENT_DEADLINE_HOURS);
  });

  it("무통장은 PG 보다 반드시 길다 — 은행 이체가 분 단위로 끝나지 않는다", () => {
    expect(OFFLINE_PAYMENT_DEADLINE_HOURS * 60).toBeGreaterThan(PG_PAYMENT_DEADLINE_MINUTES);
  });
});

describe("paymentDeadlineISO", () => {
  const now = new Date("2026-08-01T00:00:00.000Z");

  it("무통장은 24시간 뒤", () => {
    expect(paymentDeadlineISO(now, true)).toBe("2026-08-02T00:00:00.000Z");
  });

  it("PG 는 15분 뒤 — 종전 동작을 바꾸지 않는다", () => {
    // ⚠️ 카드 기한을 같이 늘리면 미결제 주문이 재고를 오래 묶는다. 여기서 못박는다.
    expect(paymentDeadlineISO(now, false)).toBe("2026-08-01T00:15:00.000Z");
  });

  it("무통장과 PG 가 서로 다른 값을 낸다", () => {
    // 분기를 지우는 뮤테이션(항상 offline 값 / 항상 PG 값)을 잡는다.
    expect(paymentDeadlineISO(now, true)).not.toBe(paymentDeadlineISO(now, false));
  });
});

describe("resolveBankInfo — 빈 문자열은 '없음' 이다", () => {
  const full = { bankName: "국민은행", account: "123-45-6789", holder: "주식회사 노드엑스" };

  it("세 값이 다 있으면 통과하고 공백을 다듬는다", () => {
    const r = resolveBankInfo({ bankName: " 국민은행 ", account: "123-45-6789", holder: "노드엑스" });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.info.bankName).toBe("국민은행");
  });

  it("🔴 빈 문자열은 없는 것으로 본다 — prod 가 정확히 이 상태였다", () => {
    // `?? "국민은행"` 은 빈 문자열을 막지 못해 화면에 빈칸이 나갔다.
    const r = resolveBankInfo({ bankName: "", account: "", holder: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toEqual(["은행명", "계좌번호", "예금주"]);
  });

  it("공백만 있는 값도 없는 것으로 본다", () => {
    const r = resolveBankInfo({ ...full, account: "   " });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.missing).toEqual(["계좌번호"]);
  });

  /**
   * 🔴 세 필드 × 세 형태를 전부 돈다 (뮤테이션 생존으로 발견한 구멍, 2026-07-30).
   *
   * 처음엔 `account` 만 undefined/공백으로 검사했다. 그래서 `bankName` 에만
   * `?? "국민은행"` 자리값을 되살리는 뮤테이션이 **생존**했다 — 한 필드에만 남은
   * 폴백은 다른 필드 테스트로 잡히지 않는다.
   */
  const FIELDS = ["bankName", "account", "holder"] as const;
  const LABEL = { bankName: "은행명", account: "계좌번호", holder: "예금주" } as const;
  for (const field of FIELDS) {
    for (const [name, bad] of [
      ["undefined", undefined],
      ["빈 문자열", ""],
      ["공백만", "   "],
    ] as const) {
      it(`${LABEL[field]}가 ${name}이면 없는 것으로 본다`, () => {
        const r = resolveBankInfo({ ...full, [field]: bad });
        expect(r.ok).toBe(false);
        if (!r.ok) expect(r.missing).toContain(LABEL[field]);
      });
    }
  }

  it("🔴 어떤 자리값도 되돌려주지 않는다 — 남의 계좌로 송금될 수 있다", () => {
    const r = resolveBankInfo({});
    expect(r.ok).toBe(false);
    // 종전 폴백 값이 결과에 섞여 나오지 않는지 확인.
    expect(JSON.stringify(r)).not.toContain("123-456-789012");
    expect(JSON.stringify(r)).not.toContain("국민은행");
  });
});

describe("bankInfoFromEnv — env 가 비어도 정본으로 동작한다", () => {
  const KEYS = ["NEXT_PUBLIC_BANK_NAME", "NEXT_PUBLIC_BANK_ACCOUNT", "NEXT_PUBLIC_BANK_HOLDER"] as const;
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it("🔴 env 가 빈 문자열이어도 정본 계좌를 쓴다 — prod 가 그 상태였다", () => {
    // `??` 가 빈 문자열을 통과시켜 화면에 빈칸이 나갔던 자리. 이제 `||` + 정본.
    for (const k of KEYS) process.env[k] = "";
    const r = bankInfoFromEnv();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.info).toEqual(DEFAULT_BANK_INFO);
  });

  it("env 가 없어도 정본 계좌를 쓴다", () => {
    for (const k of KEYS) delete process.env[k];
    const r = bankInfoFromEnv();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.info.account).toBe(DEFAULT_BANK_INFO.account);
  });

  it("env 가 있으면 env 가 이긴다 — 계좌 변경을 배포 없이 덮을 수 있다", () => {
    process.env.NEXT_PUBLIC_BANK_NAME = "국민은행";
    process.env.NEXT_PUBLIC_BANK_ACCOUNT = "999-99-9999";
    process.env.NEXT_PUBLIC_BANK_HOLDER = "테스트";
    const r = bankInfoFromEnv();
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.info).toEqual({ bankName: "국민은행", account: "999-99-9999", holder: "테스트" });
  });

  it("🔴 정본 계좌가 대표 지정값과 일치한다", () => {
    // 오타는 곧 남의 계좌로 송금이다. 값 자체를 단언해 무단 변경을 드러낸다.
    expect(DEFAULT_BANK_INFO).toEqual({
      bankName: "신한은행",
      account: "140-016-400872",
      holder: "(주)노드엑스",
    });
  });
});
