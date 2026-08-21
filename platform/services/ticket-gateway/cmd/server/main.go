package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"strings"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"

	"github.com/pickket/ticket-gateway/internal/admission"
	"github.com/pickket/ticket-gateway/internal/cart"
	"github.com/pickket/ticket-gateway/internal/config"
	"github.com/pickket/ticket-gateway/internal/events"
	"github.com/pickket/ticket-gateway/internal/middleware"
	"github.com/pickket/ticket-gateway/internal/purchase"
	"github.com/pickket/ticket-gateway/internal/queue"
	redisclient "github.com/pickket/ticket-gateway/internal/redis"
	"github.com/pickket/ticket-gateway/internal/seats"
)

func main() {
	cfg := config.Load()

	// Initialize Redis client
	redis, err := redisclient.NewClient(cfg)
	if err != nil {
		log.Fatalf("Failed to connect to Redis: %v", err)
	}
	defer redis.Close()
	log.Printf("Connected to Redis (cluster=%v)", redis.IsCluster())

	// Initialize services
	publisher := events.NewPublisher(cfg)
	seatHandler := seats.NewHandler(redis)
	purchaseService := purchase.NewService(redis, seatHandler, publisher)
	purchaseHandler := purchase.NewHandler(purchaseService)
	queueService := queue.NewService(redis)
	admissionCtrl := admission.NewController(redis, cfg.BackendHealthURL)
	defer admissionCtrl.Stop()
	cartService := cart.NewService(redis, seatHandler, publisher)
	cartHandler := cart.NewHandler(cartService)
	cartSweepCtx, stopCartSweep := context.WithCancel(context.Background())
	defer stopCartSweep()
	go cartService.StartExpirySweeper(cartSweepCtx)

	// Build router
	r := chi.NewRouter()

	// Global middleware
	r.Use(chimw.Logger)
	r.Use(chimw.Recoverer)
	r.Use(chimw.RealIP)
	r.Use(chimw.RequestID)
	r.Use(chimw.Timeout(30 * time.Second))
	r.Use(corsMiddleware(cfg.AllowedOrigins))

	// Health check — no auth required
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		healthy := redis.Ping(r.Context()) == nil
		status := "ok"
		httpStatus := http.StatusOK
		if !healthy {
			status = "degraded"
			httpStatus = http.StatusServiceUnavailable
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(httpStatus)
		json.NewEncoder(w).Encode(map[string]interface{}{
			"status":      status,
			"service":     "ticket-gateway",
			"version":     "1.0.0",
			"redis":       healthy,
			"environment": cfg.Environment,
			"timestamp":   time.Now().UTC().Format(time.RFC3339),
		})
	})

	// API v1 routes — all require JWT auth
	r.Route("/api/v1", func(r chi.Router) {
		r.Use(middleware.JWTAuth(cfg.JWTSecretKey))
		r.Use(middleware.DeviceBinding(redis))
		r.Use(middleware.GeneralRateLimit(redis))

		// Event-scoped routes
		r.Route("/{eventId}", func(r chi.Router) {
			// Purchase — stricter rate limit
			r.Route("/tiers/{tierId}", func(r chi.Router) {
				r.With(middleware.PurchaseRateLimit(redis)).Post("/purchase", purchaseHandler.HandlePurchase)
			})

			// Queue
			r.Post("/queue/join", queueService.HandleJoinQueue)
			r.Get("/queue/status", queueService.HandleGetStatus)

			// Seats
			r.Post("/seats/hold", seatHandler.HandleHoldSeat)
			r.Delete("/seats/hold", seatHandler.HandleReleaseSeat)
		})

		// Cart state machine — Ticketmaster-style reserve/status/confirm/cancel
		r.Post("/cart/reserve", cartHandler.HandleReserve)
		r.Get("/cart/status", cartHandler.HandleStatus)
		r.Post("/cart/confirm", cartHandler.HandleConfirm)
		r.Delete("/cart", cartHandler.HandleCancel)

		// Waiting room status
		r.Get("/waiting-room/status/{eventId}", admissionCtrl.HandleWaitingRoomStatus)
	})

	// Create server
	srv := &http.Server{
		Addr:         ":" + cfg.Port,
		Handler:      r,
		ReadTimeout:  10 * time.Second,
		WriteTimeout: 30 * time.Second,
		IdleTimeout:  60 * time.Second,
	}

	// Graceful shutdown
	done := make(chan os.Signal, 1)
	signal.Notify(done, os.Interrupt, syscall.SIGINT, syscall.SIGTERM)

	go func() {
		log.Printf("Ticket Gateway starting on :%s (env=%s)", cfg.Port, cfg.Environment)
		if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
			log.Fatalf("Server error: %v", err)
		}
	}()

	<-done
	log.Println("Shutting down gracefully...")
	stopCartSweep()

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	if err := srv.Shutdown(ctx); err != nil {
		log.Fatalf("Shutdown error: %v", err)
	}

	log.Println("Server stopped")
}

// corsMiddleware validates the request Origin against the allowed origins list
// and sets appropriate CORS headers. Configure via ALLOWED_ORIGINS env var.
func corsMiddleware(allowedOrigins []string) func(http.Handler) http.Handler {
	allowed := make(map[string]bool, len(allowedOrigins))
	for _, o := range allowedOrigins {
		allowed[strings.TrimSpace(o)] = true
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if allowed[origin] {
				w.Header().Set("Access-Control-Allow-Origin", origin)
				w.Header().Set("Vary", "Origin")
			}
			w.Header().Set("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Request-ID")
			w.Header().Set("Access-Control-Max-Age", "86400")

			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
