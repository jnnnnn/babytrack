package main

import (
	"encoding/json"
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
	if version != 1 {
		t.Errorf("expected version 1, got %d", version)
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
