import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const latency = new Trend('request_latency');

export const options = {
  scenarios: {
    sustained: {
      executor: 'constant-vus',
      vus: 80,
      duration: '30m',
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<1000', 'p(99)<2000'],
    errors: ['rate<0.01'],
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
  const endpoints = [
    '/health',
    '/api/v1/events/featured',
    '/api/v1/events/trending',
  ];

  const endpoint = endpoints[Math.floor(Math.random() * endpoints.length)];
  const res = http.get(`${BASE_URL}${endpoint}`, { headers: HEADERS });

  latency.add(res.timings.duration);
  errorRate.add(res.status >= 500);

  check(res, {
    'status ok': (r) => r.status < 500,
    'latency < 1s': (r) => r.timings.duration < 1000,
  });

  sleep(0.5 + Math.random() * 1.5);
}
