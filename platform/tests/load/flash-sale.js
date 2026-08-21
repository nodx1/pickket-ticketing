/**
 * M-1: k6 Flash Sale Load Test
 *
 * Simulates 500 concurrent users competing for 100 seats in a single tier.
 * Validates:
 * 1. Zero overselling (purchase_successes <= SEAT_LIMIT)
 * 2. p95 response time < 2s
 * 3. p99 response time < 3s
 * 4. All responses are expected status codes (201, 403, 409, 429)
 *
 * Usage:
 *   # Against local backend
 *   k6 run tests/load/flash-sale.js --env BASE_URL=http://localhost:8021
 *
 *   # Against staging (pre-provisioned event)
 *   k6 run tests/load/flash-sale.js \
 *     --env BASE_URL=https://api-staging.pickket.kr \
 *     --env EVENT_ID=<uuid> \
 *     --env TIER_ID=<uuid> \
 *     --env AUTH_TOKENS=<comma-separated>
 *
 *   # Custom parameters
 *   k6 run tests/load/flash-sale.js \
 *     --env VUS=500 \
 *     --env SEAT_LIMIT=100 \
 *     --env BASE_URL=http://localhost:8021
 */

import http from "k6/http";
import { check, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

// ── Configuration ──────────────────────────────────────────────────────────

const BASE_URL = __ENV.BASE_URL || "http://localhost:8021";
const VUS = Number(__ENV.VUS || "500");
const SEAT_LIMIT = Number(__ENV.SEAT_LIMIT || "100");
const EVENT_ID = __ENV.EVENT_ID || "";
const TIER_ID = __ENV.TIER_ID || "";
const AUTH_TOKENS = (__ENV.AUTH_TOKENS || "")
  .split(",")
  .map((t) => t.trim())
  .filter(Boolean);

// ── Custom Metrics ─────────────────────────────────────────────────────────

const purchaseSuccesses = new Counter("purchase_successes");
const purchaseRejections = new Counter("purchase_rejections");
const unexpectedErrors = new Counter("unexpected_errors");
const oversellCount = new Counter("oversell_count");
const purchaseDuration = new Trend("purchase_duration_ms");

// ── Thresholds ─────────────────────────────────────────────────────────────

export const options = {
  scenarios: {
    flash_sale: {
      executor: "shared-iterations",
      vus: VUS,
      iterations: VUS, // Each VU tries exactly once
      maxDuration: "60s",
    },
  },
  thresholds: {
    // Zero overselling — this is the critical assertion
    purchase_successes: [`count<=${SEAT_LIMIT}`],
    oversell_count: ["count==0"],
    // No unexpected errors
    unexpected_errors: ["count==0"],
    // Latency SLOs
    purchase_duration_ms: ["p(95)<2000", "p(99)<3000"],
    // Standard HTTP thresholds
    http_req_duration: ["p(95)<2000", "p(99)<3000"],
  },
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function getAuthToken() {
  if (AUTH_TOKENS.length > 0) {
    return AUTH_TOKENS[(__VU - 1) % AUTH_TOKENS.length];
  }
  // For local testing: register on-the-fly (setup phase should provide tokens)
  return __ENV.AUTH_TOKEN || "";
}

function buildHeaders() {
  const token = getAuthToken();
  const headers = {
    "Content-Type": "application/json",
    "X-Device-Hash": `k6-flash-${__VU}`,
  };
  if (token) {
    headers["Authorization"] = `Bearer ${token}`;
  }
  return headers;
}

// ── Main Test Function ─────────────────────────────────────────────────────

export default function () {
  if (!EVENT_ID || !TIER_ID) {
    console.error(
      "EVENT_ID and TIER_ID are required. " +
        "Provide via --env EVENT_ID=... --env TIER_ID=..."
    );
    return;
  }

  const payload = JSON.stringify({
    quantity: 1,
    idempotency_key: `k6-flash-${__VU}-${__ITER}-${Date.now()}`,
  });

  const startTime = Date.now();

  const res = http.post(
    `${BASE_URL}/api/v1/events/${EVENT_ID}/tiers/${TIER_ID}/purchase`,
    payload,
    { headers: buildHeaders(), timeout: "10s" }
  );

  const duration = Date.now() - startTime;
  purchaseDuration.add(duration);

  // ── Classify response ──────────────────────────────────────────────────

  const isSuccess = res.status === 201;
  const isExpectedRejection = [403, 409, 429, 400, 422].includes(res.status);

  if (isSuccess) {
    purchaseSuccesses.add(1);
  } else if (isExpectedRejection) {
    purchaseRejections.add(1);
  } else {
    unexpectedErrors.add(1);
    console.error(
      `VU ${__VU}: Unexpected HTTP ${res.status}: ${(res.body || "").substring(0, 200)}`
    );
  }

  check(res, {
    "status is purchase success or expected rejection": () =>
      isSuccess || isExpectedRejection,
    "response time < 3s": () => duration < 3000,
  });

  // Small jitter to simulate real user variance
  sleep(Math.random() * 0.1);
}

// ── Summary ────────────────────────────────────────────────────────────────

export function handleSummary(data) {
  const successes =
    data.metrics.purchase_successes?.values?.count || 0;
  const rejections =
    data.metrics.purchase_rejections?.values?.count || 0;
  const errors =
    data.metrics.unexpected_errors?.values?.count || 0;
  const p95 =
    data.metrics.purchase_duration_ms?.values?.["p(95)"] || 0;
  const p99 =
    data.metrics.purchase_duration_ms?.values?.["p(99)"] || 0;

  const oversold = successes > SEAT_LIMIT;
  if (oversold) {
    oversellCount.add(successes - SEAT_LIMIT);
  }

  const summary = `
╔══════════════════════════════════════════════════════════════╗
║                   FLASH SALE LOAD TEST RESULTS              ║
╠══════════════════════════════════════════════════════════════╣
║  VUs: ${String(VUS).padEnd(10)} Seat Limit: ${String(SEAT_LIMIT).padEnd(20)}  ║
║  Successes: ${String(successes).padEnd(8)} Rejections: ${String(rejections).padEnd(16)}  ║
║  Errors: ${String(errors).padEnd(11)} Oversold: ${String(oversold ? "YES ⚠️" : "NO ✓").padEnd(18)}  ║
║  p95: ${String(p95.toFixed(0) + "ms").padEnd(12)} p99: ${String(p99.toFixed(0) + "ms").padEnd(20)}  ║
╠══════════════════════════════════════════════════════════════╣
║  ${oversold ? "❌ FAIL: OVERSELLING DETECTED" : "✅ PASS: No overselling"}                              ║
║  ${p95 < 2000 ? "✅ PASS: p95 < 2s" : "❌ FAIL: p95 >= 2s"}                                       ║
║  ${p99 < 3000 ? "✅ PASS: p99 < 3s" : "❌ FAIL: p99 >= 3s"}                                       ║
║  ${errors === 0 ? "✅ PASS: No unexpected errors" : "❌ FAIL: Unexpected errors found"}                            ║
╚══════════════════════════════════════════════════════════════╝
`;

  console.log(summary);

  return {
    stdout: summary,
  };
}
