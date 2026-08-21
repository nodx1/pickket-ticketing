package redis

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strings"

	goredis "github.com/redis/go-redis/v9"

	"github.com/pickket/realtime-hub/internal/ws"
)

// ChannelPatterns are the Redis pub/sub patterns the subscriber listens to.
var ChannelPatterns = []string{
	"event_stats:*",
	"seats:*",
	"queue:*:position",
}

// Subscriber listens on Redis pub/sub channels and fans messages out to the
// Hub's rooms.
type Subscriber struct {
	rdb      goredis.UniversalClient
	hub      *ws.Hub
	patterns []string
}

// NewSubscriber creates a new Redis pub/sub subscriber.
func NewSubscriber(rdb goredis.UniversalClient, hub *ws.Hub) *Subscriber {
	return &Subscriber{
		rdb:      rdb,
		hub:      hub,
		patterns: ChannelPatterns,
	}
}

// Run starts listening for Redis pub/sub messages and broadcasting them to
// WebSocket rooms. It blocks until the context is cancelled.
func (s *Subscriber) Run(ctx context.Context) {
	pubsub := s.rdb.PSubscribe(ctx, s.patterns...)
	defer pubsub.Close()

	log.Printf("redis subscriber started, patterns: %v", s.patterns)

	ch := pubsub.Channel()
	for {
		select {
		case <-ctx.Done():
			log.Println("redis subscriber stopped")
			return
		case msg, ok := <-ch:
			if !ok {
				log.Println("redis subscriber channel closed")
				return
			}
			s.handleMessage(msg)
		}
	}
}

// handleMessage parses a Redis pub/sub message, determines the target room and
// message type, wraps it in the outbound JSON envelope, and broadcasts it.
func (s *Subscriber) handleMessage(msg *goredis.Message) {
	channel := msg.Channel
	payload := msg.Payload

	roomID, msgType, eventID := parseChannel(channel)
	if roomID == "" {
		log.Printf("redis: unrecognized channel: %s", channel)
		return
	}

	// Ensure payload is valid JSON.
	trimmed := strings.TrimSpace(payload)
	if !json.Valid([]byte(trimmed)) {
		log.Printf("redis: invalid JSON payload on %s: %s", channel, payload)
		return
	}

	envelope := fmt.Sprintf(`{"type":"%s","event_id":"%s","data":%s}`, msgType, eventID, trimmed)

	s.hub.BroadcastToRoom(roomID, []byte(envelope))
}

// parseChannel extracts the room ID, outbound message type, and event ID from a
// Redis channel name.
//
// Supported patterns:
//   - "event_stats:{event_id}" → room "event_stats:{event_id}", type "event_stats"
//   - "seats:{event_id}"       → room "seats:{event_id}", type "seat_update"
//   - "queue:{event_id}:position" → room "queue:{event_id}", type "queue_position"
func parseChannel(channel string) (roomID, msgType, eventID string) {
	parts := strings.SplitN(channel, ":", 3)
	if len(parts) < 2 {
		return "", "", ""
	}

	switch {
	case parts[0] == "event_stats":
		// event_stats:abc123
		eventID = parts[1]
		return "event_stats:" + eventID, "event_stats", eventID

	case parts[0] == "seats":
		// seats:abc123
		eventID = parts[1]
		return "seats:" + eventID, "seat_update", eventID

	case parts[0] == "queue" && len(parts) == 3 && parts[2] == "position":
		// queue:abc123:position
		eventID = parts[1]
		return "queue:" + eventID, "queue_position", eventID

	default:
		return "", "", ""
	}
}
