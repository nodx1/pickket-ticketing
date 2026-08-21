/**
 * 판매 단계(sale plan) v2 클라이언트 — 레벨2 컷오버 T2-PHASE.
 *
 * go `sale_phases` 테이블과 `lib/sale-plan/*` 서비스는 제거됐다. 판매계획의 SSOT 는
 * v2 `phase_configs` 이며, 주최자 대시보드는 이 클라이언트를 통해 v2 정본 경로를 호출한다.
 *
 * ⚠️ 브라우저가 v2 internal API 를 직접 부를 수 없다(서비스 토큰/HMAC 필요). 따라서
 * go 의 `/api/events/[eventId]/sale-phases*` 라우트는 **go DB 를 전혀 쓰지 않는 얇은
 * v2 프록시**로 남아 주최자 세션 인증(withRole)만 담당한다.
 */
import { logger } from "@/lib/logger";
import { resolveOwnedV2EventId } from "@/lib/v2/event-access";
import { V2CommerceError, v2SalePlanRequest } from "@/lib/v2/commerce-client";

/** v2 phase_configs.phase — docs SALE_MODE_POLICY_v2 canonical 5종. */
export type SalePhaseMode =
  | "membership_presale"
  | "lottery"
  | "waitlist_promotion"
  | "queue_sale"
  | "fcfs_residual";

/** 주최자가 직접 선택 가능한 주 판매 모드 (waitlist_promotion/fcfs_residual 는 자동 추가). */
export type MainSaleMode = "membership_presale" | "lottery" | "queue_sale";

export type SalePhaseStatus =
  | "scheduled"
  | "open"
  | "closed"
  | "allocating"
  | "allocated"
  | "skipped";

/** v2 `phase_to_dict` 응답 — 기존 go SalePhase DTO 와 키 호환(UI 무변경). */
export interface SalePhaseDTO {
  id: string;
  eventId: string;
  phaseOrder: number;
  mode: SalePhaseMode;
  opensAt: string | null;
  closesAt: string | null;
  targetQuantity: number | null;
  allocatedQuantity: number;
  status: SalePhaseStatus;
  config: Record<string, unknown>;
}

export interface SalePlanPhaseInput {
  mode: MainSaleMode;
  /** 전체 좌석 중 이 단계에 할당할 비율 (0~100, 합 100) */
  ratioPct: number;
  opensAt: Date;
  closesAt: Date;
  /** membership_presale 필수 — v2 fanclubs.id */
  fanclubId?: string;
}

interface SalePlanReadResponse {
  phases: SalePhaseDTO[];
  current: SalePhaseDTO | null;
  total: number;
}

interface SalePlanWriteResponse {
  phases: SalePhaseDTO[];
  total: number;
}

// 소유 검증 + v2 canonical id 해석은 `@/lib/v2/event-access` 정본을 쓴다.
//
// ⚠️ T2-EVT 와의 교차 변경: 이 파일은 원래 go `events.v2_event_id` 앵커를 읽고, 앵커가 없으면
//    `{ ensure: true }` 로 멱등 createEvent 를 걸어 재확립했다. T2-EVT 가 앵커 컬럼 자체를
//    폐기(go event id == v2 event id)하면서 "앵커 미확립" 상태가 존재하지 않게 됐고,
//    따라서 ensure 분기도 소멸했다. read/write 모두 동일한 소유검증 한 경로를 쓴다.
//    (read 경로가 v2 이벤트를 만들어내면 안 된다는 원 제약은 event-access 가 write 를
//     전혀 하지 않으므로 자동 충족된다.)

/**
 * 판매 단계 목록 + 현재 단계 조회 (v2 정본).
 *
 * read 전용 — 이벤트가 v2 에 없거나 타 계정 소유면 null. (write 부작용 없음.)
 * ⚠️ v2 장애는 null 이 아니라 EventAccessError 로 던진다 — 호출측이 404/빈화면으로 뭉개지 말 것.
 * @param opts.timeoutMs/retries 페이지 렌더 경로에서 v2 지연이 로드를 막지 않도록 조절.
 */
export async function fetchSalePlan(
  eventId: string,
  accountId: string,
  opts?: { timeoutMs?: number; retries?: number },
): Promise<SalePlanReadResponse | null> {
  const v2EventId = await resolveOwnedV2EventId(eventId, accountId);
  if (!v2EventId) return null;
  return v2SalePlanRequest<SalePlanReadResponse>(
    "GET",
    `/api/v1/internal/events/${v2EventId}/sale-plan`,
    undefined,
    opts,
  );
}

/**
 * 판매계획 저장 (v2 정본 write 경로).
 *
 * 멱등키는 `sale-plan:{eventId}` 로 **안정**하게 고정한다 — 네트워크 재시도가 같은 키를
 * 재사용해 중복 적용을 만들지 않는다. v2 는 body fingerprint 를 키에 섞으므로 주최자가
 * 내용을 바꿔 다시 저장하면 옛 응답이 replay 되지 않는다(승인 후 변경 반영).
 */
export async function applySalePlan(
  eventId: string,
  accountId: string,
  phases: SalePlanPhaseInput[],
  fcfsOpensAt?: Date,
): Promise<SalePhaseDTO[] | null> {
  const v2EventId = await resolveOwnedV2EventId(eventId, accountId);
  if (!v2EventId) return null;

  const body = {
    phases: phases.map((p) => ({
      mode: p.mode,
      ratio_pct: p.ratioPct,
      opens_at: p.opensAt.toISOString(),
      closes_at: p.closesAt.toISOString(),
      fanclub_id: p.fanclubId ?? null,
    })),
    fcfs_opens_at: fcfsOpensAt ? fcfsOpensAt.toISOString() : null,
  };

  const result = await v2SalePlanRequest<SalePlanWriteResponse>(
    "PUT",
    `/api/v1/internal/events/${v2EventId}/sale-plan`,
    body,
    { idempotencyKey: `sale-plan:${eventId}` },
  );
  return result.phases;
}

/**
 * 추첨 계열 단계(lottery/waitlist_promotion/membership_presale) 존재 여부.
 *
 * 주최자 사이드바의 추첨 메뉴 게이트 — 워크스페이스 **페이지 렌더 경로**에서 호출되므로
 * 재시도 없이 짧은 타임아웃을 쓰고, 실패 시 false(메뉴 숨김)로 보수적 폴백한다.
 * (메뉴가 잠깐 안 보이는 것이 페이지가 안 뜨는 것보다 낫다.)
 */
export async function hasLotteryPhase(
  eventId: string,
  accountId: string,
): Promise<boolean> {
  try {
    const plan = await fetchSalePlan(eventId, accountId, {
      retries: 0,
      timeoutMs: 3_000,
    });
    if (!plan) return false;
    return plan.phases.some((p) =>
      ["lottery", "waitlist_promotion", "membership_presale"].includes(p.mode),
    );
  } catch (err: unknown) {
    logger.warn("v2 판매 단계 조회 실패 — 추첨 메뉴 게이트 false 폴백", {
      eventId,
      error: err instanceof Error ? err.message : "unknown",
    });
    return false;
  }
}

/**
 * 판매가 진행 중인(open/allocating) 단계가 있는지 — 가격 변경 차단 게이트.
 *
 * ⚠️ 조회 실패 시 **true(차단)** 로 폴백한다. 판매 중인데 게이트를 열어 가격을 바꾸면
 * 소비자 표시가·결제액·집계가 갈라진다 — 실패 시 보수적으로 막는 쪽이 안전하다.
 */
export async function hasActiveSalePhase(
  eventId: string,
  accountId: string,
): Promise<boolean> {
  const plan = await fetchSalePlan(eventId, accountId);
  if (!plan) return false; // 이벤트 없음/미소유 — 상위에서 404 처리
  return plan.phases.some((p) => p.status === "open" || p.status === "allocating");
}

/**
 * v2 에러 봉투에서 주최자에게 보여줄 한국어 메시지만 추출한다.
 * commerce-client 는 4xx 메시지를 `"CODE: 본문"` 으로 합쳐두므로 코드 접두어를 제거.
 */
export function salePlanErrorMessage(err: V2CommerceError, fallback: string): string {
  if (err.body) {
    try {
      const parsed = JSON.parse(err.body) as { error?: { message?: string } };
      if (parsed.error?.message) return parsed.error.message;
    } catch {
      /* raw body — 아래 메시지 파싱으로 폴백 */
    }
  }
  const stripped = err.message.replace(/^[A-Z_]+:\s*/, "").trim();
  return stripped || fallback;
}
