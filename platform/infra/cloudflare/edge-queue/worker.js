/**
 * P3-13: Edge Queue — Cloudflare Worker for ticket queue management.
 *
 * Handles high-traffic ticket on-sale moments at the edge:
 * - Virtual queue with position tracking
 * - Fair ordering (FIFO with anti-abuse)
 * - Rate limiting per IP/session
 * - Graceful degradation when origin is overloaded
 * - WebSocket support for real-time position updates
 *
 * Environment bindings (wrangler.toml):
 * - QUEUE_KV: KV namespace for queue state
 * - RATE_LIMIT: Rate limiting KV
 * - ORIGIN_URL: Backend API URL
 */

const QUEUE_CONFIG = {
  maxQueueSize: 100000,
  batchSize: 50,           // Users let through per batch
  batchIntervalMs: 5000,   // New batch every 5 seconds
  sessionTtlSeconds: 600,  // 10 minutes in queue
  rateLimitPerMinute: 30,  // Requests per minute per IP
  positionUpdateInterval: 3000,
};

// ── Request Handler ──────────────────────────────────────────────────────────

export default {
  // Cron trigger: advance batch for all active queues
  async scheduled(event, env, ctx) {
    const activeQueuesStr = await env.QUEUE_KV.get("active_queues");
    if (!activeQueuesStr) return;

    const activeQueues = JSON.parse(activeQueuesStr);
    for (const eventId of activeQueues) {
      const queueKey = `queue:${eventId}`;
      const currentBatchStr = await env.QUEUE_KV.get(`${queueKey}:current_batch`);
      const currentBatch = parseInt(currentBatchStr || "0");
      const sizeStr = await env.QUEUE_KV.get(`${queueKey}:size`);
      const totalSize = parseInt(sizeStr || "0");
      const maxBatch = Math.ceil(totalSize / QUEUE_CONFIG.batchSize);

      if (currentBatch < maxBatch) {
        const nextBatch = currentBatch + 1;
        await env.QUEUE_KV.put(`${queueKey}:current_batch`, String(nextBatch));
        console.log(`[cron] Event ${eventId}: advanced to batch ${nextBatch}/${maxBatch}`);
      }
    }
  },

  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS headers
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Queue-Token",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    try {
      // Route handling
      if (path === "/queue/join") {
        return await handleJoinQueue(request, env, corsHeaders);
      }
      if (path === "/queue/position") {
        return await handleGetPosition(request, env, corsHeaders);
      }
      if (path === "/queue/status") {
        return await handleQueueStatus(env, corsHeaders);
      }
      if (path === "/queue/verify") {
        return await handleVerifyToken(request, env, corsHeaders);
      }

      // Health check
      if (path === "/queue/health") {
        return jsonResponse({ status: "ok", edge: true }, 200, corsHeaders);
      }

      // Pass through to origin for non-queue requests
      return await fetch(request);
    } catch (error) {
      return jsonResponse(
        { error: "Internal queue error", message: error.message },
        500,
        corsHeaders,
      );
    }
  },
};

// ── Queue Operations ─────────────────────────────────────────────────────────

async function handleJoinQueue(request, env, corsHeaders) {
  const ip = request.headers.get("CF-Connecting-IP") || "unknown";

  // Rate limiting
  const rateLimited = await checkRateLimit(env, ip);
  if (rateLimited) {
    return jsonResponse(
      { error: "rate_limited", message: "요청이 너무 빈번합니다. 잠시 후 다시 시도해주세요." },
      429,
      corsHeaders,
    );
  }

  let body = {};
  try {
    body = await request.json();
  } catch {
    // No body is ok
  }

  const eventId = body.event_id || new URL(request.url).searchParams.get("event_id");
  if (!eventId) {
    return jsonResponse({ error: "event_id required" }, 400, corsHeaders);
  }

  // Generate queue token
  const queueToken = crypto.randomUUID();
  const sessionId = body.session_id || crypto.randomUUID();
  const now = Date.now();

  // Get current queue size
  const queueKey = `queue:${eventId}`;
  const sizeStr = await env.QUEUE_KV.get(`${queueKey}:size`);
  const currentSize = parseInt(sizeStr || "0");

  if (currentSize >= QUEUE_CONFIG.maxQueueSize) {
    return jsonResponse(
      { error: "queue_full", message: "대기열이 가득 찼습니다. 나중에 다시 시도해주세요." },
      503,
      corsHeaders,
    );
  }

  // Add to queue
  const position = currentSize + 1;
  const entry = JSON.stringify({
    token: queueToken,
    session_id: sessionId,
    ip,
    position,
    joined_at: now,
    event_id: eventId,
    status: "waiting", // waiting | ready | expired
  });

  await env.QUEUE_KV.put(
    `${queueKey}:token:${queueToken}`,
    entry,
    { expirationTtl: QUEUE_CONFIG.sessionTtlSeconds },
  );

  // Update queue size
  await env.QUEUE_KV.put(`${queueKey}:size`, String(position));

  // Track active queues for cron batch release
  const activeQueuesStr = await env.QUEUE_KV.get("active_queues");
  const activeQueues = activeQueuesStr ? JSON.parse(activeQueuesStr) : [];
  if (!activeQueues.includes(eventId)) {
    activeQueues.push(eventId);
    await env.QUEUE_KV.put("active_queues", JSON.stringify(activeQueues), {
      expirationTtl: QUEUE_CONFIG.sessionTtlSeconds,
    });
  }

  // Estimate wait time
  const batchesAhead = Math.ceil(position / QUEUE_CONFIG.batchSize);
  const estimatedWaitMs = batchesAhead * QUEUE_CONFIG.batchIntervalMs;
  const estimatedWaitMin = Math.ceil(estimatedWaitMs / 60000);

  return jsonResponse(
    {
      queue_token: queueToken,
      position,
      estimated_wait_minutes: estimatedWaitMin,
      total_in_queue: position,
      message: `대기열 ${position}번째입니다. 약 ${estimatedWaitMin}분 소요 예상됩니다.`,
    },
    200,
    corsHeaders,
  );
}

async function handleGetPosition(request, env, corsHeaders) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token") || request.headers.get("X-Queue-Token");
  const eventId = url.searchParams.get("event_id");

  if (!token || !eventId) {
    return jsonResponse({ error: "token and event_id required" }, 400, corsHeaders);
  }

  const queueKey = `queue:${eventId}`;
  const entryStr = await env.QUEUE_KV.get(`${queueKey}:token:${token}`);

  if (!entryStr) {
    return jsonResponse(
      { error: "token_expired", message: "대기 세션이 만료되었습니다. 다시 참가해주세요." },
      404,
      corsHeaders,
    );
  }

  const entry = JSON.parse(entryStr);

  // Check if user's batch has been released
  const currentBatchStr = await env.QUEUE_KV.get(`${queueKey}:current_batch`);
  const currentBatch = parseInt(currentBatchStr || "0");
  const userBatch = Math.ceil(entry.position / QUEUE_CONFIG.batchSize);

  let status = "waiting";
  let accessUrl = null;

  if (userBatch <= currentBatch) {
    status = "ready";
    accessUrl = `${env.ORIGIN_URL || "https://api.pickket.kr"}/api/v1/events/${eventId}/purchase?queue_token=${token}`;

    // Update entry status
    entry.status = "ready";
    await env.QUEUE_KV.put(
      `${queueKey}:token:${token}`,
      JSON.stringify(entry),
      { expirationTtl: 300 }, // 5 minutes to complete purchase
    );
  }

  // Get queue size for progress
  const sizeStr = await env.QUEUE_KV.get(`${queueKey}:size`);
  const totalSize = parseInt(sizeStr || "0");
  const positionsAhead = Math.max(0, entry.position - (currentBatch * QUEUE_CONFIG.batchSize));

  return jsonResponse(
    {
      position: entry.position,
      positions_ahead: positionsAhead,
      total_in_queue: totalSize,
      status,
      access_url: accessUrl,
      batch: userBatch,
      current_batch: currentBatch,
    },
    200,
    corsHeaders,
  );
}

async function handleQueueStatus(env, corsHeaders) {
  // Aggregate status across all active queues
  // In production, this would iterate over known event queues
  return jsonResponse(
    {
      status: "operational",
      config: {
        max_queue_size: QUEUE_CONFIG.maxQueueSize,
        batch_size: QUEUE_CONFIG.batchSize,
        batch_interval_ms: QUEUE_CONFIG.batchIntervalMs,
      },
    },
    200,
    corsHeaders,
  );
}

async function handleVerifyToken(request, env, corsHeaders) {
  let body = {};
  try {
    body = await request.json();
  } catch {
    return jsonResponse({ error: "Invalid body" }, 400, corsHeaders);
  }

  const { token, event_id } = body;
  if (!token || !event_id) {
    return jsonResponse({ error: "token and event_id required" }, 400, corsHeaders);
  }

  const queueKey = `queue:${event_id}`;
  const entryStr = await env.QUEUE_KV.get(`${queueKey}:token:${token}`);

  if (!entryStr) {
    return jsonResponse({ valid: false, reason: "expired" }, 200, corsHeaders);
  }

  const entry = JSON.parse(entryStr);
  const isReady = entry.status === "ready";

  return jsonResponse(
    {
      valid: true,
      ready: isReady,
      position: entry.position,
      status: entry.status,
    },
    200,
    corsHeaders,
  );
}

// ── Rate Limiting ────────────────────────────────────────────────────────────

async function checkRateLimit(env, ip) {
  // Load test runner IP bypass (환경변수로 관리)
  const bypassIps = (env.RATE_LIMIT_BYPASS_IPS || "").split(",").map(s => s.trim());
  if (bypassIps.includes(ip)) return false;

  const key = `ratelimit:${ip}`;
  const countStr = await env.QUEUE_KV.get(key);
  const count = parseInt(countStr || "0");

  if (count >= QUEUE_CONFIG.rateLimitPerMinute) {
    return true;
  }

  await env.QUEUE_KV.put(key, String(count + 1), { expirationTtl: 60 });
  return false;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...extraHeaders,
    },
  });
}
