import { slugify } from "@/lib/slug";
import { listEventHosts } from "@/lib/v2/commerce-client";

/**
 * 주최자 slug 자동 생성.
 *
 * slug 는 공개 URL·조회키로 쓰이지 않는 내부 식별자(대시보드 표시조차 제거됨)이지만
 * 저장소가 `slug NOT NULL · UNIQUE(계정, slug)` 를 요구하므로 이름에서 파생해 채운다.
 * 사용자는 slug 를 입력하지 않는다. 계정 내 충돌 시 `-2`, `-3` … suffix.
 *
 * ## 레벨2 컷오버 W2-EVT
 * 조회 대상이 go `organizers` 테이블 → v2 `event_hosts`(계정 스코프 목록 1회 read)로 바뀌었다.
 * 옛 구현은 후보마다 SELECT 를 돌렸지만(최대 200 왕복), v2 는 목록을 한 번 받아 메모리에서
 * 판정한다(왕복 1회).
 *
 * ⚠️ 이 함수는 **경합에 대해 권위적이지 않다**(read-then-write). 최종 유일성은 v2 의
 *    UNIQUE(organizer_id, slug) 가 강제하며, 충돌 시 호출측이 409 를 받는다.
 *
 * @throws V2CommerceError v2 조회 실패 시 — 호출측이 503 으로 통지한다(임의 slug 로 밀어붙이면
 *   같은 이름의 주최자가 중복 생성된다).
 */
export async function generateOrganizerSlug(accountId: string, name: string): Promise<string> {
  const base = slugify(name) || "organizer";
  const { hosts } = await listEventHosts(accountId);
  const taken = new Set(hosts.map((h) => h.slug));

  let candidate = base;
  let n = 1;
  while (n < 200) {
    if (!taken.has(candidate)) return candidate;
    n += 1;
    candidate = `${base}-${n}`;
  }
  // 극단적 폴백(동일 이름 200개 이상) — 무한루프 방지.
  return `${base}-${Math.floor(Math.random() * 1_000_000)}`;
}
