/**
 * v2 사업자 인증 심사 프록시 클라이언트 (레벨2 2차 D4 — go DB 제거).
 *
 * go 는 business_verifications(+documents) 를 자체 DB 에 갖던 것을 v2 정본으로 이관한다.
 * 이 클라이언트는 go API 라우트가 v2 내부/admin 엔드포인트를 호출하는 얇은 프록시.
 *
 * 인증: X-Pickket-Service-Token(전환기) + HMAC 서명(X-Pickket-Signature/Timestamp) 병행.
 *   v2 _internal_auth 계약: sig = HMAC-SHA256(GO_WEBHOOK_SECRET, `${ts}.${rawBody}`), GET=빈 본문.
 *   commerce-client·settlement-fetcher 와 동일 — enforce 전환돼도 무중단.
 *
 * env 는 호출 시점 lazy read(모듈 로드 시점 캡처 금지 — cron/tsx 초기화 순서 대비).
 */
import crypto from "node:crypto";

function getV2Base(): string | undefined {
  return process.env.V2_INTERNAL_BASE_URL;
}
function getSecret(): string | undefined {
  return process.env.GO_WEBHOOK_SECRET ?? process.env.V2_EVENT_SYNC_SECRET;
}

export class V2BizVerifError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body?: string,
  ) {
    super(message);
    this.name = "V2BizVerifError";
  }
}

export interface BizVerifDocument {
  docType: "biz_cert" | "bankbook" | "permit";
  fileUrl: string;
  storageKey?: string | null;
}

export interface BizVerifCurrent {
  id: string;
  accountId: string;
  bizNumber: string | null;
  companyName: string | null;
  repName: string | null;
  bizType: string | null;
  bizItem: string | null;
  address: string | null;
  openedOn: string | null;
  bankName: string | null;
  bankAccount: string | null;
  bankHolder: string | null;
  authorizedConfirmed: boolean;
  maskingConfirmed: boolean;
  status: string;
  rejectedReason: string | null;
  createdAt: string | null;
  documents: BizVerifDocument[];
}

export interface BizVerifStatusResult {
  verificationStatus: string;
  verifiedAt: string | null;
  rejectedReason: string | null;
  current: BizVerifCurrent | null;
}

export interface BizVerifSubmitInput {
  accountId: string;
  action: "save" | "submit";
  bizNumber?: string;
  companyName?: string;
  repName?: string;
  bizType?: string;
  bizItem?: string;
  address?: string;
  openedOn?: string;
  bankName?: string;
  bankAccount?: string;
  bankHolder?: string;
  authorizedConfirmed?: boolean;
  maskingConfirmed?: boolean;
  documents?: BizVerifDocument[];
}

interface RawCurrent {
  id: string;
  account_id: string;
  biz_number: string | null;
  company_name: string | null;
  rep_name: string | null;
  biz_type: string | null;
  biz_item: string | null;
  address: string | null;
  opened_on: string | null;
  bank_name: string | null;
  bank_account: string | null;
  bank_holder: string | null;
  authorized_confirmed: boolean;
  masking_confirmed: boolean;
  status: string;
  rejected_reason: string | null;
  created_at: string | null;
  documents?: Array<{ doc_type: string; file_url: string; storage_key: string | null }>;
}

function mapCurrent(raw: RawCurrent): BizVerifCurrent {
  return {
    id: raw.id,
    accountId: raw.account_id,
    bizNumber: raw.biz_number,
    companyName: raw.company_name,
    repName: raw.rep_name,
    bizType: raw.biz_type,
    bizItem: raw.biz_item,
    address: raw.address,
    openedOn: raw.opened_on,
    bankName: raw.bank_name,
    bankAccount: raw.bank_account,
    bankHolder: raw.bank_holder,
    authorizedConfirmed: raw.authorized_confirmed,
    maskingConfirmed: raw.masking_confirmed,
    status: raw.status,
    rejectedReason: raw.rejected_reason,
    createdAt: raw.created_at,
    documents: (raw.documents ?? []).map((d) => ({
      docType: d.doc_type as BizVerifDocument["docType"],
      fileUrl: d.file_url,
      storageKey: d.storage_key,
    })),
  };
}

async function v2Request<T>(
  method: "GET" | "PUT" | "PATCH",
  path: string,
  body?: unknown,
): Promise<T> {
  const base = getV2Base();
  const secret = getSecret();
  if (!base || !secret) {
    throw new V2BizVerifError(
      "v2 사업자인증 클라이언트 미설정 (V2_INTERNAL_BASE_URL / GO_WEBHOOK_SECRET)",
      500,
    );
  }
  const url = `${base.replace(/\/$/, "")}${path}`;
  const payload = body === undefined ? "" : JSON.stringify(body);
  const ts = new Date().toISOString();
  const sig = crypto.createHmac("sha256", secret).update(`${ts}.${payload}`).digest("hex");

  const res = await fetch(url, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Pickket-Service-Token": secret,
      "X-Pickket-Signature": sig,
      "X-Pickket-Timestamp": ts,
      "User-Agent": "pickket-go-bizverif/1.0",
    },
    body: body === undefined ? undefined : payload,
    signal: AbortSignal.timeout(10_000),
  });

  const text = await res.text().catch(() => "");
  if (!res.ok) {
    let msg = `v2 사업자인증 ${method} ${path} 실패`;
    try {
      const parsed = JSON.parse(text);
      if (parsed?.detail) msg = typeof parsed.detail === "string" ? parsed.detail : msg;
    } catch {
      /* raw body 유지 */
    }
    throw new V2BizVerifError(msg, res.status, text);
  }
  return (text ? JSON.parse(text) : {}) as T;
}

/** 계정 최신 인증 신청 + 게이트 상태 조회 (go GET 프록시). */
export async function fetchBizVerification(accountId: string): Promise<BizVerifStatusResult> {
  const raw = await v2Request<{
    verification_status: string;
    has_approved: boolean;
    verified_at: string | null;
    rejected_reason: string | null;
    current: RawCurrent | null;
  }>("GET", `/api/v1/internal/business-verifications/current?account_id=${encodeURIComponent(accountId)}`);

  return {
    verificationStatus: raw.verification_status,
    verifiedAt: raw.verified_at,
    rejectedReason: raw.rejected_reason,
    current: raw.current ? mapCurrent(raw.current) : null,
  };
}

export interface BizVerifQueueItem {
  id: string;
  accountId: string;
  bizNumber: string | null;
  companyName: string | null;
  repName: string | null;
  bankName: string | null;
  bankHolder: string | null;
  status: string;
  createdAt: string | null;
}

/** 심사 대기열 조회 (go internal 프록시 — v2 정본). */
export async function listBizVerifications(status = "pending"): Promise<BizVerifQueueItem[]> {
  const raw = await v2Request<{
    data: Array<{
      id: string;
      account_id: string;
      biz_number: string | null;
      company_name: string | null;
      rep_name: string | null;
      bank_name: string | null;
      bank_holder: string | null;
      status: string;
      created_at: string | null;
    }>;
  }>("GET", `/api/v1/internal/business-verifications?status_filter=${encodeURIComponent(status)}`);
  return raw.data.map((r) => ({
    id: r.id,
    accountId: r.account_id,
    bizNumber: r.biz_number,
    companyName: r.company_name,
    repName: r.rep_name,
    bankName: r.bank_name,
    bankHolder: r.bank_holder,
    status: r.status,
    createdAt: r.created_at,
  }));
}

/** 심사 상세(서류 포함) 조회 (go internal 프록시). */
export async function getBizVerificationDetail(verificationId: string): Promise<BizVerifCurrent> {
  const raw = await v2Request<{ data: RawCurrent }>(
    "GET",
    `/api/v1/internal/business-verifications/${encodeURIComponent(verificationId)}`,
  );
  return mapCurrent(raw.data);
}

/** 승인/반려 (go internal 프록시). reviewerId 는 심사한 admin(있으면). */
export async function reviewBizVerification(
  verificationId: string,
  action: "approve" | "reject",
  reason?: string | null,
  reviewerId?: string | null,
): Promise<{ id: string; accountId: string; status: string }> {
  const raw = await v2Request<{ data: { id: string; account_id: string; status: string } }>(
    "PATCH",
    `/api/v1/internal/business-verifications/${encodeURIComponent(verificationId)}`,
    { action, reason: reason ?? null, reviewer_id: reviewerId ?? null },
  );
  return { id: raw.data.id, accountId: raw.data.account_id, status: raw.data.status };
}

/** 계정 저장(save)/제출(submit) (go PUT 프록시). */
export async function submitBizVerification(
  input: BizVerifSubmitInput,
): Promise<{ status: string; id: string }> {
  const body = {
    account_id: input.accountId,
    action: input.action,
    biz_number: input.bizNumber,
    company_name: input.companyName,
    rep_name: input.repName,
    biz_type: input.bizType,
    biz_item: input.bizItem,
    address: input.address,
    opened_on: input.openedOn,
    bank_name: input.bankName,
    bank_account: input.bankAccount,
    bank_holder: input.bankHolder,
    authorized_confirmed: input.authorizedConfirmed,
    masking_confirmed: input.maskingConfirmed,
    documents: (input.documents ?? []).map((d) => ({
      doc_type: d.docType,
      file_url: d.fileUrl,
      storage_key: d.storageKey ?? null,
    })),
  };
  return v2Request<{ status: string; id: string }>("PUT", `/api/v1/internal/business-verifications`, body);
}
