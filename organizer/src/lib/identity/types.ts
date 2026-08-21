/**
 * 실명인증 Provider 인터페이스.
 *
 * Phase 5B-2.
 *
 * 지원 예정 provider:
 *  - NICE 표준창 (SEED128/AES)
 *  - KCB 주민번호대체확인
 *  - PCC 본인확인
 *  - Toss 본인인증 (대안)
 *
 * 현재는 인터페이스만. 실제 API 호출은 CEO 벤더 결정 후 활성화.
 */

export interface IdentityStartParams {
  purpose: "signup" | "checkout" | "refund" | "age_check" | "organizer_kyc";
  returnUrl: string;   // 콜백으로 돌아올 URL
  orderId?: string;    // 구매자 인증 시
  accountId?: string;  // 주최자 인증 시
  userAgent?: string;
  clientIp?: string;
}

export interface IdentityStartResult {
  /** 인증 시작 URL (사용자를 이 URL로 redirect) */
  redirectUrl: string;
  /** 내부 추적용 ID */
  verificationId: string;
  /** provider별 tx_id 등 메타데이터 */
  providerMeta?: Record<string, unknown>;
}

export interface IdentityCallbackParams {
  /** 콜백 쿼리스트링/바디 전체 */
  rawCallback: Record<string, unknown>;
  /** start 시 발급한 내부 verificationId */
  verificationId: string;
}

export interface IdentityCallbackResult {
  success: boolean;
  /** SHA-256(CI). 소비자 식별/중복 방지용 */
  ciHash?: string;
  /** SHA-256(DI). 동일 provider 내 중복 방지용 */
  diHash?: string;
  /** AES-256-GCM(원본 CI). 복호화 가능 필요 시 */
  ciEncrypted?: string;
  diEncrypted?: string;
  /** 이름 해시 */
  nameHash?: string;
  birthYear?: number;
  gender?: "M" | "F";
  phoneEncrypted?: string;
  /** provider 원본 응답 */
  rawResponse: Record<string, unknown>;
  error?: string;
}

export interface IdentityProvider {
  readonly name: "nice" | "kcb" | "pcc" | "toss_cert" | "stub";
  start(params: IdentityStartParams): Promise<IdentityStartResult>;
  handleCallback(params: IdentityCallbackParams): Promise<IdentityCallbackResult>;
}
