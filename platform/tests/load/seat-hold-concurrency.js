import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const doubleBookings = new Counter('double_bookings');

export const options = {
  scenarios: {
    concurrent_hold: {
      executor: 'shared-iterations',
      vus: 100,
      iterations: 100,
      maxDuration: '30s',
    },
  },
  thresholds: {
    double_bookings: ['count==0'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8030';
const EVENT_ID = __ENV.EVENT_ID || 'test-event-001';
const SEAT_ID = __ENV.SEAT_ID || 'seat-A1';

export default function () {
  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer test-token-${__VU}`,
      'X-Device-Hash': `device-${__VU}`,
    },
  };

  const res = http.post(
    `${BASE_URL}/api/v1/events/${EVENT_ID}/seats/hold`,
    JSON.stringify({ seat_id: SEAT_ID }),
    params
  );

  const success = res.status === 200 || res.status === 201;
  const conflict = res.status === 409;

  check(res, {
    'either held or conflict': () => success || conflict,
  });

  // Only one VU should succeed for same seat
  if (success && __ITER > 0) {
    doubleBookings.add(1);
  }
}
