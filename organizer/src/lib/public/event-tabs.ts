/**
 * 공개 이벤트 상세(/e/[eventSlug]) — 탭 노출 판정 + 태그 파싱/직렬화.
 *
 * ★ 순수 함수만 둔다. 서버 컴포넌트 안에 인라인으로 두면 테스트가 닿지 못한다
 *   (판정을 뒤집어도 전체 스위트가 초록으로 통과하는 사고 전례).
 *
 * 정보구조(IA)는 consumer 의 EventInfoTabs(공연 정보·예매 안내·참여자·프로그램·장소 안내)를 흡수하되,
 * organizer 는 참여자(캐스트/라인업) 데이터가 없고 예매/환불/할인은 상시 노출 구매 패널이 담당하므로
 * **내용이 실제로 존재하는 탭만** 노출한다(빈 탭 = "준비 중"만 보이는 페이지 방지).
 */

export type PublicEventTabId = "intro" | "program" | "venue" | "contact";

export interface PublicEventTab {
  id: PublicEventTabId;
  label: string;
}

/** 탭 판정 입력 — 전부 optional(누락 = 값 없음)으로 두어 호출부 스프레드에 안전. */
export interface PublicEventTabInput {
  /** events.description — 소개 본문. */
  description?: string | null;
  /** events.summary — 한 줄 요약(본문 폴백). */
  summary?: string | null;
  /** event_schedules 행 수(이벤트 일정). */
  scheduleCount?: number | null;
  /** events.program_notes — 프로그램 안내(줄바꿈 = 항목). */
  programNotes?: string | null;
  /** events.is_online — 온라인 이벤트. */
  isOnline?: boolean | null;
  /** events.venue_address — 공연장 주소(지도/주소복사의 전제). */
  venueAddress?: string | null;
  /** events.transport_info — 대중교통 안내. */
  transportInfo?: string | null;
  /** events.parking_info — 주차 안내. */
  parkingInfo?: string | null;
  /** events.stage_info — 무대·구역 안내. */
  stageInfo?: string | null;
  /**
   * homepage_design.showVenueMap 토글. 명시적 false 면 주최자가 장소 안내를 숨긴 것이므로
   * 탭 자체를 만들지 않는다(기존 페이지 동작 보존 — `showVenueMap !== false` 일 때만 렌더했음).
   */
  showVenueMap?: boolean | null;
}

/**
 * 탭 라벨은 **짧게 유지한다** — 길어지면 모바일에서 잘린다.
 *
 * 🔴 2026-07-31 실측(390px 기기): 네 탭의 총폭 417px 인데 탭 바 폭은 358px 이라
 *    마지막 탭이 화면 밖으로 잘렸다. 그런데 스크롤바를 숨겨놔서 **넘친다는 단서가 없었다**
 *    — 대표가 "탭이 짤린다"고 지적해서 알았다. 가로 스크롤은 안전망일 뿐 해법이 아니다.
 *    상세 문구는 각 패널 안의 제목이 담당한다(예: program 패널의 "이벤트 일정").
 *
 * ⚠️ 라벨을 늘리기 전에 `event-tabs.width.test.ts` 의 폭 예산을 먼저 볼 것.
 */
const TAB_LABELS: Record<PublicEventTabId, string> = {
  intro: "행사 소개",
  program: "프로그램",
  venue: "장소·주차",
  // 공유 버튼을 뺐으므로 "문의·공유" 가 아니다 — 이 탭은 문의 창구(향후 리뷰 게시판)다.
  contact: "문의",
};

/** 공백만 있는 문자열은 "없음"으로 본다. */
export function hasText(value: string | null | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * 프로그램·일정 탭 — 이벤트 일정(event_schedules)이 있거나 프로그램 안내 문구가 있을 때만.
 * 둘 다 없으면 탭을 만들지 않는다(빈 목록만 보이는 탭 방지).
 */
export function hasProgramTab(input: PublicEventTabInput): boolean {
  // ✅ 2026-08-02 — 렌더 블록을 먼저 넣고 조건을 넓혔다(위 주석이 못박은 순서).
  //    `page.tsx` program 패널이 `programNotes`·`stageInfo` 를 각각 그린다.
  //    ⚠️ 여기를 넓힐 때는 **반드시 그 패널의 렌더 블록을 먼저 확인**할 것 —
  //       조건만 넓히면 빈 탭이 된다. `program-tab-fields.test.ts` 가 둘의 짝을 지킨다.
  //    ⚠️ `stageInfo` 는 원래 venue 탭 후보였는데(무대·구역), 일정·프로그램과 같은
  //       화면에서 읽히는 편이 자연스러워 program 으로 뒀다. venue 탭 조건은 안 건드린다.
  return (
    (input.scheduleCount ?? 0) > 0 || hasText(input.programNotes) || hasText(input.stageInfo)
  );
}

/**
 * 장소·주차 안내 탭.
 *  - 주최자가 showVenueMap 을 껐으면 무조건 미노출(기존 동작 보존).
 *  - 주소/대중교통/주차 중 하나라도 있어야 노출.
 *
 * ★ **이 조건은 venue 패널이 실제로 렌더하는 블록과 1:1 이어야 한다.** 넓히면 빈 탭이 생긴다.
 *   지금 패널이 그리는 것은 `VenueMap` 뿐이고, `VenueMap` 은 주소·교통·주차 셋 다 없으면
 *   null 을 낸다(`venue-map.tsx`). 그래서 조건도 정확히 그 셋이다.
 *   `venue-map.test.ts` 가 이 함수를 직접 호출해 두 판정이 어긋나지 않는지 지킨다.
 *
 * 🔴 2026-07-28 자체검수: 원래 여기 두 조건이 더 있었는데 **둘 다 패널에 렌더 블록이 없었다**.
 *   · `isOnline === true` → 무조건 노출. "온라인은 안내 문구가 있으므로"라고 썼지만
 *     **온라인 안내 블록이 존재하지 않는다** ⟹ 주소·교통·주차가 빈 온라인 이벤트는 빈 탭.
 *   · `stageInfo` → 무대·구역 안내. 이 필드는 아직 v2 read 응답에 실리지도, 패널에서
 *     렌더되지도 않는다(호출부가 전달조차 안 함) ⟹ 나중에 필드를 배선하는 순간 판정만
 *     켜져 빈 탭이 재발하는 구조였다.
 *   ⟹ 둘 다 제거. **렌더가 생길 때 조건을 함께 넣는다** — 그 반대 순서는 항상 빈 탭을 만든다.
 */
export function hasVenueTab(input: PublicEventTabInput): boolean {
  if (input.showVenueMap === false) return false;
  return (
    hasText(input.venueAddress) || hasText(input.transportInfo) || hasText(input.parkingInfo)
  );
}

/**
 * 노출할 탭 목록(표시 순서 고정).
 *  - intro/contact 는 항상 — 일시·장소 정보 카드와 문의 폼·공유 버튼은 데이터와 무관하게 늘 렌더된다.
 *  - program/venue 는 내용이 있을 때만.
 */
export function resolveEventTabs(input: PublicEventTabInput): PublicEventTab[] {
  const ids: PublicEventTabId[] = ["intro"];
  if (hasProgramTab(input)) ids.push("program");
  if (hasVenueTab(input)) ids.push("venue");
  ids.push("contact");
  return ids.map((id) => ({ id, label: TAB_LABELS[id] }));
}

/** 태그 개수·길이 상한(주최자 입력 폭주·레이아웃 붕괴 방지). */
export const MAX_EVENT_TAGS = 20;
export const MAX_EVENT_TAG_LENGTH = 20;

function normalizeTag(raw: string): string {
  // 공백 정리 → 선행 '#'(표기 습관) 제거 → 다시 공백 정리 → 길이 컷.
  return raw.trim().replace(/^#+/, "").trim().slice(0, MAX_EVENT_TAG_LENGTH);
}

/** 후보 문자열들 → 정규화·중복제거·상한 적용된 태그 배열. */
function collectTags(candidates: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const candidate of candidates) {
    const tag = normalizeTag(candidate);
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
    if (out.length >= MAX_EVENT_TAGS) break;
  }
  return out;
}

/**
 * events.tags(JSON 배열 문자열) → 문자열 배열.
 * v2 events.tags 와 동일 표현을 쓰되, 쉼표 문자열이 들어와 있어도 흡수한다.
 * 파싱 불가/빈 값이면 빈 배열(= 태그 섹션 미노출).
 */
export function parseEventTags(raw: string | null | undefined): string[] {
  if (!hasText(raw)) return [];
  const text = (raw as string).trim();
  try {
    const parsed: unknown = JSON.parse(text);
    // JSON 으로 읽혔는데 배열이 아니면 태그 목록이 아니다(객체/숫자 등) → 빈 배열.
    // 쉼표 폴백으로 넘기면 '{"a":1}' 같은 원문이 태그로 둔갑한다.
    return Array.isArray(parsed)
      ? collectTags(parsed.filter((t): t is string => typeof t === "string"))
      : [];
  } catch {
    // JSON 이 아니면 쉼표 구분 폴백.
    return collectTags(text.split(","));
  }
}

/**
 * 주최자 입력(쉼표 구분) → 저장용 태그 배열.
 * 빈 값·중복·'#' 접두는 정리하고 상한을 적용한다. 결과가 비면 빈 배열(= 태그 삭제 의도).
 */
export function normalizeEventTagsInput(raw: string | null | undefined): string[] {
  if (!hasText(raw)) return [];
  return collectTags((raw as string).split(","));
}
