package ws

import (
	"log"
	"sync"
)

// Room represents a pub/sub room for a specific channel and event.
// For example, "seats:abc123" or "event_stats:abc123".
type Room struct {
	id      string
	clients map[*Client]struct{}
	mu      sync.RWMutex
}

// NewRoom creates a new Room with the given ID.
func NewRoom(id string) *Room {
	return &Room{
		id:      id,
		clients: make(map[*Client]struct{}),
	}
}

// Add registers a client in this room.
func (r *Room) Add(c *Client) {
	r.mu.Lock()
	r.clients[c] = struct{}{}
	r.mu.Unlock()
}

// Remove deregisters a client from this room. Returns true if the room is now empty.
func (r *Room) Remove(c *Client) bool {
	r.mu.Lock()
	delete(r.clients, c)
	empty := len(r.clients) == 0
	r.mu.Unlock()
	return empty
}

// Broadcast sends a message to every client in the room. If a client's send
// buffer is full, the client is removed from the room and its channel is closed
// to trigger disconnect cleanup.
func (r *Room) Broadcast(msg []byte) {
	r.mu.RLock()
	clients := make([]*Client, 0, len(r.clients))
	for c := range r.clients {
		clients = append(clients, c)
	}
	r.mu.RUnlock()

	var slow []*Client
	for _, c := range clients {
		select {
		case c.send <- msg:
		default:
			slow = append(slow, c)
		}
	}

	if len(slow) > 0 {
		r.mu.Lock()
		for _, c := range slow {
			delete(r.clients, c)
			close(c.send)
			log.Printf("disconnected slow client from room %s", r.id)
		}
		r.mu.Unlock()
	}
}

// Len returns the number of clients in the room.
func (r *Room) Len() int {
	r.mu.RLock()
	defer r.mu.RUnlock()
	return len(r.clients)
}
