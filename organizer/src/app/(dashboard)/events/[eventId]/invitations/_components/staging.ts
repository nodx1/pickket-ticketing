import { parseRecipients, type ParsedRecipient } from "./parse-recipients";

/**
 * 발송 전 **수신인 목록** 조립 로직 — 순수 함수(화면 상태 없음).
 *
 * 🔴 왜 컴포넌트에서 꺼냈나
 * 여기가 틀어지면 **수신자가 조용히 빠지거나 두 번 들어간다.** 화면에는 그럴듯하게
 * 보이므로 눈으로는 못 잡는다. 그런데 컴포넌트 안에 두면 테스트가 원리적으로 닿지
 * 않는다(jsdom·testing-library 미도입) — 오늘 반복해서 나온 형태다.
 *
 * ## 🔴 전제가 바뀌었다 (2026-07-31)
 * 종전 주석: *"v2 는 한 번호당 1장만 발권하므로(UNIQUE(event_id, phone)) … 목록 단계에서
 * 미리 접어 …"*. **그 전제는 폐기됐다** — v2 가 `UNIQUE(event_id, phone_normalized, seq)` 로
 * 바뀌어 **한 번호당 여러 장**을 발급한다(요건: 같이 오거나 선물해서 나눈다).
 *
 * 서버(go)는 이미 전화번호 dedupe 를 제거하고 seq 루프를 돈다. 그런데 **이 파일이 계속
 * 접고 있었다** — 서버는 5장을 받을 준비가 됐는데 화면이 1장만 보냈다. 배포는 그린이었다.
 * ⟹ 여기서 접지 않는다. 같은 번호를 넣은 만큼 목록에 담는다.
 *
 * ⚠️ **상한(5장)은 여기서 세지 않는다.** 화면이 세면 동시 요청에 뚫리고, 무엇보다
 *    상한 판정의 정본은 v2 다(`CHECK(seq 1..5)` + 409). go 도 같은 이유로 상한을
 *    복제하지 않는다(`SEQ_LOOP_GUARD` 는 폭주 방어용이지 업무 규칙이 아니다).
 *    화면은 **결과(`atLimit`)를 받아 보여주는 역할**만 한다.
 */

/** 번호 정규화 — 하이픈·공백 표기가 달라도 같은 사람으로 본다. */
function phoneKey(phone: string): string {
  return phone.replace(/\D/g, "");
}

/**
 * 기존 목록에 새 수신인을 합친다.
 *
 * · **같은 번호도 넣은 만큼 담는다** — 1인 다장 발급이 요건이다.
 * · 전화번호를 못 뽑는 줄만 버린다(발송 불가).
 * · 순서는 유지한다 — 주최자가 넣은 순서대로 보여야 확인이 된다.
 *
 * 🔴 종전엔 여기서 번호별로 접었다. 서버가 dedupe 를 제거한 뒤에도 이 파일이 남아
 *    **화면에서만 1장으로 줄어드는** 상태였다. 접는 로직을 되살리지 말 것.
 */
export function mergeRecipients(
  prev: ParsedRecipient[],
  next: ParsedRecipient[],
): ParsedRecipient[] {
  const added = next.filter((r) => phoneKey(r.phone) !== "");
  return [...prev, ...added];
}

/**
 * 목록에서 번호별 장수를 센다 — 화면 표시용(“홍길동 · 2장째”).
 *
 * ⚠️ 상한 판정에 쓰지 말 것. 이 값으로 5장을 막으면 동시 요청에 뚫리고,
 *    정본은 v2 의 `CHECK(seq 1..5)` + 409 다.
 */
export function countByPhone(staged: ParsedRecipient[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of staged) {
    const k = phoneKey(r.phone);
    if (!k) continue;
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

/**
 * 한 명씩 추가에서 **장수**만큼 같은 줄을 만든다 (2026-07-31 대표 요청).
 *
 * 🔴 왜 필요한가
 * dedupe 를 제거해 "같은 번호를 줄 수만큼 넣으면" 다장이 되게 했지만, 화면에서는
 * 여전히 **같은 번호를 손으로 3번 입력**해야 했다. 3장이면 3번, 5명에게 5장이면 25번이다.
 * 오타 확률이 그만큼 늘고, 실제로 대표가 "매번 입력하게 하지 말라" 고 지적했다.
 *
 * ⚠️ **이 상한은 업무 규칙이 아니라 입력칸의 경계다.**
 *    화면은 목록에 이미 몇 장이 있는지 **세지 않는다** — 세면 동시 요청에 뚫리고,
 *    상한 판정의 정본은 v2 의 `CHECK(seq 1..INVITATION_MAX_PER_PHONE)` + 409 다(`countByPhone` 주석과 같은 이유).
 *    여기서 하는 일은 "한 번의 추가로 상한을 넘는 줄이 들어가는 오조작" 을 막는 것뿐이다.
 */
export const ADD_QTY_MAX = 50;

export function repeatRecipient(recipient: ParsedRecipient, qty: number): ParsedRecipient[] {
  const n = Number.isFinite(qty) ? Math.floor(qty) : 1;
  const bounded = Math.min(Math.max(n, 1), ADD_QTY_MAX);
  // 같은 객체를 공유하면 한 줄을 지울 때 참조가 얽힌다 — 줄마다 새 객체를 만든다.
  return Array.from({ length: bounded }, () => ({ ...recipient }));
}

/** 목록에서 **한 줄**만 제거한다(번호가 중복될 수 있으므로 인덱스로 지운다). */
export function removeAt(staged: ParsedRecipient[], index: number): ParsedRecipient[] {
  if (index < 0 || index >= staged.length) return staged;
  return [...staged.slice(0, index), ...staged.slice(index + 1)];
}

export type AddOneResult =
  | { ok: true; recipient: ParsedRecipient }
  | { ok: false; reason: string };

/**
 * 한 명씩 추가 — **붙여넣기와 같은 파서**를 재사용한다.
 *
 * 🔴 검증 규칙을 따로 짜면 두 입력 경로가 갈린다(한쪽은 통과, 한쪽은 거부).
 *    같은 함수를 태워 규칙이 하나로 유지되게 한다.
 */
export function addOneRecipient(input: {
  name: string;
  phone: string;
  admissionDay?: string;
  requireAdmissionDay: boolean;
  validDays?: string[];
  staged: ParsedRecipient[];
}): AddOneResult {
  const line = input.requireAdmissionDay
    ? `${input.name},${input.phone},${input.admissionDay ?? ""}`
    : `${input.name},${input.phone}`;
  const parsed = parseRecipients(line, {
    requireAdmissionDay: input.requireAdmissionDay,
    validDays: input.requireAdmissionDay ? input.validDays : undefined,
  });
  const recipient = parsed.recipients[0];
  if (parsed.errors.length > 0 || !recipient) {
    return { ok: false, reason: parsed.errors[0]?.reason ?? "이름과 전화번호를 확인해주세요" };
  }
  // 🔴 같은 번호 재추가를 막지 않는다 — 1인 다장이 요건이다.
  //    종전엔 "이미 목록에 있는 번호입니다" 로 거부해 2장째를 담을 수 없었다.
  return { ok: true, recipient };
}

/*
 * 🔴 `removeRecipient(staged, phone)` 를 **삭제했다** (2026-07-31).
 *    번호로 지우면 같은 번호 3줄이 **한 번에 다 지워진다** — 1인 다장에서는 함정이다.
 *    화면의 X 는 그 줄 하나만 지워야 하므로 `removeAt(staged, index)` 를 쓴다.
 */
