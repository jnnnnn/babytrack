package main

import (
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"log/slog"
	"math/big"
	"net"
	"net/http"
	"os"
	"time"
)

const version = "0.2.0"

type Server struct {
	db  *DB
	hub *Hub
}

func main() {
	initLogger()

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
		slog.Error("failed to open database", "error", err)
		os.Exit(1)
	}
	defer db.Close()

	// Bootstrap admin if configured
	adminUser := os.Getenv("ADMIN_USER")
	adminPass := os.Getenv("ADMIN_PASS")
	if adminUser != "" && adminPass != "" {
		if err := db.EnsureAdmin(adminUser, adminPass); err != nil {
			slog.Error("failed to create admin", "error", err)
			os.Exit(1)
		}
	}

	s := &Server{db: db, hub: NewHub(db)}
	mux := http.NewServeMux()

	// Static files
	mux.HandleFunc("GET /admin", serveFile("admin.html"))
	mux.HandleFunc("GET /", serveFile("babytrack.html"))
	mux.HandleFunc("GET /babytrack.css", serveFile("babytrack.css"))
	mux.HandleFunc("GET /babytrack.js", serveFile("babytrack.js"))
	mux.HandleFunc("GET /sync-client.js", serveFile("sync-client.js"))
	mux.HandleFunc("GET /manifest.json", serveFile("manifest.json"))
	mux.HandleFunc("GET /sw.js", serveFile("sw.js"))
	mux.HandleFunc("GET /icon-192.png", serveFile("icon-192.png"))
	mux.HandleFunc("GET /icon-512.png", serveFile("icon-512.png"))
	mux.HandleFunc("GET /sitemap.html", serveFile("sitemap.html"))

	// Public
	mux.HandleFunc("GET /health", healthHandler)
	mux.HandleFunc("POST /log", handleClientLog)
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

	// Add session validation route
	mux.HandleFunc("GET /admin/session", s.validateSession)

	slog.Info("babytrackd starting", "version", version, "port", port)

	handler := loggingMiddleware(mux)

	if os.Getenv("TLS") == "true" || os.Getenv("TLS") == "1" {
		cert, err := generateSelfSignedCert()
		if err != nil {
			slog.Error("failed to generate TLS cert", "error", err)
			os.Exit(1)
		}
		srv := &http.Server{
			Addr:    ":" + port,
			Handler: handler,
			TLSConfig: &tls.Config{
				Certificates: []tls.Certificate{cert},
			},
		}
		slog.Info("serving HTTPS with self-signed certificate")
		if err := srv.ListenAndServeTLS("", ""); err != nil {
			slog.Error("server error", "error", err)
			os.Exit(1)
		}
	} else {
		if err := http.ListenAndServe(":"+port, handler); err != nil {
			slog.Error("server error", "error", err)
			os.Exit(1)
		}
	}
}

func healthHandler(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	w.Write([]byte(`{"ok":true,"version":"` + version + `"}`))
}

func serveFile(name string) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		http.ServeFile(w, r, "static/"+name)
	}
}

func generateSelfSignedCert() (tls.Certificate, error) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		return tls.Certificate{}, err
	}

	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject: pkix.Name{
			Organization: []string{"BabyTrack Dev"},
		},
		NotBefore:             time.Now(),
		NotAfter:              time.Now().Add(365 * 24 * time.Hour),
		KeyUsage:              x509.KeyUsageKeyEncipherment | x509.KeyUsageDigitalSignature,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		DNSNames:              []string{"localhost"},
	}

	if ip := localIP(); ip != nil {
		template.IPAddresses = []net.IP{ip}
	}

	certDER, err := x509.CreateCertificate(rand.Reader, &template, &template, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}

	return tls.Certificate{
		Certificate: [][]byte{certDER},
		PrivateKey:  key,
	}, nil
}

func localIP() net.IP {
	conn, err := net.Dial("udp", "8.8.8.8:80")
	if err != nil {
		return nil
	}
	defer conn.Close()
	addr := conn.LocalAddr().(*net.UDPAddr)
	return addr.IP
}
