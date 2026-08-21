import http from 'k6/http';
import { check } from 'k6';
import { Counter } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'https://api-staging.pickket.kr';
const EVENT_ID = __ENV.EVENT_ID || '';
const TIER_ID = __ENV.TIER_ID || '';
const EXPECTED_MAX_SUCCESS = Number(__ENV.EXPECTED_MAX_SUCCESS || '1');
const AUTH_TOKENS = (__ENV.AUTH_TOKENS || '')
  .split(',')
  .map((token) => token.trim())
  .filter(Boolean);

export const fcfsPurchaseSuccesses = new Counter('fcfs_purchase_successes');
export const unexpectedResponses = new Counter('unexpected_responses');

export const options = {
  scenarios: {
    single_tier_contention: {
      executor: 'shared-iterations',
      vus: Number(__ENV.VUS || '100'),
      iterations: Number(__ENV.ITERATIONS || '100'),
      maxDuration: __ENV.MAX_DURATION || '45s',
    },
  },
  thresholds: {
    fcfs_purchase_successes: [`count<=${EXPECTED_MAX_SUCCESS}`],
    unexpected_responses: ['count==0'],
  },
};

function getAuthToken() {
  if (AUTH_TOKENS.length === 0) {
    return __ENV.AUTH_TOKEN || '';
  }
  return AUTH_TOKENS[(__VU - 1) % AUTH_TOKENS.length];
}

function buildHeaders() {
  const token = getAuthToken();
  const headers = {
    'Content-Type': 'application/json',
    'X-Device-Hash': `k6-device-${__VU}`,
  };

  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }

  return headers;
}

function buildPayload() {
  return JSON.stringify({
    quantity: 1,
    idempotency_key: `k6-fcfs-${__VU}-${__ITER}`,
  });
}

export default function () {
  if (!EVENT_ID || !TIER_ID) {
    throw new Error('EVENT_ID and TIER_ID are required');
  }

  const res = http.post(
    `${BASE_URL}/api/v1/events/${EVENT_ID}/tiers/${TIER_ID}/purchase`,
    buildPayload(),
    { headers: buildHeaders() },
  );

  let success = false;

  if (res.status === 201) {
    try {
      const body = JSON.parse(res.body || '{}');
      success = body.success === true;
    } catch {
      unexpectedResponses.add(1);
    }
  } else if (![403, 409, 429].includes(res.status)) {
    unexpectedResponses.add(1);
  }

  check(res, {
    'returns purchase success or expected rejection': () =>
      res.status === 201 || res.status === 403 || res.status === 409 || res.status === 429,
  });

  if (success) {
    fcfsPurchaseSuccesses.add(1);
  }
}
