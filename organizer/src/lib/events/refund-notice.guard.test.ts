import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  buildHomepageDesignPatch,
  homepageDesignSchema,
  REFUND_NOTICE_MAX,
} from "./homepage-design-schema";

/**
 * 🔴 환불 안내 문구가 **조용히 사라지지 않게** 고정한다 (2026-07-31 신설).
 *
 * ## 왜 이 가드가 필요한가
 * 이 필드는 `events.homepage_design` JSONB 에 산다. 그 JSONB 를 쓰는 화면이 **둘**이다:
 *
 *   · 환불 정책 화면   → `PATCH` (보낸 키만 병합)
 *   · 홈페이지 빌더    → `PUT`   (**통째로 교체** · `homepageDesignSchema.parse()`)
 *
 * zod 는 기본이 strip 이다. 스키마에 `refundNotice` 가 없으면, 주최자가 홈페이지 빌더에서
 * 저장을 한 번 누르는 순간 **에러도 로그도 없이 환불 문구가 사라진다.**
 * 같은 함정에 이미 두 번 빠졌다(갤러리 `caption`, 상세이미지 `section`).
 *
 * ## 실제로 들어갈 문구 (대표 제공)
 *   "당일 기상 악화로 경기 진행이 불가능할 경우, 주최사의 판단으로 티켓 환불이 진행될 수 있습니다.
 *    기상 악화로 경기가 취소될 시, 첫 조 출발 기준 9홀 종료 전까지만 환불 가능합니다."
 * 수수료 단계로는 한 글자도 담을 수 없다 — 그래서 이 필드가 있다.
 */
const KLPGA_NOTICE =
  "당일 기상 악화로 경기 진행이 불가능할 경우, 주최사의 판단으로 티켓 환불이 진행될 수 있습니다.\n" +
  "기상 악화로 경기가 취소될 시, 첫 조 출발 기준 9홀 종료 전까지만 환불 가능합니다. (이후 환불 불가능)";

const BASE = {
  backgroundColor: "#ffffff",
  textColor: "#111111",
  accentColor: "#6C5CE7",
  showCountdown: true,
  showVenueMap: true,
  showOrganizer: true,
};

/**
 * 주석을 걷어낸 소스. 🔴 이게 없으면 **설명 주석까지 결함으로 잡는다**(실제로 두 번 잡혔다).
 * 거짓 양성을 내는 가드는 다음 사람이 꺼버린다 — 그게 가드를 죽이는 가장 흔한 경로다.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

describe("환불 안내 문구 — 스키마 보존", () => {
  it("🔴 PUT(parse)이 문구를 strip 하지 않는다 — 빌더 저장 한 번에 사라지면 안 된다", () => {
    const parsed = homepageDesignSchema.parse({ ...BASE, refundNotice: KLPGA_NOTICE });
    expect(parsed.refundNotice).toBe(KLPGA_NOTICE);
  });

  it("줄바꿈이 보존된다 — 두 줄짜리 문구다", () => {
    const parsed = homepageDesignSchema.parse({ ...BASE, refundNotice: KLPGA_NOTICE });
    expect(parsed.refundNotice?.split("\n")).toHaveLength(2);
  });

  it("실제 문구가 상한 안에 들어간다", () => {
    expect(KLPGA_NOTICE.length).toBeLessThanOrEqual(REFUND_NOTICE_MAX);
  });

  it(`상한(${REFUND_NOTICE_MAX})을 넘으면 거부 — 약관 통째 붙여넣기 방지`, () => {
    const tooLong = "가".repeat(REFUND_NOTICE_MAX + 1);
    expect(homepageDesignSchema.safeParse({ ...BASE, refundNotice: tooLong }).success).toBe(false);
  });

  it("미설정도 유효 — 선택 항목이다", () => {
    expect(homepageDesignSchema.parse(BASE).refundNotice).toBeUndefined();
  });
});

describe("환불 안내 문구 — PATCH 병합", () => {
  it("🔴 문구만 보내도 다른 설정이 날아가지 않는다", () => {
    const current = { ...BASE, heroHeadline: "제48회 KLPGA", showCountdown: false };
    const patch = buildHomepageDesignPatch({ refundNotice: KLPGA_NOTICE });
    const merged = { ...current, ...patch };
    expect(merged.refundNotice).toBe(KLPGA_NOTICE);
    expect(merged.heroHeadline).toBe("제48회 KLPGA");
    expect(merged.showCountdown).toBe(false);
  });

  it("빈 문자열로 지울 수 있다 — 삭제 경로", () => {
    const current = { ...BASE, refundNotice: KLPGA_NOTICE };
    const patch = buildHomepageDesignPatch({ refundNotice: "" });
    expect({ ...current, ...patch }.refundNotice).toBe("");
  });

  it("🔴 보내지 않으면 patch 에 키 자체가 없다 — 다른 화면 저장이 문구를 지우면 안 된다", () => {
    const patch = buildHomepageDesignPatch({ heroHeadline: "바뀐 제목" });
    // `.partial()` 은 안 보낸 키에 default 를 채워 넣는다. 그걸 걸러내는 것이 이 함수의 존재 이유다.
    expect(Object.prototype.hasOwnProperty.call(patch, "refundNotice")).toBe(false);
    const current = { ...BASE, refundNotice: KLPGA_NOTICE };
    expect({ ...current, ...patch }.refundNotice).toBe(KLPGA_NOTICE);
  });
});

describe("배선 — 쓰는 곳과 보는 곳이 이어져 있다", () => {
  const EDITOR = path.join(
    process.cwd(),
    "src/app/(dashboard)/events/[eventId]/settings/_components/cancellation-policy.tsx",
  );
  const PUBLIC = path.join(process.cwd(), "src/app/(public)/e/[eventSlug]/page.tsx");

  it("🔴 환불 정책 화면에서 문구를 저장한다 — 공지사항으로 보내지 않는다", () => {
    const src = readFileSync(EDITOR, "utf8");
    expect(src).toMatch(/refundNotice/);
    expect(src).toMatch(/homepage-design/);
  });

  it("공개 상세가 그 값을 읽는다", () => {
    expect(readFileSync(PUBLIC, "utf8")).toMatch(/hpDesign\.refundNotice/);
  });
});

describe("🔴 다른 화면의 저장이 문구를 지우지 않는다", () => {
  const DESIGNER = path.join(
    process.cwd(),
    "src/app/(dashboard)/events/[eventId]/homepage-designer/_components/homepage-designer-client.tsx",
  );

  /**
   * 홈페이지 디자이너는 `homepage_design` 을 통째로 다루는 유일한 화면이다.
   * PUT 이면 **마운트 시점 스냅샷으로 전체를 교체**하므로, 그사이 다른 탭이 저장한
   * 환불 문구가 에러도 로그도 없이 사라진다(2026-07-31 코덱스 감사에서 확정).
   * 스키마에 필드를 넣은 것만으로는 이 경로를 못 막는다 — 메서드가 계약이다.
   */
  it("디자이너가 PUT(전체 교체)로 저장하지 않는다", () => {
    const src = stripComments(readFileSync(DESIGNER, "utf8"));
    expect(src).not.toMatch(/method:\s*["']PUT["']/);
    expect(src).toMatch(/method:\s*["']PATCH["']/);
  });

  /**
   * 🔴 PATCH 로 바꾼 것만으로는 부족했다 (2026-07-31 적대검수 H2).
   * GET 은 `homepage_design` **전체**를 주고 `setDesign({...defaultState, ...payload.data})`
   * 가 그걸 안는다. `JSON.stringify(design)` 을 그대로 보내면 **이 화면이 모르는 키까지**
   * 되돌려 보내, 그사이 다른 탭이 저장한 환불 문구가 **옛 값으로 되돌아간다.**
   * `buildHomepageDesignPatch` 는 "요청에 있는 키" 만 거르므로 못 막는다 —
   * **보내지 않는 것**이 유일한 방어다.
   */
  it("🔴 스냅샷을 통째로 보내지 않는다 — 아는 키만 골라서 보낸다", () => {
    const src = stripComments(readFileSync(DESIGNER, "utf8"));
    expect(src).not.toMatch(/JSON\.stringify\(design\)/);
    expect(src).toMatch(/pickDesignerKeys\(design\)/);
  });

  it("고르는 키 목록에 refundNotice 가 들어 있지 않다 — 이 화면은 그 값을 모른다", () => {
    const src = readFileSync(DESIGNER, "utf8");
    const list = /const DESIGNER_KEYS = \[([\s\S]*?)\] as const/.exec(src)?.[1] ?? "";
    expect(list).not.toMatch(/refundNotice/);
    expect(list).not.toMatch(/detailImages/);
    expect(list).toMatch(/backgroundColor/); // 목록 자체는 제대로 잡혔는지
  });
});
