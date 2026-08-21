import { toKstLocalInput } from "@/lib/datetime/kst-local";

/**
 * ISO 시각 → `<input type="datetime-local">` 값. **KST 고정.**
 *
 * ## 🔴 왜 위임하는가 (2026-07-31 실사고, 읽기 경로)
 * 종전 구현은 `date.getFullYear()` / `getHours()` 를 썼다. 이건 **코드가 도는 곳의
 * 시간대**를 따르는데, organizer 컨테이너는 `TZ` 미설정 = **UTC** 다(실측).
 * 그래서 DB 에 `2026-08-19T22:00Z`(= KST 8/20 07:00)가 정확히 들어 있는데도
 * 설정 화면이 **8월 19일 22:00** 으로 보여줬다. 대표가 "왜 KST 가 아니냐"고 물어서 알았다.
 *
 * 같은 날 오전에 **쓰기 경로 19곳**을 `toIsoFromKstLocal` 로 고쳤는데, 그때
 * **읽기 경로는 안 봤다.** 저장은 맞는데 화면이 9시간 거짓말을 하고 있었고,
 * 그 화면을 보고 값을 다시 저장하면 그때 진짜로 밀린다.
 *
 * ⟹ 변환 규칙은 `lib/datetime/kst-local.ts` **한 곳**에만 둔다. 여기서 다시 구현하지 말 것.
 *    (`datetime-local.read.guard.test.ts` 가 복제본 부활을 막는다)
 */
export function toDateTimeLocal(value: string | Date | null | undefined): string {
  return toKstLocalInput(value instanceof Date ? value.toISOString() : value);
}
