package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"net/http"
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
		http.Error(w, "internal error", http.StatusInternalServerError)
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

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"ok": "true"})
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

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]string{"ok": "true"})
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

// Family handlers

func (s *Server) listFamilies(w http.ResponseWriter, r *http.Request) {
	families, err := s.db.ListFamilies(r.URL.Query().Get("archived") == "true")
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(families)
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
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(family)
}

func (s *Server) getFamily(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	family, err := s.db.GetFamily(id)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(family)
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
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	family, _ := s.db.GetFamily(id)
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(family)
}

// Access link handlers

func (s *Server) listAccessLinks(w http.ResponseWriter, r *http.Request) {
	familyID := r.PathValue("id")
	links, err := s.db.ListAccessLinks(familyID)
	if err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(links)
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
		http.Error(w, "internal error", http.StatusInternalServerError)
		return
	}

	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusCreated)
	json.NewEncoder(w).Encode(link)
}

func (s *Server) deleteAccessLink(w http.ResponseWriter, r *http.Request) {
	token := r.PathValue("token")

	if err := s.db.DeleteAccessLink(token); err != nil {
		http.Error(w, "internal error", http.StatusInternalServerError)
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

// Helper to generate random tokens

func generateToken(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}
