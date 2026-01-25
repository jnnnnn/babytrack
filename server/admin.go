package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"time"

	"golang.org/x/crypto/bcrypt"
)

// Admin handlers

func (s *Server) adminLogin(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}

	admin, err := s.db.GetAdminByUsername(req.Username)
	if err != nil {
		http.Error(w, "invalid credentials", http.StatusUnauthorized)
		return
	}

	if err := bcrypt.CompareHashAndPassword([]byte(admin.PasswordHash), []byte(req.Password)); err != nil {
		http.Error(w, "invalid credentials", http.StatusUnauthorized)
		return
	}

	token, err := s.db.CreateAdminSession(admin.ID, 24*time.Hour)
	if err != nil {
		serverError(w, "failed to create session", err)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "admin_session",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   r.TLS != nil,
		SameSite: http.SameSiteStrictMode,
		MaxAge:   86400,
	})

	jsonOK(w, map[string]string{"ok": "true"})
}

func (s *Server) adminLogout(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie("admin_session")
	if err == nil {
		s.db.DeleteAdminSession(cookie.Value)
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "admin_session",
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		MaxAge:   -1,
	})

	jsonOK(w, map[string]string{"ok": "true"})
}

func (s *Server) adminRequired(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		cookie, err := r.Cookie("admin_session")
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		adminID, err := s.db.ValidateAdminSession(cookie.Value)
		if err != nil {
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}

		r.Header.Set("X-Admin-ID", adminID)
		next(w, r)
	}
}

// Add session validation endpoint
func (s *Server) validateSession(w http.ResponseWriter, r *http.Request) {
	cookie, err := r.Cookie("admin_session")
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	adminID, err := s.db.ValidateAdminSession(cookie.Value)
	if err != nil {
		http.Error(w, "unauthorized", http.StatusUnauthorized)
		return
	}

	jsonOK(w, map[string]string{"status": "ok", "admin_id": adminID})
}

// Family handlers

type FamilyWithStats struct {
	Family
	EntryCount     int   `json:"entry_count"`
	LatestActivity int64 `json:"latest_activity"`
	LinkCount      int   `json:"link_count"`
}

func (s *Server) listFamilies(w http.ResponseWriter, r *http.Request) {
	families, err := s.db.ListFamilies(r.URL.Query().Get("archived") == "true")
	if err != nil {
		serverError(w, "failed to list families", err)
		return
	}

	// Enrich with stats
	result := make([]FamilyWithStats, len(families))
	for i, f := range families {
		result[i].Family = f
		result[i].EntryCount, _ = s.db.GetEntryCount(f.ID)
		result[i].LatestActivity, _ = s.db.GetLatestActivity(f.ID)
		result[i].LinkCount, _ = s.db.GetLinkCount(f.ID)
	}

	jsonOK(w, result)
}

func (s *Server) createFamily(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name  string `json:"name"`
		Notes string `json:"notes"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}

	if req.Name == "" {
		http.Error(w, "name required", http.StatusBadRequest)
		return
	}

	family, err := s.db.CreateFamily(req.Name, req.Notes)
	if err != nil {
		serverError(w, "failed to create family", err)
		return
	}

	jsonCreated(w, family)
}

func (s *Server) getFamily(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	family, err := s.db.GetFamily(id)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	jsonOK(w, family)
}

func (s *Server) updateFamily(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")

	var req struct {
		Name     *string `json:"name"`
		Notes    *string `json:"notes"`
		Archived *bool   `json:"archived"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}

	if err := s.db.UpdateFamily(id, req.Name, req.Notes, req.Archived); err != nil {
		serverError(w, "failed to update family", err)
		return
	}

	family, _ := s.db.GetFamily(id)
	jsonOK(w, family)
}

// Access link handlers

func (s *Server) listAccessLinks(w http.ResponseWriter, r *http.Request) {
	familyID := r.PathValue("id")
	links, err := s.db.ListAccessLinks(familyID)
	if err != nil {
		serverError(w, "failed to list access links", err)
		return
	}

	jsonOK(w, links)
}

func (s *Server) createAccessLink(w http.ResponseWriter, r *http.Request) {
	familyID := r.PathValue("id")

	var req struct {
		Label     string `json:"label"`
		ExpiresAt *int64 `json:"expires_at"`
	}
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		http.Error(w, "invalid request", http.StatusBadRequest)
		return
	}

	link, err := s.db.CreateAccessLink(familyID, req.Label, req.ExpiresAt)
	if err != nil {
		serverError(w, "failed to create access link", err)
		return
	}

	jsonCreated(w, link)
}

func (s *Server) deleteAccessLink(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")

	if err := s.db.DeleteAccessLink(token); err != nil {
		serverError(w, "failed to delete access link", err)
		return
	}

	w.WriteHeader(http.StatusNoContent)
}

// Client token handler

func (s *Server) handleClientToken(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")

	link, err := s.db.ValidateAccessLink(token)
	if err != nil {
		http.Error(w, "invalid or expired link", http.StatusUnauthorized)
		return
	}

	http.SetCookie(w, &http.Cookie{
		Name:     "client_session",
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   r.TLS != nil,
		SameSite: http.SameSiteLaxMode,
		MaxAge:   86400 * 30, // 30 days
	})

	// Redirect to app with family context
	http.Redirect(w, r, "/?family="+link.FamilyID, http.StatusFound)
}

// Summary handler

type HourlySummary struct {
	Hour    int            `json:"hour"`
	Entries []EntrySummary `json:"entries"`
}

type EntrySummary struct {
	Time  string `json:"time"`
	Type  string `json:"type"`
	Value string `json:"value"`
}

type DailySummary struct {
	Date   string          `json:"date"`
	Hours  []HourlySummary `json:"hours"`
	Totals map[string]int  `json:"totals"`
}

func (s *Server) getFamilySummary(w http.ResponseWriter, r *http.Request) {
	familyID := r.PathValue("id")
	dateStr := r.URL.Query().Get("date")
	offsetStr := r.URL.Query().Get("offset")

	// Parse offset in minutes (default to 0 = UTC)
	offsetMins := 0
	if offsetStr != "" {
		parsed, err := strconv.Atoi(offsetStr)
		if err != nil {
			http.Error(w, "invalid offset", http.StatusBadRequest)
			return
		}
		offsetMins = parsed
	}
	loc := time.FixedZone("client", offsetMins*60)

	// Parse date (default to today in client's timezone)
	var startTime time.Time
	if dateStr != "" {
		parsed, err := time.ParseInLocation("2006-01-02", dateStr, loc)
		if err != nil {
			http.Error(w, "invalid date format (use YYYY-MM-DD)", http.StatusBadRequest)
			return
		}
		startTime = parsed
	} else {
		now := time.Now().In(loc)
		startTime = time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, loc)
	}

	endTime := startTime.Add(24 * time.Hour)
	startMs := startTime.UnixMilli()
	endMs := endTime.UnixMilli()

	entries, err := s.db.GetEntriesForDate(familyID, startMs, endMs)
	if err != nil {
		serverError(w, "failed to get entries", err)
		return
	}

	// Group by hour
	hourlyMap := make(map[int][]EntrySummary)
	totals := make(map[string]int)

	for _, e := range entries {
		t := time.UnixMilli(e.Ts).In(loc)
		hour := t.Hour()

		hourlyMap[hour] = append(hourlyMap[hour], EntrySummary{
			Time:  t.Format("15:04"),
			Type:  e.Type,
			Value: e.Value,
		})

		// Count by type
		totals[e.Type]++
	}

	// Build hours array (only hours with data)
	var hours []HourlySummary
	for h := 0; h < 24; h++ {
		if entries, ok := hourlyMap[h]; ok {
			hours = append(hours, HourlySummary{
				Hour:    h,
				Entries: entries,
			})
		}
	}

	summary := DailySummary{
		Date:   startTime.Format("2006-01-02"),
		Hours:  hours,
		Totals: totals,
	}

	jsonOK(w, summary)
}
