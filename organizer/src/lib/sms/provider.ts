/**
 * SMS Provider 인터페이스.
 *
 * v2 패턴 참조: backend/app/services/sms_service.py (factory + NCP/Twilio/Stub)
 *
 * go는 Stub으로 시작 → Solapi 계약 후 SolapiProvider 추가.
 * 필요시 NCP/Twilio도 쉽게 붙일 수 있도록 추상화.
 */

export interface SmsSendParams {
  to: string;           // E.164 형식 권장 (+821012345678)
  body: string;         // 메시지 본문 (한글 45자 이내 권장)
  templateId?: string;  // 프로바이더별 템플릿 ID (선택)
}

export interface SmsSendResult {
  success: boolean;
  messageId: string;    // provider가 준 id 또는 stub의 내부 id
  provider: string;     // 'stub' | 'solapi' | 'ncp' | 'twilio'
  cost?: number;        // 발송 비용 (원, 있으면)
  rawResponse?: Record<string, unknown>;
}

export interface SmsProvider {
  readonly name: "stub" | "solapi" | "ncp" | "twilio";
  send(params: SmsSendParams): Promise<SmsSendResult>;
}
