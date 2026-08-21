/**
 * Ticket Status 공유 계약
 *
 * 정본: docs/architecture/standards/DOMAIN_MODEL_STANDARD.md
 * v2가 SSOT. 티켓 상태는 v2가 단독 소유하고, app/go는 이 값을 그대로 표시·투영한다.
 *
 * 값의 원천(SSOT): backend/app/models/ticket.py::TicketStatus
 * → scripts/codegen/generate_ts_contracts.py 로 `generated/ticket-status.ts` 로 내보냄.
 * → 이 파일은 generated 값을 재-export 한다. (드리프트 시 codegen freshness 게이트가 감지)
 *
 * NOTE: 과거 app이 로컬에 정의하던 `checked_in`/`issued`/`paid` 는 v2 SSOT에 존재하지
 *       않는 값이었다. 현장 입장 처리는 `used` 로 표현된다(별도 체크인 상태 없음).
 */

import {
  V2_TICKET_STATUSES_GENERATED,
  type V2TicketStatusGenerated,
} from "./generated/ticket-status";

export const V2_TICKET_STATUSES = V2_TICKET_STATUSES_GENERATED;
export type V2TicketStatus = V2TicketStatusGenerated;
