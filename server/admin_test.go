package main

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func setupTestServer(t *testing.T) (*Server, func()) {
	t.Helper()
	path := t.TempDir() + "/test.db"
	db, err := NewDB(path)
	if err != nil {
		t.Fatalf("failed to create db: %v", err)
	}

	// Create test admin
	if err := db.EnsureAdmin("testadmin", "testpass"); err != nil {
		t.Fatalf("failed to create admin: %v", err)
	}

	s := &Server{db: db}
	cleanup := func() {
		db.Close()
		os.Remove(path)
	}
	return s, cleanup
}

func TestAdminLogin(t *testing.T) {
	s, cleanup := setupTestServer(t)
	defer cleanup()

	// Test successful login
	body := `{"username":"testadmin","password":"testpass"}`
	req := httptest.NewRequest("POST", "/admin/login", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	s.adminLogin(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	cookies := w.Result().Cookies()
	var found bool
	for _, c := range cookies {
		if c.Name == "admin_session" && c.Value != "" {
			found = true
		}
	}
	if !found {
		t.Error("expected admin_session cookie to be set")
	}
}

func TestAdminLoginBadPassword(t *testing.T) {
	s, cleanup := setupTestServer(t)
	defer cleanup()

	body := `{"username":"testadmin","password":"wrong"}`
	req := httptest.NewRequest("POST", "/admin/login", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	w := httptest.NewRecorder()

	s.adminLogin(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestFamilyCRUD(t *testing.T) {
	s, cleanup := setupTestServer(t)
	defer cleanup()

	// Login first
	token, _ := s.db.CreateAdminSession("admin", 24*3600*1000)
	cookie := &http.Cookie{Name: "admin_session", Value: token}

	// Create family
	body := `{"name":"Test Baby","notes":"Test notes"}`
	req := httptest.NewRequest("POST", "/admin/families", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	req.AddCookie(cookie)
	w := httptest.NewRecorder()

	s.adminRequired(s.createFamily)(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("create expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var created Family
	json.Unmarshal(w.Body.Bytes(), &created)

	if created.Name != "Test Baby" {
		t.Errorf("expected name 'Test Baby', got %s", created.Name)
	}

	// Get family
	req = httptest.NewRequest("GET", "/admin/families/"+created.ID, nil)
	req.SetPathValue("id", created.ID)
	req.AddCookie(cookie)
	w = httptest.NewRecorder()

	s.adminRequired(s.getFamily)(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("get expected 200, got %d", w.Code)
	}

	// List families
	req = httptest.NewRequest("GET", "/admin/families", nil)
	req.AddCookie(cookie)
	w = httptest.NewRecorder()

	s.adminRequired(s.listFamilies)(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("list expected 200, got %d", w.Code)
	}

	var families []Family
	json.Unmarshal(w.Body.Bytes(), &families)
	if len(families) != 1 {
		t.Errorf("expected 1 family, got %d", len(families))
	}

	// Update family
	body = `{"name":"Updated Baby"}`
	req = httptest.NewRequest("PATCH", "/admin/families/"+created.ID, bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	req.SetPathValue("id", created.ID)
	req.AddCookie(cookie)
	w = httptest.NewRecorder()

	s.adminRequired(s.updateFamily)(w, req)

	if w.Code != http.StatusOK {
		t.Errorf("update expected 200, got %d", w.Code)
	}

	var updated Family
	json.Unmarshal(w.Body.Bytes(), &updated)
	if updated.Name != "Updated Baby" {
		t.Errorf("expected name 'Updated Baby', got %s", updated.Name)
	}
}

func TestAccessLinks(t *testing.T) {
	s, cleanup := setupTestServer(t)
	defer cleanup()

	// Create a family first
	family, _ := s.db.CreateFamily("Test Baby", "")
	token, _ := s.db.CreateAdminSession("admin", 24*3600*1000)
	cookie := &http.Cookie{Name: "admin_session", Value: token}

	// Create access link
	body := `{"label":"Mum phone"}`
	req := httptest.NewRequest("POST", "/admin/families/"+family.ID+"/links", bytes.NewBufferString(body))
	req.Header.Set("Content-Type", "application/json")
	req.SetPathValue("id", family.ID)
	req.AddCookie(cookie)
	w := httptest.NewRecorder()

	s.adminRequired(s.createAccessLink)(w, req)

	if w.Code != http.StatusCreated {
		t.Fatalf("create link expected 201, got %d: %s", w.Code, w.Body.String())
	}

	var link AccessLink
	json.Unmarshal(w.Body.Bytes(), &link)

	if link.Label != "Mum phone" {
		t.Errorf("expected label 'Mum phone', got %s", link.Label)
	}
	if len(link.Token) != 32 {
		t.Errorf("expected 32-char token, got %d", len(link.Token))
	}

	// List links
	req = httptest.NewRequest("GET", "/admin/families/"+family.ID+"/links", nil)
	req.SetPathValue("id", family.ID)
	req.AddCookie(cookie)
	w = httptest.NewRecorder()

	s.adminRequired(s.listAccessLinks)(w, req)

	var links []AccessLink
	json.Unmarshal(w.Body.Bytes(), &links)
	if len(links) != 1 {
		t.Errorf("expected 1 link, got %d", len(links))
	}

	// Client can use the token
	req = httptest.NewRequest("GET", "/t/"+link.Token, nil)
	req.SetPathValue("token", link.Token)
	w = httptest.NewRecorder()

	s.handleClientToken(w, req)

	if w.Code != http.StatusFound {
		t.Errorf("expected 302 redirect, got %d", w.Code)
	}

	// Delete link
	req = httptest.NewRequest("DELETE", "/admin/families/"+family.ID+"/links/"+link.Token, nil)
	req.SetPathValue("id", family.ID)
	req.SetPathValue("token", link.Token)
	req.AddCookie(cookie)
	w = httptest.NewRecorder()

	s.adminRequired(s.deleteAccessLink)(w, req)

	if w.Code != http.StatusNoContent {
		t.Errorf("delete expected 204, got %d", w.Code)
	}
}

func TestAdminRequired(t *testing.T) {
	s, cleanup := setupTestServer(t)
	defer cleanup()

	// Request without cookie
	req := httptest.NewRequest("GET", "/admin/families", nil)
	w := httptest.NewRecorder()

	s.adminRequired(s.listFamilies)(w, req)

	if w.Code != http.StatusUnauthorized {
		t.Errorf("expected 401, got %d", w.Code)
	}
}

func TestSummaryTimezone(t *testing.T) {
	s, cleanup := setupTestServer(t)
	defer cleanup()

	family, _ := s.db.CreateFamily("Test Baby", "")
	token, _ := s.db.CreateAdminSession("admin", 24*3600*1000)
	cookie := &http.Cookie{Name: "admin_session", Value: token}

	// Create an entry at 2026-01-25 08:00:00 Pacific/Auckland (+13:00)
	// This is 2026-01-24 19:00:00 UTC - i.e., "yesterday" in UTC
	aucklandTime := "2026-01-25T08:00:00+13:00"
	parsed, _ := time.Parse(time.RFC3339, aucklandTime)
	tsMs := parsed.UnixMilli()

	entry := &Entry{
		ID:        "test-entry-1",
		FamilyID:  family.ID,
		Ts:        tsMs,
		Type:      "feed",
		Value:     "bottle",
		UpdatedAt: tsMs,
	}
	s.db.UpsertEntry(entry)

	// Query with UTC timezone - should NOT find the entry on 2026-01-25
	req := httptest.NewRequest("GET", "/admin/families/"+family.ID+"/summary?date=2026-01-25&tz=UTC", nil)
	req.SetPathValue("id", family.ID)
	req.AddCookie(cookie)
	w := httptest.NewRecorder()

	s.adminRequired(s.getFamilySummary)(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var summaryUTC DailySummary
	json.Unmarshal(w.Body.Bytes(), &summaryUTC)

	if summaryUTC.Totals["feed"] != 0 {
		t.Errorf("expected 0 feeds in UTC 2026-01-25, got %d", summaryUTC.Totals["feed"])
	}

	// Query with Pacific/Auckland timezone - SHOULD find the entry on 2026-01-25
	req = httptest.NewRequest("GET", "/admin/families/"+family.ID+"/summary?date=2026-01-25&tz=Pacific/Auckland", nil)
	req.SetPathValue("id", family.ID)
	req.AddCookie(cookie)
	w = httptest.NewRecorder()

	s.adminRequired(s.getFamilySummary)(w, req)

	if w.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", w.Code, w.Body.String())
	}

	var summaryNZ DailySummary
	json.Unmarshal(w.Body.Bytes(), &summaryNZ)

	if summaryNZ.Totals["feed"] != 1 {
		t.Errorf("expected 1 feed in Auckland 2026-01-25, got %d", summaryNZ.Totals["feed"])
	}

	// Verify the entry appears at 08:00 in Auckland timezone
	if len(summaryNZ.Hours) == 0 {
		t.Fatal("expected hourly data in Auckland timezone")
	}

	found := false
	for _, h := range summaryNZ.Hours {
		if h.Hour == 8 {
			for _, e := range h.Entries {
				if e.Time == "08:00" && e.Type == "feed" {
					found = true
				}
			}
		}
	}
	if !found {
		t.Errorf("expected entry at 08:00 in Auckland timezone, got hours: %+v", summaryNZ.Hours)
	}
}

func TestSummaryInvalidTimezone(t *testing.T) {
	s, cleanup := setupTestServer(t)
	defer cleanup()

	family, _ := s.db.CreateFamily("Test Baby", "")
	token, _ := s.db.CreateAdminSession("admin", 24*3600*1000)
	cookie := &http.Cookie{Name: "admin_session", Value: token}

	req := httptest.NewRequest("GET", "/admin/families/"+family.ID+"/summary?tz=Invalid/Zone", nil)
	req.SetPathValue("id", family.ID)
	req.AddCookie(cookie)
	w := httptest.NewRecorder()

	s.adminRequired(s.getFamilySummary)(w, req)

	if w.Code != http.StatusBadRequest {
		t.Errorf("expected 400 for invalid timezone, got %d", w.Code)
	}
}
