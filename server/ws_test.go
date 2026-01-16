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

func init() {
	initLogger()
}
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

func TestIncrementalSync(t *testing.T) {
	path := t.TempDir() + "/test.db"
	db, err := NewDB(path)
	if err != nil {
		t.Fatalf("failed to create db: %v", err)
	}
	defer db.Close()

	family, _ := db.CreateFamily("Test Baby", "")

	// Create some entries with different timestamps
	entry1 := &Entry{ID: "entry-1", FamilyID: family.ID, Ts: 1000, Type: "feed", Value: "bottle"}
	entry2 := &Entry{ID: "entry-2", FamilyID: family.ID, Ts: 2000, Type: "sleep", Value: "nap"}
	db.UpsertEntry(entry1)
	time.Sleep(10 * time.Millisecond) // ensure different updated_at
	db.UpsertEntry(entry2)

	// Get entries since entry1's update time
	entries, err := db.GetEntries(family.ID, entry1.UpdatedAt)
	if err != nil {
		t.Fatalf("failed to get entries: %v", err)
	}

	// Should only get entry2
	if len(entries) != 1 {
		t.Errorf("expected 1 entry, got %d", len(entries))
	}
	if len(entries) > 0 && entries[0].ID != "entry-2" {
		t.Errorf("expected entry-2, got %s", entries[0].ID)
	}

	// Get all entries
	allEntries, _ := db.GetEntries(family.ID, 0)
	if len(allEntries) != 2 {
		t.Errorf("expected 2 entries, got %d", len(allEntries))
	}
}

func TestDeleteEntrySync(t *testing.T) {
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

	// Wait for init messages on both clients
	conn1.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	conn2.SetReadDeadline(time.Now().Add(500 * time.Millisecond))

	// Drain until we get init for both
	for {
		_, msg, err := conn1.ReadMessage()
		if err != nil {
			t.Fatalf("client1 failed to receive init: %v", err)
		}
		var m map[string]any
		json.Unmarshal(msg, &m)
		if m["type"] == "init" {
			break
		}
	}
	for {
		_, msg, err := conn2.ReadMessage()
		if err != nil {
			t.Fatalf("client2 failed to receive init: %v", err)
		}
		var m map[string]any
		json.Unmarshal(msg, &m)
		if m["type"] == "init" {
			break
		}
	}

	// Client 1 adds an entry
	addMsg := map[string]any{
		"type":   "entry",
		"action": "add",
		"entry": map[string]any{
			"id":    "delete-test-entry",
			"ts":    time.Now().UnixMilli(),
			"type":  "feed",
			"value": "bottle",
		},
	}
	addJSON, _ := json.Marshal(addMsg)
	conn1.WriteMessage(websocket.TextMessage, addJSON)

	time.Sleep(100 * time.Millisecond)

	// Client 2 receives the add broadcast - drain it
	conn2.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	_, _, err = conn2.ReadMessage()
	if err != nil {
		t.Fatalf("client2 failed to receive add broadcast: %v", err)
	}

	// Verify entry exists
	entries, _ := db.GetEntries(family.ID, 0)
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if entries[0].Deleted {
		t.Error("entry should not be deleted yet")
	}

	// Client 1 deletes the entry
	deleteMsg := map[string]any{
		"type":   "entry",
		"action": "delete",
		"id":     "delete-test-entry",
	}
	deleteJSON, _ := json.Marshal(deleteMsg)
	conn1.WriteMessage(websocket.TextMessage, deleteJSON)

	time.Sleep(100 * time.Millisecond)

	// Verify entry is marked as deleted in DB
	entries, _ = db.GetEntries(family.ID, 0)
	if len(entries) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(entries))
	}
	if !entries[0].Deleted {
		t.Error("entry should be marked as deleted")
	}

	// Client 2 should receive delete broadcast
	conn2.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	_, msg, err := conn2.ReadMessage()
	if err != nil {
		t.Fatalf("client2 failed to receive delete broadcast: %v", err)
	}

	var received map[string]any
	if err := json.Unmarshal(msg, &received); err != nil {
		t.Fatalf("failed to parse broadcast: %v", err)
	}

	if received["type"] != "entry" {
		t.Errorf("expected type=entry, got %v", received["type"])
	}
	if received["action"] != "delete" {
		t.Errorf("expected action=delete, got %v", received["action"])
	}
	if received["id"] != "delete-test-entry" {
		t.Errorf("expected id=delete-test-entry, got %v", received["id"])
	}
}

func TestDeletedEntrySyncToNewClient(t *testing.T) {
	path := t.TempDir() + "/test.db"
	db, err := NewDB(path)
	if err != nil {
		t.Fatalf("failed to create db: %v", err)
	}
	defer db.Close()

	family, _ := db.CreateFamily("Test Baby", "")
	link, _ := db.CreateAccessLink(family.ID, "Client", nil)

	// Create an entry and then delete it
	entry := &Entry{ID: "already-deleted", FamilyID: family.ID, Ts: 1000, Type: "feed", Value: "bottle"}
	db.UpsertEntry(entry)
	db.DeleteEntry(family.ID, "already-deleted")

	s := &Server{db: db, hub: NewHub(db)}

	server := httptest.NewServer(http.HandlerFunc(s.handleWebSocket))
	defer server.Close()

	wsURL := "ws" + strings.TrimPrefix(server.URL, "http")
	dialer := websocket.Dialer{}

	header := http.Header{}
	header.Add("Cookie", "client_session="+link.Token)
	conn, _, err := dialer.Dial(wsURL, header)
	if err != nil {
		t.Fatalf("failed to connect: %v", err)
	}
	defer conn.Close()

	// Read init message (skip presence messages)
	conn.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	var initMsg map[string]any
	for {
		_, msg, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("failed to read init: %v", err)
		}
		if err := json.Unmarshal(msg, &initMsg); err != nil {
			t.Fatalf("failed to parse message: %v", err)
		}
		if initMsg["type"] == "init" {
			break
		}
	}

	// Init should include the deleted entry with deleted=true
	entriesRaw, ok := initMsg["entries"].([]any)
	if !ok {
		t.Fatalf("expected entries array in init, got %T", initMsg["entries"])
	}
	if len(entriesRaw) != 1 {
		t.Fatalf("expected 1 entry in init, got %d", len(entriesRaw))
	}

	entryData := entriesRaw[0].(map[string]any)
	if entryData["deleted"] != true {
		t.Errorf("expected entry to have deleted=true, got %v", entryData["deleted"])
	}
}

func TestSyncDeletedEntryBroadcast(t *testing.T) {
	// Test that when client1 syncs a deleted entry, client2 receives a delete action
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

	// Connect both clients
	header1 := http.Header{}
	header1.Add("Cookie", "client_session="+link1.Token)
	conn1, _, err := dialer.Dial(wsURL, header1)
	if err != nil {
		t.Fatalf("client1 failed to connect: %v", err)
	}
	defer conn1.Close()

	header2 := http.Header{}
	header2.Add("Cookie", "client_session="+link2.Token)
	conn2, _, err := dialer.Dial(wsURL, header2)
	if err != nil {
		t.Fatalf("client2 failed to connect: %v", err)
	}
	defer conn2.Close()

	// Wait for init messages
	conn1.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	conn2.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	for {
		_, msg, _ := conn1.ReadMessage()
		var m map[string]any
		json.Unmarshal(msg, &m)
		if m["type"] == "init" {
			break
		}
	}
	for {
		_, msg, _ := conn2.ReadMessage()
		var m map[string]any
		json.Unmarshal(msg, &m)
		if m["type"] == "init" {
			break
		}
	}

	// Client 1 sends a sync message with a deleted entry
	syncMsg := map[string]any{
		"type":         "sync",
		"since_update": 0,
		"entries": []map[string]any{
			{
				"id":         "synced-deleted-entry",
				"ts":         time.Now().UnixMilli(),
				"type":       "feed",
				"value":      "bottle",
				"deleted":    true,
				"updated_at": time.Now().UnixMilli(),
			},
		},
	}
	syncJSON, _ := json.Marshal(syncMsg)
	conn1.WriteMessage(websocket.TextMessage, syncJSON)

	time.Sleep(100 * time.Millisecond)

	// Client 2 should receive a delete broadcast (not an add)
	conn2.SetReadDeadline(time.Now().Add(500 * time.Millisecond))
	_, msg, err := conn2.ReadMessage()
	if err != nil {
		t.Fatalf("client2 failed to receive broadcast: %v", err)
	}

	var received map[string]any
	if err := json.Unmarshal(msg, &received); err != nil {
		t.Fatalf("failed to parse broadcast: %v", err)
	}

	if received["type"] != "entry" {
		t.Errorf("expected type=entry, got %v", received["type"])
	}
	if received["action"] != "delete" {
		t.Errorf("expected action=delete for synced deleted entry, got %v", received["action"])
	}
	if received["id"] != "synced-deleted-entry" {
		t.Errorf("expected id=synced-deleted-entry, got %v", received["id"])
	}
}
