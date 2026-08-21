import { ORGANIZER_ROLE_LABELS, type OrganizerRole } from "@/lib/types";

/**
 * 공개 랜딩 주최자 표시 — **역할을 행으로 나눈다.**
 *
 * ## 🔴 왜 인라인 역할명을 버렸나 (2026-07-30 주최측 피드백)
 *
 * 종전 화면:
 *
 *     주최자                    ← 카드 라벨
 *     주최 비씨카드              ← 값이 역할명을 품고 있었다
 *
 * "주최" 가 두 번 나온다. 주최측 요청은 "주최자에 협회 추가 · **비씨카드 앞의 '주최' 삭제**".
 *
 * 처음엔 "역할이 한 종류면 이름만" 으로 하려 했는데 성립하지 않았다 —
 * **협회는 주최 겸 주관**이다(대표 확인). 그러면 역할이 섞인 케이스라 그 안에서는
 * `주최 A · 주관 B` 가 되어 요청과 **정반대**가 된다.
 *
 * ⟹ 역할명이 **라벨 역할**을 하도록 행으로 나눈다:
 *
 *     주최   비씨카드, 한경, KLPGA
 *     주관   KLPGA
 *
 * 중복이 사라지고 겸직도 정확히 표현된다.
 *
 * 판정을 순수 함수로 빼는 이유: 이 값은 서버 컴포넌트 안에서 만들어져 테스트가 닿지 못한다.
 * 이 프로젝트에서 반복된 실패 유형이다.
 */

/** 표시 순서 — 주최 → 주관 → 후원. 중요도 순이고 이 순서가 곧 화면 순서다. */
const ROLE_ORDER: OrganizerRole[] = ["host", "coordinator", "sponsor"];

export interface OrganizerLine {
  role: OrganizerRole;
  /** "주최" · "주관" · "후원" */
  label: string;
  /** 같은 역할의 이름들을 쉼표로 이은 것 */
  names: string;
}

interface RawOrganizer {
  role?: unknown;
  name?: unknown;
}

function isRole(value: unknown): value is OrganizerRole {
  return value === "host" || value === "coordinator" || value === "sponsor";
}

/**
 * 주최자 목록 → 역할별 표시 행.
 *
 * @param raw          `event.organizers` (v2 JSONB — 요소 구조가 보장되지 않는다)
 * @param fallbackName 목록이 비었을 때 쓸 단일 이름(`event.organizerName`)
 *
 * 🔴 목록이 비고 폴백도 없으면 **빈 배열**을 준다. 빈 카드를 그리면
 *    "주최자 없음" 처럼 보여 오히려 나쁘다 — 호출부가 렌더를 생략하게 한다.
 */
export function toOrganizerLines(raw: unknown, fallbackName?: unknown): OrganizerLine[] {
  const grouped = new Map<OrganizerRole, string[]>();

  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null) continue;
      const { role, name } = entry as RawOrganizer;
      if (!isRole(role)) continue;
      if (typeof name !== "string") continue;
      const trimmed = name.trim();
      if (trimmed === "") continue;

      const list = grouped.get(role) ?? [];
      // 같은 역할에 같은 이름이 두 번 들어오면 한 번만 — 데이터 중복이 화면에 새지 않게.
      if (!list.includes(trimmed)) list.push(trimmed);
      grouped.set(role, list);
    }
  }

  if (grouped.size > 0) {
    return ROLE_ORDER.filter((role) => (grouped.get(role)?.length ?? 0) > 0).map((role) => ({
      role,
      label: ORGANIZER_ROLE_LABELS[role],
      names: (grouped.get(role) ?? []).join(", "),
    }));
  }

  // 목록이 없으면 단일 주최자로 폴백(레거시 이벤트).
  if (typeof fallbackName === "string" && fallbackName.trim() !== "") {
    return [{ role: "host", label: ORGANIZER_ROLE_LABELS.host, names: fallbackName.trim() }];
  }

  return [];
}
