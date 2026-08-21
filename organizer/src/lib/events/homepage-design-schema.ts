import { z } from "zod";
import { REFUND_NOTICE_MAX } from "./refund-notice-limits";

import {
  DETAIL_CAPTION_MAX,
  DETAIL_IMAGE_MAX,
  DETAIL_SECTION_LABELS,
  DETAIL_SECTION_MAX,
  DETAIL_SECTIONS,
  type DetailSection,
  resolveDetailSection,
} from "@/lib/public/detail-image";

/**
 * 홈페이지 디자인 입력 스키마 — `PUT`(전체 교체)·`PATCH`(부분 병합)가 공유한다.
 *
 * 🔴 이 스키마에 없는 필드는 **조용히 사라진다.**
 * zod 는 기본 strip 이고 `PUT` 은 `homepage_design` 을 통째로 교체한다. 즉 어떤 화면이
 * 저장한 값이라도, 여기 필드가 없으면 **홈페이지 디자이너가 한 번 저장하는 순간 날아간다** —
 * 에러도 로그도 남지 않는다. 새 설정을 추가할 때 반드시 여기에 먼저 넣을 것.
 *
 * 라우트 파일이 아니라 별도 모듈에 두는 이유는 **테스트가 닿게** 하기 위해서다.
 * 라우트에 두면 DB·세션 의존이 딸려 와 스키마만 검사할 수 없다.
 */

// 색상은 #RRGGBB HEX 만 허용 — SVG/CSS 인젝션 차단 (og-image 등에서 직접 보간됨)
const hexColor = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, "색상은 #RRGGBB 형식이어야 합니다")
  .optional();

export { REFUND_NOTICE_MAX };

export const homepageDesignSchema = z.object({
  coverImageUrl: z.string().optional(),
  backgroundColor: hexColor,
  textColor: hexColor,
  accentColor: hexColor,
  showCountdown: z.boolean(),
  showVenueMap: z.boolean(),
  showOrganizer: z.boolean(),
  sections: z.array(z.string()).default(["event", "products", "venue", "organizer"]),
  templateId: z.string().optional(),
  heroHeadline: z.string().max(50).optional(),
  heroSubtext: z.string().max(100).optional(),
  // 히어로 이미지 맞춤: cover(꽉채움·크롭, 기본) | contain(전체표시·레터박스+블러필). 완성형 포스터 이미지용.
  heroFit: z.enum(["cover", "contain"]).optional(),
  // 히어로 위 제목·배지 + 가독성 어둠막. 포스터에 글자가 이미 있으면 false 로 끈다.
  // 🔴 어둠막은 흰 배경을 회색으로 만든다(실측 RGB 255→195) — 끌 수 있어야 한다.
  heroOverlay: z.boolean().optional(),
  ctaText: z.string().max(20).optional(),
  sectionDescriptions: z.record(z.string(), z.string().max(100)).optional(),
  /**
   * 환불 안내 자유 문구 — 수수료 단계(숫자)로는 표현할 수 없는 조건을 주최자가 직접 쓴다.
   *
   * 🔴 왜 필요한가 (2026-07-31 대표 요구)
   * 실제로 넣어야 하는 문구가 이렇다:
   *   "당일 기상 악화로 경기 진행이 불가능할 경우, 주최사의 판단으로 티켓 환불이 진행될 수 있습니다.
   *    기상 악화로 경기가 취소될 시, 첫 조 출발 기준 9홀 종료 전까지만 환불 가능합니다."
   * `[{daysBefore, feePct}]` 로는 한 글자도 담을 수 없다. 주최자마다 조건이 다르므로
   * 플랫폼이 문구를 정할 수도 없다.
   *
   * ⚠️ **스키마에 반드시 있어야 한다.** PUT(`homepage-design`)이 `parse()` 로 strip 하므로,
   *    여기 없으면 홈페이지 빌더가 한 번 저장하는 순간 **에러도 로그도 없이 사라진다.**
   */
  refundNotice: z.string().max(REFUND_NOTICE_MAX).optional(),
  aiGenerated: z.boolean().optional(),
  // 소개 본문 아래에 세로로 이어 붙는 상세 안내 이미지.
  detailImages: z
    .array(
      z.object({
        url: z.string(),
        caption: z.string().max(DETAIL_CAPTION_MAX).optional(),
        // 🔴 없으면 intro 로 폴백(순수 함수가 처리) — 섹션 개념 이전 데이터 호환.
        //    ⚠️ 이 필드를 스키마에서 빼면 zod strip 이 조용히 버려 섹션 지정이 저장되지 않는다.
        section: z.enum(DETAIL_SECTIONS).optional(),
      }),
    )
    .max(DETAIL_IMAGE_MAX, `상세 이미지는 최대 ${DETAIL_IMAGE_MAX}장까지 등록할 수 있습니다`)
    /**
     * 🔴 **섹션별 상한**을 서버에서 강제한다. 총합만 보면 한 섹션이 전부를 먹는다.
     *
     * 실측한 결함(2026-07-30): 세 계층이 서로 다른 상한을 보고 있었다 —
     *   업로드  detail-image-editor.tsx  총합만 (8장)
     *   저장    이 스키마               총합만 (8장)
     *   렌더    detail-image.ts:108     **섹션별로 버린다** (intro 3장)
     * ⟹ intro 에 5장을 올려 저장하면 **저장은 성공하고 랜딩엔 3장만** 나온다.
     *   편집 화면엔 5장이 보이므로 주최자는 2장이 왜 안 나오는지 알 방법이 없다.
     *
     * UI(그룹별 추가 버튼)가 먼저 막지만 **여기서도 막는다** — UI 를 우회한 PATCH·옛
     * 클라이언트가 있고, "UI 가 막으니 서버는 안 봐도 된다" 는 이 리포에서 반복해 터진
     * 형태다(검증 원칙 #2 — 없는 하위 게이트를 근거로 삼지 말 것).
     */
    .superRefine((images, ctx) => {
      const used = new Map<DetailSection, number>();
      for (const image of images) {
        const section = resolveDetailSection(image.section);
        used.set(section, (used.get(section) ?? 0) + 1);
      }
      for (const [section, count] of used) {
        const limit = DETAIL_SECTION_MAX[section];
        if (count <= limit) continue;
        ctx.addIssue({
          code: "custom",
          message: `${DETAIL_SECTION_LABELS[section]} 이미지는 최대 ${limit}장까지 등록할 수 있습니다 (현재 ${count}장)`,
          path: ["detailImages"],
        });
      }
    })
    .optional(),
});

export type HomepageDesignInput = z.infer<typeof homepageDesignSchema>;

/**
 * PATCH 본문 → **실제로 요청된 키만** 담은 부분 패치.
 *
 * 🔴 왜 `.partial().parse()` 결과를 그대로 쓰면 안 되는가 (2026-07-29 적대검수에서 잡힘)
 * `.partial()` 은 `.default()` 를 뚫는다. 기본값을 가진 필드(`sections`)는 요청에 없어도
 * zod 가 **기본값으로 채워서** 돌려준다. 그걸 `{ ...current, ...patch }` 로 병합하면
 * 기존 값이 기본값으로 덮여, "받은 키만 덮어쓴다" 는 계약이 그 필드에서만 깨진다.
 *
 * 증상이 조용하다 — 상세 이미지를 저장할 때마다 `sections` 가 리셋되는데 아무 신호가 없다.
 * 그래서 파싱 결과를 **원본 요청의 키 집합으로 다시 거른다**. 나중에 `.default()` 가
 * 붙은 필드가 더 생겨도 이 방식은 자동으로 안전하다.
 */
export function buildHomepageDesignPatch(raw: unknown): Partial<HomepageDesignInput> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new z.ZodError([]);
  }
  const source = raw as Record<string, unknown>;
  const parsed = homepageDesignSchema.partial().parse(source);
  return Object.fromEntries(
    Object.entries(parsed).filter(([key]) => Object.prototype.hasOwnProperty.call(source, key)),
  ) as Partial<HomepageDesignInput>;
}
