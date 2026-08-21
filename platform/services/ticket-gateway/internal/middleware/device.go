package middleware

import (
	"fmt"
	"net/http"
	"time"

	redisclient "github.com/pickket/ticket-gateway/internal/redis"
	goredis "github.com/redis/go-redis/v9"
)

const (
	deviceHashHeader = "X-Device-Hash"
	deviceBindingTTL = 24 * time.Hour
)

// Lua script: bind device to user if not already bound to a different user.
// Returns: 1 if OK (new binding or same user), 0 if bound to different user.
var deviceBindLua = goredis.NewScript(`
local key = KEYS[1]
local user_id = ARGV[1]
local ttl = tonumber(ARGV[2])

local current = redis.call('GET', key)
if current == false then
	redis.call('SET', key, user_id, 'EX', ttl)
	return 1
elseif current == user_id then
	redis.call('EXPIRE', key, ttl)
	return 1
else
	return 0
end
`)

// DeviceBinding is middleware that enforces one-device-per-user binding
// via the X-Device-Hash header. The device hash is stored in Redis and
// mapped to a user_id. If a device is already bound to a different user,
// the request is rejected with 403.
func DeviceBinding(client *redisclient.Client) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			deviceHash := r.Header.Get(deviceHashHeader)
			if deviceHash == "" {
				// No device hash header — allow through (mobile apps may not send it initially)
				next.ServeHTTP(w, r)
				return
			}

			userID, ok := r.Context().Value(userIDKey).(string)
			if !ok || userID == "" {
				// No authenticated user — skip device binding check
				next.ServeHTTP(w, r)
				return
			}

			key := fmt.Sprintf("device:{%s}", deviceHash)
			ttlSeconds := int(deviceBindingTTL.Seconds())

			result, err := deviceBindLua.Run(r.Context(), client.Underlying(), []string{key}, userID, ttlSeconds).Int64()
			if err != nil {
				// On Redis error, fail-open
				next.ServeHTTP(w, r)
				return
			}

			if result == 0 {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusForbidden)
				fmt.Fprint(w, `{"error":"device_bound_to_another_user","message":"This device is already associated with a different account"}`)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
