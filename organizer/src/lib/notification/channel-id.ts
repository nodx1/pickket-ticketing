/**
 * 카카오 채널 ID(plusFriendId) 정규화·검증 — 순수 모듈(서버 의존 0).
 *
 * ## 🔴 왜 필요한가 (2026-07-29 실사고)
 * `SENS_ALIMTALK_CHANNEL_ID` 에 **주석이 값으로** 들어가 있었다:
 *
 *     '@pickket  # 2026-07-21 카카오채널 연동 완료(정상)'
 *
 * `.env` 파일 감각으로 주석을 달았지만 CapRover env 는 그 줄 전체가 값이다. 앱은 38글자를
 * 그대로 plusFriendId 로 보냈고 NCP 가 404 로 거부했다:
 *
 *     'plusFriendId' is not an registered or 'plusFriendId' status is not active
 *
 * ⟹ **초대권이 발권은 되고 발송만 조용히 실패**했다. 대표 번호로 시험 발권한 1건이
 *    실제로 이렇게 죽었다.
 *
 * 더 나빴던 건 **화면이 그 값을 "연결됨" 으로 보여줬다**는 점이다. 발송 준비 상태 패널에
 * `@pickket # 2026-07-21 …` 이 그대로 찍혀 있었는데, 사람 눈에는 "채널 붙어 있네" 로 읽혔다.
 * 형식이 깨진 걸 **초록불로 보여준 것**이 발견을 늦췄다.
 *
 * 그래서 두 가지를 한다:
 *   ① 정규화 — 첫 공백 앞까지만 취한다(채널 ID 에 공백은 올 수 없다).
 *   ② 판정   — 형식이 어긋나면 화면이 **경고로** 표시할 수 있게 사유를 돌려준다.
 *
 * ⚠️ 정규화는 **구제책이지 면죄부가 아니다.** env 값 자체를 고쳐야 하고(그렇게 했다),
 *    이 모듈은 같은 실수가 또 나도 조용히 죽지 않게 하는 안전망이다.
 */

/** 카카오 채널 ID 형식 — `@` + 영문소문자/숫자/`-`/`_`. 공백·한글·주석 불가. */
const CHANNEL_ID_RE = /^@[a-z0-9_-]+$/;

export type ChannelIdProblem = "missing" | "no_at_prefix" | "has_extra" | "bad_chars";

export interface ChannelIdCheck {
  /** 실제로 NCP 에 보낼 값(정규화 결과). 형식이 깨졌으면 null. */
  value: string | null;
  ok: boolean;
  problem: ChannelIdProblem | null;
  /** 화면에 띄울 사람 말 설명. */
  message: string | null;
}

/**
 * 원본 env 값을 NCP 에 보낼 채널 ID 로 정규화한다.
 *
 * 첫 공백 앞까지만 취한다 — `'@pickket  # 주석'` → `'@pickket'`.
 * 형식이 끝내 어긋나면 null 을 돌려준다(잘못된 값으로 발송을 시도하지 않는다).
 */
export function normalizeChannelId(raw: string | null | undefined): string | null {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return null;
  const head = trimmed.split(/\s/)[0] ?? "";
  return CHANNEL_ID_RE.test(head) ? head : null;
}

/** 정규화 + 사유 판정. 화면(발송 준비 상태)이 초록/경고를 가르는 근거다. */
export function checkChannelId(raw: string | null | undefined): ChannelIdCheck {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) {
    return { value: null, ok: false, problem: "missing", message: "채널 ID가 설정되지 않았습니다" };
  }
  const head = trimmed.split(/\s/)[0] ?? "";
  if (!head.startsWith("@")) {
    return {
      value: null,
      ok: false,
      problem: "no_at_prefix",
      message: "채널 ID는 @로 시작해야 합니다",
    };
  }
  if (!CHANNEL_ID_RE.test(head)) {
    return {
      value: null,
      ok: false,
      problem: "bad_chars",
      message: "채널 ID에 사용할 수 없는 문자가 있습니다",
    };
  }
  if (head !== trimmed) {
    // 정규화하면 보낼 수는 있다. 다만 설정이 잘못된 것이므로 **초록불로 감추지 않는다.**
    return {
      value: head,
      ok: false,
      problem: "has_extra",
      message: `설정값에 불필요한 내용이 붙어 있습니다(주석 등). "${head}" 로 보정해 발송하지만 설정을 고쳐주세요`,
    };
  }
  return { value: head, ok: true, problem: null, message: null };
}
