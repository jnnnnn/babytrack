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
		return true
	},
}

type Hub struct {
	mu       sync.RWMutex
	families map[string]map[*Client]bool
	db       *DB
	push     *pushManager
}

type Client struct {
	hub      *Hub
	conn     *websocket.Conn
	send     chan []byte
	familyID string
	label    string
	token    string // access link token
}

func NewHub(db *DB, push *pushManager) *Hub {
	return &Hub{
		families: make(map[string]map[*Client]bool),
		db:       db,
		push:     push,
	}
}

func (h *Hub) Register(c *Client) {
	h.mu.Lock()
	defer h.mu.Unlock()

	if h.families[c.familyID] == nil {
		h.families[c.familyID] = make(map[*Client]bool)
	}
	h.families[c.familyID][c] = true

	h.broadcastPresenceLocked(c.familyID)
}

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

func (h *Hub) Broadcast(familyID string, msg []byte, exclude *Client) {
	h.mu.RLock()
	defer h.mu.RUnlock()

	clients := h.families[familyID]
	for c := range clients {
		if c != exclude {
			select {
			case c.send <- msg:
			default:
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

type WSMessage struct {
	Type        string          `json:"type"`
	Action      string          `json:"action,omitempty"`
	Entry       json.RawMessage `json:"entry,omitempty"`
	Entries     json.RawMessage `json:"entries,omitempty"`
	ID          string          `json:"id,omitempty"`
	Data        json.RawMessage `json:"data,omitempty"`
	SinceUpdate int64           `json:"since_update,omitempty"`
	Cursor      int64           `json:"cursor,omitempty"`
	Limit       int             `json:"limit,omitempty"`
}

func (s *Server) handleWebSocket(w http.ResponseWriter, r *http.Request) {
	log := loggerFromCtx(r.Context())

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
		token:    cookie.Value,
	}

	s.hub.Register(client)

	s.sendInit(client)

	go client.writePump()
	go client.readPump(s)
}

func (s *Server) sendInit(c *Client) {
	config, _ := s.db.GetConfig(c.familyID)

	vapidPublicKey := ""
	if s.hub.push != nil {
		vapidPublicKey = s.hub.push.publicKey()
	}

	msg, _ := json.Marshal(map[string]any{
		"type":             "init",
		"config":           config,
		"vapid_public_key": vapidPublicKey,
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
		case "sync", "sync_request":
			s.handleSyncMessage(c, msg)
		case "config":
			s.handleConfigMessage(c, msg)
		case "push_subscribe":
			s.handlePushSubscribe(c, msg)
		case "push_unsubscribe":
			s.handlePushUnsubscribe(c)
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

		ack, _ := json.Marshal(map[string]any{
			"type": "entry_ack",
			"id":   entry.ID,
			"seq":  entry.Seq,
		})
		c.send <- ack

		broadcast, _ := json.Marshal(map[string]any{
			"type":   "entry",
			"action": msg.Action,
			"entry":  entry,
		})
		s.hub.Broadcast(c.familyID, broadcast, c)

		s.maybeSendPush(c, entry.Type, entry.Value)

	case "delete":
		seq, err := s.db.DeleteEntry(c.familyID, msg.ID)
		if err != nil {
			slog.Error("failed to delete entry", "error", err, "family_id", c.familyID, "entry_id", msg.ID)
			return
		}

		ack, _ := json.Marshal(map[string]any{
			"type": "entry_ack",
			"id":   msg.ID,
			"seq":  seq,
		})
		c.send <- ack

		broadcast, _ := json.Marshal(map[string]any{
			"type":   "entry",
			"action": "delete",
			"id":     msg.ID,
			"seq":    seq,
		})
		s.hub.Broadcast(c.familyID, broadcast, c)
	}
}

func (s *Server) maybeSendPush(c *Client, entryType, entryValue string) {
	if s.hub.push == nil {
		return
	}

	config, err := s.db.GetConfig(c.familyID)
	if err != nil {
		return
	}

	notifyMap := parseNotifyConfig(config)
	if !notifyMap[entryValue] {
		return
	}

	subs, err := s.db.GetPushSubscriptions(c.familyID, c.token)
	if err != nil {
		slog.Error("failed to get push subscriptions", "error", err, "family_id", c.familyID)
		return
	}

	title := c.label
	if title == "" {
		title = "BabyTrack"
	}
	body := entryType + ": " + entryValue

	for _, sub := range subs {
		go func(sub PushSubscription) {
			if err := s.hub.push.sendPushNotification(&sub, title, body); err != nil {
				slog.Warn("push send failed", "error", err)
			}
		}(sub)
	}
}

func (s *Server) handlePushSubscribe(c *Client, msg WSMessage) {
	var sub PushSubscription
	if err := json.Unmarshal(msg.Data, &sub); err != nil {
		slog.Warn("invalid push subscribe data", "error", err)
		return
	}
	sub.FamilyID = c.familyID
	sub.Token = c.token

	if err := s.db.SavePushSubscription(&sub); err != nil {
		slog.Error("failed to save push subscription", "error", err, "family_id", c.familyID)
		return
	}

	ack, _ := json.Marshal(map[string]any{
		"type": "push_subscribe_ack",
	})
	c.send <- ack

	slog.Debug("push subscription saved", "family_id", c.familyID, "token", c.token[:min(8, len(c.token))])
}

func (s *Server) handlePushUnsubscribe(c *Client) {
	if err := s.db.DeletePushSubscription(c.familyID, c.token); err != nil {
		slog.Error("failed to delete push subscription", "error", err, "family_id", c.familyID)
		return
	}

	ack, _ := json.Marshal(map[string]any{
		"type": "push_unsubscribe_ack",
	})
	c.send <- ack

	slog.Debug("push subscription removed", "family_id", c.familyID, "token", c.token[:min(8, len(c.token))])
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

func (s *Server) handleSyncMessage(c *Client, msg WSMessage) {
	if len(msg.Entries) > 0 {
		var clientEntries []Entry
		if err := json.Unmarshal(msg.Entries, &clientEntries); err == nil {
			for _, e := range clientEntries {
				e.FamilyID = c.familyID
				if err := s.db.UpsertEntry(&e); err != nil {
					slog.Error("failed to upsert sync entry", "error", err, "family_id", c.familyID)
					continue
				}

				ack, _ := json.Marshal(map[string]any{
					"type": "entry_ack",
					"id":   e.ID,
					"seq":  e.Seq,
				})
				c.send <- ack

				var broadcast []byte
				if e.Deleted {
					broadcast, _ = json.Marshal(map[string]any{
						"type":   "entry",
						"action": "delete",
						"id":     e.ID,
						"seq":    e.Seq,
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

	cursor := msg.Cursor
	limit := msg.Limit
	if limit <= 0 {
		limit = 2000
	}

	for {
		entries, hasMore, err := s.db.GetEntriesSinceCursor(c.familyID, cursor, limit)
		if err != nil {
			slog.Error("failed to get entries for sync", "error", err, "family_id", c.familyID)
			return
		}

		newCursor := cursor
		if len(entries) > 0 {
			newCursor = entries[len(entries)-1].Seq
		}

		resp, _ := json.Marshal(map[string]any{
			"type":     "sync_response",
			"entries":  entries,
			"cursor":   newCursor,
			"has_more": hasMore,
		})
		c.send <- resp

		if !hasMore {
			break
		}
		cursor = newCursor
	}
}
