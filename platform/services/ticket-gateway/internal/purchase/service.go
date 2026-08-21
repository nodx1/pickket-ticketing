package purchase

import (
	"context"
	"fmt"
	"log"
	"time"

	"github.com/google/uuid"
	"github.com/pickket/ticket-gateway/internal/events"
	redisclient "github.com/pickket/ticket-gateway/internal/redis"
	"github.com/pickket/ticket-gateway/internal/seats"
	goredis "github.com/redis/go-redis/v9"
)

const lockTTL = 8 * time.Second

type Service struct {
	redis     *redisclient.Client
	seats     *seats.Handler
	publisher *events.Publisher
}

func NewService(redis *redisclient.Client, seats *seats.Handler, publisher *events.Publisher) *Service {
	return &Service{
		redis:     redis,
		seats:     seats,
		publisher: publisher,
	}
}

type PurchaseRequest struct {
	EventID  string `json:"event_id"`
	TierID   string `json:"tier_id"`
	UserID   string `json:"user_id"`
	SeatID   string `json:"seat_id,omitempty"`
	Quantity int    `json:"quantity"`
}

type PurchaseResult struct {
	PurchaseID string `json:"purchase_id"`
	Status     string `json:"status"`
	EventID    string `json:"event_id"`
	TierID     string `json:"tier_id"`
	SeatID     string `json:"seat_id,omitempty"`
	Message    string `json:"message"`
}

func capacityKey(eventID, tierID string) string {
	return fmt.Sprintf("capacity:{%s}:%s", eventID, tierID)
}

// ProcessPurchase handles the core purchase flow:
// 1. Acquire distributed lock
// 2. Check remaining capacity
// 3. Hold seat if applicable
// 4. Decrement capacity
// 5. Publish SNS event asynchronously
// 6. Return immediately with HELD status
func (s *Service) ProcessPurchase(ctx context.Context, req PurchaseRequest) (*PurchaseResult, error) {
	lockKey := fmt.Sprintf("%s:purchase:%s", req.EventID, req.UserID)
	lock, err := redisclient.AcquireLock(ctx, s.redis, lockKey, lockTTL)
	if err != nil {
		return nil, fmt.Errorf("could not acquire purchase lock: %w", err)
	}
	defer func() {
		if releaseErr := lock.Release(ctx); releaseErr != nil {
			log.Printf("[Purchase] Lock release warning: %v", releaseErr)
		}
	}()

	// Check capacity
	capKey := capacityKey(req.EventID, req.TierID)
	remaining, err := s.redis.Underlying().Get(ctx, capKey).Int64()
	if err == goredis.Nil {
		return nil, fmt.Errorf("tier not found or capacity not initialized: %s/%s", req.EventID, req.TierID)
	}
	if err != nil {
		return nil, fmt.Errorf("capacity check error: %w", err)
	}

	quantity := req.Quantity
	if quantity <= 0 {
		quantity = 1
	}
	if remaining < int64(quantity) {
		return &PurchaseResult{
			Status:  "sold_out",
			EventID: req.EventID,
			TierID:  req.TierID,
			Message: fmt.Sprintf("Insufficient capacity: %d remaining, %d requested", remaining, quantity),
		}, nil
	}

	// Hold seat if specified
	if req.SeatID != "" {
		held, err := s.seats.HoldSeat(ctx, req.EventID, req.SeatID, req.UserID)
		if err != nil {
			return nil, fmt.Errorf("seat hold error: %w", err)
		}
		if !held {
			return &PurchaseResult{
				Status:  "seat_unavailable",
				EventID: req.EventID,
				TierID:  req.TierID,
				SeatID:  req.SeatID,
				Message: "Seat is already held by another user",
			}, nil
		}
	}

	// Decrement capacity
	newRemaining, err := s.redis.Underlying().DecrBy(ctx, capKey, int64(quantity)).Result()
	if err != nil {
		return nil, fmt.Errorf("capacity decrement error: %w", err)
	}

	// Safety check: if we went below zero, rollback
	if newRemaining < 0 {
		s.redis.Underlying().IncrBy(ctx, capKey, int64(quantity))
		// Release seat hold if we had one
		if req.SeatID != "" {
			s.seats.ReleaseSeat(ctx, req.EventID, req.SeatID, req.UserID)
		}
		return &PurchaseResult{
			Status:  "sold_out",
			EventID: req.EventID,
			TierID:  req.TierID,
			Message: "Race condition: sold out during purchase",
		}, nil
	}

	purchaseID := uuid.NewString()

	// Publish SNS event asynchronously — never blocks the response
	s.publisher.PublishPurchaseAsync(events.PurchaseEvent{
		EventID: req.EventID,
		TierID:  req.TierID,
		UserID:  req.UserID,
		SeatID:  req.SeatID,
		Status:  "HELD",
	})

	return &PurchaseResult{
		PurchaseID: purchaseID,
		Status:     "HELD",
		EventID:    req.EventID,
		TierID:     req.TierID,
		SeatID:     req.SeatID,
		Message:    "Purchase held. Awaiting payment confirmation from backend.",
	}, nil
}
