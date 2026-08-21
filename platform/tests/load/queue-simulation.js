import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend } from 'k6/metrics';

const queueWait = new Trend('queue_wait_time');

export const options = {
  scenarios: {
    mass_queue: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 1000 },
        { duration: '3m', target: 5000 },
        { duration: '2m', target: 10000 },
        { duration: '1m', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(99)<2000'],
    http_req_failed: ['rate<0.01'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'http://localhost:8030';
const EVENT_ID = __ENV.EVENT_ID || 'test-event-001';

export default function () {
  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer test-token-${__VU}`,
  };

  // Join queue
  const joinRes = http.post(`${BASE_URL}/api/v1/events/${EVENT_ID}/queue/join`, '{}', { headers });
  check(joinRes, { 'joined queue': (r) => r.status === 200 || r.status === 201 });

  const start = Date.now();

  // Poll status until activated or timeout
  for (let i = 0; i < 30; i++) {
    sleep(2);
    const statusRes = http.get(`${BASE_URL}/api/v1/events/${EVENT_ID}/queue/status`, { headers });
    check(statusRes, { 'status ok': (r) => r.status === 200 });

    try {
      const body = JSON.parse(statusRes.body);
      if (body.status === 'ACTIVE') {
        queueWait.add(Date.now() - start);
        return;
      }
    } catch (e) {}
  }

  queueWait.add(Date.now() - start);
}
