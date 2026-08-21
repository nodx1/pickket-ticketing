/**
 * 트랙 2.13 — 무대 시야 기반 quality_score 자동 계산
 *
 * 빌더가 좌석과 무대 랜드마크 위치를 주면 각 좌석에 대해
 * - 무대까지 거리 (가까울수록 1.0)
 * - 무대 정면 ±30도 각도 보너스 (+0.1)
 * - is_obstructed 좌석 패널티 (-0.3)
 * 을 적용해 0~1 사이의 점수를 반환한다.
 */

export interface PositionedSeat {
  id: string;
  x: number;
  y: number;
  isObstructed?: boolean;
}

export interface StageRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface QualityResult {
  id: string;
  qualityScore: number;
}

export function calculateSeatQuality(
  seats: PositionedSeat[],
  stage: StageRect,
): QualityResult[] {
  if (seats.length === 0) return [];

  const stageCenterX = stage.x + stage.width / 2;
  const stageCenterY = stage.y + stage.height / 2;

  // 거리 계산
  const distances = seats.map((s) => {
    const dx = s.x - stageCenterX;
    const dy = s.y - stageCenterY;
    return Math.sqrt(dx * dx + dy * dy);
  });
  const minD = Math.min(...distances);
  const maxD = Math.max(...distances);
  const range = Math.max(1, maxD - minD);

  return seats.map((s, idx) => {
    // 정규화 거리 점수 (가까울수록 1.0)
    const distanceScore = 1 - (distances[idx] - minD) / range;

    // 무대 정면 각도 보너스 (무대에서 아래쪽 시야각 ±30도 가정)
    const dx = s.x - stageCenterX;
    const dy = s.y - stageCenterY;
    let angleBonus = 0;
    if (dy > 0) {
      // 좌석이 무대 아래쪽 (정면)
      const angle = Math.atan2(Math.abs(dx), dy); // 0=정중앙, ±pi/2=측면
      if (angle < Math.PI / 6) angleBonus = 0.1; // ±30도 이내
    }

    // is_obstructed 패널티
    const obstructedPenalty = s.isObstructed ? -0.3 : 0;

    const raw = distanceScore + angleBonus + obstructedPenalty;
    const clamped = Math.max(0, Math.min(1, raw));
    return {
      id: s.id,
      qualityScore: Math.round(clamped * 100) / 100,
    };
  });
}
