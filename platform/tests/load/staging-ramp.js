import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend, Counter } from 'k6/metrics';

const errorRate = new Rate('errors');
const rateLimited = new Counter('rate_limited');
const featuredLatency = new Trend('featured_latency');
const trendingLatency = new Trend('trending_latency');
const healthLatency = new Trend('health_latency');

export const options = {
  scenarios: {
    ramp: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 50 },
        { duration: '1m', target: 200 },
        { duration: '1m', target: 500 },
        { duration: '30s', target: 500 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<3000', 'p(99)<5000'],
    errors: ['rate<0.05'],       // 5xx only
    rate_limited: ['count>=0'],  // informational
  },
};

// Direct ALB URL bypasses Cloudflare edge guard for pure backend perf testing
const BASE_URL = __ENV.BASE_URL || 'https://pickket-stg-alb-963299864.ap-northeast-2.elb.amazonaws.com';
const HEADERS = {
  'Host': 'api-staging.pickket.kr',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept-Language': 'ko-KR,ko;q=0.9',
  'Accept': 'application/json',
};

export default function () {
  // Health check (no rate limiting) — pure backend capacity
  const health = http.get(`${BASE_URL}/health`, { headers: HEADERS });
  healthLatency.add(health.timings.duration);
  errorRate.add(health.status >= 500);
  check(health, {
    'health ok': (r) => r.status === 200,
  });

  // API endpoints (rate limited at 200/min/IP — measures realistic throughput)
  const featured = http.get(`${BASE_URL}/api/v1/events/featured`, { headers: HEADERS });
  featuredLatency.add(featured.timings.duration);
  if (featured.status === 429) {
    rateLimited.add(1);
  } else {
    errorRate.add(featured.status >= 500);
  }
  check(featured, {
    'featured ok': (r) => r.status < 400,
  });

  const trending = http.get(`${BASE_URL}/api/v1/events/trending`, { headers: HEADERS });
  trendingLatency.add(trending.timings.duration);
  if (trending.status === 429) {
    rateLimited.add(1);
  } else {
    errorRate.add(trending.status >= 500);
  }
  check(trending, {
    'trending ok': (r) => r.status < 400,
  });

  sleep(0.3);
}
