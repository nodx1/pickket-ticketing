/**
 * Pickket Edge Guard — Cloudflare Worker
 * First line of defense: bot detection, rate limiting, Turnstile verification
 */

interface Env {
  RATE_LIMITS: KVNamespace;
  RATE_LIMIT_PURCHASE: string;
  RATE_LIMIT_GENERAL: string;
  TURNSTILE_SECRET?: string;
}

interface RateLimitEntry {
  count: number;
  resetAt: number;
}

// Purchase-related paths that need strict rate limiting
const PURCHASE_PATHS = ["/purchase", "/queue/join", "/seats/hold"];

// Paths exempt from rate limiting (saves KV quota)
const RATE_LIMIT_EXEMPT_PATHS = [
  "/health",
  "/queue/health",
  "/favicon.ico",
  "/_next/",
];

// Paths that should bypass edge guard entirely (pass through to origin as-is)
const PASSTHROUGH_PATHS = ["/ws/"];

function isPurchasePath(path: string): boolean {
  return PURCHASE_PATHS.some((p) => path.includes(p));
}

function getClientIP(request: Request): string {
  return (
    request.headers.get("CF-Connecting-IP") ||
    request.headers.get("X-Forwarded-For")?.split(",")[0]?.trim() ||
    "unknown"
  );
}

function getBotScore(request: Request): number {
  /**
   * Simple bot scoring based on request characteristics.
   * Returns 0-100 (higher = more likely bot)
   */
  let score = 0;
  const ua = request.headers.get("User-Agent") || "";

  // No user agent
  if (!ua) score += 40;

  // Known bot patterns
  const botPatterns = [
    /bot/i,
    /crawler/i,
    /spider/i,
    /scraper/i,
    /headless/i,
    /phantom/i,
    /selenium/i,
    /puppeteer/i,
    /python-requests/i,
    /axios/i,
    /curl/i,
    /wget/i,
  ];
  if (botPatterns.some((p) => p.test(ua))) score += 50;

  // Missing common headers
  if (!request.headers.get("Accept-Language")) score += 15;
  if (!request.headers.get("Accept")) score += 10;
  if (!request.headers.get("Sec-Fetch-Mode")) score += 10;

  // Cloudflare bot score (if available from Bot Management)
  const cfBotScore = request.headers.get("Cf-Bot-Score");
  if (cfBotScore) {
    const cfScore = parseInt(cfBotScore, 10);
    if (cfScore < 30) score += 30; // CF thinks it's likely a bot
  }

  return Math.min(100, score);
}

async function checkRateLimit(
  kv: KVNamespace,
  key: string,
  limit: number,
  windowSeconds: number = 60,
): Promise<{ allowed: boolean; remaining: number; retryAfter: number }> {
  try {
    const now = Date.now();
    const kvKey = `rl:${key}`;

    const stored = await kv.get<RateLimitEntry>(kvKey, "json");

    if (!stored || stored.resetAt < now) {
      // New window
      await kv.put(
        kvKey,
        JSON.stringify({ count: 1, resetAt: now + windowSeconds * 1000 }),
        {
          expirationTtl: windowSeconds + 10,
        },
      );
      return { allowed: true, remaining: limit - 1, retryAfter: 0 };
    }

    if (stored.count >= limit) {
      const retryAfter = Math.ceil((stored.resetAt - now) / 1000);
      return { allowed: false, remaining: 0, retryAfter };
    }

    stored.count++;
    await kv.put(kvKey, JSON.stringify(stored), {
      expirationTtl: Math.ceil((stored.resetAt - now) / 1000) + 10,
    });

    return { allowed: true, remaining: limit - stored.count, retryAfter: 0 };
  } catch {
    // Fail open: if KV is unavailable (quota exceeded, etc.), allow the request
    return { allowed: true, remaining: limit, retryAfter: 0 };
  }
}

async function verifyTurnstile(
  token: string,
  secret: string,
  ip: string,
): Promise<boolean> {
  try {
    const response = await fetch(
      "https://challenges.cloudflare.com/turnstile/v0/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          secret,
          response: token,
          remoteip: ip,
        }),
      },
    );
    const result = await response.json<{ success: boolean }>();
    return result.success;
  } catch {
    return false; // Fail open or closed depending on policy
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      const url = new URL(request.url);
      const path = url.pathname;
      const ip = getClientIP(request);
      const isPurchase = isPurchasePath(path);

      // 0. WebSocket and passthrough paths — skip all checks, forward directly
      const isPassthrough = PASSTHROUGH_PATHS.some((p) => path.startsWith(p));
      if (isPassthrough || request.headers.get("Upgrade") === "websocket") {
        return fetch(request);
      }

      // 1. Bot detection
      const botScore = getBotScore(request);
      if (botScore >= 70) {
        return new Response(
          JSON.stringify({ error: "blocked", reason: "bot_detected" }),
          {
            status: 403,
            headers: { "Content-Type": "application/json" },
          },
        );
      }

      // 2. Rate limiting (skip for exempt paths to save KV quota)
      const isExempt = RATE_LIMIT_EXEMPT_PATHS.some((p) => path.startsWith(p));
      let rl = { allowed: true, remaining: -1, retryAfter: 0 };

      if (!isExempt) {
        const limit = isPurchase
          ? parseInt(env.RATE_LIMIT_PURCHASE, 10)
          : parseInt(env.RATE_LIMIT_GENERAL, 10);

        const rateLimitKey = isPurchase ? `purchase:${ip}` : `general:${ip}`;
        rl = await checkRateLimit(env.RATE_LIMITS, rateLimitKey, limit);

        if (!rl.allowed) {
          return new Response(
            JSON.stringify({
              error: "rate_limited",
              retry_after: rl.retryAfter,
            }),
            {
              status: 429,
              headers: {
                "Content-Type": "application/json",
                "Retry-After": String(rl.retryAfter),
                "X-RateLimit-Remaining": "0",
              },
            },
          );
        }
      }

      // 3. Turnstile CAPTCHA verification (purchase paths only)
      if (isPurchase && request.method === "POST" && env.TURNSTILE_SECRET) {
        const turnstileToken = request.headers.get("X-Turnstile-Token");
        if (turnstileToken) {
          const valid = await verifyTurnstile(
            turnstileToken,
            env.TURNSTILE_SECRET,
            ip,
          );
          if (!valid) {
            return new Response(JSON.stringify({ error: "captcha_failed" }), {
              status: 403,
              headers: { "Content-Type": "application/json" },
            });
          }
        }
      }

      // 4. Add security headers and pass through
      const response = await fetch(request);
      const newResponse = new Response(response.body, response);

      newResponse.headers.set("X-Bot-Score", String(botScore));
      newResponse.headers.set("X-RateLimit-Remaining", String(rl.remaining));

      return newResponse;
    } catch (err) {
      // Fail open: if Worker crashes, pass request through to origin
      console.error("Edge guard error:", err);
      return fetch(request);
    }
  },
};
