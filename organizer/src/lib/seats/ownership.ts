/**
 * 좌석맵 소유권 검증 helper (IDOR 방어 공통)
 *
 * 관리자 라우트가 mapId 만 받고 account_id 로 격리해 INSERT/SELECT 하면
 * 다른 계정의 mapId 를 넘겨도 빈 결과가 나올 뿐이라 IDOR 위험은 낮지만,
 * INSERT 시 데이터 무결성이 깨지거나 mapId 존재 여부가 leak 될 수 있다.
 *
 * 본 helper 는 mapId 가 (eventId, accountId) 조합에 속하는지 미리 검증해
 * 잘못된 호출은 즉시 404 로 차단한다.
 */
import { getOwnedEvent } from "@/lib/v2/event-access";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: string | undefined | null): boolean {
  if (!value) return false;
  return UUID_RE.test(value);
}

/**
 * @deprecated 레벨2 컷오버 T1 — go `seat_maps` SELECT 를 제거하고 v2 판정으로 위임한다.
 * 남은 호출부 호환용 별칭일 뿐이며 신규 코드는 `verifySeatMapOwnershipV2` 를 직접 쓴다.
 */
export async function verifySeatMapOwnership(
  eventId: string,
  mapId: string,
  accountId: string,
): Promise<boolean> {
  return verifySeatMapOwnershipV2(eventId, mapId, accountId);
}

/**
 * 레벨2 3차 3.1 — go seat_maps 미read 소유권 검증.
 *  (1) eventId 가 세션 계정 소유 이벤트.
 *  (2) mapId 가 v2 events.seat_map_data.maps[] 에 존재(v2 SoT).
 * 미소유/미존재/맵 부재는 false. v2 응답불가는 **false 로 뭉개지 않고 throw** 한다 —
 * "확인 불가"를 "없음"으로도 "허용"으로도 바꾸지 않기 위해서다(호출부가 503 으로 통지).
 *
 * 레벨2 T2-EVT — go `events` 소유 SELECT 제거. **테넌트 경계는 유지된다**: 옛
 * `AND account_id = $2` 가 v2 `organizer_ref` 로 이관돼 v2 가 강제한다(불일치/미존재 → 404 → null).
 * 상세를 그대로 돌려받으므로 v2 왕복이 2회(앵커조회+getEvent)에서 1회로 준다.
 * ⚠️ 에러 타입 변화: v2 5xx/네트워크 실패는 V2CommerceError 가 아니라
 *    `EventAccessError(reason="unavailable", status=502)` 로 던져진다(호출부 catch 갱신 필요).
 */
export async function verifySeatMapOwnershipV2(
  eventId: string,
  mapId: string,
  accountId: string,
): Promise<boolean> {
  if (!isUuid(eventId) || !isUuid(mapId)) return false;
  const detail = await getOwnedEvent(eventId, accountId);
  if (!detail) return false; // 없거나 내 계정 소유가 아님
  const maps = detail.content?.seat_map_data?.maps ?? [];
  return maps.some((m) => m.id === mapId);
}
