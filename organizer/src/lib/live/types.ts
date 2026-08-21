/**
 * 대회 라이브 응답 — `GET /api/public/live/summary?ticket=<ticketNumber>`.
 *
 * 🔴 **필드명을 우리 마음대로 바꾸지 않는다.** 백엔드 지시서
 * (`docs/plans/WORKORDER-LIVE-BACKEND-20260806.md` §2)의 JSON 모양이 정본이다.
 * 한 글자만 달라도 화면은 조용히 빈칸이 된다 — 타입은 맞고 값만 `undefined` 라
 * 컴파일도 테스트도 통과한다.
 *
 * ⚠️ 그래서 snake_case 를 **그대로** 쓴다. camelCase 로 옮기는 매핑 계층을 두면
 *    거기서 오타가 나고, 그 오타는 화면에서만 보인다.
 */

/**
 * 대회 진행 단계.
 *
 * ```
 * not_started  대회 시작 전 — 조편성이 아직 없다(원천이 첫 조 출발 후에 준다)
 * live         진행 중
 * ended        라운드 종료
 * ```
 *
 * 🔴 **`stale` 은 여기 없다.** 정지 여부는 **직교하는 별도 축**이다 —
 *    `status="live"` 이면서 `stale=true` 인 상태가 정상적으로 존재한다
 *    (경기는 하고 있는데 우리 쪽 데이터가 멈춘 경우).
 *    한 축에 넣으면 그 조합이 표현 불가능해지고, 화면은 "경기가 끝났다" 고 거짓말한다.
 */
/**
 * 🔴 2026-08-07 통합 — **타입을 두 벌로 두지 않는다.**
 *
 * 여기에 `LiveSummary`·`LiveGroup`·`LiveGroupPlayer` 를 따로 선언하고 있었다.
 * 요약을 만드는 곳(`summary.ts`)과 화면이 믿는 곳이 갈려서, 백엔드가
 * `players[].name` 을 `string | null` 로 바꿨는데 여기는 `string` 인 채였다.
 *
 * ⚠️ **tsc 는 통과했다.** 두 선언이 서로를 모르기 때문이다 — 런타임에만 깨진다.
 *    조편성에 이름이 빈 줄로 뜨고, 이름이 없는 선수가 둘이면 React key 가 중복된다.
 *
 * ⟹ 정본은 **요약을 만드는 `summary.ts`** 다. 여기서는 재수출만 한다.
 *    (같은 날 `gate.ts` 의 리허설 판정도 같은 형태로 두 벌이었다.)
 */
export type { LiveStatus } from "./source";
export type {
  LiveSummary,
  LiveSummaryLeader as LiveLeader,
  LiveSummaryGroup as LiveGroup,
  LiveSummaryPlayer as LiveGroupPlayer,
} from "./summary";
