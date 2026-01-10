# Backend Sync Server

## Requirements

- **Realtime sync**: Multiple clients viewing same baby see updates instantly
- **Offline-first**: Frontend works offline, syncs when connected
- **Multi-device**: Phone, tablet, partner's phone, nurse station
- **Simple auth**: Magic link (email) - no passwords
- **Self-hosted**: Single Go binary + SQLite, runs on fly.io
- **Low resource**: Should run on smallest fly.io instance (256MB)

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
CREATE TABLE families (
  id TEXT PRIMARY KEY,           -- 8-char random (url-safe)
  name TEXT,                     -- "Baby Smith"
  created_at INTEGER NOT NULL
);

CREATE TABLE members (
  id TEXT PRIMARY KEY,
  family_id TEXT NOT NULL REFERENCES families(id),
  email TEXT NOT NULL,
  name TEXT,                     -- "Dad", "Mum", "Nurse Jane"
  created_at INTEGER NOT NULL,
  UNIQUE(family_id, email)
);

CREATE TABLE magic_links (
  token TEXT PRIMARY KEY,        -- 32-char random
  member_id TEXT NOT NULL REFERENCES members(id),
  expires_at INTEGER NOT NULL,
  used INTEGER DEFAULT 0
);

CREATE TABLE sessions (
  token TEXT PRIMARY KEY,        -- 32-char random  
  member_id TEXT NOT NULL REFERENCES members(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE entries (
  id TEXT PRIMARY KEY,           -- UUID from client
  family_id TEXT NOT NULL REFERENCES families(id),
  ts INTEGER NOT NULL,           -- event timestamp (ms)
  type TEXT NOT NULL,
  value TEXT NOT NULL,
  deleted INTEGER DEFAULT 0,
  created_by TEXT REFERENCES members(id),
  updated_at INTEGER NOT NULL    -- for sync ordering
);

CREATE TABLE configs (
  family_id TEXT PRIMARY KEY REFERENCES families(id),
  data TEXT NOT NULL,            -- JSON blob (buttonGroups)
  updated_at INTEGER NOT NULL
);

CREATE INDEX idx_entries_family ON entries(family_id);
CREATE INDEX idx_entries_updated ON entries(family_id, updated_at);
```

## API

### HTTP Endpoints

```
POST /auth/start
  Body: { email, family_id? }
  → Creates family if needed, sends magic link email
  → Returns { ok: true }

GET /auth/verify?token=xxx
  → Sets session cookie, redirects to /?family=xxx

POST /auth/logout
  → Clears session

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

## Auth Flow

1. User opens app, enters email
2. Server creates/finds member, sends magic link
3. User clicks link → session cookie set
4. Cookie used for WebSocket auth
5. Sessions expire after 30 days

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
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_USER=xxx
SMTP_PASS=xxx
SMTP_FROM=noreply@babytrack.example.com
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
├── main.go           # Entry point, HTTP server
├── auth.go           # Magic link, sessions
├── ws.go             # WebSocket hub, broadcast
├── db.go             # SQLite operations
├── email.go          # SMTP sending
├── Dockerfile
└── fly.toml
```

## Security Considerations

- Magic links expire in 15 minutes
- Sessions are httpOnly, secure, sameSite=strict
- Rate limit magic link requests (5/hour/email)
- WebSocket validates session before upgrade
- No PII in logs
