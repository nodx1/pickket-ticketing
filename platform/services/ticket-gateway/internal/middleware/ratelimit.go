package middleware

import (
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	redisclient "github.com/pickket/ticket-gateway/internal/redis"
	goredis "github.com/redis/go-redis/v9"
)

// Lua script for sliding window rate limiting.
// Returns: [current_count, ttl_ms]
var rateLimitLua = goredis.NewScript(`
local key = KEYS[1]
local limit = tonumber(ARGV[1])
local window = tonumber(ARGV[2])
local now = tonumber(ARGV[3])

-- Remove expired entries
redis.call('ZREMRANGEBYSCORE', key, 0, now - window)

local current = redis.call('ZCARD', key)
if current >= limit then
	local ttl = redis.call('PTTL', key)
	return {current, ttl}
end

redis.call('ZADD', key, now, now .. ':' .. math.random(1000000))
redis.call('PEXPIRE', key, window)
current = current + 1
return {current, 0}
`)

// RateLimit creates a rate limiting middleware.
// limit: max requests per window.
// window: time window duration.
// prefix: key prefix to distinguish different rate limit buckets.
func RateLimit(client *redisclient.Client, limit int, window time.Duration, prefix string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Extract user ID from context (set by auth middleware)
			userID, ok := r.Context().Value(userIDKey).(string)
			if !ok || userID == "" {
				// If no user ID, fall back to IP-based limiting
				userID = extractIP(r)
			}

			key := fmt.Sprintf("ratelimit:{%s}:%s:%s", prefix, userID, prefix)
			now := time.Now().UnixMilli()
			windowMs := window.Milliseconds()

			result, err := rateLimitLua.Run(r.Context(), client.Underlying(), []string{key}, limit, windowMs, now).Int64Slice()
			if err != nil {
				// On Redis error, allow the request through (fail-open)
				next.ServeHTTP(w, r)
				return
			}

			current := result[0]
			w.Header().Set("X-RateLimit-Limit", strconv.Itoa(limit))
			w.Header().Set("X-RateLimit-Remaining", strconv.FormatInt(int64(limit)-current, 10))

			if current > int64(limit) {
				ttlMs := result[1]
				retryAfter := (ttlMs / 1000) + 1
				if retryAfter < 1 {
					retryAfter = 1
				}
				w.Header().Set("Retry-After", strconv.FormatInt(retryAfter, 10))
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusTooManyRequests)
				fmt.Fprintf(w, `{"error":"rate_limit_exceeded","retry_after":%d,"limit":%d}`, retryAfter, limit)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}

// PurchaseRateLimit returns a middleware that limits purchase requests to 10/min.
func PurchaseRateLimit(client *redisclient.Client) func(http.Handler) http.Handler {
	return RateLimit(client, 10, time.Minute, "purchase")
}

// GeneralRateLimit returns a middleware that limits general requests to 100/min.
func GeneralRateLimit(client *redisclient.Client) func(http.Handler) http.Handler {
	return RateLimit(client, 100, time.Minute, "general")
}

func extractIP(r *http.Request) string {
	// Check X-Forwarded-For first (behind load balancer)
	xff := r.Header.Get("X-Forwarded-For")
	if xff != "" {
		parts := strings.SplitN(xff, ",", 2)
		return strings.TrimSpace(parts[0])
	}
	// Check X-Real-IP
	xri := r.Header.Get("X-Real-IP")
	if xri != "" {
		return xri
	}
	// Fall back to RemoteAddr
	parts := strings.SplitN(r.RemoteAddr, ":", 2)
	return parts[0]
}
