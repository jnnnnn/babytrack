package main

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"log/slog"
	"net/http"
	"os"
	"time"
)

type ctxKey string

const requestIDKey ctxKey = "request_id"

var logger *slog.Logger

func initLogger() {
	level := slog.LevelInfo
	if os.Getenv("LOG_LEVEL") == "debug" {
		level = slog.LevelDebug
	}

	opts := &slog.HandlerOptions{Level: level}

	var handler slog.Handler
	if os.Getenv("LOG_FORMAT") == "text" {
		handler = slog.NewTextHandler(os.Stdout, opts)
	} else {
		handler = slog.NewJSONHandler(os.Stdout, opts)
	}

	logger = slog.New(handler)
	slog.SetDefault(logger)
}

// requestID generates a short unique ID for request tracing
func requestID() string {
	b := make([]byte, 8)
	rand.Read(b)
	return hex.EncodeToString(b)
}

// withRequestID adds request ID to context
func withRequestID(ctx context.Context, id string) context.Context {
	return context.WithValue(ctx, requestIDKey, id)
}

// getRequestID retrieves request ID from context
func getRequestID(ctx context.Context) string {
	if id, ok := ctx.Value(requestIDKey).(string); ok {
		return id
	}
	return ""
}

// loggerFromCtx returns a logger with request context
func loggerFromCtx(ctx context.Context) *slog.Logger {
	if id := getRequestID(ctx); id != "" {
		return logger.With("req_id", id)
	}
	return logger
}

// loggingMiddleware adds request ID and logs request timing
func loggingMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		reqID := requestID()

		ctx := withRequestID(r.Context(), reqID)
		r = r.WithContext(ctx)

		// Wrap response writer to capture status
		lrw := &loggingResponseWriter{ResponseWriter: w, status: 200}

		next.ServeHTTP(lrw, r)

		duration := time.Since(start)
		log := logger.With(
			"req_id", reqID,
			"method", r.Method,
			"path", r.URL.Path,
			"status", lrw.status,
			"duration_ms", duration.Milliseconds(),
		)

		if lrw.status >= 500 {
			log.Error("request completed")
		} else if lrw.status >= 400 {
			log.Warn("request completed")
		} else {
			log.Info("request completed")
		}
	})
}

type loggingResponseWriter struct {
	http.ResponseWriter
	status int
}

func (lrw *loggingResponseWriter) WriteHeader(code int) {
	lrw.status = code
	lrw.ResponseWriter.WriteHeader(code)
}
