package ws

import (
	"encoding/json"
	"log"
	"sync"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pickket/realtime-hub/internal/config"
)

const sendBufferSize = 256

// InboundMessage represents a message sent from client to server.
type InboundMessage struct {
	Type    string `json:"type"`
	Channel string `json:"channel,omitempty"`
	EventID string `json:"event_id,omitempty"`
}

// OutboundMessage represents a message sent from server to client.
type OutboundMessage struct {
	Type    string          `json:"type"`
	EventID string          `json:"event_id,omitempty"`
	Data    json.RawMessage `json:"data,omitempty"`
	Message string          `json:"message,omitempty"`
}

// Client represents a single WebSocket connection.
type Client struct {
	hub   *Hub
	conn  *websocket.Conn
	send  chan []byte
	rooms map[string]bool
	mu    sync.RWMutex
	cfg   *config.Config
}

// NewClient creates a new Client instance.
func NewClient(hub *Hub, conn *websocket.Conn, cfg *config.Config) *Client {
	return &Client{
		hub:   hub,
		conn:  conn,
		send:  make(chan []byte, sendBufferSize),
		rooms: make(map[string]bool),
		cfg:   cfg,
	}
}

// ReadPump reads messages from the WebSocket connection and processes
// subscribe, unsubscribe, and ping requests.
func (c *Client) ReadPump() {
	defer func() {
		c.hub.unregister <- c
		c.conn.Close()
	}()

	c.conn.SetReadLimit(4096)
	c.conn.SetReadDeadline(time.Now().Add(c.cfg.PongWait))
	c.conn.SetPongHandler(func(string) error {
		c.conn.SetReadDeadline(time.Now().Add(c.cfg.PongWait))
		return nil
	})

	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			if websocket.IsUnexpectedCloseError(err, websocket.CloseGoingAway, websocket.CloseNormalClosure) {
				log.Printf("ws read error: %v", err)
			}
			return
		}
		c.handleMessage(message)
	}
}

// WritePump writes messages from the send channel to the WebSocket connection.
// It also sends periodic ping frames to keep the connection alive.
func (c *Client) WritePump() {
	ticker := time.NewTicker(c.cfg.PingPeriod)
	defer func() {
		ticker.Stop()
		c.conn.Close()
	}()

	for {
		select {
		case msg, ok := <-c.send:
			c.conn.SetWriteDeadline(time.Now().Add(c.cfg.WriteWait))
			if !ok {
				// Hub closed the channel.
				c.conn.WriteMessage(websocket.CloseMessage, []byte{})
				return
			}

			w, err := c.conn.NextWriter(websocket.TextMessage)
			if err != nil {
				return
			}
			w.Write(msg)

			// Drain queued messages into the current write.
			n := len(c.send)
			for i := 0; i < n; i++ {
				w.Write([]byte("\n"))
				w.Write(<-c.send)
			}

			if err := w.Close(); err != nil {
				return
			}

		case <-ticker.C:
			c.conn.SetWriteDeadline(time.Now().Add(c.cfg.WriteWait))
			if err := c.conn.WriteMessage(websocket.PingMessage, nil); err != nil {
				return
			}
		}
	}
}

// handleMessage processes an inbound JSON message from the client.
func (c *Client) handleMessage(raw []byte) {
	var msg InboundMessage
	if err := json.Unmarshal(raw, &msg); err != nil {
		c.sendError("invalid JSON")
		return
	}

	switch msg.Type {
	case "subscribe":
		c.handleSubscribe(msg)
	case "unsubscribe":
		c.handleUnsubscribe(msg)
	case "ping":
		c.sendPong()
	default:
		c.sendError("unknown message type: " + msg.Type)
	}
}

// handleSubscribe subscribes the client to a room identified by channel:event_id.
func (c *Client) handleSubscribe(msg InboundMessage) {
	if msg.EventID == "" {
		c.sendError("invalid event_id")
		return
	}

	channelName := resolveChannelName(msg.Channel)
	if channelName == "" {
		c.sendError("invalid channel: " + msg.Channel)
		return
	}

	roomID := channelName + ":" + msg.EventID

	c.mu.Lock()
	c.rooms[roomID] = true
	c.mu.Unlock()

	c.hub.Subscribe(c, roomID)
}

// handleUnsubscribe removes the client from a room.
func (c *Client) handleUnsubscribe(msg InboundMessage) {
	if msg.EventID == "" {
		c.sendError("invalid event_id")
		return
	}

	channelName := resolveChannelName(msg.Channel)
	if channelName == "" {
		c.sendError("invalid channel: " + msg.Channel)
		return
	}

	roomID := channelName + ":" + msg.EventID

	c.mu.Lock()
	delete(c.rooms, roomID)
	c.mu.Unlock()

	c.hub.Unsubscribe(c, roomID)
}

// GetRooms returns a snapshot of the rooms this client is subscribed to.
func (c *Client) GetRooms() []string {
	c.mu.RLock()
	defer c.mu.RUnlock()
	rooms := make([]string, 0, len(c.rooms))
	for r := range c.rooms {
		rooms = append(rooms, r)
	}
	return rooms
}

// sendPong sends a pong response to the client.
func (c *Client) sendPong() {
	out := OutboundMessage{Type: "pong"}
	data, _ := json.Marshal(out)
	select {
	case c.send <- data:
	default:
	}
}

// sendError sends an error message to the client.
func (c *Client) sendError(message string) {
	out := OutboundMessage{Type: "error", Message: message}
	data, _ := json.Marshal(out)
	select {
	case c.send <- data:
	default:
	}
}

// resolveChannelName maps a user-facing channel name to the internal Redis
// channel prefix. Returns empty string if the channel is not recognized.
func resolveChannelName(channel string) string {
	switch channel {
	case "seats":
		return "seats"
	case "event_stats":
		return "event_stats"
	case "queue_position":
		return "queue"
	default:
		return ""
	}
}
