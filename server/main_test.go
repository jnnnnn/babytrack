package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
)

func TestHealthHandler(t *testing.T) {
	req := httptest.NewRequest("GET", "/health", nil)
	w := httptest.NewRecorder()

	healthHandler(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected status 200, got %d", w.Code)
	}

	var resp struct {
		OK      bool   `json:"ok"`
		Version string `json:"version"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &resp); err != nil {
		t.Fatalf("failed to parse response: %v", err)
	}

	if !resp.OK {
		t.Error("expected ok=true")
	}
	if resp.Version != version {
		t.Errorf("expected version=%s, got %s", version, resp.Version)
	}
}

func TestDB(t *testing.T) {
	path := t.TempDir() + "/test.db"
	db, err := NewDB(path)
	if err != nil {
		t.Fatalf("failed to create db: %v", err)
	}
	defer db.Close()
	defer os.Remove(path)

	// Verify schema was created
	var count int
	err = db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='entries'").Scan(&count)
	if err != nil {
		t.Fatalf("failed to query: %v", err)
	}
	if count != 1 {
		t.Error("entries table not created")
	}
}

func TestSeqIncrement(t *testing.T) {
	path := t.TempDir() + "/test.db"
	db, err := NewDB(path)
	if err != nil {
		t.Fatalf("failed to create db: %v", err)
	}
	defer db.Close()
	defer os.Remove(path)

	// Create a family
	family, err := db.CreateFamily("Test Baby", "")
	if err != nil {
		t.Fatalf("failed to create family: %v", err)
	}

	// Verify initial family seq is 0
	var familySeq int64
	err = db.QueryRow("SELECT seq FROM families WHERE id = ?", family.ID).Scan(&familySeq)
	if err != nil {
		t.Fatalf("failed to query family seq: %v", err)
	}
	if familySeq != 0 {
		t.Errorf("expected initial family seq=0, got %d", familySeq)
	}

	// Create first entry
	entry1 := &Entry{ID: "entry-1", FamilyID: family.ID, Ts: 1000, Type: "feed", Value: "bf"}
	if err := db.UpsertEntry(entry1); err != nil {
		t.Fatalf("failed to upsert entry1: %v", err)
	}
	if entry1.Seq != 1 {
		t.Errorf("expected entry1.Seq=1, got %d", entry1.Seq)
	}

	// Create second entry
	entry2 := &Entry{ID: "entry-2", FamilyID: family.ID, Ts: 2000, Type: "sleep", Value: "nap"}
	if err := db.UpsertEntry(entry2); err != nil {
		t.Fatalf("failed to upsert entry2: %v", err)
	}
	if entry2.Seq != 2 {
		t.Errorf("expected entry2.Seq=2, got %d", entry2.Seq)
	}

	// Update first entry - should get new seq
	entry1.Value = "bottle"
	if err := db.UpsertEntry(entry1); err != nil {
		t.Fatalf("failed to update entry1: %v", err)
	}
	if entry1.Seq != 3 {
		t.Errorf("expected updated entry1.Seq=3, got %d", entry1.Seq)
	}

	// Delete entry - should get new seq
	deleteSeq, err := db.DeleteEntry(family.ID, "entry-2")
	if err != nil {
		t.Fatalf("failed to delete entry: %v", err)
	}
	if deleteSeq != 4 {
		t.Errorf("expected deleteSeq=4, got %d", deleteSeq)
	}

	// Verify family seq is now 4
	err = db.QueryRow("SELECT seq FROM families WHERE id = ?", family.ID).Scan(&familySeq)
	if err != nil {
		t.Fatalf("failed to query family seq: %v", err)
	}
	if familySeq != 4 {
		t.Errorf("expected family seq=4, got %d", familySeq)
	}

	// Query entries since cursor=0 and verify seq values
	entries, err := db.GetEntries(family.ID, 0)
	if err != nil {
		t.Fatalf("failed to get entries: %v", err)
	}
	if len(entries) != 2 {
		t.Errorf("expected 2 entries, got %d", len(entries))
	}
	// Check entries have proper seq values
	for _, e := range entries {
		if e.ID == "entry-1" && e.Seq != 3 {
			t.Errorf("expected entry-1 seq=3, got %d", e.Seq)
		}
		if e.ID == "entry-2" && e.Seq != 4 {
			t.Errorf("expected entry-2 seq=4, got %d", e.Seq)
		}
	}
}

func TestGetEntriesSinceCursor(t *testing.T) {
	path := t.TempDir() + "/test.db"
	db, err := NewDB(path)
	if err != nil {
		t.Fatalf("failed to create db: %v", err)
	}
	defer db.Close()
	defer os.Remove(path)

	// Create a family
	family, err := db.CreateFamily("Test Baby", "")
	if err != nil {
		t.Fatalf("failed to create family: %v", err)
	}

	// Create 5 entries
	for i := 1; i <= 5; i++ {
		entry := &Entry{
			ID:       fmt.Sprintf("entry-%d", i),
			FamilyID: family.ID,
			Ts:       int64(i * 1000),
			Type:     "feed",
			Value:    fmt.Sprintf("value-%d", i),
		}
		if err := db.UpsertEntry(entry); err != nil {
			t.Fatalf("failed to create entry %d: %v", i, err)
		}
	}

	// Test cursor=0 returns all entries
	entries, hasMore, err := db.GetEntriesSinceCursor(family.ID, 0, 10)
	if err != nil {
		t.Fatalf("failed to get entries: %v", err)
	}
	if len(entries) != 5 {
		t.Errorf("expected 5 entries, got %d", len(entries))
	}
	if hasMore {
		t.Error("expected hasMore=false")
	}

	// Test cursor=2 returns entries 3,4,5
	entries, hasMore, err = db.GetEntriesSinceCursor(family.ID, 2, 10)
	if err != nil {
		t.Fatalf("failed to get entries: %v", err)
	}
	if len(entries) != 3 {
		t.Errorf("expected 3 entries (seq 3,4,5), got %d", len(entries))
	}
	if entries[0].Seq != 3 {
		t.Errorf("expected first entry seq=3, got %d", entries[0].Seq)
	}

	// Test pagination with limit=2
	entries, hasMore, err = db.GetEntriesSinceCursor(family.ID, 0, 2)
	if err != nil {
		t.Fatalf("failed to get entries: %v", err)
	}
	if len(entries) != 2 {
		t.Errorf("expected 2 entries, got %d", len(entries))
	}
	if !hasMore {
		t.Error("expected hasMore=true")
	}
	if entries[1].Seq != 2 {
		t.Errorf("expected last entry seq=2, got %d", entries[1].Seq)
	}

	// Continue pagination from cursor=2
	entries, hasMore, err = db.GetEntriesSinceCursor(family.ID, 2, 2)
	if err != nil {
		t.Fatalf("failed to get entries: %v", err)
	}
	if len(entries) != 2 {
		t.Errorf("expected 2 entries, got %d", len(entries))
	}
	if !hasMore {
		t.Error("expected hasMore=true")
	}

	// Final page
	entries, hasMore, err = db.GetEntriesSinceCursor(family.ID, 4, 2)
	if err != nil {
		t.Fatalf("failed to get entries: %v", err)
	}
	if len(entries) != 1 {
		t.Errorf("expected 1 entry, got %d", len(entries))
	}
	if hasMore {
		t.Error("expected hasMore=false")
	}
}

func TestDBMigrationIdempotent(t *testing.T) {
	path := t.TempDir() + "/test.db"

	// Run migrations twice
	db1, err := NewDB(path)
	if err != nil {
		t.Fatalf("first open failed: %v", err)
	}
	db1.Close()

	db2, err := NewDB(path)
	if err != nil {
		t.Fatalf("second open failed: %v", err)
	}
	defer db2.Close()

	var version int
	err = db2.QueryRow("SELECT MAX(version) FROM schema_version").Scan(&version)
	if err != nil {
		t.Fatalf("failed to query version: %v", err)
	}
	if version != 2 {
		t.Errorf("expected version 2, got %d", version)
	}
}

func TestConfigHandling(t *testing.T) {
	path := t.TempDir() + "/test.db"
	db, err := NewDB(path)
	if err != nil {
		t.Fatalf("failed to create db: %v", err)
	}
	defer db.Close()
	defer os.Remove(path)

	// Insert a configuration
	config := `[
		{
			"category": "sleep",
			"stateful": true,
			"buttons": [
				{"label": "sleeping", "timing": true, "counted": true},
				{"label": "awake", "timing": true, "counted": false}
			]
		}
	]`
	err = db.SaveConfig("family1", config)
	if err != nil {
		t.Fatalf("failed to save config: %v", err)
	}

	// Retrieve the configuration
	savedConfig, err := db.GetConfig("family1")
	if err != nil {
		t.Fatalf("failed to get config: %v", err)
	}

	if savedConfig != config {
		t.Errorf("retrieved config does not match: got %v, want %v", savedConfig, config)
	}
}

func TestHandleClientLog(t *testing.T) {
	initLogger()

	tests := []struct {
		name       string
		body       string
		wantStatus int
	}{
		{
			name:       "valid error log",
			body:       `[{"level":"error","message":"test error","url":"http://localhost/","family":"test-family"}]`,
			wantStatus: http.StatusNoContent,
		},
		{
			name:       "valid warn log",
			body:       `[{"level":"warn","message":"test warning","url":"http://localhost/","family":""}]`,
			wantStatus: http.StatusNoContent,
		},
		{
			name:       "valid info log",
			body:       `[{"level":"info","message":"[WS Sync] connected","url":"http://localhost/","family":"fam1"}]`,
			wantStatus: http.StatusNoContent,
		},
		{
			name:       "multiple logs",
			body:       `[{"level":"error","message":"err1"},{"level":"warn","message":"warn1"}]`,
			wantStatus: http.StatusNoContent,
		},
		{
			name:       "invalid json",
			body:       `{invalid`,
			wantStatus: http.StatusBadRequest,
		},
		{
			name:       "empty array",
			body:       `[]`,
			wantStatus: http.StatusNoContent,
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req := httptest.NewRequest("POST", "/log", bytes.NewBufferString(tt.body))
			req.Header.Set("Content-Type", "application/json")
			w := httptest.NewRecorder()

			handleClientLog(w, req)

			if w.Code != tt.wantStatus {
				t.Errorf("expected status %d, got %d", tt.wantStatus, w.Code)
			}
		})
	}
}
