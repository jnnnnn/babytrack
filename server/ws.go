package main

import (
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"

	"github.com/gorilla/websocket"
)

var upgrader = websocket.Upgrader{
	CheckOrigin: func(r *http.Request) bool {
		return true // Allow all origins for now; tighten in production
	},
}

// Hub maintains connected clients grouped by family
type Hub struct {
	mu       sync.RWMutex
	families map[string]map[*Client]bool
	db       *DB
}

// Client represents a WebSocket connection
type Client struct {
	hub      *Hub
	conn     *websocket.Conn
	send     chan []byte
	familyID string
	label    string // from access link
}

func NewHub(db *DB) *Hub {
	return &Hub{
		families: make(map[string]map[*Client]bool),
		db:       db,
	}
}

// Register adds a client to its family room
func (h *Hub) Register(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.families[c.familyID] == nil {
		h.families[c.familyID] = make(map[*Client]bool)
	}
	h.families[c.familyID][c] = true

	h.broadcastPresenceLocked(c.familyID)
}

// Unregister removes a client
func (h *Hub) Unregister(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if clients, ok := h.families[c.familyID]; ok {
		delete(clients, c)
		if len(clients) == 0 {
			delete(h.families, c.familyID)
		} else {
			h.broadcastPresenceLocked(c.familyID)
		}
	}
	close(c.send)
}

// Broadcast sends a message to all clients in a family
func (h *Hub) Broadcast(familyID string, msg []byte, exclude *Client) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	clients := h.families[familyID]
	for c := range clients {
		if c != exclude {
			select {
			case c.send <- msg:
			default:
				// Client buffer full, skip
			}
		}
	}
}

func (h *Hub) broadcastPresenceLocked(familyID string) {
	clients := h.families[familyID]
	members := make([]string, 0, len(clients))
	for c := range clients {
		if c.label != "" {
			members = append(members, c.label)
		}
	}

	msg, _ := json.Marshal(map[string]any{
		"type":    "presence",
		"members": members,
	})

	for c := range clients {
		select {
		case c.send <- msg:
		default:
		}
	}
}

// WebSocket message types
type WSMessage struct {
	Type        string          `json:"type"`
	Action      string          `json:"action,omitempty"`
	Entry       json.RawMessage `json:"entry,omitempty"`
	Entries     json.RawMessage `json:"entries,omitempty"` // for bulk sync
	ID          string          `json:"id,omitempty"`
	Data        json.RawMessage `json:"data,omitempty"`
	SinceUpdate int64           `json:"since_update,omitempty"` // for incremental sync
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	log := loggerFromCtx(r.Context())

	// Auth via cookie
	cookie, err := r.Cookie("client_session")
	if err != nil {
		log.Debug("ws auth failed: no cookie", "error", err)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	link, err := s.db.ValidateAccessLink(cookie.Value)
	if err != nil {
		log.Debug("ws auth failed: invalid token", "token_prefix", cookie.Value[:min(8, len(cookie.Value))], "error", err)
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	log.Debug("ws auth success", "family", link.FamilyID, "label", link.Label)

	conn, err := upgrader.Upgrade(w, r, nil)
	if err != nil {
		loggerFromCtx(r.Context()).Error("websocket upgrade failed", "error", err)
		return
	}

	client := &Client{
		hub:      s.hub,
		conn:     conn,
		send:     make(chan []byte, 256),
		familyID: link.FamilyID,
		label:    link.Label,
	}

	s.hub.Register(client)

	// Send initial state
	s.sendInit(client)

	go client.writePump()
	go client.readPump(s)
}

func (s *Server) sendInit(c *Client) {
	entries, _ := s.db.GetEntries(c.familyID, 0)
	config, _ := s.db.GetConfig(c.familyID)

	msg, _ := json.Marshal(map[string]any{
		"type":    "init",
		"entries": entries,
		"config":  config,
	})
	c.send <- msg
}

func (c *Client) readPump(s *Server) {
	defer func() {
		c.hub.Unregister(c)
		c.conn.Close()
	}()

	for {
		_, message, err := c.conn.ReadMessage()
		if err != nil {
			break
		}

		var msg WSMessage
		if err := json.Unmarshal(message, &msg); err != nil {
			continue
		}

		switch msg.Type {
		case "entry":
			s.handleEntryMessage(c, msg)
		case "sync":
			s.handleSyncMessage(c, msg)
		case "config":
			s.handleConfigMessage(c, msg)
		case "ping":
			c.send <- []byte(`{"type":"pong"}`)
		}
	}
}

func (c *Client) writePump() {
	defer c.conn.Close()

	for msg := range c.send {
		if err := c.conn.WriteMessage(websocket.TextMessage, msg); err != nil {
			break
		}
	}
}

func (s *Server) handleEntryMessage(c *Client, msg WSMessage) {
	switch msg.Action {
	case "add", "update":
		var entry Entry
		if err := json.Unmarshal(msg.Entry, &entry); err != nil {
			return
		}
		entry.FamilyID = c.familyID

		if err := s.db.UpsertEntry(&entry); err != nil {
			slog.Error("failed to upsert entry", "error", err, "family_id", c.familyID)
			return
		}

		// Broadcast to other clients
		broadcast, _ := json.Marshal(map[string]any{
			"type":   "entry",
			"action": msg.Action,
			"entry":  entry,
		})
		s.hub.Broadcast(c.familyID, broadcast, c)

	case "delete":
		if err := s.db.DeleteEntry(c.familyID, msg.ID); err != nil {
			slog.Error("failed to delete entry", "error", err, "family_id", c.familyID, "entry_id", msg.ID)
			return
		}

		broadcast, _ := json.Marshal(map[string]any{
			"type":   "entry",
			"action": "delete",
			"id":     msg.ID,
		})
		s.hub.Broadcast(c.familyID, broadcast, c)
	}
}

func (s *Server) handleConfigMessage(c *Client, msg WSMessage) {
	if err := s.db.SaveConfig(c.familyID, string(msg.Data)); err != nil {
		slog.Error("failed to save config", "error", err, "family_id", c.familyID)
		return
	}

	broadcast, _ := json.Marshal(map[string]any{
		"type": "config",
		"data": msg.Data,
	})
	s.hub.Broadcast(c.familyID, broadcast, c)
}

// handleSyncMessage handles incremental sync requests from clients
// Client sends: {"type": "sync", "since_update": 1234567890, "entries": [...]}
// Server responds with entries newer than since_update
// Server also processes any entries the client sends
func (s *Server) handleSyncMessage(c *Client, msg WSMessage) {
	// First, process any entries the client is sending
	if len(msg.Entries) > 0 {
		var clientEntries []Entry
		if err := json.Unmarshal(msg.Entries, &clientEntries); err == nil {
			for _, e := range clientEntries {
				e.FamilyID = c.familyID
				if err := s.db.UpsertEntry(&e); err != nil {
					slog.Error("failed to upsert sync entry", "error", err, "family_id", c.familyID)
					continue
				}

				// Broadcast to other clients - use appropriate action based on deleted flag
				var broadcast []byte
				if e.Deleted {
					broadcast, _ = json.Marshal(map[string]any{
						"type":   "entry",
						"action": "delete",
						"id":     e.ID,
					})
				} else {
					broadcast, _ = json.Marshal(map[string]any{
						"type":   "entry",
						"action": "add",
						"entry":  e,
					})
				}
				s.hub.Broadcast(c.familyID, broadcast, c)
			}
		}
	}

	// Then send server entries newer than client's last update
	entries, err := s.db.GetEntries(c.familyID, msg.SinceUpdate)
	if err != nil {
		slog.Error("failed to get entries for sync", "error", err, "family_id", c.familyID)
		return
	}

	resp, _ := json.Marshal(map[string]any{
		"type":    "sync",
		"entries": entries,
	})
	c.send <- resp
}
