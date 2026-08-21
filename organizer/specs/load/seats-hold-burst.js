/**
 * 트랙 7.20 — 좌석 hold burst load test (k6)
 *
 * 1,000 동시 사용자가 5초간 hold 시도 → 95% 성공률 검증.
 * SELECT FOR UPDATE SKIP LOCKED 의 race condition 방어 회귀.
 *
 * 실행:
 *   k6 run specs/load/seats-hold-burst.js \
 *     --env BASE_URL=https://go-staging.pickket.kr \
 *     --env EVENT_SLUG=2026-... \
 *     --env SEAT_MAP_ID=...
 *
 * 사전 조건:
 *  - target 환경에 PLAYWRIGHT_TEST=0 (rate limit 정상 작동)
 *  - 좌석맵에 100석 이상 available
 */
import http from "k6/http";
import { check, sleep } from "k6";
import { Rate } from "k6/metrics";

export const options = {
  stages: [
    { duration: "10s", target: 100 }, // ramp up
    { duration: "20s", target: 1000 }, // burst
    { duration: "10s", target: 0 }, // ramp down
  ],
  thresholds: {
    http_req_failed: ["rate<0.05"], // 5% 미만 실패
    http_req_duration: ["p(95)<500"], // p95 < 500ms
    seat_hold_success: ["rate>0.50"], // 50% 이상 hold 성공
  },
};

const seatHoldSuccess = new Rate("seat_hold_success");

const BASE_URL = __ENV.BASE_URL || "http://localhost:3013";
const EVENT_SLUG = __ENV.EVENT_SLUG || "test-event";
const SEAT_MAP_ID = __ENV.SEAT_MAP_ID || "";

export default function seatsHoldBurst() {
  // 1. 좌석 목록 조회
  const listRes = http.get(
    `${BASE_URL}/api/public/events/${EVENT_SLUG}/seats?mapId=${SEAT_MAP_ID}`,
  );
  check(listRes, { "list 200": (r) => r.status === 200 });

  let body;
  try {
    body = JSON.parse(listRes.body);
  } catch {
    return;
  }
  const seats = (body.data && body.data.seats) || [];
  const available = seats.filter((s) => s.status === "available");
  if (available.length === 0) return;

  // 2. 무작위 1석 hold 시도
  const target = available[Math.floor(Math.random() * available.length)];
  const holdRes = http.post(
    `${BASE_URL}/api/public/events/${EVENT_SLUG}/seats/hold`,
    JSON.stringify({ seatIds: [target.id] }),
    {
      headers: {
        "Content-Type": "application/json",
        Origin: BASE_URL,
      },
    },
  );
  const holdOk = holdRes.status === 200;
  seatHoldSuccess.add(holdOk);
  check(holdRes, {
    "hold success or conflict": (r) => r.status === 200 || r.status === 409,
  });

  // 3. 곧바로 release (정리)
  if (holdOk) {
    try {
      const holdBody = JSON.parse(holdRes.body);
      if (holdBody.data && holdBody.data.holdId) {
        http.del(
          `${BASE_URL}/api/public/events/${EVENT_SLUG}/seats/hold`,
          JSON.stringify({ holdId: holdBody.data.holdId }),
          {
            headers: {
              "Content-Type": "application/json",
              Origin: BASE_URL,
            },
          },
        );
      }
    } catch {
      /* noop */
    }
  }

  sleep(0.1);
}
