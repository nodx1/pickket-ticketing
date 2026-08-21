import { getPrefixedRedis } from "@/lib/redis";

const WINDOW_SECONDS = 300; // 5 minutes
const MAX_REQUESTS = 50;
const SUSPECT_THRESHOLD = 30;

interface BotScore {
  score: number;
  flags: string[];
  blocked: boolean;
}

export async function evaluateBotScore(
  ip: string,
  userAgent: string,
  headers: Record<string, string>,
): Promise<BotScore> {
  const flags: string[] = [];
  let score = 0;

  // 1. Rate check via Redis
  try {
    const redis = getPrefixedRedis();
    const key = `bot:rate:${ip}`;
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, WINDOW_SECONDS);

    if (count > MAX_REQUESTS) {
      score += 40;
      flags.push("rate_limit_exceeded");
    } else if (count > SUSPECT_THRESHOLD) {
      score += 20;
      flags.push("high_request_rate");
    }
  } catch {
    // Redis unavailable — skip rate check
  }

  // 2. User-Agent analysis
  if (!userAgent || userAgent.length < 10) {
    score += 25;
    flags.push("suspicious_user_agent");
  }
  const botPatterns = /bot|crawler|spider|scraper|headless|phantom|selenium|puppeteer/i;
  if (botPatterns.test(userAgent)) {
    score += 30;
    flags.push("known_bot_pattern");
  }

  // 3. Missing typical browser headers
  if (!headers["accept-language"]) {
    score += 10;
    flags.push("missing_accept_language");
  }
  if (!headers["accept"]) {
    score += 5;
    flags.push("missing_accept");
  }

  return {
    score: Math.min(100, score),
    flags,
    blocked: score >= 80,
  };
}

export async function recordFingerprint(ip: string, fingerprint: string): Promise<void> {
  try {
    const redis = getPrefixedRedis();
    const key = `bot:fp:${ip}`;
    await redis.sadd(key, fingerprint);
    await redis.expire(key, 3600); // 1 hour
  } catch {
    // Redis unavailable
  }
}
