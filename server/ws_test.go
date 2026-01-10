package main

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

func TestWebSocketConnection(t *testing.T) {
	// Setup
	path := t.TempDir() + "/test.db"
	db, err := NewDB(path)
	if err != nil {
		t.Fatalf("failed to create db: %v", err)
	}
	defer db.Close()

	family, _ := db.CreateFamily("Test Baby", "")
	link, _ := db.CreateAccessLink(family.ID, "Test Client", nil)

	s := &Server{db: db, hub: NewHub(db)}

	// Create test server
	server := httptest.NewServer(http.HandlerFunc(s.handleWebSocket))
	defer server.Close()

	// Connect WebSocket
	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	dialer := websocket.Dialer{}
	header := http.Header{}
	header.Add("Cookie", "client_session="+link.Token)

	conn, resp, err := dialer.Dial(wsURL, header)
	if err != nil {
		t.Fatalf("failed to connect: %v (resp: %v)", err, resp)
	}
	defer conn.Close()

	// Should receive init and presence messages (order may vary)
	conn.SetReadDeadline(time.Now().Add(time.Second))
	gotInit := false
	for i := 0; i < 2; i++ {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			break
		}
		var m map[string]any
		json.Unmarshal(msg, &m)
		if m["type"] == "init" {
			gotInit = true
		}
	}

	if !gotInit {
		t.Error("expected init message")
	}
}

func TestWebSocketEntrySync(t *testing.T) {
	// Setup - use a fixed temp path that persists
	path := t.TempDir() + "/test.db"
	db, err := NewDB(path)
	if err != nil {
		t.Fatalf("failed to create db: %v", err)
	}
	defer db.Close()

	family, _ := db.CreateFamily("Test Baby", "")
	link1, _ := db.CreateAccessLink(family.ID, "Client 1", nil)
	link2, _ := db.CreateAccessLink(family.ID, "Client 2", nil)

	s := &Server{db: db, hub: NewHub(db)}

	server := httptest.NewServer(http.HandlerFunc(s.handleWebSocket))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	dialer := websocket.Dialer{}

	// Connect client 1
	header1 := http.Header{}
	header1.Add("Cookie", "client_session="+link1.Token)
	conn1, _, err := dialer.Dial(wsURL, header1)
	if err != nil {
		t.Fatalf("client1 failed to connect: %v", err)
	}
	defer conn1.Close()

	// Connect client 2
	header2 := http.Header{}
	header2.Add("Cookie", "client_session="+link2.Token)
	conn2, _, err := dialer.Dial(wsURL, header2)
	if err != nil {
		t.Fatalf("client2 failed to connect: %v", err)
	}
	defer conn2.Close()

	// Give time for connections to stabilize
	time.Sleep(100 * time.Millisecond)

	// Client 1 sends an entry
	entry := map[string]any{
		"type":   "entry",
		"action": "add",
		"entry": map[string]any{
			"id":    "test-entry-1",
			"ts":    time.Now().UnixMilli(),
			"type":  "feed",
			"value": "bottle",
		},
	}
	entryJSON, _ := json.Marshal(entry)
	conn1.WriteMessage(websocket.TextMessage, entryJSON)

	// Wait for db write and broadcast
	time.Sleep(100 * time.Millisecond)

	// Verify entry was persisted
	entries, _ := db.GetEntries(family.ID, 0)
	if len(entries) != 1 {
		t.Errorf("expected 1 entry in db, got %d", len(entries))
	}
	if len(entries) > 0 && entries[0].ID != "test-entry-1" {
		t.Errorf("expected entry id test-entry-1, got %s", entries[0].ID)
	}
}

func TestWebSocketUnauthorized(t *testing.T) {
	path := t.TempDir() + "/test.db"
	db, err := NewDB(path)
	if err != nil {
		t.Fatalf("failed to create db: %v", err)
	}
	defer db.Close()

	s := &Server{db: db, hub: NewHub(db)}

	// Test without cookie
	req := httptest.NewRequest("GET", "/ws", nil)
	w := httptest.NewRecorder()
	s.handleWebSocket(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}

	// Test with invalid cookie
	req = httptest.NewRequest("GET", "/ws", nil)
	req.AddCookie(&http.Cookie{Name: "client_session", Value: "invalid"})
	w = httptest.NewRecorder()
	s.handleWebSocket(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401 for invalid token, got %d", w.Code)
	}
}

func TestHubBroadcast(t *testing.T) {
	path := t.TempDir() + "/test.db"
	db, err := NewDB(path)
	if err != nil {
		t.Fatalf("failed to create db: %v", err)
	}
	defer db.Close()

	hub := NewHub(db)

	// Create mock clients
	client1 := &Client{
		hub:      hub,
		send:     make(chan []byte, 10),
		familyID: "family1",
		label:    "Client 1",
	}
	client2 := &Client{
		hub:      hub,
		send:     make(chan []byte, 10),
		familyID: "family1",
		label:    "Client 2",
	}
	client3 := &Client{
		hub:      hub,
		send:     make(chan []byte, 10),
		familyID: "family2", // different family
		label:    "Client 3",
	}

	hub.Register(client1)
	hub.Register(client2)
	hub.Register(client3)

	// Clear presence messages
	<-client1.send
	<-client1.send
	<-client2.send
	<-client3.send

	// Broadcast to family1
	hub.Broadcast("family1", []byte("test message"), client1)

	// Client 2 should receive, client 1 and 3 should not
	select {
	case msg := <-client2.send:
		if string(msg) != "test message" {
			t.Errorf("unexpected message: %s", msg)
		}
	case <-time.After(100 * time.Millisecond):
		t.Error("client2 should have received message")
	}

	select {
	case <-client1.send:
		t.Error("client1 should not receive own message")
	case <-time.After(50 * time.Millisecond):
		// expected
	}

	select {
	case <-client3.send:
		t.Error("client3 in different family should not receive")
	case <-time.After(50 * time.Millisecond):
		// expected
	}
}
