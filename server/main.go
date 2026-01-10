package main

import (
	"log"
	"net/http"
	"os"
)

const version = "0.1.0"

type Server struct {
	db  *DB
	hub *Hub
}

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	dbPath := os.Getenv("DB_PATH")
	if dbPath == "" {
		dbPath = "babytrack.db"
	}

	db, err := NewDB(dbPath)
	if err != nil {
		log.Fatalf("failed to open database: %v", err)
	}
	defer db.Close()

	// Bootstrap admin if configured
	adminUser := os.Getenv("ADMIN_USER")
	adminPass := os.Getenv("ADMIN_PASS")
	if adminUser != "" && adminPass != "" {
		if err := db.EnsureAdmin(adminUser, adminPass); err != nil {
			log.Fatalf("failed to create admin: %v", err)
		}
	}

	s := &Server{db: db, hub: NewHub(db)}
	mux := http.NewServeMux()

	// Static files
	mux.HandleFunc("GET /admin", serveFile("admin.html"))
	mux.HandleFunc("GET /", serveFile("babytrack.html"))
	mux.HandleFunc("GET /sync-client.js", serveFile("sync-client.js"))

	// Public
	mux.HandleFunc("GET /health", healthHandler)
	mux.HandleFunc("GET /t/{token}", s.handleClientToken)
	mux.HandleFunc("GET /ws", s.handleWebSocket)

	// Admin auth
	mux.HandleFunc("POST /admin/login", s.adminLogin)
	mux.HandleFunc("POST /admin/logout", s.adminLogout)

	// Admin API (protected)
	mux.HandleFunc("GET /admin/families", s.adminRequired(s.listFamilies))
	mux.HandleFunc("POST /admin/families", s.adminRequired(s.createFamily))
	mux.HandleFunc("GET /admin/families/{id}", s.adminRequired(s.getFamily))
	mux.HandleFunc("PATCH /admin/families/{id}", s.adminRequired(s.updateFamily))
	mux.HandleFunc("GET /admin/families/{id}/summary", s.adminRequired(s.getFamilySummary))
	mux.HandleFunc("GET /admin/families/{id}/links", s.adminRequired(s.listAccessLinks))
	mux.HandleFunc("POST /admin/families/{id}/links", s.adminRequired(s.createAccessLink))
	mux.HandleFunc("DELETE /admin/families/{id}/links/{token}", s.adminRequired(s.deleteAccessLink))

	log.Printf("babytrackd %s listening on :%s", version, port)
	if err := http.ListenAndServe(":"+port, mux); err != nil {
		log.Fatalf("server error: %v", err)
	}
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true,"version":"` + version + `"}`))
}

func serveFile(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "../"+name)
	}
}
