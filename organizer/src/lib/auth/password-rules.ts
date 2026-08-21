/**
 * 비밀번호 규칙 — **화면과 검증이 같은 출처를 본다.**
 *
 * ## 🔴 왜 필요한가 (2026-08-01 오픈일 신고)
 * "회원가입이 안 된다" 신고를 받고 폼을 열어보니, 가입 버튼이
 * `disabled={submitting || !isValid}` 였다. 즉 **규칙을 못 맞추면 버튼이 그냥 죽는다.**
 *
 *     비밀번호 두 칸이 전부 `type="password"`   → 뭘 쳤는지 볼 수 없다
 *     규칙 미충족                              → 버튼이 회색인 채 아무 말 없음
 *     오류 문구는 제출해야 나옴                  → 제출이 안 되니 영영 안 나옴
 *
 * ⟹ **사용자는 "고장났다" 로 읽는다.** 실제로 그렇게 신고가 들어왔다.
 *    규칙은 8자·대문자·숫자·특수문자 **네 가지**인데 안내는 placeholder 한 줄뿐이었고,
 *    입력을 시작하면 그 placeholder 마저 사라진다.
 *
 * ⟹ 규칙을 **항목별로** 만들어 화면이 실시간으로 체크를 보여준다.
 *    zod 스키마도 이 목록에서 만들어 **둘이 갈라지지 않게** 한다
 *    (오늘 하루 사고가 전부 "같은 규칙이 두 곳에 따로 적혀 있어서" 였다).
 */

export interface PasswordRule {
  /** 화면에 그대로 노출되는 문구. */
  label: string;
  test: (value: string) => boolean;
  /** 미충족 시 제출 검증이 내는 메시지. */
  message: string;
}

/** v2 `core/password_policy.py` 와 같은 규칙이어야 한다(서버가 최종 관문). */
export const PASSWORD_RULES: readonly PasswordRule[] = [
  { label: "8자 이상", test: (v) => v.length >= 8, message: "비밀번호는 8자 이상이어야 합니다" },
  { label: "대문자 1자", test: (v) => /[A-Z]/.test(v), message: "비밀번호에 대문자를 1자 이상 포함해주세요" },
  { label: "숫자 1자", test: (v) => /[0-9]/.test(v), message: "비밀번호에 숫자를 1자 이상 포함해주세요" },
  { label: "특수문자 1자", test: (v) => /[^A-Za-z0-9]/.test(v), message: "비밀번호에 특수문자를 1자 이상 포함해주세요" },
] as const;

/** 각 규칙의 충족 여부 — 화면 체크리스트용. */
export function checkPasswordRules(value: string): Array<PasswordRule & { ok: boolean }> {
  return PASSWORD_RULES.map((r) => ({ ...r, ok: r.test(value) }));
}

/** 아직 못 맞춘 규칙들. 비어 있으면 통과. */
export function unmetPasswordRules(value: string): PasswordRule[] {
  return PASSWORD_RULES.filter((r) => !r.test(value));
}
