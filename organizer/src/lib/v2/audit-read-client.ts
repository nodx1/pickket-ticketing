/**
 * v2 감사 로그 조회 프록시 클라이언트 (레벨2 컷오버 스코프A — go audit_logs 완전 이관).
 *
 * go 는 audit_logs 를 자체 DB 에서 조회(admin/audit-logs·compliance)했다. 감사 정본이
 * v2(AuditLog)로 이관됨에 따라 조회도 v2 내부 엔드포인트로 프록시한다(DB 직접참조 금지).
 *
 * 인증: X-Pickket-Service-Token(전환기) + HMAC 서명(X-Pickket-Signature/Timestamp) 병행.
 *   v2 _internal_auth 계약: sig = HMAC-SHA256(GO_WEBHOOK_SECRET, `${ts}.${rawBody}`), GET=빈 본문.
 *   commerce-client·bizverif-client·audit(write) 와 동일 계약 — enforce 전환돼도 무중단.
 *
 * env 는 호출 시점 lazy read(모듈 로드 시점 캡처 금지 — cron/tsx 초기화 순서 대비).
 * account_id 경계: 모든 조회는 accountId 필수 파라미터 — 크로스테넌트 누출 차단(Critical).
 */
import crypto from "node:crypto";
import { logger } from "@/lib/logger";

function getV2Base(): string | undefined {
  return process.env.V2_INTERNAL_BASE_URL;
}
function getSecret(): string | undefined {
  return process.env.GO_WEBHOOK_SECRET ?? process.env.V2_EVENT_SYNC_SECRET;
}

export class V2AuditReadError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "V2AuditReadError";
  }
}

/** v2 audit 조회 원시 행(스네이크). go_context 에서 복원된 원본 식별자. */
interface RawAuditRow {
  id: string;
  account_id: string | null;
  user_id: string | null;
  action: string;
  table_name: string | null;
  record_id: string | null;
  changes: unknown;
  ip_address: string | null;
  created_at: string | null;
}

interface RawAuditResponse {
  logs: RawAuditRow[];
  total: number;
}

/** go 소비자용 감사 행(카멜/스네이크 혼용은 각 라우트 응답계약에 맞춰 매핑). */
export interface AuditReadRow {
  id: string;
  accountId: string | null;
  userId: string | null;
  action: string;
  tableName: string | null;
  recordId: string | null;
  changes: unknown;
  ipAddress: string | null;
  createdAt: string | null;
}

export interface AuditReadQuery {
  accountId: string;
  /** 단일 resource_type. resourceTypes 와 동시 지정 가능. */
  resourceType?: string;
  /** 다중 resource_type. */
  resourceTypes?: string[];
  recordId?: string;
  /** go_context.changes.eventId 매칭(compliance 이벤트 스코프). */
  eventId?: string;
  limit?: number;
  offset?: number;
}

export interface AuditReadResult {
  logs: AuditReadRow[];
  total: number;
}

function mapRow(raw: RawAuditRow): AuditReadRow {
  return {
    id: raw.id,
    accountId: raw.account_id,
    userId: raw.user_id,
    action: raw.action,
    tableName: raw.table_name,
    recordId: raw.record_id,
    changes: raw.changes,
    ipAddress: raw.ip_address,
    createdAt: raw.created_at,
  };
}

/**
 * v2 감사 로그 조회 (fail-closed — 레벨2 코덱스 재감사 P1).
 *
 * ⚠️ 규제: 감사 이력 조회 장애를 "감사 없음(빈 목록)"으로 위장하면 안 된다. 미설정/4xx/5xx/
 *   timeout/네트워크 오류는 **V2AuditReadError 를 던진다**(상위 라우트가 502/503 으로 명시).
 *   빈 목록은 v2 가 200 으로 "실제 없음"을 응답한 경우에만 반환한다.
 */
export async function fetchAuditLogs(query: AuditReadQuery): Promise<AuditReadResult> {
  const base = getV2Base();
  const secret = getSecret();
  if (!base || !secret) {
    logger.error("감사 조회 — v2 클라이언트 미설정(fail-closed)", { accountId: query.accountId });
    throw new V2AuditReadError("감사 조회 서비스가 설정되지 않았습니다", 503);
  }

  const params = new URLSearchParams();
  params.set("account_id", query.accountId);
  if (query.resourceType) params.set("resource_type", query.resourceType);
  if (query.resourceTypes?.length) params.set("resource_types", query.resourceTypes.join(","));
  if (query.recordId) params.set("record_id", query.recordId);
  if (query.eventId) params.set("event_id", query.eventId);
  params.set("limit", String(query.limit ?? 50));
  params.set("offset", String(query.offset ?? 0));

  const path = `/api/v1/internal/audit-logs?${params.toString()}`;
  const url = `${base.replace(/\/$/, "")}${path}`;
  const ts = new Date().toISOString();
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.`).digest("hex");

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Pickket-Service-Token": secret,
        "X-Pickket-Signature": sig,
        "X-Pickket-Timestamp": ts,
        "User-Agent": "pickket-go-audit-read/1.0",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.error("감사 조회 — v2 비정상 응답(fail-closed)", { accountId: query.accountId, status: res.status });
      throw new V2AuditReadError("감사 조회 서비스가 응답하지 않습니다", 502);
    }
    const body = (await res.json()) as RawAuditResponse;
    return { logs: (body.logs ?? []).map(mapRow), total: body.total ?? 0 };
  } catch (err: unknown) {
    if (err instanceof V2AuditReadError) throw err;
    // 네트워크/timeout/파싱 오류 → 장애를 "없음"으로 위장 금지, 502 로 전파.
    logger.error("감사 조회 — v2 프록시 실패(fail-closed)", {
      accountId: query.accountId,
      error: err instanceof Error ? err.message : "unknown",
    });
    throw new V2AuditReadError("감사 조회 서비스에 연결할 수 없습니다", 502);
  }
}

/** 이벤트 감사 추적(compliance) 행 — 화면 계약(userName/userEmail 포함). */
export interface ComplianceAuditLog {
  id: string;
  action: string;
  tableName: string | null;
  recordId: string | null;
  changes: unknown;
  ipAddress: string | null;
  createdAt: string | null;
  userName: string | null;
  userEmail: string | null;
  userId: string | null;
}

export interface ComplianceAuditStats {
  totalLogs: number;
  uniqueUsers: number;
  tablesAffected: number;
  deleteActions: number;
}

export interface ComplianceAuditResult {
  logs: ComplianceAuditLog[];
  stats: ComplianceAuditStats;
}

const EMPTY_COMPLIANCE: ComplianceAuditResult = {
  logs: [],
  stats: { totalLogs: 0, uniqueUsers: 0, tablesAffected: 0, deleteActions: 0 },
};

/**
 * 이벤트 감사 추적 조회(로그+통계). account_id·event_id 경계는 v2 가 강제.
 *
 * ⚠️ fail-closed(레벨2 코덱스 재감사 P1): 미설정/4xx/5xx/timeout 은 V2AuditReadError 를 던진다
 *   (감사 이력 장애를 "없음"으로 위장 금지 — 규제). 빈 결과는 v2 200 실제 응답만.
 */
export async function fetchComplianceAudit(input: {
  accountId: string;
  eventId: string;
  limit?: number;
  offset?: number;
}): Promise<ComplianceAuditResult> {
  const base = getV2Base();
  const secret = getSecret();
  if (!base || !secret) {
    logger.error("컴플라이언스 감사 조회 — v2 클라이언트 미설정(fail-closed)", {
      accountId: input.accountId,
      eventId: input.eventId,
    });
    throw new V2AuditReadError("감사 조회 서비스가 설정되지 않았습니다", 503);
  }

  const params = new URLSearchParams();
  params.set("account_id", input.accountId);
  params.set("event_id", input.eventId);
  params.set("limit", String(input.limit ?? 50));
  params.set("offset", String(input.offset ?? 0));

  const path = `/api/v1/internal/audit-logs/compliance?${params.toString()}`;
  const url = `${base.replace(/\/$/, "")}${path}`;
  const ts = new Date().toISOString();
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.`).digest("hex");

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        "X-Pickket-Service-Token": secret,
        "X-Pickket-Signature": sig,
        "X-Pickket-Timestamp": ts,
        "User-Agent": "pickket-go-audit-read/1.0",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) {
      logger.error("컴플라이언스 감사 조회 — v2 비정상 응답(fail-closed)", {
        accountId: input.accountId,
        status: res.status,
      });
      throw new V2AuditReadError("감사 조회 서비스가 응답하지 않습니다", 502);
    }
    const body = (await res.json()) as ComplianceAuditResult;
    return {
      logs: body.logs ?? [],
      stats: body.stats ?? EMPTY_COMPLIANCE.stats,
    };
  } catch (err: unknown) {
    if (err instanceof V2AuditReadError) throw err;
    logger.error("컴플라이언스 감사 조회 — v2 프록시 실패(fail-closed)", {
      accountId: input.accountId,
      error: err instanceof Error ? err.message : "unknown",
    });
    throw new V2AuditReadError("감사 조회 서비스에 연결할 수 없습니다", 502);
  }
}
