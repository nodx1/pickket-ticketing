/**
 * 회전 QR **선발급 캐시** 판정 — 순수 함수(서버·React 의존 0).
 *
 * ## 🔴 왜 꺼냈나
 * 컴포넌트 안에 두니 "미리 채운다" 는 의도가 **영영 발동하지 않는데도** 아무도 몰랐다.
 * 지난 창을 지우지 않아 캐시 크기가 계속 20 으로 보였고, `size <= 5` 조건이 참이 될 수
 * 없었다. 결과적으로 **캐시가 바닥난 순간에야** 서버를 불렀고, 그때 네트워크가 끊겨
 * 있으면 QR 이 죽는다 — 골프장 대비로 넣은 장치가 무력화된 상태였다.
 *
 * 화면으로는 "30초마다 QR 이 바뀐다" 로 똑같이 보여 구분이 안 된다.
 */

/** 30초 창. 서버 생성 규칙과 같아야 한다. */
export const WINDOW_SECONDS = 30;

/** 남은 창이 이 수 이하면 **미리** 더 받아둔다(끊기기 전에 확보). */
export const LOW_WATERMARK = 5;

export function windowOf(nowMs: number): number {
  return Math.floor(nowMs / (WINDOW_SECONDS * 1000));
}

/**
 * 지난 창을 버리고 **지금부터 쓸 수 있는 창 수**를 센다.
 *
 * 🔴 캐시 크기(`map.size`)를 쓰면 안 된다 — 지난 창이 쌓여 항상 가득 차 보인다.
 *    지금 창 이후만 세야 "얼마나 더 버틸 수 있나" 가 나온다.
 */
export function pruneAndCountUsable(cache: Map<number, string>, current: number): number {
  for (const k of [...cache.keys()]) {
    if (k < current) cache.delete(k);
  }
  return cache.size;
}

/** 남은 창이 부족한가 — 부족하면 아직 온라인일 때 미리 받아둔다. */
export function shouldRefill(usable: number, watermark: number = LOW_WATERMARK): boolean {
  return usable <= watermark;
}
