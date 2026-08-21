/**
 * Pickket v2 — 구매 피크 부하 테스트 (k6)
 *
 * 시나리오:
 *   1. ramp_up   — 티켓 오픈 순간: 0→500 VU (30s), 유지 2분, 램프다운
 *   2. spike     — 급격한 트래픽 스파이크: 0→1000 VU (10s), 유지 30s
 *   3. sustained — 정상 상태 지속 부하: 200 VU, 5분
 *
 * 실행 예시:
 *   K6_API_BASE=http://localhost:8021/api/v1 \
 *   K6_EVENT_ID=<uuid> K6_TIER_ID=<uuid> \
 *   ./k6 run backend/tests/load/k6-purchase-peak.js \
 *     --scenario ramp_up
 */

import http from "k6/http";
import { check, group, sleep } from "k6";
import { Counter, Trend, Rate } from "k6/metrics";
import { SharedArray } from "k6/data";
import { uuidv4 } from "https://jslib.k6.io/k6-utils/1.4.0/index.js";
import { textSummary } from "https://jslib.k6.io/k6-summary/0.1.0/index.js";

// ---------------------------------------------------------------------------
// Custom Metrics
// ---------------------------------------------------------------------------
var purchaseSuccess = new Counter("purchase_success");
var purchaseFail = new Counter("purchase_fail");
var queueWaitTime = new Trend("queue_wait_time", true); // in ms
var purchaseRate = new Rate("purchase_success_rate");

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
var API_BASE = __ENV.K6_API_BASE || "http://localhost:8021/api/v1";
var EVENT_ID = __ENV.K6_EVENT_ID || ""; // optional — auto-discovered if empty
var TIER_ID = __ENV.K6_TIER_ID || ""; // optional — auto-discovered if empty
var TOTAL_USERS = 1000;

// Pre-generate test user list (shared across VUs, loaded once)
var testUsers = new SharedArray("users", function () {
  var users = [];
  for (var i = 1; i <= TOTAL_USERS; i++) {
    var padded = String(i).padStart(4, "0");
    users.push({
      email: "testuser" + padded + "@seedtest.pickket.kr",
      password: "PickketTest2026!",
    });
  }
  return users;
});

// ---------------------------------------------------------------------------
// Thresholds & Scenarios
// ---------------------------------------------------------------------------
export var options = {
  thresholds: {
    http_req_duration: ["p(95)<2000"],
    http_req_failed: ["rate<0.05"],
    purchase_success_rate: ["rate>0.5"], // at least 50% purchases succeed
    queue_wait_time: ["p(95)<30000"], // queue wait p95 < 30s
  },

  scenarios: {
    ramp_up: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "30s", target: 500 },
        { duration: "2m", target: 500 },
        { duration: "30s", target: 0 },
      ],
      exec: "purchaseFlow",
      tags: { scenario: "ramp_up" },
    },
    spike: {
      executor: "ramping-vus",
      startVUs: 0,
      stages: [
        { duration: "10s", target: 1000 },
        { duration: "30s", target: 1000 },
        { duration: "10s", target: 0 },
      ],
      exec: "purchaseFlow",
      tags: { scenario: "spike" },
    },
    sustained: {
      executor: "constant-vus",
      vus: 200,
      duration: "5m",
      exec: "purchaseFlow",
      tags: { scenario: "sustained" },
    },
  },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------
function randomThink(minSec, maxSec) {
  if (minSec === undefined) minSec = 0.5;
  if (maxSec === undefined) maxSec = 2.0;
  var t = minSec + Math.random() * (maxSec - minSec);
  sleep(t);
}

function makeParams(token, tag) {
  var params = {
    headers: {
      "Content-Type": "application/json",
    },
    tags: { name: tag },
  };
  if (token) {
    params.headers["Authorization"] = "Bearer " + token;
  }
  return params;
}

// ---------------------------------------------------------------------------
// Step 1: Login
// ---------------------------------------------------------------------------
function doLogin(user) {
  var url = API_BASE + "/auth/login";
  var payload = JSON.stringify({
    email: user.email,
    password: user.password,
  });

  var res = http.post(url, payload, makeParams(null, "POST /auth/login"));

  var ok = check(res, {
    "login status 200": function (r) { return r.status === 200; },
    "login has access_token": function (r) {
      try {
        return !!JSON.parse(r.body).access_token;
      } catch (e) {
        return false;
      }
    },
  });

  if (!ok) {
    console.warn(
      "Login failed for " + user.email + ": status=" + res.status + " body=" + res.body
    );
    return null;
  }

  return JSON.parse(res.body).access_token;
}

// ---------------------------------------------------------------------------
// Step 2: Discover purchasable event + tier
// ---------------------------------------------------------------------------
function discoverEventAndTier(token) {
  // If both are provided via env, skip discovery
  if (EVENT_ID && TIER_ID) {
    return { eventId: EVENT_ID, tierId: TIER_ID };
  }

  // Fetch events
  var eventsRes = http.get(API_BASE + "/events/", makeParams(token, "GET /events/"));

  check(eventsRes, {
    "events status 200": function (r) { return r.status === 200; },
  });

  if (eventsRes.status !== 200) {
    return null;
  }

  var events;
  try {
    var parsed = JSON.parse(eventsRes.body);
    events = Array.isArray(parsed) ? parsed : (parsed.events || parsed.data || []);
  } catch (e) {
    console.warn("Failed to parse events response");
    return null;
  }

  if (events.length === 0) {
    console.warn("No events found");
    return null;
  }

  // Use provided EVENT_ID or pick a random event
  var eventId = EVENT_ID || events[Math.floor(Math.random() * events.length)].id;

  // Fetch tiers for the event
  var tiersRes = http.get(
    API_BASE + "/events/" + eventId + "/tiers",
    makeParams(token, "GET /events/{id}/tiers")
  );

  check(tiersRes, {
    "tiers status 200": function (r) { return r.status === 200; },
  });

  if (tiersRes.status !== 200) {
    return null;
  }

  var tiers;
  try {
    var parsedTiers = JSON.parse(tiersRes.body);
    tiers = Array.isArray(parsedTiers) ? parsedTiers : (parsedTiers.data || []);
  } catch (e) {
    console.warn("Failed to parse tiers response");
    return null;
  }

  // Pick a tier with remaining tickets, or fallback to first
  var available = tiers.filter(function (t) { return t.remaining > 0; });
  var tier = available.length > 0
    ? available[Math.floor(Math.random() * available.length)]
    : tiers[0];

  if (!tier) {
    console.warn("No tiers found for event " + eventId);
    return null;
  }

  return { eventId: eventId, tierId: TIER_ID || tier.id };
}

// ---------------------------------------------------------------------------
// Step 3: Join Queue
// ---------------------------------------------------------------------------
function joinQueue(token, eventId) {
  var url = API_BASE + "/events/" + eventId + "/queue/join";
  var res = http.post(url, null, makeParams(token, "POST /events/{id}/queue/join"));

  check(res, {
    "queue join status 2xx": function (r) { return r.status >= 200 && r.status < 300; },
  });

  return res.status >= 200 && res.status < 300;
}

// ---------------------------------------------------------------------------
// Step 4: Poll Queue Status (wait for turn)
// ---------------------------------------------------------------------------
function pollQueueStatus(token, eventId) {
  var url = API_BASE + "/events/" + eventId + "/queue/status";
  var maxPolls = 30;
  var pollInterval = 1; // seconds
  var startTime = Date.now();

  for (var i = 0; i < maxPolls; i++) {
    var res = http.get(url, makeParams(token, "GET /events/{id}/queue/status"));

    check(res, {
      "queue status 2xx": function (r) { return r.status >= 200 && r.status < 300; },
    });

    if (res.status >= 200 && res.status < 300) {
      try {
        var body = JSON.parse(res.body);
        // Consider ready if status says so, or if position is 0/1, or can_purchase
        var isReady =
          body.status === "ready" ||
          body.status === "READY" ||
          body.can_purchase === true ||
          body.position === 0 ||
          body.position === 1;

        if (isReady) {
          queueWaitTime.add(Date.now() - startTime);
          return true;
        }
      } catch (e) {
        // If body cannot be parsed, assume queue is not blocking
        queueWaitTime.add(Date.now() - startTime);
        return true;
      }
    }

    // 404 or 422 might mean queue is not enabled — proceed
    if (res.status === 404 || res.status === 422) {
      queueWaitTime.add(Date.now() - startTime);
      return true;
    }

    sleep(pollInterval);
  }

  // Timed out waiting for queue
  queueWaitTime.add(Date.now() - startTime);
  console.warn("Queue poll timeout for event " + eventId + " after " + maxPolls + " polls");
  return false;
}

// ---------------------------------------------------------------------------
// Step 5: Attempt Purchase
// ---------------------------------------------------------------------------
function attemptPurchase(token, eventId, tierId) {
  var url = API_BASE + "/events/" + eventId + "/tiers/" + tierId + "/purchase";
  var payload = JSON.stringify({
    quantity: 1,
    idempotency_key: uuidv4(),
  });

  var res = http.post(url, payload, makeParams(token, "POST /events/{id}/tiers/{id}/purchase"));

  var success = check(res, {
    "purchase status 2xx": function (r) { return r.status >= 200 && r.status < 300; },
  });

  if (success) {
    purchaseSuccess.add(1);
    purchaseRate.add(true);
  } else {
    purchaseFail.add(1);
    purchaseRate.add(false);
    if (res.status !== 409 && res.status !== 422 && res.status !== 429) {
      // Log unexpected errors (skip conflict/validation/rate-limit)
      console.warn(
        "Purchase failed: status=" + res.status + " body=" + res.body
      );
    }
  }

  return success;
}

// ---------------------------------------------------------------------------
// Main VU Flow (exported, referenced by all scenarios)
// ---------------------------------------------------------------------------
export function purchaseFlow() {
  // Assign each VU a deterministic user based on VU id
  var userIndex = (__VU - 1) % testUsers.length;
  var user = testUsers[userIndex];

  group("1_login", function () {
    var token = doLogin(user);
    if (!token) {
      purchaseFail.add(1);
      purchaseRate.add(false);
      return; // cannot continue without token
    }

    randomThink();

    group("2_discover", function () {
      var target = discoverEventAndTier(token);
      if (!target) {
        purchaseFail.add(1);
        purchaseRate.add(false);
        return;
      }

      randomThink(0.5, 1.5);

      group("3_queue_join", function () {
        var joined = joinQueue(token, target.eventId);
        if (!joined) {
          // Queue join failed — might be optional, still try purchase
          console.info("Queue join returned non-2xx, proceeding to purchase anyway");
        }

        randomThink(0.3, 1.0);

        group("4_queue_poll", function () {
          pollQueueStatus(token, target.eventId);

          randomThink(0.5, 1.5);

          group("5_purchase", function () {
            attemptPurchase(token, target.eventId, target.tierId);
          });
        });
      });
    });
  });

  // Cooldown between iterations
  randomThink(1.0, 3.0);
}

// ---------------------------------------------------------------------------
// Summary handler — console output
// ---------------------------------------------------------------------------
export function handleSummary(data) {
  var purchaseOk = data.metrics.purchase_success
    ? data.metrics.purchase_success.values.count
    : 0;
  var purchaseNg = data.metrics.purchase_fail
    ? data.metrics.purchase_fail.values.count
    : 0;
  var total = purchaseOk + purchaseNg;
  var successPct = total > 0 ? ((purchaseOk / total) * 100).toFixed(1) : "N/A";

  var p95 = data.metrics.http_req_duration
    ? data.metrics.http_req_duration.values["p(95)"].toFixed(1)
    : "N/A";
  var failRate = data.metrics.http_req_failed
    ? (data.metrics.http_req_failed.values.rate * 100).toFixed(2)
    : "N/A";

  var queueP95 = data.metrics.queue_wait_time
    ? data.metrics.queue_wait_time.values["p(95)"].toFixed(0)
    : "N/A";

  var summary =
    "\n" +
    "================================================================================\n" +
    "  PICKKET 구매 피크 부하 테스트 결과\n" +
    "================================================================================\n" +
    "\n" +
    "  구매 성공:          " + purchaseOk + "\n" +
    "  구매 실패:          " + purchaseNg + "\n" +
    "  구매 성공률:        " + successPct + "%\n" +
    "\n" +
    "  HTTP 요청 p95:      " + p95 + " ms\n" +
    "  HTTP 실패율:        " + failRate + "%\n" +
    "  대기열 대기 p95:    " + queueP95 + " ms\n" +
    "\n" +
    "================================================================================\n";

  return {
    stdout: summary + "\n" + textSummary(data, { indent: "  ", enableColors: true }),
  };
}
