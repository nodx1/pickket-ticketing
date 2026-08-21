import { z } from "zod";

/**
 * 발송 세그먼트 화이트리스트 스키마(2.6-Med2 공용화).
 * 메시지·캠페인 양쪽이 공유해, 저장 시점부터 임의 필드/타입을 차단한다(자유 SQL 아님).
 * resolveSegment 가 이 필드만 파라미터화 WHERE 로 조립한다.
 *
 * W3-MSG: `crmTiers`·`crmTags` 폐기(go `crm_contacts` 제거 — writer 0·행 0 실측).
 *   ⚠️ **조용히 무시(strip)하면 안 된다.** 이 둘은 대상을 *좁히는* 필터라, 무시하면
 *   주최자가 "VIP 만"으로 지정한 발송이 **전체 발송**으로 확대된다. 그렇다고 조건을
 *   남겨두면 crm_contacts 행이 0 이라 항상 0명(조용한 무발송)이다.
 *   ⟹ 폐기 키가 오면 스키마 파싱 전에 **400 으로 거부**한다(`assertNoRetiredSegmentKeys`).
 */
const RETIRED_SEGMENT_KEYS = ["crmTiers", "crmTags"] as const;

export const segmentSchema = z.object({
  status: z.enum(["all", "checked_in", "not_checked_in"]).optional(),
  productIds: z.array(z.string().uuid()).optional(),
  purchasedAfter: z.string().optional(),
  purchasedBefore: z.string().optional(),
  attendeeIds: z.array(z.string().uuid()).optional(),
  lotteryWon: z.boolean().optional(),
});

/** 폐기 세그먼트 키가 요청에 포함됐을 때 던지는 에러(라우트가 400 으로 변환). */
export class RetiredSegmentKeyError extends Error {
  constructor(readonly keys: string[]) {
    super(
      `더 이상 지원하지 않는 세그먼트 조건입니다: ${keys.join(", ")}. 고객 등급·태그 세그먼트는 폐지되었습니다.`,
    );
    this.name = "RetiredSegmentKeyError";
  }
}

/**
 * 폐기 세그먼트 키 검사. **segmentSchema.parse 전에** 호출해야 한다
 * (zod object 는 unknown 키를 조용히 제거하므로 파싱 후에는 흔적이 남지 않는다).
 */
export function assertNoRetiredSegmentKeys(input: unknown): void {
  if (!input || typeof input !== "object" || Array.isArray(input)) return;
  const record = input as Record<string, unknown>;
  const found = RETIRED_SEGMENT_KEYS.filter((k) => record[k] !== undefined);
  if (found.length > 0) throw new RetiredSegmentKeyError(found);
}

export type SegmentInput = z.infer<typeof segmentSchema>;
