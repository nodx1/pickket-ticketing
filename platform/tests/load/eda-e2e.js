import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const edaLatency = new Trend('eda_propagation');

export const options = {
  scenarios: {
    eda_flow: {
      executor: 'constant-vus',
      vus: 10,
      duration: '2m',
    },
  },
  thresholds: {
    eda_propagation: ['p(95)<5000'],
    http_req_failed: ['rate<0.05'],
  },
};

const GW_URL = __ENV.GW_URL || 'http://localhost:8030';
const API_URL = __ENV.API_URL || 'http://localhost:8021';
const EVENT_ID = __ENV.EVENT_ID || 'test-event-001';

export default function () {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer test-token-${__VU}`,
    'X-Device-Hash': `device-${__VU}-${__ITER}`,
  };

  const start = Date.now();

  // Step 1: Hold seat via Go gateway (Redis)
  const holdRes = http.post(`${GW_URL}/api/v1/events/${EVENT_ID}/seats/hold`,
    JSON.stringify({ seat_id: `seat-${__VU}-${__ITER}` }),
    { headers }
  );

  if (holdRes.status !== 200 && holdRes.status !== 201) {
    return;
  }

  // Step 2: Poll Python backend for order creation (SNS → SQS → Python)
  for (let i = 0; i < 25; i++) {
    sleep(0.2);
    const orderRes = http.get(`${API_URL}/api/v1/orders/latest`, { headers });

    if (orderRes.status === 200) {
      try {
        const body = JSON.parse(orderRes.body);
        if (body.status === 'HELD' || body.status === 'PENDING') {
          edaLatency.add(Date.now() - start);
          check(null, { 'EDA propagated': () => true });
          return;
        }
      } catch (e) {}
    }
  }

  // Timeout — EDA didn't propagate in 5s
  edaLatency.add(Date.now() - start);
  check(null, { 'EDA propagated': () => false });

  sleep(1);
}
