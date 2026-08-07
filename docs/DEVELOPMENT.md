# Developing BabyTrack

## Prerequisites

- **Go** 1.25+
- **pnpm** (dev dependencies only: Playwright, ESLint)
- **gcc** (for CGO SQLite build)

```bash
# Install Go: https://go.dev/dl/
# Install pnpm:  npm install -g pnpm
pnpm install
```

## Project Structure

```
server/
├── main.go           # Entry point, HTTP routing
├── db.go             # SQLite schema, migrations, all queries
├── admin.go          # Admin login, family CRUD, summaries
├── ws.go             # WebSocket hub, sync protocol
├── http.go           # JSON helpers, token generation
├── log.go            # Structured logging, middleware
├── admin_test.go     # Admin integration tests
├── main_test.go      # DB, config, migration unit tests
├── ws_test.go        # WebSocket integration tests
├── Dockerfile        # Multi-stage Alpine build
├── fly.toml          # Fly.io deployment config
└── static/
    ├── babytrack.html       # Main tracking page
    ├── babytrack.js         # App logic (~2500 lines)
    ├── babytrack.css        # Stylesheet with dark mode
    ├── sync-client.js       # WebSocket sync client
    ├── admin.html           # Self-contained admin dashboard
    ├── manifest.json        # PWA web app manifest
    ├── sw.js                # Service worker (offline cache)
    ├── icon-192.png         # PWA icon 192×192
    └── icon-512.png         # PWA icon 512×512
e2e/
├── admin.spec.ts          # Playwright: admin workflow
└── client-workflow.spec.ts # Playwright: client tracking + sync
```

## Build & Run

```bash
# Run directly (dev mode)
cd server
go run .

# Run with HTTPS for phone testing (PWA needs secure context)
# Starts with a self-signed cert at https://<local-ip>:8080
TLS=true go run .
```

When testing on a phone, use the HTTPS URL (e.g. `https://192.168.1.88:8080`) — service workers require a secure context, and only `localhost`/`127.0.0.1` are considered secure over plain HTTP. The self-signed cert will trigger a browser warning you must accept.

Production deploys (Fly.io) handle TLS termination transparently, so `TLS=true` is not needed in production.

```bash
# Build for production
cd server
go build -o babytrackd .

# Docker
cd server
docker build -t babytrackd .
```

## Testing

Run the full pipeline:

```bash
uv run verify.py
```

This runs: `gofmt`, ESLint, Go unit/integration tests, and Playwright E2E tests.

Useful options:

```bash
uv run verify.py --human      # Headed browser, slow-motion (for debugging)
uv run verify.py --uncovered  # Print uncovered Go lines
```

To run just the Go tests:

```bash
cd server && go test -cover ./...
```

To run just the E2E tests:

```bash
pnpm playwright test
```

## Where to Make Changes

| You want to… | Edit these files |
|---|---|
| Add a new event type | `db.go` (schema), `babytrack.js` (UI + submit logic) |
| Change the UI look | `babytrack.css` / `babytrack.html` |
| Add an admin feature | `admin.go` + `admin.html` |
| Change how sync works | `ws.go` (server), `sync-client.js` (client) |
| Add an API endpoint | `main.go` (route) + relevant handler file |
| Add database queries | `db.go` |

## Architecture Notes

- **SQLite with WAL mode** — enables concurrent reads during writes (critical for multi-client sync)
- **Cursor-based sync** — each entry gets a monotonically increasing `seq` per family; clients track their last-received `seq` to efficiently pull only what's new
- **Cookie-based auth** — admin gets 24h `admin_session`; clients get permanent `client_session` via magic link
- **Client error forwarding** — `console.error/warn/log` in the browser are POSTed to `/log` for server-side visibility
- **No frontend build step** — everything is vanilla HTML/JS/CSS served directly
