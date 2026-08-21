import { describe, expect, it } from "vitest";

import { MARKETING_CONSENT_TEXT, MARKETING_CONSENT_VERSION } from "./consent-wording";

/**
 * 🔴 문구와 버전이 **짝으로** 움직이게 강제한다.
 *
 * 파일 주석에 "문구 변경 시 반드시 버전도 함께 올릴 것" 이라고 적혀 있지만, 주석은
 * 규칙을 **알려줄 뿐 지키게 하지 못한다.** 버전은 `message_consents.wording_version` 에
 * 저장돼 "이 사람은 어떤 문구를 보고 동의했나" 를 사후 증명하는 근거인데,
 * 문구만 바뀌고 버전이 그대로면 그 근거가 조용히 무너진다(동의 이력이 거짓을 말한다).
 *
 * 아래 표가 그 규칙을 코드로 만든다:
 *   · 문구만 바꾸면      → 실패 (버전도 올려라)
 *   · 버전만 올리면      → 실패 (표에 새 문구를 등록해라)
 *   · 둘 다 하면         → 통과
 */
const REGISTERED_WORDING: Record<string, string> = {
  "2026-07-v1":
    "이벤트·혜택·프로모션 등 광고성 정보를 이메일/문자로 받겠습니다. (선택) " +
    "수신동의는 언제든 수신거부 링크로 철회할 수 있으며, 예매·환불 등 거래 안내는 동의와 무관하게 발송됩니다.",
  // v2(2026-07-30): (선택) 을 문장 중간 → 맨 끝으로(주최측 요청). 문안 자체는 불변.
  "2026-07-v2":
    "이벤트·혜택·프로모션 등 광고성 정보를 이메일/문자로 받겠습니다. " +
    "수신동의는 언제든 수신거부 링크로 철회할 수 있으며, 예매·환불 등 거래 안내는 동의와 무관하게 발송됩니다. (선택)",
};

describe("마케팅 수신동의 문구·버전 짝", () => {
  it("🔴 현재 버전이 표에 등록돼 있다 — 없으면 버전만 올리고 문구를 안 남긴 것", () => {
    expect(Object.keys(REGISTERED_WORDING)).toContain(MARKETING_CONSENT_VERSION);
  });

  it("🔴 현재 문구가 그 버전으로 등록된 것과 정확히 일치한다 — 문구만 바꾸면 여기서 잡힌다", () => {
    expect(MARKETING_CONSENT_TEXT).toBe(REGISTERED_WORDING[MARKETING_CONSENT_VERSION]);
  });

  it("과거 버전 기록을 지우지 않는다 — 옛 문구로 받은 동의를 증명해야 한다", () => {
    expect(REGISTERED_WORDING["2026-07-v1"]).toBeTruthy();
  });
});

/**
 * 법적 고지 요건 — 위치가 바뀌어도 **빠지면 안 되는 것들**.
 * (선택) 을 맨 끝으로 옮기는 과정에서 통째로 사라지는 사고를 막는다.
 */
describe("고지 필수 요소", () => {
  it("선택 사항임을 표시한다", () => {
    expect(MARKETING_CONSENT_TEXT).toContain("(선택)");
  });

  it("수신 항목(광고성 정보)을 밝힌다", () => {
    expect(MARKETING_CONSENT_TEXT).toContain("광고성 정보");
  });

  it("채널(이메일/문자)을 밝힌다", () => {
    expect(MARKETING_CONSENT_TEXT).toContain("이메일/문자");
  });

  it("철회 방법을 안내한다", () => {
    expect(MARKETING_CONSENT_TEXT).toContain("철회");
    expect(MARKETING_CONSENT_TEXT).toContain("수신거부");
  });

  it("🔴 거래 안내는 동의와 무관하다는 분리를 밝힌다 — 이게 빠지면 거래 메일도 막혔다고 오해한다", () => {
    expect(MARKETING_CONSENT_TEXT).toContain("동의와 무관하게");
  });

  it("(선택) 이 맨 끝에 온다 — 2026-07-30 주최측 요청", () => {
    expect(MARKETING_CONSENT_TEXT.trimEnd().endsWith("(선택)")).toBe(true);
  });
});
