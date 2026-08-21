package admission

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/go-chi/chi/v5"
	redisclient "github.com/pickket/ticket-gateway/internal/redis"
	goredis "github.com/redis/go-redis/v9"
)

const (
	pollInterval     = 5 * time.Second
	defaultBatchSize = 50
	maxBatchSize     = 200
	minBatchSize     = 10
)

// Controller implements adaptive admission control.
// A background goroutine pings Redis every 5 seconds to gauge health,
// adjusting the batch size for queue activation accordingly.
type Controller struct {
	redis      *redisclient.Client
	mu         sync.RWMutex
	batchSize  int
	healthy    bool
	latencyMs  int64
	stopCh     chan struct{}
	backendURL string
}

func NewController(redis *redisclient.Client, backendHealthURL string) *Controller {
	c := &Controller{
		redis:      redis,
		batchSize:  defaultBatchSize,
		healthy:    true,
		stopCh:     make(chan struct{}),
		backendURL: backendHealthURL,
	}
	go c.monitorLoop()
	return c
}

// monitorLoop runs every pollInterval, pinging Redis to determine system health.
// It adjusts batch size based on latency:
//   - < 5ms  → increase batch size (up to max)
//   - 5-20ms → keep current batch size
//   - > 20ms → decrease batch size (down to min)
func (c *Controller) monitorLoop() {
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()

	for {
		select {
		case <-c.stopCh:
			return
		case <-ticker.C:
			c.checkHealth()
		}
	}
}

func (c *Controller) checkHealth() {
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()

	start := time.Now()
	err := c.redis.Underlying().Ping(ctx).Err()
	latency := time.Since(start).Milliseconds()

	c.mu.Lock()
	defer c.mu.Unlock()

	if err != nil {
		c.healthy = false
		c.latencyMs = -1
		c.batchSize = minBatchSize
		log.Printf("[Admission] Redis unhealthy: %v — batch size reduced to %d", err, c.batchSize)
		return
	}

	c.healthy = true
	c.latencyMs = latency

	// Check backend (Aurora) health if configured
	if c.backendURL != "" {
		httpClient := &http.Client{Timeout: 200 * time.Millisecond}
		resp, err := httpClient.Get(c.backendURL)
		if err != nil || resp.StatusCode != http.StatusOK {
			c.healthy = false
			c.batchSize = minBatchSize
			if err != nil {
				log.Printf("[Admission] Backend unhealthy: %v — batch size reduced to %d", err, c.batchSize)
			} else {
				resp.Body.Close()
				log.Printf("[Admission] Backend unhealthy: status %d — batch size reduced to %d", resp.StatusCode, c.batchSize)
			}
			return
		}
		resp.Body.Close()
	}

	switch {
	case latency < 5:
		// Redis is very responsive — increase batch size
		newSize := c.batchSize + 10
		if newSize > maxBatchSize {
			newSize = maxBatchSize
		}
		c.batchSize = newSize
	case latency > 20:
		// Redis is slow — decrease batch size
		newSize := c.batchSize - 10
		if newSize < minBatchSize {
			newSize = minBatchSize
		}
		c.batchSize = newSize
	}
	// 5-20ms: no change
}

// Stop terminates the monitor goroutine.
func (c *Controller) Stop() {
	close(c.stopCh)
}

// GetBatchSize returns the current adaptive batch size.
func (c *Controller) GetBatchSize() int {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.batchSize
}

// IsHealthy returns the current health status.
func (c *Controller) IsHealthy() bool {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.healthy
}

type ThrottleStatus struct {
	Healthy       bool   `json:"healthy"`
	BatchSize     int    `json:"batch_size"`
	LatencyMs     int64  `json:"latency_ms"`
	WaitingCount  int64  `json:"waiting_count"`
	ActiveCount   int64  `json:"active_count"`
	EventID       string `json:"event_id"`
	ThrottleLevel string `json:"throttle_level"`
}

// GetThrottleStatus returns the current admission state for an event.
func (c *Controller) GetThrottleStatus(ctx context.Context, eventID string) (*ThrottleStatus, error) {
	c.mu.RLock()
	healthy := c.healthy
	batchSize := c.batchSize
	latencyMs := c.latencyMs
	c.mu.RUnlock()

	waitingKey := fmt.Sprintf("queue:{%s}:waiting", eventID)
	activeKey := fmt.Sprintf("queue:{%s}:active", eventID)

	pipe := c.redis.Underlying().Pipeline()
	waitingCmd := pipe.ZCard(ctx, waitingKey)
	activeCmd := pipe.ZCard(ctx, activeKey)
	_, err := pipe.Exec(ctx)

	var waitingCount, activeCount int64
	if err != nil && err != goredis.Nil {
		log.Printf("[Admission] Pipeline error: %v", err)
	} else {
		waitingCount = waitingCmd.Val()
		activeCount = activeCmd.Val()
	}

	throttleLevel := "normal"
	if !healthy {
		throttleLevel = "critical"
	} else if latencyMs > 20 {
		throttleLevel = "high"
	} else if latencyMs > 10 {
		throttleLevel = "moderate"
	}

	return &ThrottleStatus{
		Healthy:       healthy,
		BatchSize:     batchSize,
		LatencyMs:     latencyMs,
		WaitingCount:  waitingCount,
		ActiveCount:   activeCount,
		EventID:       eventID,
		ThrottleLevel: throttleLevel,
	}, nil
}

// HandleWaitingRoomStatus is the HTTP handler for GET /api/v1/waiting-room/status/{eventId}
func (c *Controller) HandleWaitingRoomStatus(w http.ResponseWriter, r *http.Request) {
	eventID := chi.URLParam(r, "eventId")
	if eventID == "" {
		http.Error(w, `{"error":"event_id is required"}`, http.StatusBadRequest)
		return
	}

	status, err := c.GetThrottleStatus(r.Context(), eventID)
	if err != nil {
		http.Error(w, fmt.Sprintf(`{"error":"%s"}`, err.Error()), http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(status)
}
