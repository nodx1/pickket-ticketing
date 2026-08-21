import { describe, expect, it } from "vitest";
import {
  ALIMTALK_TEMPLATES,
  MANUAL_SEND_TEMPLATE_KEYS,
  isNcpRegistrableCode,
  manualSendTemplateOptions,
} from "./alimtalk-templates";

/**
 * 🔴 카카오/NCP 등록 규칙 가드 (2026-08-01).
 *
 * 같은 실패를 **두 번** 했다:
 *   · `PICKKET_PURCHASE_001` → NCP 는 템플릿 코드에 언더바를 허용하지 않는다.
 *     `PICKKETPURCHASE001` 로 교정하고서야 발송됐다.
 *   · `PICKKET_CANCEL_001`   → 같은 이유로 **등록 자체가 불가능**했다. 그래서 환불완료
 *     알림톡은 한 번도 나간 적이 없다.
 *
 * 코드 오류는 실패가 조용하다 — 접수는 A000 이고 전달만 거부된다(3027). 배포 후에는
 * 잘 안 보이므로 여기서 막는다.
 */
/**
   * ⚠️ **미등록·미사용 템플릿** — 호출부가 0곳이라 발송되지 않는다(2026-08-01 실측).
   *   · REMINDER_D7 / REMINDER_D1 — 리마인더는 v2 로 이관됐다. go 의 cron 은 위임 스텁이고
   *     발송 주체는 `v2:app.tasks.messaging_dispatch.reminders` 다
   *   · CHECKIN_QR                — `notifyCheckinQr` 를 부르는 곳이 없다
   *
   * 코드에 언더바가 있어 **애초에 등록도 안 된다.** 살릴 때는 코드부터 영문+숫자로
   * 바꾸고 카카오에 등록해야 한다 — 여기 목록에서 지우면 아래 규칙이 강제한다.
   */
const UNREGISTERED = new Set(["REMINDER_D7", "REMINDER_D1", "CHECKIN_QR"]);

describe("알림톡 템플릿 등록 규칙", () => {
  const entries = Object.entries(ALIMTALK_TEMPLATES);

  it("발송되는 템플릿 코드는 영문 대문자+숫자만 — NCP 가 언더바를 거부한다", () => {
    for (const [name, tpl] of entries) {
      if (UNREGISTERED.has(name)) continue;
      expect(`${name}: ${tpl.code}`).toMatch(/: [A-Z0-9]+$/);
    }
  });

  it("미등록 목록은 실제로 미등록 형태다 — 등록 가능해졌으면 목록에서 지울 것", () => {
    // 목록이 낡아 "사실은 등록된 것" 을 가리면 위 규칙이 조용히 헐거워진다.
    // 코드가 이미 영문+숫자면 등록 준비가 끝난 것이므로 목록에서 빠져야 한다.
    for (const name of UNREGISTERED) {
      const tpl = ALIMTALK_TEMPLATES[name as keyof typeof ALIMTALK_TEMPLATES];
      expect(`${name}: ${tpl.code}`).not.toMatch(/: [A-Z0-9]+$/);
    }
  });

  it("템플릿 코드는 서로 겹치지 않는다", () => {
    const codes = entries.map(([, t]) => t.code);
    expect(new Set(codes).size).toBe(codes.length);
  });
});

describe("취소·환불 완료 본문", () => {
  const render = () =>
    ALIMTALK_TEMPLATES.CANCEL_CONFIRM.body({
      eventTitle: "BC카드·한경 제48회 KLPGA 챔피언십",
      orderNumber: "ORD-260801-002",
      refundAmount: "₩15,000",
    });

  it("🔴 본문에 URL 을 넣지 않는다 — 인라인 URL 이 과거 반려 형태였다", () => {
    expect(render()).not.toMatch(/https?:\/\//);
  });

  it("변수 3개가 모두 본문에 렌더된다 — 하나라도 빠지면 승인본과 어긋나 3027", () => {
    const text = render();
    expect(text).toContain("BC카드·한경 제48회 KLPGA 챔피언십");
    expect(text).toContain("ORD-260801-002");
    expect(text).toContain("₩15,000");
  });

  it("발신주체와 수신맥락을 밝힌다 — 검수 통과한 두 템플릿과 같은 포맷", () => {
    const text = render();
    expect(text).toContain("티켓 서비스 '피켓'입니다.");
    expect(text).toContain("고객님께서 요청하신");
  });

  it("환불 소요기간을 고지한다 — 이게 빠지면 CS 문의가 여기로 몰린다", () => {
    expect(render()).toContain("3~5영업일");
  });
});

/**
 * 🔴 수동 발송 드롭다운 — **막다른 선택지를 화면에 두지 않는다** (2026-08-04).
 *
 * 실측: 드롭다운 5개 중 **실제로 나갈 수 있는 것이 0개**였다.
 *   · `PICKKET_PURCHASE_001` / `PICKKET_CANCEL_001` — 레지스트리 코드와 불일치(오타)
 *   · `PICKKET_REMIND_D7` / `D1` / `PICKKET_CHECKIN_001` — 언더바라 NCP 등록 자체가 불가
 *
 * 주최자가 무엇을 고르든 실패하는 화면이었다. 실패는 조용하다(접수 A000·전달 거부).
 *
 * ⚠️ **코드 문자열만 맞추는 것으로는 부족하다.** 3개는 맞춰도 카카오에 템플릿이 없다.
 *    그래서 목록에서 빼는 것까지가 요구다.
 */
describe("🔴 수동 발송 선택지", () => {
  it("승인·운영 중인 3종만 보인다", () => {
    expect(manualSendTemplateOptions().map((o) => o.code)).toEqual([
      "PICKKETPURCHASE001",
      "PICKKETCANCEL001",
      "PICKKETINVITE001",
    ]);
  });

  it("🔴 미등록 3종은 선택지에 없다 — 골라도 실패한다", () => {
    const codes = manualSendTemplateOptions().map((o) => o.code);
    for (const dead of ["PICKKET_REMIND_D7", "PICKKET_REMIND_D1", "PICKKET_CHECKIN_001"]) {
      expect(codes, `${dead} 이 화면에 남아 있다`).not.toContain(dead);
    }
  });

  it("🔴 선택지 코드는 전부 레지스트리 실물에서 온다 — 손으로 적지 않는다", () => {
    const registry = new Set(Object.values(ALIMTALK_TEMPLATES).map((t) => t.code));
    for (const o of manualSendTemplateOptions()) {
      expect(registry, `${o.code} 는 레지스트리에 없는 문자열이다`).toContain(o.code);
    }
  });

  it("🔴 선택지는 전부 NCP 등록 가능한 형식이다", () => {
    for (const o of manualSendTemplateOptions()) {
      expect(isNcpRegistrableCode(o.code), `${o.code}`).toBe(true);
    }
  });

  it("레지스트리에서 지우지는 않았다 — 승인되면 되살릴 문안이다", () => {
    // 목록에서 뺀 것과 문안을 버린 것은 다르다.
    expect(ALIMTALK_TEMPLATES.REMINDER_D7.body).toBeTypeOf("function");
    expect(ALIMTALK_TEMPLATES.CHECKIN_QR.body).toBeTypeOf("function");
  });

  /**
   * 🔴 **목록에 무엇을 넣었는지**를 본다 (2026-08-04, 배포 세션 지적).
   *
   * 종전 테스트는 `manualSendTemplateOptions()` 의 **출력**만 봤다. 그래서 미등록
   * `REMINDER_D7` 을 목록에 되돌려도 20건 전부 통과했다 — 형식 필터가 조용히 걸러낸
   * 덕분이지, 검사가 잡은 것이 아니다.
   *
   * ⚠️ 필터는 **언더바가 있을 때만** 막는다. 코드가 영문+숫자인데 카카오 승인은 안 난
   *    템플릿을 넣으면 그대로 화면에 뜬다. 그래서 목록 자체를 검사한다.
   */
  it("🔴 미등록 템플릿을 목록에 넣으면 실패한다 — 필터에 기대지 않는다", () => {
    for (const key of MANUAL_SEND_TEMPLATE_KEYS) {
      expect(UNREGISTERED.has(key), `${key} 는 미등록인데 수동 발송 목록에 있다`).toBe(false);
    }
  });

  it("🔴 목록의 모든 키가 실재하고, 코드가 등록 가능한 형식이다", () => {
    for (const key of MANUAL_SEND_TEMPLATE_KEYS) {
      const tpl = ALIMTALK_TEMPLATES[key];
      expect(tpl, `${key} 가 레지스트리에 없다`).toBeDefined();
      expect(isNcpRegistrableCode(tpl.code), `${key}: ${tpl.code}`).toBe(true);
    }
  });

  it("🔴 목록 길이와 출력 길이가 같다 — 조용히 걸러진 키가 없다", () => {
    // 길이가 갈리면 목록에 '뜨지 않는 키' 가 섞여 있다는 뜻이다.
    expect(manualSendTemplateOptions()).toHaveLength(MANUAL_SEND_TEMPLATE_KEYS.length);
  });

  it("빈 라벨은 없다 — 주최자가 무엇인지 알아야 고른다", () => {
    for (const o of manualSendTemplateOptions()) {
      expect(o.label.trim().length).toBeGreaterThan(0);
    }
  });
});

describe("NCP 코드 형식 판정", () => {
  it("영문+숫자만 통과", () => {
    expect(isNcpRegistrableCode("PICKKETINVITE001")).toBe(true);
    expect(isNcpRegistrableCode("abc123")).toBe(true);
  });

  it("🔴 언더바·하이픈·공백·빈값은 등록 불가", () => {
    expect(isNcpRegistrableCode("PICKKET_CANCEL_001")).toBe(false);
    expect(isNcpRegistrableCode("PICKKET-CANCEL")).toBe(false);
    expect(isNcpRegistrableCode("PICKKET CANCEL")).toBe(false);
    expect(isNcpRegistrableCode("")).toBe(false);
  });
});
