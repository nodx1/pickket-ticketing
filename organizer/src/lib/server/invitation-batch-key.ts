import crypto from "node:crypto";

/**
 * 대량 초대 **배치 멱등키** — 같은 명단을 두 번 올려도 두 번 발급되지 않게 한다.
 *
 * ── 왜 필요한가 (2026-07-30) ──
 * 1인 최대 5장 요건 때문에 phone 기준 중복제거를 **없앴다**. 그래서 시스템은
 * "의도적으로 3장" 과 "실수로 같은 파일 두 번" 을 구분할 수 없게 됐다.
 * 종전에는 `UNIQUE(event_id, phone_normalized)` 가 재업로드 방어를 겸했는데
 * 그 방어가 사라진 것이다.
 *
 * 사고의 크기가 다르다: 붙여넣기 실수는 한 사람이지만, 파일 재업로드는 **명단 전체**다.
 * 그리고 알림톡은 되돌릴 수 없다(초대권 회수는 되지만 발송된 문자는 회수 불가).
 * 5장 상한은 사고 크기만 줄이고 발생을 막지 못한다 — 4번 올리면 상한에 도달한다.
 *
 * ── 왜 이름(name)을 키에 넣지 않는가 ──
 * 담당자가 이름 오타를 고쳐 다시 올리는 일이 흔하다. 이름이 키에 들어가면 그 재업로드가
 * **새 배치**가 되어 명단 전원에게 한 장씩 더 나간다 — 우리가 막으려던 바로 그 사고다.
 * 이름은 표시용 메타데이터이고, "누구에게 무엇을 발급하는가" 를 정하는 것은
 * 번호와 입장 조건이다. 그래서 키는 그 둘만 본다.
 * ⚠️ 대가: 이름만 고쳐 재업로드하면 재사용으로 처리되어 **고친 이름이 반영되지 않는다.**
 *    표시가 틀리는 것과 명단 전체 이중발송을 견주면 전자를 택한다.
 *
 * ── 왜 순서를 무시하는가 ──
 * 엑셀 정렬을 바꿔 다시 올리는 것도 같은 명단이다. 정렬 후 해시해 **다중집합**으로 본다
 * (같은 번호가 3줄이면 3줄인 것까지 동일해야 같은 배치다).
 */

export interface BatchKeyRecipient {
  phoneNormalized: string;
  admissionDay?: string | null;
  admissionMode?: string | null;
}

/**
 * 배치 지문 — 같은 이벤트·같은 명단이면 같은 값.
 *
 * @returns sha256 hex. 수신자가 0명이면 빈 문자열(호출측이 멱등 처리를 건너뛴다).
 */
export function invitationBatchFingerprint(
  eventId: string,
  recipients: readonly BatchKeyRecipient[],
): string {
  if (recipients.length === 0) return "";
  const lines = recipients
    .map((r) => [r.phoneNormalized, r.admissionDay ?? "", r.admissionMode ?? ""].join("\u0001"))
    .sort();
  return crypto.createHash("sha256").update(`${eventId}\u0002${lines.join("\u0000")}`).digest("hex");
}

/** Redis 키. `getPrefixedRedis()` 가 `go:` 를 붙이므로 여기서는 붙이지 않는다. */
export function invitationBatchKey(eventId: string, fingerprint: string): string {
  return `invite-batch:${eventId}:${fingerprint}`;
}

/**
 * 진행 중 클레임의 TTL(초).
 *
 * 🔴 완료 결과보다 **훨씬 짧아야 한다.** 처리 중에 프로세스가 죽으면 이 키가 남는데,
 *    완료 TTL(7일)로 잡아두면 그 명단은 **7일간 재시도 불가**가 된다.
 *    10분 뒤에는 재시도가 통과하도록 짧게 둔다.
 */
export const BATCH_CLAIM_TTL_SECONDS = 600;

/** 완료 결과 보관 TTL(초) — 다음 날 "저번에 보낸 게 맞나" 재업로드까지 덮는다. */
export const BATCH_RESULT_TTL_SECONDS = 7 * 24 * 60 * 60;

export const BATCH_STATE_PROCESSING = "processing";
