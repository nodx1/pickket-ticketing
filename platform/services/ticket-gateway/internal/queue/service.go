package queue

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"

	"github.com/pickket/ticket-gateway/internal/middleware"
	"time"

	"github.com/go-chi/chi/v5"
	redisclient "github.com/pickket/ticket-gateway/internal/redis"
	goredis "github.com/redis/go-redis/v9"
)

// ACTIVATE_BATCH_LUA — identical logic to the Python backend.
// Moves users from waiting queue (sorted set) to active set.
// KEYS[1] = waiting queue sorted set key
// KEYS[2] = active set key
// ARGV[1] = batch size
// ARGV[2] = current timestamp (for active set score)
var activateBatchLua = goredis.NewScript(`
local waiting_key = KEYS[1]
local active_key = KEYS[2]
local batch_size = tonumber(ARGV[1])
local now = tonumber(ARGV[2])

local members = redis.call('ZRANGEBYSCORE', waiting_key, '-inf', '+inf', 'LIMIT', 0, batch_size)
if #members == 0 then
	return 0
end

for i, member in ipairs(members) do
	redis.call('ZREM', waiting_key, member)
	redis.call('ZADD', active_key, now, member)
end

return #members
`)

type Service struct {
	redis *redisclient.Client
}

func NewService(redis *redisclient.Client) *Service {
	return &Service{redis: redis}
}

func waitingKey(eventID string) string {
	return fmt.Sprintf("queue:{%s}:waiting", eventID)
}

func activeKey(eventID string) string {
	return fmt.Sprintf("queue:{%s}:active", eventID)
}

// JoinQueue adds a user to the waiting queue with current timestamp as score.
func (s *Service) JoinQueue(ctx context.Context, eventID, userID string) (int64, error) {
	key := waitingKey(eventID)
	now := float64(time.Now().UnixMilli())

	added, err := s.redis.Underlying().ZAddNX(ctx, key, goredis.Z{
		Score:  now,
		Member: userID,
	}).Result()
	if err != nil {
		return -1, fmt.Errorf("queue join error: %w", err)
	}

	if added == 0 {
		// User already in queue, return current position
		return s.GetPosition(ctx, eventID, userID)
	}

	return s.GetPosition(ctx, eventID, userID)
}

// GetPosition returns 0-based position in the waiting queue, or -1 if not found.
func (s *Service) GetPosition(ctx context.Context, eventID, userID string) (int64, error) {
	key := waitingKey(eventID)
	rank, err := s.redis.Underlying().ZRank(ctx, key, userID).Result()
	if err == goredis.Nil {
		return -1, nil
	}
	if err != nil {
		return -1, fmt.Errorf("queue position error: %w", err)
	}
	return rank, nil
}

// IsActive checks if a user is in the active set.
func (s *Service) IsActive(ctx context.Context, eventID, userID string) (bool, error) {
	key := activeKey(eventID)
	_, err := s.redis.Underlying().ZScore(ctx, key, userID).Result()
	if err == goredis.Nil {
		return false, nil
	}
	if err != nil {
		return false, fmt.Errorf("active check error: %w", err)
	}
	return true, nil
}

type QueueStatus struct {
	Status   string `json:"status"`
	Position int64  `json:"position"`
	EventID  string `json:"event_id"`
	UserID   string `json:"user_id"`
}

// GetStatus returns the user's queue status: "active", "waiting", or "not_in_queue".
func (s *Service) GetStatus(ctx context.Context, eventID, userID string) (*QueueStatus, error) {
	active, err := s.IsActive(ctx, eventID, userID)
	if err != nil {
		return nil, err
	}
	if active {
		return &QueueStatus{
			Status:   "active",
			Position: 0,
			EventID:  eventID,
			UserID:   userID,
		}, nil
	}

	pos, err := s.GetPosition(ctx, eventID, userID)
	if err != nil {
		return nil, err
	}
	if pos >= 0 {
		return &QueueStatus{
			Status:   "waiting",
			Position: pos,
			EventID:  eventID,
			UserID:   userID,
		}, nil
	}

	return &QueueStatus{
		Status:   "not_in_queue",
		Position: -1,
		EventID:  eventID,
		UserID:   userID,
	}, nil
}

// ActivateBatch moves a batch of users from waiting to active using the Lua script.
func (s *Service) ActivateBatch(ctx context.Context, eventID string, batchSize int) (int64, error) {
	wKey := waitingKey(eventID)
	aKey := activeKey(eventID)
	now := time.Now().UnixMilli()

	result, err := activateBatchLua.Run(ctx, s.redis.Underlying(), []string{wKey, aKey}, batchSize, now).Int64()
	if err != nil {
		return 0, fmt.Errorf("activate batch error: %w", err)
	}
	return result, nil
}

// --- HTTP Handlers ---

func (s *Service) HandleJoinQueue(w http.ResponseWriter, r *http.Request) {
	eventID := chi.URLParam(r, "eventId")
	userID, ok := middleware.UserIDFromContext(r.Context())
	if !ok || userID == "" {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	position, err := s.JoinQueue(r.Context(), eventID, userID)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":   "queued",
		"position": position,
		"event_id": eventID,
		"user_id":  userID,
	})
}

func (s *Service) HandleGetStatus(w http.ResponseWriter, r *http.Request) {
	eventID := chi.URLParam(r, "eventId")
	userID, ok := middleware.UserIDFromContext(r.Context())
	if !ok || userID == "" {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	status, err := s.GetStatus(r.Context(), eventID, userID)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}
