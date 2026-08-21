package redis

import (
	"context"
	"fmt"
	"time"

	"github.com/google/uuid"
	goredis "github.com/redis/go-redis/v9"
)

const (
	defaultLockTTL   = 10 * time.Second
	defaultRetryWait = 50 * time.Millisecond
	maxRetries       = 20
)

// Lua script: release lock only if the value matches (owner check)
var releaseLuaScript = goredis.NewScript(`
if redis.call("GET", KEYS[1]) == ARGV[1] then
	return redis.call("DEL", KEYS[1])
else
	return 0
end
`)

// Lua script: renew lock TTL only if the value matches
var renewLuaScript = goredis.NewScript(`
if redis.call("GET", KEYS[1]) == ARGV[1] then
	return redis.call("PEXPIRE", KEYS[1], ARGV[2])
else
	return 0
end
`)

type DistributedLock struct {
	client *Client
	key    string
	value  string
	ttl    time.Duration
}

// AcquireLock attempts to acquire a distributed lock. Returns nil if failed.
// Key format matches Python backend: lock:{key}
// For cluster mode, the caller should use hash tags in the key, e.g. {event_id}:resource
func AcquireLock(ctx context.Context, client *Client, key string, ttl time.Duration) (*DistributedLock, error) {
	if ttl == 0 {
		ttl = defaultLockTTL
	}
	lockKey := fmt.Sprintf("lock:{%s}", key)
	value := uuid.NewString()

	for i := 0; i < maxRetries; i++ {
		ok, err := client.Underlying().SetNX(ctx, lockKey, value, ttl).Result()
		if err != nil {
			return nil, fmt.Errorf("redis setnx error: %w", err)
		}
		if ok {
			return &DistributedLock{
				client: client,
				key:    lockKey,
				value:  value,
				ttl:    ttl,
			}, nil
		}
		time.Sleep(defaultRetryWait)
	}
	return nil, fmt.Errorf("failed to acquire lock after %d retries: %s", maxRetries, lockKey)
}

// Release releases the distributed lock if still owned.
func (l *DistributedLock) Release(ctx context.Context) error {
	result, err := releaseLuaScript.Run(ctx, l.client.Underlying(), []string{l.key}, l.value).Int64()
	if err != nil {
		return fmt.Errorf("lock release error: %w", err)
	}
	if result == 0 {
		return fmt.Errorf("lock already expired or owned by another process: %s", l.key)
	}
	return nil
}

// Renew extends the lock TTL if still owned.
func (l *DistributedLock) Renew(ctx context.Context) error {
	ms := l.ttl.Milliseconds()
	result, err := renewLuaScript.Run(ctx, l.client.Underlying(), []string{l.key}, l.value, ms).Int64()
	if err != nil {
		return fmt.Errorf("lock renew error: %w", err)
	}
	if result == 0 {
		return fmt.Errorf("lock already expired or owned by another process: %s", l.key)
	}
	return nil
}
