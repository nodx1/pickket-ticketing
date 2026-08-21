package cart

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/pickket/ticket-gateway/internal/events"
	redisclient "github.com/pickket/ticket-gateway/internal/redis"
	"github.com/pickket/ticket-gateway/internal/seats"
	goredis "github.com/redis/go-redis/v9"
)

const (
	defaultHoldTTL     = 5 * time.Minute  // reservation hold expires after 5 min
	cartRetentionTTL   = 30 * time.Minute // keep cart state long enough for explicit expiry cleanup
	finalizedCartTTL   = 10 * time.Minute
	expiredCartTTL     = 5 * time.Minute
	cartSweepInterval  = 5 * time.Second
	cartSweepBatchSize = int64(100)
	sweepLockTTL       = 15 * time.Second
	lockTTL            = 8 * time.Second
)

// Cart states
const (
	StateReserved  = "RESERVED"
	StateConfirmed = "CONFIRMED"
	StateExpired   = "EXPIRED"
	StateCancelled = "CANCELLED"
)

// ReserveRequest is the body for POST /cart/reserve.
type ReserveRequest struct {
	EventID  string `json:"event_id"`
	TierID   string `json:"tier_id"`
	SeatID   string `json:"seat_id,omitempty"`
	Quantity int    `json:"quantity"`
}

// CartState is the persisted state in Redis.
type CartState struct {
	CartID    string `json:"cart_id"`
	UserID    string `json:"user_id"`
	EventID   string `json:"event_id"`
	TierID    string `json:"tier_id"`
	SeatID    string `json:"seat_id,omitempty"`
	Quantity  int    `json:"quantity"`
	Status    string `json:"status"`
	CreatedAt string `json:"created_at"`
	ExpiresAt string `json:"expires_at"`
}

// CartResponse is the HTTP response.
type CartResponse struct {
	CartID    string `json:"cart_id"`
	Status    string `json:"status"`
	ExpiresIn int    `json:"expires_in,omitempty"` // seconds remaining
	Message   string `json:"message,omitempty"`
}

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

func cartKey(userID string) string {
	return fmt.Sprintf("cart:{%s}", userID)
}

func cartExpiryIndexKey() string {
	return "cart-expiry:index"
}

func cartLockKey(userID string) string {
	return fmt.Sprintf("cart:%s", userID)
}

func sweepLockKey() string {
	return "cart-expiry-sweeper"
}

func capacityKey(eventID, tierID string) string {
	return fmt.Sprintf("capacity:{%s}:%s", eventID, tierID)
}

func (s *Service) loadCartState(ctx context.Context, userID string) (*CartState, error) {
	raw, err := s.redis.Underlying().Get(ctx, cartKey(userID)).Result()
	if err == goredis.Nil {
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("get cart state: %w", err)
	}

	var state CartState
	if err := json.Unmarshal([]byte(raw), &state); err != nil {
		return nil, fmt.Errorf("unmarshal cart state: %w", err)
	}
	return &state, nil
}

func (s *Service) storeCartState(ctx context.Context, state *CartState, ttl time.Duration) error {
	data, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("marshal cart state: %w", err)
	}
	if err := s.redis.Underlying().Set(ctx, cartKey(state.UserID), string(data), ttl).Err(); err != nil {
		return fmt.Errorf("store cart state: %w", err)
	}
	return nil
}

func parseCartExpiry(state *CartState) (time.Time, error) {
	expiresAt, err := time.Parse(time.RFC3339, state.ExpiresAt)
	if err != nil {
		return time.Time{}, fmt.Errorf("parse cart expiry: %w", err)
	}
	return expiresAt.UTC(), nil
}

func (s *Service) expiresInSeconds(state *CartState, now time.Time) int {
	expiresAt, err := parseCartExpiry(state)
	if err != nil {
		return 0
	}
	remaining := int(time.Until(expiresAt).Seconds())
	if remaining < 0 {
		return 0
	}
	return remaining
}

func (s *Service) isExpired(state *CartState, now time.Time) bool {
	expiresAt, err := parseCartExpiry(state)
	if err != nil {
		return true
	}
	return !expiresAt.After(now.UTC())
}

func (s *Service) upsertExpiryIndex(ctx context.Context, state *CartState) error {
	expiresAt, err := parseCartExpiry(state)
	if err != nil {
		return err
	}
	return s.redis.Underlying().ZAdd(ctx, cartExpiryIndexKey(), goredis.Z{
		Score:  float64(expiresAt.Unix()),
		Member: state.UserID,
	}).Err()
}

func (s *Service) removeExpiryIndex(ctx context.Context, userID string) error {
	return s.redis.Underlying().ZRem(ctx, cartExpiryIndexKey(), userID).Err()
}

func (s *Service) withCartLock(ctx context.Context, userID string, fn func() error) error {
	lock, err := redisclient.AcquireLock(ctx, s.redis, cartLockKey(userID), lockTTL)
	if err != nil {
		return fmt.Errorf("could not acquire cart lock: %w", err)
	}
	defer func() {
		if releaseErr := lock.Release(ctx); releaseErr != nil {
			log.Printf("[Cart] Lock release warning: %v", releaseErr)
		}
	}()
	return fn()
}

func (s *Service) setTerminalState(
	ctx context.Context,
	state *CartState,
	status string,
	ttl time.Duration,
) error {
	state.Status = status
	state.ExpiresAt = time.Now().UTC().Format(time.RFC3339)
	return s.storeCartState(ctx, state, ttl)
}

func (s *Service) releaseReservation(
	ctx context.Context,
	state *CartState,
	finalStatus string,
	retainTerminalState bool,
) error {
	if err := s.redis.Underlying().IncrBy(ctx, capacityKey(state.EventID, state.TierID), int64(state.Quantity)).Err(); err != nil {
		return fmt.Errorf("restore capacity: %w", err)
	}

	if state.SeatID != "" {
		if _, err := s.seats.ReleaseSeat(ctx, state.EventID, state.SeatID, state.UserID); err != nil {
			return fmt.Errorf("release seat hold: %w", err)
		}
		s.publisher.PublishSeatHoldAsync(events.SeatHoldEvent{
			EventID: state.EventID,
			SeatID:  state.SeatID,
			UserID:  state.UserID,
			Action:  "release",
		})
	}

	if err := s.removeExpiryIndex(ctx, state.UserID); err != nil {
		return fmt.Errorf("remove expiry index: %w", err)
	}

	if retainTerminalState {
		return s.setTerminalState(ctx, state, finalStatus, expiredCartTTL)
	}
	return s.redis.Underlying().Del(ctx, cartKey(state.UserID)).Err()
}

func (s *Service) expireUserCart(ctx context.Context, userID string) error {
	state, err := s.loadCartState(ctx, userID)
	if err != nil {
		return err
	}
	if state == nil {
		return s.removeExpiryIndex(ctx, userID)
	}
	if state.Status != StateReserved {
		return s.removeExpiryIndex(ctx, userID)
	}
	if !s.isExpired(state, time.Now().UTC()) {
		return s.upsertExpiryIndex(ctx, state)
	}

	return s.withCartLock(ctx, userID, func() error {
		latest, err := s.loadCartState(ctx, userID)
		if err != nil {
			return err
		}
		if latest == nil {
			return s.removeExpiryIndex(ctx, userID)
		}
		if latest.Status != StateReserved {
			return s.removeExpiryIndex(ctx, userID)
		}
		if !s.isExpired(latest, time.Now().UTC()) {
			return s.upsertExpiryIndex(ctx, latest)
		}
		return s.releaseReservation(ctx, latest, StateExpired, true)
	})
}

func (s *Service) sweepExpiredReservations(ctx context.Context) error {
	sweepLock, err := redisclient.AcquireLock(ctx, s.redis, sweepLockKey(), sweepLockTTL)
	if err != nil {
		return nil
	}
	defer func() {
		if releaseErr := sweepLock.Release(ctx); releaseErr != nil {
			log.Printf("[Cart] Sweep lock release warning: %v", releaseErr)
		}
	}()

	members, err := s.redis.Underlying().ZRangeByScore(ctx, cartExpiryIndexKey(), &goredis.ZRangeBy{
		Min:    "-inf",
		Max:    strconv.FormatInt(time.Now().UTC().Unix(), 10),
		Offset: 0,
		Count:  cartSweepBatchSize,
	}).Result()
	if err == goredis.Nil || len(members) == 0 {
		return nil
	}
	if err != nil {
		return fmt.Errorf("scan expiry index: %w", err)
	}

	for _, userID := range members {
		if err := s.expireUserCart(ctx, userID); err != nil {
			log.Printf("[Cart] Expiry sweep warning for user %s: %v", userID, err)
		}
	}
	return nil
}

// StartExpirySweeper reclaims expired carts so capacity/seat holds are restored
// even if the client never calls status or cancel.
func (s *Service) StartExpirySweeper(ctx context.Context) {
	ticker := time.NewTicker(cartSweepInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if err := s.sweepExpiredReservations(ctx); err != nil {
				log.Printf("[Cart] Expiry sweep error: %v", err)
			}
		}
	}
}

// Reserve creates a new cart reservation with explicit expiry tracking.
func (s *Service) Reserve(ctx context.Context, userID string, req ReserveRequest) (*CartResponse, error) {
	quantity := req.Quantity
	if quantity <= 0 {
		quantity = 1
	}
	if req.SeatID != "" && quantity != 1 {
		return nil, fmt.Errorf("seat-specific reservations must use quantity=1")
	}

	var response *CartResponse
	err := s.withCartLock(ctx, userID, func() error {
		existing, err := s.loadCartState(ctx, userID)
		if err != nil {
			return err
		}
		if existing != nil && existing.Status == StateReserved {
			if s.isExpired(existing, time.Now().UTC()) {
				if err := s.releaseReservation(ctx, existing, StateExpired, true); err != nil {
					return err
				}
			} else {
				return fmt.Errorf("active cart already exists: %s", existing.CartID)
			}
		}

		capKey := capacityKey(req.EventID, req.TierID)
		remaining, err := s.redis.Underlying().Get(ctx, capKey).Int64()
		if err == goredis.Nil {
			return fmt.Errorf("tier not found: %s/%s", req.EventID, req.TierID)
		}
		if err != nil {
			return fmt.Errorf("capacity check error: %w", err)
		}
		if remaining < int64(quantity) {
			response = &CartResponse{
				Status:  "sold_out",
				Message: fmt.Sprintf("Insufficient capacity: %d remaining", remaining),
			}
			return nil
		}

		if req.SeatID != "" {
			held, err := s.seats.HoldSeat(ctx, req.EventID, req.SeatID, userID)
			if err != nil {
				return fmt.Errorf("seat hold error: %w", err)
			}
			if !held {
				response = &CartResponse{
					Status:  "seat_unavailable",
					Message: "Seat is already held by another user",
				}
				return nil
			}
		}

		newRemaining, err := s.redis.Underlying().DecrBy(ctx, capKey, int64(quantity)).Result()
		if err != nil {
			return fmt.Errorf("capacity decrement error: %w", err)
		}
		if newRemaining < 0 {
			_ = s.redis.Underlying().IncrBy(ctx, capKey, int64(quantity)).Err()
			if req.SeatID != "" {
				_, _ = s.seats.ReleaseSeat(ctx, req.EventID, req.SeatID, userID)
			}
			response = &CartResponse{
				Status:  "sold_out",
				Message: "Race condition: sold out during reservation",
			}
			return nil
		}

		now := time.Now().UTC()
		state := &CartState{
			CartID:    uuid.NewString(),
			UserID:    userID,
			EventID:   req.EventID,
			TierID:    req.TierID,
			SeatID:    req.SeatID,
			Quantity:  quantity,
			Status:    StateReserved,
			CreatedAt: now.Format(time.RFC3339),
			ExpiresAt: now.Add(defaultHoldTTL).Format(time.RFC3339),
		}

		if err := s.storeCartState(ctx, state, cartRetentionTTL); err != nil {
			_ = s.redis.Underlying().IncrBy(ctx, capKey, int64(quantity)).Err()
			if req.SeatID != "" {
				_, _ = s.seats.ReleaseSeat(ctx, req.EventID, req.SeatID, userID)
			}
			return err
		}
		if err := s.upsertExpiryIndex(ctx, state); err != nil {
			_ = s.releaseReservation(ctx, state, StateCancelled, false)
			return err
		}

		if req.SeatID != "" {
			s.publisher.PublishSeatHoldAsync(events.SeatHoldEvent{
				EventID: req.EventID,
				SeatID:  req.SeatID,
				UserID:  userID,
				HoldTTL: int(defaultHoldTTL.Seconds()),
				Action:  "hold",
			})
		}

		response = &CartResponse{
			CartID:    state.CartID,
			Status:    StateReserved,
			ExpiresIn: int(defaultHoldTTL.Seconds()),
			Message:   "Reserved. Complete payment before expiry.",
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return response, nil
}

// Status returns the current state of the user's cart.
func (s *Service) Status(ctx context.Context, userID string) (*CartResponse, error) {
	state, err := s.loadCartState(ctx, userID)
	if err != nil {
		return nil, err
	}
	if state == nil {
		_ = s.removeExpiryIndex(ctx, userID)
		return &CartResponse{
			Status:  StateExpired,
			Message: "No active cart. Reservation may have expired.",
		}, nil
	}

	if state.Status == StateReserved && s.isExpired(state, time.Now().UTC()) {
		if err := s.expireUserCart(ctx, userID); err != nil {
			return nil, err
		}
		return &CartResponse{
			CartID:  state.CartID,
			Status:  StateExpired,
			Message: "Reservation expired.",
		}, nil
	}

	return &CartResponse{
		CartID:    state.CartID,
		Status:    state.Status,
		ExpiresIn: s.expiresInSeconds(state, time.Now().UTC()),
	}, nil
}

// Confirm finalizes the reservation — transitions RESERVED → CONFIRMED.
// Publishes order.created to SNS for backend to persist.
func (s *Service) Confirm(ctx context.Context, userID string) (*CartResponse, error) {
	var response *CartResponse
	err := s.withCartLock(ctx, userID, func() error {
		state, err := s.loadCartState(ctx, userID)
		if err != nil {
			return err
		}
		if state == nil {
			response = &CartResponse{
				Status:  StateExpired,
				Message: "Cart expired or does not exist.",
			}
			return nil
		}

		if state.Status != StateReserved {
			response = &CartResponse{
				CartID:  state.CartID,
				Status:  state.Status,
				Message: fmt.Sprintf("Cannot confirm: current status is %s", state.Status),
			}
			return nil
		}

		if s.isExpired(state, time.Now().UTC()) {
			if err := s.releaseReservation(ctx, state, StateExpired, true); err != nil {
				return err
			}
			response = &CartResponse{
				CartID:  state.CartID,
				Status:  StateExpired,
				Message: "Cart expired before confirmation.",
			}
			return nil
		}

		state.Status = StateConfirmed
		if err := s.storeCartState(ctx, state, finalizedCartTTL); err != nil {
			return err
		}
		if err := s.removeExpiryIndex(ctx, userID); err != nil {
			return err
		}

		s.publisher.PublishPurchaseAsync(events.PurchaseEvent{
			EventID:  state.EventID,
			TierID:   state.TierID,
			UserID:   state.UserID,
			SeatID:   state.SeatID,
			OrderID:  state.CartID, // use cart ID as order ID
			Quantity: state.Quantity,
			Status:   "CONFIRMED",
		})

		response = &CartResponse{
			CartID:  state.CartID,
			Status:  StateConfirmed,
			Message: "Confirmed. Order submitted for payment processing.",
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return response, nil
}

// Cancel releases the reservation — restores capacity + releases seat.
func (s *Service) Cancel(ctx context.Context, userID string) (*CartResponse, error) {
	var response *CartResponse
	err := s.withCartLock(ctx, userID, func() error {
		state, err := s.loadCartState(ctx, userID)
		if err != nil {
			return err
		}
		if state == nil {
			response = &CartResponse{
				Status:  StateExpired,
				Message: "No active cart to cancel.",
			}
			return nil
		}

		if state.Status != StateReserved {
			response = &CartResponse{
				CartID:  state.CartID,
				Status:  state.Status,
				Message: fmt.Sprintf("Cannot cancel: current status is %s", state.Status),
			}
			return nil
		}

		if s.isExpired(state, time.Now().UTC()) {
			if err := s.releaseReservation(ctx, state, StateExpired, true); err != nil {
				return err
			}
			response = &CartResponse{
				CartID:  state.CartID,
				Status:  StateExpired,
				Message: "Reservation already expired.",
			}
			return nil
		}

		if err := s.releaseReservation(ctx, state, StateCancelled, false); err != nil {
			return err
		}

		response = &CartResponse{
			CartID:  state.CartID,
			Status:  StateCancelled,
			Message: "Cart cancelled. Capacity restored.",
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return response, nil
}
