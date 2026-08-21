import http from 'k6/http';
import { check, sleep } from 'k6';
import { Rate, Trend } from 'k6/metrics';

const errorRate = new Rate('errors');
const featuredLatency = new Trend('featured_latency');
const trendingLatency = new Trend('trending_latency');
const healthLatency = new Trend('health_latency');

export const options = {
  scenarios: {
    baseline: {
      executor: 'ramping-vus',
      startVUs: 0,
      stages: [
        { duration: '30s', target: 20 },
        { duration: '1m', target: 50 },
        { duration: '1m', target: 100 },
        { duration: '30s', target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ['p(95)<1000', 'p(99)<2000'],
    errors: ['rate<0.05'],
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
  // Featured events
  const featured = http.get(`${BASE_URL}/api/v1/events/featured`, { headers: HEADERS });
  featuredLatency.add(featured.timings.duration);
  errorRate.add(featured.status >= 500);
  check(featured, {
    'featured 2xx': (r) => r.status < 400,
    'featured < 500ms': (r) => r.timings.duration < 500,
  });

  // Trending events
  const trending = http.get(`${BASE_URL}/api/v1/events/trending`, { headers: HEADERS });
  trendingLatency.add(trending.timings.duration);
  errorRate.add(trending.status >= 500);
  check(trending, {
    'trending 2xx': (r) => r.status < 400,
    'trending < 500ms': (r) => r.timings.duration < 500,
  });

  // Health check
  const health = http.get(`${BASE_URL}/health`, { headers: HEADERS });
  healthLatency.add(health.timings.duration);
  errorRate.add(health.status >= 500);
  check(health, {
    'health 2xx': (r) => r.status < 400,
  });

  sleep(0.5);
}
