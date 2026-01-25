package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"log/slog"
	"net/http"
)

// generateToken creates a random hex-encoded token of n bytes (2n hex chars).
func generateToken(n int) string {
	b := make([]byte, n)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// jsonResponse writes a JSON response with the given status code.
func jsonResponse(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(data); err != nil {
		slog.Error("failed to encode response", "error", err)
	}
}

// jsonOK writes a 200 JSON response.
func jsonOK(w http.ResponseWriter, data any) {
	jsonResponse(w, http.StatusOK, data)
}

// jsonCreated writes a 201 JSON response.
func jsonCreated(w http.ResponseWriter, data any) {
	jsonResponse(w, http.StatusCreated, data)
}

// serverError logs the error and returns a generic 500 response.
// Use this for unexpected errors that shouldn't expose details to clients.
func serverError(w http.ResponseWriter, msg string, err error) {
	slog.Error(msg, "error", err)
	http.Error(w, "internal error", http.StatusInternalServerError)
}
