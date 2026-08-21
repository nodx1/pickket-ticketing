package sse

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/redis/go-redis/v9"
)

const heartbeatInterval = 15 * time.Second

// Handler handles SSE fallback connections for clients that cannot use WebSocket.
type Handler struct {
	rdb redis.UniversalClient
}

// NewHandler creates a new SSE handler.
func NewHandler(rdb redis.UniversalClient) *Handler {
	return &Handler{rdb: rdb}
}

// ServeHTTP streams events to the client via Server-Sent Events.
// The client subscribes to a single channel for a specific event.
// Query parameter "channel" must be one of: seats, event_stats, queue_position.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	eventID := chi.URLParam(r, "eventId")
	channel := r.URL.Query().Get("channel")

	if eventID == "" {
		http.Error(w, "missing eventId", http.StatusBadRequest)
		return
	}

	redisPattern := resolveRedisChannel(channel, eventID)
	if redisPattern == "" {
		http.Error(w, "invalid channel parameter", http.StatusBadRequest)
		return
	}

	flusher, ok := w.(http.Flusher)
	if !ok {
		http.Error(w, "streaming unsupported", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache")
	w.Header().Set("Connection", "keep-alive")
	w.Header().Set("X-Accel-Buffering", "no")
	flusher.Flush()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	pubsub := h.rdb.Subscribe(ctx, redisPattern)
	defer pubsub.Close()

	ch := pubsub.Channel()
	heartbeat := time.NewTicker(heartbeatInterval)
	defer heartbeat.Stop()

	msgType := resolveMessageType(channel)

	for {
		select {
		case <-ctx.Done():
			return

		case msg, ok := <-ch:
			if !ok {
				return
			}
			envelope := buildSSEPayload(msgType, eventID, msg.Payload)
			fmt.Fprintf(w, "data: %s\n\n", envelope)
			flusher.Flush()

		case <-heartbeat.C:
			fmt.Fprintf(w, ": heartbeat\n\n")
			flusher.Flush()
		}
	}
}

// resolveRedisChannel maps the user-facing channel name and event ID to a Redis
// channel name.
func resolveRedisChannel(channel, eventID string) string {
	switch channel {
	case "seats":
		return "seats:" + eventID
	case "event_stats":
		return "event_stats:" + eventID
	case "queue_position":
		return "queue:" + eventID + ":position"
	default:
		return ""
	}
}

// resolveMessageType maps a channel name to the outbound message type.
func resolveMessageType(channel string) string {
	switch channel {
	case "seats":
		return "seat_update"
	case "event_stats":
		return "event_stats"
	case "queue_position":
		return "queue_position"
	default:
		return "unknown"
	}
}

// buildSSEPayload builds a JSON payload for an SSE event.
func buildSSEPayload(msgType, eventID, rawData string) string {
	// Ensure rawData is valid JSON; if not, wrap it as a string.
	rawData = strings.TrimSpace(rawData)
	if !json.Valid([]byte(rawData)) {
		escaped, _ := json.Marshal(rawData)
		rawData = string(escaped)
	}

	payload := fmt.Sprintf(`{"type":"%s","event_id":"%s","data":%s}`, msgType, eventID, rawData)

	// Validate the final payload; if somehow broken, log and return as-is.
	if !json.Valid([]byte(payload)) {
		log.Printf("sse: produced invalid JSON payload for %s:%s", msgType, eventID)
	}
	return payload
}
