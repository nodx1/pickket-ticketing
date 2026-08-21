package ws

import (
	"log"
	"net/http"

	"github.com/gorilla/websocket"
	"github.com/pickket/realtime-hub/internal/config"
)

// Handler handles HTTP → WebSocket upgrade requests.
type Handler struct {
	hub      *Hub
	cfg      *config.Config
	upgrader websocket.Upgrader
}

// NewHandler creates a new WebSocket upgrade handler.
func NewHandler(hub *Hub, cfg *config.Config) *Handler {
	return &Handler{
		hub: hub,
		cfg: cfg,
		upgrader: websocket.Upgrader{
			ReadBufferSize:  cfg.ReadBufferSize,
			WriteBufferSize: cfg.WriteBufferSize,
			CheckOrigin: func(r *http.Request) bool {
				origin := r.Header.Get("Origin")
				if origin == "" {
					return true // Allow non-browser clients (ALB health checks, server-to-server)
				}
				for _, allowed := range cfg.AllowedOrigins {
					if allowed == "*" || origin == allowed {
						return true
					}
				}
				return false
			},
		},
	}
}

// ServeHTTP upgrades the HTTP connection to a WebSocket and starts the
// client read/write pumps.
func (h *Handler) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if h.hub.ClientCount() >= int64(h.cfg.MaxConnections) {
		http.Error(w, "server at capacity", http.StatusServiceUnavailable)
		return
	}

	conn, err := h.upgrader.Upgrade(w, r, nil)
	if err != nil {
		log.Printf("ws upgrade error: %v", err)
		return
	}

	client := NewClient(h.hub, conn, h.cfg)
	h.hub.Register(client)

	go client.WritePump()
	go client.ReadPump()
}
