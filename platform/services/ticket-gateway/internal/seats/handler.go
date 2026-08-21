package seats

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

const seatHoldTTL = 300 * time.Second // 5 minutes

// Lua script: delete seat hold only if the caller is the owner.
var releaseIfOwnerLua = goredis.NewScript(`
if redis.call("GET", KEYS[1]) == ARGV[1] then
	return redis.call("DEL", KEYS[1])
else
	return 0
end
`)

type Handler struct {
	redis *redisclient.Client
}

func NewHandler(redis *redisclient.Client) *Handler {
	return &Handler{redis: redis}
}

func seatKey(eventID, seatID string) string {
	return fmt.Sprintf("seat:{%s}:%s", eventID, seatID)
}

type HoldRequest struct {
	SeatID string `json:"seat_id"`
}

type ReleaseRequest struct {
	SeatID string `json:"seat_id"`
}

// HoldSeat attempts to hold a seat for a user using SET NX EX.
func (h *Handler) HoldSeat(ctx context.Context, eventID, seatID, userID string) (bool, error) {
	key := seatKey(eventID, seatID)
	ok, err := h.redis.Underlying().SetNX(ctx, key, userID, seatHoldTTL).Result()
	if err != nil {
		return false, fmt.Errorf("seat hold error: %w", err)
	}
	return ok, nil
}

// ReleaseSeat releases a seat hold only if the user is the owner.
func (h *Handler) ReleaseSeat(ctx context.Context, eventID, seatID, userID string) (bool, error) {
	key := seatKey(eventID, seatID)
	result, err := releaseIfOwnerLua.Run(ctx, h.redis.Underlying(), []string{key}, userID).Int64()
	if err != nil {
		return false, fmt.Errorf("seat release error: %w", err)
	}
	return result == 1, nil
}

// HandleHoldSeat is the HTTP handler for POST /api/v1/{eventId}/seats/hold
func (h *Handler) HandleHoldSeat(w http.ResponseWriter, r *http.Request) {
	eventID := chi.URLParam(r, "eventId")
	userID, ok := middleware.UserIDFromContext(r.Context())
	if !ok || userID == "" {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	var req HoldRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}
	if req.SeatID == "" {
		http.Error(w, `{"error":"seat_id is required"}`, http.StatusBadRequest)
		return
	}

	held, err := h.HoldSeat(r.Context(), eventID, req.SeatID, userID)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusInternalServerError)
		return
	}

	if !held {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusConflict)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error":    "seat_already_held",
			"seat_id":  req.SeatID,
			"event_id": eventID,
		})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":     "held",
		"seat_id":    req.SeatID,
		"event_id":   eventID,
		"expires_in": int(seatHoldTTL.Seconds()),
	})
}

// HandleReleaseSeat is the HTTP handler for DELETE /api/v1/{eventId}/seats/hold
func (h *Handler) HandleReleaseSeat(w http.ResponseWriter, r *http.Request) {
	eventID := chi.URLParam(r, "eventId")
	userID, ok := middleware.UserIDFromContext(r.Context())
	if !ok || userID == "" {
		http.Error(w, `{"error":"unauthorized"}`, http.StatusUnauthorized)
		return
	}

	var req ReleaseRequest
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, `{"error":"invalid request body"}`, http.StatusBadRequest)
		return
	}
	if req.SeatID == "" {
		http.Error(w, `{"error":"seat_id is required"}`, http.StatusBadRequest)
		return
	}

	released, err := h.ReleaseSeat(r.Context(), eventID, req.SeatID, userID)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusInternalServerError)
		return
	}

	if !released {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusForbidden)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"error":    "not_owner_or_expired",
			"seat_id":  req.SeatID,
			"event_id": eventID,
		})
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusOK)
	json.NewEncoder(w).Encode(map[string]interface{}{
		"status":   "released",
		"seat_id":  req.SeatID,
		"event_id": eventID,
	})
}
