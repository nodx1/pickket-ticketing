import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const purchaseLatency = new Trend('purchase_latency');

export const options = {
  scenarios: {
    ramp_up: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 100 },
        { duration: '1m', target: 500 },
        { duration: '2m', target: 1000 },
        { duration: '1m', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<200', 'p(99)<500'],
    errors: ['rate<0.01'],
    purchase_latency: ['p(95)<300', 'p(99)<800'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8030';
const EVENT_ID = __ENV.EVENT_ID || 'test-event-001';

export default function () {
  // Simulate purchase attempt
  const payload = JSON.stringify({
    event_id: EVENT_ID,
    tier_id: 'tier-001',
    quantity: 1,
  });

  const params = {
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${__ENV.TOKEN || 'test-token'}`,
      'X-Device-Hash': `device-${__VU}`,
    },
  };

  const res = http.post(`${BASE_URL}/api/v1/events/${EVENT_ID}/tiers/tier-001/purchase`, payload, params);

  purchaseLatency.add(res.timings.duration);
  errorRate.add(res.status >= 500);

  check(res, {
    'status is 2xx or 409 (conflict/sold-out)': (r) => r.status < 500,
    'response time < 50ms': (r) => r.timings.duration < 50,
  });

  sleep(0.1);
}
