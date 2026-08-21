import { toIsoFromKstLocal } from "@/lib/datetime/kst-local";

/**
 * 이벤트 타임테이블(옛 go `event_schedules` 테이블) — v2 `events.event_schedules`(JSONB) 어댑터.
 *
 * ## 왜 별도 모듈인가
 * 레벨2 컷오버 W2-EVT 에서 go `event_schedules` 테이블을 없앤다. v2 는 이미 같은 데이터를
 * `events.event_schedules` JSONB 배열로 갖고 있지만(1-S 계약 `[{time,title,description}]`),
 * go 주최자 UI 는 그보다 넓은 필드(**id / ends_at / venue_name / sort_order**)를 쓴다.
 * v2 `_validate_gap_list` 는 원소를 dict 로만 검증하고 **키를 보존**하므로, 확장 키를 그대로
 * 실어 보내면 왕복 무손실이다. 이 모듈이 그 (직렬화 ↔ 역직렬화) 한 쌍을 소유한다.
 *
 * ## 🔴 부분 갱신 계약
 * v2 updateEvent 는 "키 포함=반영 / 미포함=보존"이다. 따라서 타임테이블을 건드리지 않는 라우트는
 * `event_schedules` 키를 **절대 실어보내면 안 된다** — 옛 스냅샷으로 되돌려 편집이 유실된다.
 * (같은 이유로 `event-gap-fields.ts` 는 이 필드를 더 이상 수집하지 않는다.)
 */

/** go 주최자 UI 가 다루는 일정 1건. */
export interface EventScheduleItem {
  id: string;
  title: string;
  description: string | null;
  startsAt: string;
  endsAt: string | null;
  venueName: string | null;
  sortOrder: number;
  /**
   * 🔴 일정 항목에 붙이는 안내 이미지(조편성표 등) — 2026-08-19 대표 요청.
   *
   * 상세 이미지(`intro` 3장 상한)와 **자리가 다르다.** 조편성처럼 「그 일정에 딸린 자료」는
   * 일정 옆에 있어야 손님이 찾는다. 없으면 아무것도 안 그린다.
   */
  imageUrl: string | null;
}

/**
 * v2 JSONB 원소 형태. `time`/`title`/`description` 은 1-S 계약(소비자 상세가 소비),
 * 나머지는 go 주최자 UI 전용 확장 키다.
 */
export interface V2ScheduleItem {
  time: string;
  title: string;
  description: string | null;
  id?: string;
  ends_at?: string | null;
  venue_name?: string | null;
  sort_order?: number;
  /** go 확장 키 — 1-S 계약(time·title·description)에는 없다. 소비자는 무시한다. */
  image_url?: string | null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function toIso(value: unknown): string | null {
  // 🔴 `new Date(raw)` 를 직접 쓰지 않는다 (2026-07-31 실사고).
  //    `datetime-local` 은 시간대 없는 문자열을 주는데, 그걸 파싱하면 **이 코드가 도는 곳의**
  //    시간대로 해석된다. organizer 컨테이너는 TZ 미설정(=UTC)이라 한국시각 07:00 이
  //    07:00Z 로 저장되고, 화면에서 KST 변환이 한 번 더 걸려 **9시간 밀렸다**.
  //    시간대가 붙은 값은 그대로 두고, 없는 값만 KST 로 해석한다.
  return toIsoFromKstLocal(asString(value));
}

/**
 * v2 `content.event_schedules` → go UI 형태.
 *
 * 정렬은 저장 시점 순서를 신뢰하지 않고 `sortOrder → startsAt` 로 재정렬한다
 * (옛 go `ORDER BY sort_order ASC, starts_at ASC` 와 동일).
 * 형태가 깨진 원소는 조용히 버리지 않고 **최선 복원**한다 — 주최자가 입력한 일정을
 * 파싱 실패로 소리 없이 잃는 것이 더 나쁘기 때문.
 */
export function parseV2Schedules(raw: unknown): EventScheduleItem[] {
  if (!Array.isArray(raw)) return [];
  const items: EventScheduleItem[] = [];
  raw.forEach((entry, index) => {
    if (!entry || typeof entry !== "object") return;
    const row = entry as Record<string, unknown>;
    const title = asString(row.title);
    if (!title) return;
    items.push({
      id: asString(row.id) ?? `schedule-${index}`,
      title,
      description: asString(row.description),
      startsAt: toIso(row.time) ?? "",
      endsAt: toIso(row.ends_at),
      venueName: asString(row.venue_name),
      sortOrder: typeof row.sort_order === "number" ? row.sort_order : index,
      imageUrl: asString(row.image_url),
    });
  });
  return items.sort(
    (a, b) => a.sortOrder - b.sortOrder || a.startsAt.localeCompare(b.startsAt),
  );
}

/** go UI 형태 → v2 JSONB 원소(1-S 계약 키 + go 확장 키). */
export function toV2Schedules(items: EventScheduleItem[]): V2ScheduleItem[] {
  return items.map((s) => ({
    time: s.startsAt,
    title: s.title,
    description: s.description,
    id: s.id,
    ends_at: s.endsAt,
    venue_name: s.venueName,
    sort_order: s.sortOrder,
    image_url: s.imageUrl,
  }));
}
