import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const e2eLatency = new Trend('cart_e2e_latency');

export const options = {
  scenarios: {
    cart_flow: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '2m', target: 200 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    cart_e2e_latency: ['p(95)<500'],
    http_req_failed: ['rate<0.05'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8030';

export default function () {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer test-token-${__VU}`,
    'X-Device-Hash': `device-${__VU}`,
  };

  const start = Date.now();

  // Step 1: Reserve
  const reserveRes = http.post(`${BASE_URL}/api/v1/cart/reserve`, JSON.stringify({
    event_id: 'test-event-001',
    tier_id: 'tier-001',
    quantity: 1,
  }), { headers });

  check(reserveRes, { 'reserve 201': (r) => r.status === 201 });

  if (reserveRes.status !== 201) {
    return; // Sold out or rate limited
  }

  sleep(0.5);

  // Step 2: Status check
  const statusRes = http.get(`${BASE_URL}/api/v1/cart/status`, { headers });
  check(statusRes, { 'status 200': (r) => r.status === 200 });

  sleep(0.5);

  // Step 3: Confirm
  const confirmRes = http.post(`${BASE_URL}/api/v1/cart/confirm`, JSON.stringify({
    payment_method: 'card',
  }), { headers });

  check(confirmRes, { 'confirm 200': (r) => r.status === 200 });

  e2eLatency.add(Date.now() - start);

  sleep(1);
}
