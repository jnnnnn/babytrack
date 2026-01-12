# Backend Sync Server

## Requirements

- **Realtime sync**: Multiple clients viewing same baby see updates instantly
- **Offline-first**: Frontend works offline, syncs when connected
- **Multi-device**: Phone, tablet, partner's phone
- **Admin UI**: Jane (consultant) manages clients, views summaries, generates access links
- **Link-based access**: Clients get shareable links from Jane (no self-signup)
- **Self-hosted**: Single Go binary + SQLite, runs on fly.io
- **Low resource**: Should run on smallest fly.io instance (256MB)

## Users

**Jane (Admin)**
- Logs in with password
- Creates/manages client families
- Generates time-limited access links
- Views hourly/daily summaries for all clients

**Clients (Parents/Carers)**
- Access via link from Jane
- Track baby events in realtime
- No login required (link = auth)

## Architecture

```
┌─────────────┐         ┌─────────────┐         ┌─────────────┐
│  Client A   │◄──WS───►│             │◄──WS───►│  Client B   │
│ (phone)     │         │   babytrackd│         │ (partner)   │
└─────────────┘         │             │         └─────────────┘
                        │  Go + SQLite│
┌─────────────┐         │             │
│  Client C   │◄──WS───►│  fly.io     │
│ (nurse)     │         └──────┬──────┘
└─────────────┘                │
                               ▼
                        ┌─────────────┐
                        │ SQLite file │
                        │ (persistent)│
                        └─────────────┘
```

## Data Model

```sql
-- Admin user (Jane)
CREATE TABLE admins (
  id TEXT PRIMARY KEY,
  username TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,   -- bcrypt
  created_at INTEGER NOT NULL
);

-- Client families
CREATE TABLE families (
  id TEXT PRIMARY KEY,           -- 8-char random (url-safe)
  name TEXT NOT NULL,            -- "Baby Smith" or parent name
  notes TEXT,                    -- Jane's notes about client
  created_at INTEGER NOT NULL,
  archived INTEGER DEFAULT 0     -- soft delete when engagement ends
);

-- Access links (replaces magic_links + members)
CREATE TABLE access_links (
  token TEXT PRIMARY KEY,        -- 32-char random (the shareable link)
  family_id TEXT NOT NULL REFERENCES families(id),
  label TEXT,                    -- "Mum's phone", "Dad", "Grandma"
  expires_at INTEGER,            -- NULL = never expires
  created_at INTEGER NOT NULL
);

-- Admin sessions
CREATE TABLE admin_sessions (
  token TEXT PRIMARY KEY,
  admin_id TEXT NOT NULL REFERENCES admins(id),
  expires_at INTEGER NOT NULL
);

-- Tracking entries
CREATE TABLE entries (
  id TEXT PRIMARY KEY,           -- UUID from client
  family_id TEXT NOT NULL REFERENCES families(id),
  ts INTEGER NOT NULL,           -- event timestamp (ms)
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  deleted INTEGER DEFAULT 0,
  updated_at INTEGER NOT NULL    -- for sync ordering
);

-- Button config per family
CREATE TABLE configs (
  family_id TEXT PRIMARY KEY REFERENCES families(id),
  data TEXT NOT NULL,            -- JSON blob (buttonGroups)
  updated_at INTEGER NOT NULL
);

-- JSON Structure Example:
-- [
--   {
--     "category": "sleep",
--     "stateful": true,
--     "buttons": [
--       { "label": "sleeping", "timing": true, "counted": true },
--       { "label": "awake", "timing": true, "counted": false }
--     ]
--   }
-- ]

CREATE INDEX idx_entries_family ON entries(family_id);
CREATE INDEX idx_entries_updated ON entries(family_id, updated_at);
CREATE INDEX idx_entries_ts ON entries(family_id, ts);
```

## API

### Admin Endpoints (cookie auth)

```
POST /admin/login
  Body: { username, password }
  → Sets admin session cookie

POST /admin/logout
  → Clears session

GET /admin/families
  → List all families with summary stats

POST /admin/families
  Body: { name, notes? }
  → Create new family

GET /admin/families/:id
  → Family detail with entries

PATCH /admin/families/:id
  Body: { name?, notes?, archived? }

GET /admin/families/:id/summary?date=2026-01-11
  → Hourly breakdown for date (like export)

POST /admin/families/:id/links
  Body: { label?, expires_at? }
  → Generate access link

DELETE /admin/families/:id/links/:token
  → Revoke link
```

### Client Endpoints (link token auth)

```
GET /t/:token
  → Validate token, set cookie, redirect to app

GET /health
  → { ok: true, version: "1.0.0" }
```

### WebSocket Protocol

```
GET /ws?family=xxx
  Cookie: session=xxx
  → Upgrades to WebSocket
```

**Server → Client messages:**
```json
{"type": "init", "entries": [...], "config": {...}, "members": [...]}
{"type": "entry", "action": "add|update|delete", "entry": {...}}
{"type": "config", "data": {...}}
{"type": "presence", "members": ["Dad", "Mum"]}  // who's online
```

**Client → Server messages:**
```json
{"type": "entry", "action": "add", "entry": {id, ts, type, value}}
{"type": "entry", "action": "update", "entry": {id, ...}}
{"type": "entry", "action": "delete", "id": "xxx"}
{"type": "config", "data": {...}}
{"type": "ping"}
```

## Auth Flows

### Admin (Jane)

1. Jane visits `/admin` → login form
2. Enters username/password → session cookie set
3. Redirects to dashboard

### Client (Parents)

1. Jane creates family in admin UI
2. Jane generates access link, copies/sends to client
3. Client opens link `/t/abc123...` → cookie set, redirects to app
4. Cookie used for WebSocket auth
5. Link can optionally expire (e.g., after 2 weeks of engagement)

## Sync Strategy

**On connect:**
1. Client sends last `updated_at` it has
2. Server sends all entries with `updated_at > client's`
3. Client sends any local entries server doesn't have

**Conflict resolution:**
- Last-write-wins based on `updated_at`
- Deletes are soft (tombstones)
- Client generates UUIDs, server dedupes by ID

## Operations

### Deployment (fly.io)

```bash
# First time
fly launch --no-deploy
fly volumes create babytrack_data --size 1

# Deploy
fly deploy

# Logs
fly logs -f

# SSH
fly ssh console
```

### fly.toml

```toml
app = "babytrackd"
primary_region = "syd"

[build]
  builder = "paketobuildpacks/builder:base"

[env]
  PORT = "8080"
  DB_PATH = "/data/babytrack.db"
  SMTP_FROM = "noreply@babytrack.example.com"

[mounts]
  source = "babytrack_data"
  destination = "/data"

[[services]]
  internal_port = 8080
  protocol = "tcp"

  [[services.ports]]
    port = 443
    handlers = ["tls", "http"]
```

### Environment Variables

```
DB_PATH=/data/babytrack.db
ADMIN_USER=jane
ADMIN_PASS=xxx              # bcrypt on first run or set hash directly
BASE_URL=https://babytrackd.fly.dev
```

### Monitoring

- `/health` endpoint for uptime checks
- fly.io metrics for CPU/memory
- SQLite WAL mode for concurrent reads
- Periodic vacuum via cron or on-demand

### Backup

```bash
# Manual
fly ssh sftp get /data/babytrack.db ./backup.db

# Could add Litestream for continuous backup to S3
```

## Project Structure

```
server/
├── main.go           # Entry point, router
├── admin.go          # Admin login, family CRUD, summary endpoints
├── client.go         # Token auth, app serving
├── ws.go             # WebSocket hub, broadcast
├── db.go             # SQLite operations, queries
├── templates/        # Admin UI HTML templates
│   ├── login.html
│   ├── dashboard.html
│   ├── family.html
│   └── layout.html
├── static/           # Admin CSS/JS (minimal)
├── Dockerfile
└── fly.toml
```

## Admin UI Pages

### Dashboard (`/admin`)
- List of active clients (families)
- Each row: name, last activity, today's sleep total, link to detail
- "Add Client" button
- Archived clients toggle

### Client Detail (`/admin/families/:id`)
- Client name, notes (editable)
- Access links management (create, copy, revoke)
- Date picker for summary view
- Hourly grid (like current export):
  - Each hour: events that happened
  - Daily totals: sleep, feeds, wet, dirty
- Recent activity log

## Security Considerations

- Admin password not hashed in db (slows down testing)
- Admin sessions httpOnly, secure, sameSite=strict
- Access link tokens: 32 chars, cryptographically random
- Rate limit login attempts
- No PII in logs

## Running the Server Locally

To run the `babytrackd` server locally, follow these steps:

1. **Install Go**: Ensure you have Go 1.21 or later installed.
   ```bash
   go version
   ```
   If not installed, download it from [golang.org](https://golang.org/dl/).

2. **Set Environment Variables**:
   - `PORT`: The port the server will listen on (default: `8080`).
   - `DB_PATH`: Path to the SQLite database file (default: `babytrack.db`).
   - `ADMIN_USER` and `ADMIN_PASS`: Optional admin credentials for bootstrapping.

   Example:
   ```bash
   export PORT=8080
   export DB_PATH=./babytrack.db
   export ADMIN_USER=admin
   export ADMIN_PASS=secret
   ```

3. **Build the Server**:
   ```bash
   cd server
   go build .
   ```
   This creates an executable named `babytrackd`.

4. **Run the Server**:
   ```bash
   ./babytrackd
   ```

5. **Access the Server**:
   - Admin UI: [http://localhost:8080/admin](http://localhost:8080/admin)
   - Health Check: [http://localhost:8080/health](http://localhost:8080/health)

6. **Logs**:
   Logs are output to the console. Use `LOG_LEVEL` and `LOG_FORMAT` to configure logging:
   ```bash
   export LOG_LEVEL=debug
   export LOG_FORMAT=text
   ```
