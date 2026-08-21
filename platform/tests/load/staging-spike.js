import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const latency = new Trend('request_latency');

export const options = {
  scenarios: {
    spike: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '10s', target: 2000 },
        { duration: '3m', target: 2000 },
        { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    errors: ['rate<0.10'],
  },
};

const BASE_URL = __ENV.BASE_URL || 'https://pickket-stg-alb-963299864.ap-northeast-2.elb.amazonaws.com';
const HEADERS = {
  'Host': 'api-staging.pickket.kr',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept-Language': 'ko-KR,ko;q=0.9',
  'Accept': 'application/json',
};

export default function () {
  const res = http.get(`${BASE_URL}/api/v1/events/featured`, { headers: HEADERS });

  latency.add(res.timings.duration);
  errorRate.add(res.status >= 500);

  check(res, {
    'not 5xx': (r) => r.status < 500,
  });

  sleep(0.2 + Math.random() * 0.3);
}
