package main

import (
	"context"
	"crypto/tls"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	goredis "github.com/redis/go-redis/v9"

	"github.com/pickket/realtime-hub/internal/config"
	"github.com/pickket/realtime-hub/internal/middleware"
	redisSub "github.com/pickket/realtime-hub/internal/redis"
	"github.com/pickket/realtime-hub/internal/sse"
	"github.com/pickket/realtime-hub/internal/ws"
)

func main() {
	cfg := config.Load()

	rdb := newRedisClient(cfg)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	// Verify Redis connectivity at startup.
	if err := rdb.Ping(ctx).Err(); err != nil {
		log.Fatalf("cannot connect to Redis: %v", err)
	}
	log.Println("connected to Redis")

	// Start the WebSocket hub.
	hub := ws.NewHub()
	go hub.Run()

	// Start the Redis subscriber.
	subscriber := redisSub.NewSubscriber(rdb, hub)
	go subscriber.Run(ctx)

	// Set up the HTTP router.
	r := chi.NewRouter()
	r.Use(chimw.Logger)
	r.Use(chimw.Recoverer)
	r.Use(chimw.RealIP)
	r.Use(corsMiddleware(cfg.AllowedOrigins))
	r.Use(middleware.OptionalJWTAuth(cfg.JWTSecretKey))

	wsHandler := ws.NewHandler(hub, cfg)
	sseHandler := sse.NewHandler(rdb)

	r.Get("/ws/{eventId}", wsHandler.ServeHTTP)
	r.Get("/sse/{eventId}", sseHandler.ServeHTTP)
	r.Get("/health", healthCheck(rdb, hub))

	// Start the HTTP server.
	addr := ":" + cfg.Port
	srv := &http.Server{
		Addr:         addr,
		Handler:      r,
		ReadTimeout:  15 * time.Second,
		WriteTimeout: 0, // Disabled for long-lived WebSocket/SSE connections.
		IdleTimeout:  120 * time.Second,
	}

	// Graceful shutdown.
	go func() {
		sigCh := make(chan os.Signal, 1)
		signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
		sig := <-sigCh
		log.Printf("received signal %v, shutting down...", sig)
		cancel()

		shutdownCtx, shutdownCancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer shutdownCancel()

		if err := srv.Shutdown(shutdownCtx); err != nil {
			log.Printf("http server shutdown error: %v", err)
		}
	}()

	log.Printf("realtime-hub listening on %s", addr)
	if err := srv.ListenAndServe(); err != nil && err != http.ErrServerClosed {
		log.Fatalf("server error: %v", err)
	}
	log.Println("server stopped")
}

// newRedisClient creates a Redis client. If multiple nodes are provided
// (comma-separated), it creates a cluster client.
func newRedisClient(cfg *config.Config) goredis.UniversalClient {
	nodes := strings.Split(cfg.RedisClusterNodes, ",")
	for i := range nodes {
		nodes[i] = strings.TrimSpace(nodes[i])
	}

	// Enable TLS for non-development environments (ElastiCache transit encryption)
	var tlsCfg *tls.Config
	if env := os.Getenv("ENVIRONMENT"); env != "" && env != "development" {
		tlsCfg = &tls.Config{MinVersion: tls.VersionTLS12}
	}

	// Treat whitespace-only or "none" as no password (ElastiCache without AUTH)
	password := strings.TrimSpace(cfg.RedisPassword)
	if password == "none" {
		password = ""
	}

	if len(nodes) > 1 {
		return goredis.NewClusterClient(&goredis.ClusterOptions{
			Addrs:     nodes,
			Password:  password,
			TLSConfig: tlsCfg,
		})
	}

	return goredis.NewClient(&goredis.Options{
		Addr:      nodes[0],
		Password:  password,
		TLSConfig: tlsCfg,
	})
}

// healthCheck returns an HTTP handler that reports service health.
func healthCheck(rdb goredis.UniversalClient, hub *ws.Hub) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		ctx := r.Context()

		status := "healthy"
		code := http.StatusOK
		redisErr := ""

		if err := rdb.Ping(ctx).Err(); err != nil {
			status = "unhealthy"
			code = http.StatusServiceUnavailable
			redisErr = err.Error()
		}

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(code)

		resp := map[string]string{
			"status":      status,
			"connections": fmt.Sprintf("%d", hub.ClientCount()),
			"rooms":       fmt.Sprintf("%d", hub.RoomCount()),
		}
		if redisErr != "" {
			resp["error"] = redisErr
		}

		json.NewEncoder(w).Encode(resp)
	}
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
			w.Header().Set("Access-Control-Allow-Methods", "GET, OPTIONS")
			w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")

			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
