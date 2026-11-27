import { describe, expect, it } from "vitest";

import { buildTerminalLink, isTerminalKey, readTerminalKeyFromHash, shouldSendScan } from "./terminal-link";

const KEY = "pkt_term_" + "Ab3_-".repeat(8) + "xyz";

describe("직원 입장 링크", () => {
  it("키를 주소의 # 뒤에 넣는다(서버로 보내지지 않는 자리)", () => {
    const link = buildTerminalLink("https://go.pickket.kr/", KEY);
    expect(link).toBe(`https://go.pickket.kr/terminal#k=${KEY}`);
    expect(new URL(link).search).toBe("");
  });

  it("링크에서 키를 다시 꺼낸다", () => {
    const url = new URL(buildTerminalLink("http://localhost:3033", KEY));
    expect(readTerminalKeyFromHash(url.hash)).toBe(KEY);
    expect(readTerminalKeyFromHash(`k=${KEY}`)).toBe(KEY);
  });

  it("형식이 맞지 않는 값은 받지 않는다", () => {
    expect(readTerminalKeyFromHash("")).toBeNull();
    expect(readTerminalKeyFromHash("#")).toBeNull();
    expect(readTerminalKeyFromHash("#k=hello")).toBeNull();
    expect(readTerminalKeyFromHash("#k=pkt_term_short")).toBeNull();
    expect(readTerminalKeyFromHash(`#k=${KEY}<script>`)).toBeNull();
    expect(isTerminalKey(KEY)).toBe(true);
  });
});

describe("카메라 연속 판독 거르기", () => {
  it("같은 QR 은 일정 시간 안에 한 번만 보낸다", () => {
    const last = { text: "QR-A", at: 1_000 };
    expect(shouldSendScan("QR-A", last, 2_000)).toBe(false);
    expect(shouldSendScan("QR-A", last, 9_500)).toBe(true);
  });

  it("다른 QR(다음 관객)은 바로 보낸다", () => {
    expect(shouldSendScan("QR-B", { text: "QR-A", at: 1_000 }, 1_100)).toBe(true);
    expect(shouldSendScan("QR-B", null, 0)).toBe(true);
  });

  it("판정 중이거나 빈 값이면 보내지 않는다", () => {
    expect(shouldSendScan("QR-B", null, 0, { inFlight: true })).toBe(false);
    expect(shouldSendScan("  ", null, 0)).toBe(false);
  });
});
