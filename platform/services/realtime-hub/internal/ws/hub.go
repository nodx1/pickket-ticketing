package ws

import (
	"log"
	"sync"
	"sync/atomic"
)

// Hub is the central connection manager. It maintains a registry of rooms and
// handles client registration/unregistration via channels for goroutine safety.
type Hub struct {
	rooms        map[string]*Room
	mu           sync.RWMutex
	register     chan *Client
	unregister   chan *Client
	clientCount  atomic.Int64
}

// NewHub creates a new Hub.
func NewHub() *Hub {
	return &Hub{
		rooms:      make(map[string]*Room),
		register:   make(chan *Client, 256),
		unregister: make(chan *Client, 256),
	}
}

// Run starts the hub event loop. It should be called in its own goroutine.
func (h *Hub) Run() {
	for {
		select {
		case <-h.register:
			h.clientCount.Add(1)
			log.Printf("client registered (total: %d)", h.clientCount.Load())

		case client := <-h.unregister:
			h.removeClientFromAllRooms(client)
			h.clientCount.Add(-1)
			log.Printf("client unregistered (total: %d)", h.clientCount.Load())
		}
	}
}

// Register queues a new client for registration.
func (h *Hub) Register(c *Client) {
	h.register <- c
}

// Unregister queues a client for removal.
func (h *Hub) Unregister(c *Client) {
	h.unregister <- c
}

// Subscribe adds a client to the specified room, creating the room if needed.
func (h *Hub) Subscribe(c *Client, roomID string) {
	h.mu.Lock()
	room, ok := h.rooms[roomID]
	if !ok {
		room = NewRoom(roomID)
		h.rooms[roomID] = room
		log.Printf("room created: %s", roomID)
	}
	h.mu.Unlock()
	room.Add(c)
}

// Unsubscribe removes a client from the specified room. If the room becomes
// empty it is deleted from the registry.
func (h *Hub) Unsubscribe(c *Client, roomID string) {
	h.mu.RLock()
	room, ok := h.rooms[roomID]
	h.mu.RUnlock()
	if !ok {
		return
	}

	if empty := room.Remove(c); empty {
		h.mu.Lock()
		// Double-check under write lock to avoid race.
		if room.Len() == 0 {
			delete(h.rooms, roomID)
			log.Printf("room removed: %s", roomID)
		}
		h.mu.Unlock()
	}
}

// BroadcastToRoom sends a message to all clients in the specified room.
func (h *Hub) BroadcastToRoom(roomID string, msg []byte) {
	h.mu.RLock()
	room, ok := h.rooms[roomID]
	h.mu.RUnlock()
	if !ok {
		return
	}
	room.Broadcast(msg)
}

// ClientCount returns the current number of connected clients.
func (h *Hub) ClientCount() int64 {
	return h.clientCount.Load()
}

// RoomCount returns the current number of active rooms.
func (h *Hub) RoomCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.rooms)
}

// removeClientFromAllRooms removes the client from every room it was subscribed to.
func (h *Hub) removeClientFromAllRooms(c *Client) {
	rooms := c.GetRooms()
	for _, roomID := range rooms {
		h.Unsubscribe(c, roomID)
	}
}
