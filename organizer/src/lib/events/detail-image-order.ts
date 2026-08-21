import {
  DETAIL_SECTION_MAX,
  resolveDetailSection,
  type DetailSection,
} from "@/lib/public/detail-image";

/**
 * 상세 안내 이미지의 **섹션별 편집** 순수 로직.
 *
 * 저장 형태는 여전히 **평평한 배열** 하나다(`homepage_design.detailImages`).
 * 화면만 섹션별로 묶으므로, "그룹 안에서 한 칸 이동" 을 평평한 배열 위에서 계산해야 한다.
 *
 * 🔴 왜 순수 함수로 빼는가
 * 컴포넌트 안에 두면 테스트가 닿지 못한다(검증 원칙 #3 — 서버/클라이언트 컴포넌트 인라인
 * 로직은 뮤테이션을 걸어도 전건 통과한다). 실제로 종전 `move()` 는 **전체 배열**을 스왑해서
 * 섹션 경계를 넘으면 화면은 그대로인데 dirty 만 켜지는 결함이 있었고, 그것을 잡는 검사가
 * 하나도 없었다.
 */

export interface SectionedImage {
  url: string;
  caption?: string;
  section?: DetailSection;
}

/** 그 섹션에 속한 항목들의 **평평한 배열 인덱스** — 화면 순서와 저장 순서를 잇는다. */
export function indicesOfSection(
  items: readonly SectionedImage[],
  section: DetailSection,
): number[] {
  const out: number[] = [];
  items.forEach((item, index) => {
    if (resolveDetailSection(item.section) === section) out.push(index);
  });
  return out;
}

/** 그 섹션의 사용 장수. */
export function countInSection(
  items: readonly SectionedImage[],
  section: DetailSection,
): number {
  return indicesOfSection(items, section).length;
}

/** 그 섹션에 더 넣을 수 있는 장수. 0 이면 추가 버튼을 감춘다. */
export function remainingSlots(
  items: readonly SectionedImage[],
  section: DetailSection,
): number {
  return Math.max(0, DETAIL_SECTION_MAX[section] - countInSection(items, section));
}

/**
 * **같은 섹션 안에서만** 한 칸 이동한다.
 *
 * 🔴 종전 구현은 `[next[i], next[j]] = [next[j], next[i]]` 로 **전체 배열**을 스왑했다.
 *    intro 이미지를 아래로 내려 transport 이미지와 자리를 바꿔도 둘은 서로 다른 섹션에
 *    렌더되므로 **랜딩 화면은 아무 변화가 없는데** dirty 가 켜졌다.
 *
 * @returns 이동한 새 배열. **이동할 자리가 없으면 `null`** — 호출측이 dirty 를 켜지 않게.
 */
export function moveWithinSection(
  items: readonly SectionedImage[],
  index: number,
  dir: -1 | 1,
): SectionedImage[] | null {
  const target = items[index];
  if (!target) return null;

  const section = resolveDetailSection(target.section);
  const siblings = indicesOfSection(items, section);
  const at = siblings.indexOf(index);
  if (at === -1) return null;

  const swapWith = siblings[at + dir];
  if (swapWith === undefined) return null; // 그룹의 처음/끝 — 넘어갈 곳이 없다

  const next = [...items];
  [next[index], next[swapWith]] = [next[swapWith], next[index]];
  return next;
}

/**
 * 업로드분을 **그 섹션으로** 넣는다.
 *
 * 🔴 종전에는 업로드가 무조건 `section: "intro"` 였다. 그래서 주최자가 약도를 올려도
 *    드롭다운을 손대지 않으면 전부 「이벤트 안내」로 갔다 — KLPGA 실데이터가 그 상태였다
 *    (2장 모두 `이벤트 안내`). 섹션 지정 기능이 **기본값 때문에 사실상 안 쓰였다.**
 *
 * 지금은 "어느 그룹의 추가 버튼을 눌렀는지" 가 곧 섹션이다. 기본값이라는 개념이 없다.
 *
 * @returns 그 섹션의 잔여 슬롯만큼만 받은 새 배열 + 넘쳐서 버린 장수.
 */
export function appendToSection(
  items: readonly SectionedImage[],
  section: DetailSection,
  uploaded: readonly Omit<SectionedImage, "section">[],
): { next: SectionedImage[]; accepted: number; dropped: number } {
  const slots = remainingSlots(items, section);
  const accepted = uploaded.slice(0, slots);
  return {
    next: [...items, ...accepted.map((u) => ({ ...u, section }))],
    accepted: accepted.length,
    dropped: uploaded.length - accepted.length,
  };
}
