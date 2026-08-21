/**
 * F2 대량 초대 명단 파싱 — 붙여넣기/CSV 텍스트 → 수신자 배열.
 *
 * 한 줄 = 한 명. 구분자는 콤마 또는 탭. 컬럼 순서: 이름, 전화번호[, 입장지정일(YYYY-MM-DD)].
 * 헤더 행("이름"/"name" 포함)은 자동 스킵. 빈 줄 무시.
 */

export interface ParsedRecipient {
  name: string;
  phone: string;
  admissionDay?: string;
}

export interface ParseResult {
  recipients: ParsedRecipient[];
  /** 형식 오류가 있는 줄(1-based 원본 줄 번호 + 사유) — 화면에 안내 */
  errors: Array<{ line: number; reason: string }>;
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * KR 휴대폰 형식 판정용 정규식(숫자만 정규화 후 검사).
 * register 라우트의 표준 `/^01[0-9]-?\d{3,4}-?\d{4}$/` 와 동치(하이픈 제거 후 10~11자리).
 */
const PHONE_RE = /^01[0-9]\d{7,8}$/;

/** 전화번호에서 숫자만 남긴다(하이픈·공백·+82 등 구분자 제거). */
function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

/** 한 줄을 콤마/탭으로 분해(따옴표 미지원 — 단순 명단). */
function splitLine(line: string): string[] {
  return line.split(/[\t,]/).map((c) => c.trim());
}

/** daypass 이벤트면 지정일을 필수·유효 날짜 목록으로 검증한다. */
export function parseRecipients(
  raw: string,
  opts: { requireAdmissionDay?: boolean; validDays?: string[] } = {},
): ParseResult {
  const recipients: ParsedRecipient[] = [];
  const errors: ParseResult["errors"] = [];
  const validDaySet = opts.validDays ? new Set(opts.validDays) : null;

  const lines = raw.split(/\r?\n/);
  lines.forEach((rawLine, idx) => {
    const line = rawLine.trim();
    if (!line) return;
    const cols = splitLine(line);
    const [nameRaw = "", phoneRaw = "", dayRaw = ""] = cols;
    // 헤더 행 스킵
    const lower = nameRaw.toLowerCase();
    if (lower === "name" || nameRaw === "이름") return;

    const name = nameRaw;
    if (!name) {
      errors.push({ line: idx + 1, reason: "이름이 없습니다" });
      return;
    }
    if (!phoneRaw) {
      errors.push({ line: idx + 1, reason: "전화번호가 없습니다" });
      return;
    }
    const phone = normalizePhone(phoneRaw);
    if (!PHONE_RE.test(phone)) {
      errors.push({ line: idx + 1, reason: "휴대폰 번호 형식이 올바르지 않습니다(예: 01012345678)" });
      return;
    }

    const recipient: ParsedRecipient = { name, phone };
    const day = dayRaw;
    if (day) {
      if (!DAY_RE.test(day)) {
        errors.push({ line: idx + 1, reason: "입장 지정일 형식(YYYY-MM-DD)이 올바르지 않습니다" });
        return;
      }
      if (validDaySet && !validDaySet.has(day)) {
        errors.push({ line: idx + 1, reason: "입장 지정일이 대회 기간을 벗어났습니다" });
        return;
      }
      recipient.admissionDay = day;
    } else if (opts.requireAdmissionDay) {
      errors.push({ line: idx + 1, reason: "지정일권 이벤트는 입장 지정일이 필요합니다" });
      return;
    }
    recipients.push(recipient);
  });

  return { recipients, errors };
}
