# Task: Implement Cursor-Based Sync Protocol

## Context
You are implementing a reliable offline-first sync protocol for BabyTrack, a baby tracking PWA. The design document is at docs/sync-protocol.md - READ IT FIRST.

## Current State
- Server: Go WebSocket server in server/ (ws.go, db.go)
- Client: sync-client.js (SyncClient class) + babytrack.js (UI integration)
- Current sync: init message sends all entries, no cursor, offline entries often lost

## Ready Tasks (start here)
Run `bd ready` to see unblocked work. Start with:

1. **battleships-ido: Server: Add seq columns**
   - Add migration v2 to db.go
   - Add `seq INTEGER DEFAULT 0` to families and entries
   - Create index: `idx_entries_seq ON entries(family_id, seq)`
   - Backfill: `UPDATE entries SET seq = rowid; UPDATE families SET seq = (SELECT COALESCE(MAX(seq),0) FROM entries WHERE family_id = families.id)`

2. **battleships-2w1: Client: Cursor storage**
   - Already uses localStorage['sync-last-updated'] - rename to 'sync-cursor'
   - Initialize to 0 for fresh clients

## Key Files
- server/db.go - database schema and queries
- server/ws.go - WebSocket message handling
- sync-client.js - client sync logic
- babytrack.js - UI integration, addEntry() around line 177

## Protocol Summary
- Server assigns monotonic `seq` per family on every mutation
- Client stores cursor = highest seq received
- On connect: client sends sync_request(cursor), server responds with entries where seq > cursor
- Entry mutations: client sends entry, server responds with entry_ack(id, seq)
- Offline: entries stored with seq: null, sent on reconnect

## Workflow
1. `bd update <id> --status=in_progress` before starting a task
2. Write tests alongside implementation
3. Run `./verify` before completing
4. `bd close <id>` when done
5. `bd sync` at session end

## Dependencies
Tasks are ordered - check `bd show <id>` for what blocks what.

## Design Goals

1. **Server authoritative** — server is source of truth; client state derived from server
2. **Efficient initial sync** — no full scan of tens of thousands of entries
3. **Cursor-based sync** — sequence numbers provide a clear "synced up to" boundary
4. **No per-entry tracking** — once cursor advances, those entries never rechecked
5. **Delete propagation** — soft deletes sync like any other mutation
6. **Server-stamped ordering** — server assigns sequence numbers, not trusted from client
7. **Cold start support** — new client syncs entire history efficiently

---

## Core Concepts

### Server Sequence Number (`seq`)

Every mutation to the entries table increments a global family sequence counter. Each entry stores the `seq` at which it was last modified.

```
seq = monotonically increasing integer per family
```

When entry is created or updated:
```sql
UPDATE families SET seq = seq + 1 WHERE id = ? RETURNING seq;
UPDATE entries SET seq = ? WHERE id = ?;
```

### Client Cursor

Each client tracks `last_seq` — the highest sequence number it has received and persisted.

```javascript
localStorage.getItem('sync-cursor')  // e.g., "4523"
```

### Sync Flow

```
┌────────┐                         ┌────────┐
│ Client │                         │ Server │
└───┬────┘                         └───┬────┘
    │                                  │
    │ CONNECT (family_id)              │
    │ ─────────────────────────────────>
    │                                  │
    │ AUTH_OK                          │
    │ <─────────────────────────────────
    │                                  │
    │ SYNC_REQUEST (cursor: 4500)      │
    │ ─────────────────────────────────>
    │                                  │
    │ SYNC_RESPONSE                    │
    │   entries: [{seq:4501}, ...]     │
    │   cursor: 4523                   │
    │   has_more: false                │
    │ <─────────────────────────────────
    │                                  │
    │ (client persists, updates cursor)│
    │                                  │
    │ ENTRY (create/update/delete)     │
    │ ─────────────────────────────────>
    │                                  │
    │ ENTRY_ACK (id, seq: 4524)        │
    │ <─────────────────────────────────
    │                                  │
    │ ENTRY_BROADCAST (to other clients)
    │ <─────────────────────────────────
```

---

## Message Types

### Client → Server

#### `sync_request`
Request entries since cursor.
```json
{
  "type": "sync_request",
  "cursor": 4500,
  "limit": 500
}
```

#### `entry`
Push a new or modified entry.
```json
{
  "type": "entry",
  "action": "add|update|delete",
  "entry": {
    "id": "uuid",
    "ts": 1706000000000,
    "type": "feed",
    "value": "bf"
  }
}
```

### Server → Client

#### `sync_response`
Batch of entries since cursor.
```json
{
  "type": "sync_response",
  "entries": [
    {"id": "uuid", "ts": 1706000000000, "type": "feed", "value": "bf", "deleted": false, "seq": 4501},
    ...
  ],
  "cursor": 4523,
  "has_more": true
}
```

#### `entry_ack`
Confirms entry was persisted and assigns sequence.
```json
{
  "type": "entry_ack",
  "id": "uuid",
  "seq": 4524
}
```

#### `entry_broadcast`
Real-time push of entry from another client.
```json
{
  "type": "entry",
  "entry": {"id": "uuid", "ts": ..., "type": ..., "value": ..., "deleted": false, "seq": 4524}
}
```

---

## Database Schema Changes

### Server (SQLite)

```sql
-- Add seq to families
ALTER TABLE families ADD COLUMN seq INTEGER DEFAULT 0;

-- Add seq to entries (replaces updated_at for sync purposes)
ALTER TABLE entries ADD COLUMN seq INTEGER DEFAULT 0;

-- Index for efficient cursor queries
CREATE INDEX idx_entries_seq ON entries(family_id, seq);
```

### Client (IndexedDB)

```javascript
// Store structure
{
  id: 123,              // local auto-increment (optional, can remove)
  syncId: "uuid",       // server-assigned ID
  ts: "2026-01-22T...", // event timestamp
  type: "feed",
  value: "bf",
  deleted: false,
  seq: 4501             // server sequence number
}

// Cursor stored separately
localStorage['sync-cursor'] = "4501"
```

---

## Sync Scenarios

### 1. Fresh Client (empty database)

```
cursor = 0
→ SYNC_REQUEST(cursor: 0, limit: 500)
← SYNC_RESPONSE(entries: [...], cursor: 500, has_more: true)
→ SYNC_REQUEST(cursor: 500, limit: 500)
← SYNC_RESPONSE(entries: [...], cursor: 1000, has_more: true)
...
← SYNC_RESPONSE(entries: [...], cursor: 4523, has_more: false)
```

Client persists entries in batches, updates cursor after each batch.

### 2. Returning Client (has history)

```
cursor = 4500
→ SYNC_REQUEST(cursor: 4500)
← SYNC_RESPONSE(entries: [23 entries], cursor: 4523, has_more: false)
```

Only fetches delta.

### 3. Offline Entry Creation

Client creates entry offline:
- Stores in IndexedDB with `seq: null` (unsynced)
- On reconnect, after sync_request/response:
  - Query local entries where `seq IS NULL`
  - Send each as `entry` message
  - On `entry_ack`, update local entry with assigned `seq`

### 4. Delete Propagation

Device A deletes old entry:
```
→ ENTRY(action: "delete", entry: {id: "uuid-123"})
← ENTRY_ACK(id: "uuid-123", seq: 4525)
→ (broadcast to Device B)
← ENTRY(entry: {id: "uuid-123", deleted: true, seq: 4525})
```

Device B receives via cursor sync or real-time broadcast.

### 5. Conflict: Same Entry Modified on Two Devices

Both devices offline, both modify entry "uuid-123":
- Device A reconnects first → entry saved with seq 4525
- Device B reconnects, sends its version → server compares:
  - **Server wins**: If server `seq` for this entry > 0, reject client update (or merge)
  - **Last-writer wins**: Accept update, assign seq 4526

**Recommendation**: Last-writer wins is acceptable for baby tracker. Server can optionally log conflicts.

---

## Pending Sync Queue

For reliability across page reloads, maintain a pending queue in IndexedDB:

```javascript
// pending_sync store
{
  id: 1,
  action: "add",
  entry: {...},
  created_at: 1706000000000
}
```

On entry creation:
1. Write to `entries` store with `seq: null`
2. Write to `pending_sync` store

On connect:
1. Fetch server state (sync_request)
2. Merge into local
3. Send all items from `pending_sync`
4. On each `entry_ack`:
   - Update entry's `seq` in `entries`
   - Delete from `pending_sync`

---

## Server Implementation Notes

### Entry Upsert Logic

```go
func (db *DB) UpsertEntry(familyID string, entry *Entry) (int64, error) {
    tx, _ := db.Begin()
    defer tx.Rollback()
    
    // Increment family sequence
    var seq int64
    tx.QueryRow(`
        UPDATE families SET seq = seq + 1 WHERE id = ? RETURNING seq
    `, familyID).Scan(&seq)
    
    // Upsert entry with new sequence
    tx.Exec(`
        INSERT INTO entries (id, family_id, ts, type, value, deleted, seq)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            ts = excluded.ts,
            type = excluded.type,
            value = excluded.value,
            deleted = excluded.deleted,
            seq = excluded.seq
    `, entry.ID, familyID, entry.Ts, entry.Type, entry.Value, entry.Deleted, seq)
    
    tx.Commit()
    return seq, nil
}
```

### Cursor Query

```go
func (db *DB) GetEntriesSince(familyID string, cursor, limit int64) ([]Entry, int64, bool, error) {
    rows, _ := db.Query(`
        SELECT id, ts, type, value, deleted, seq
        FROM entries
        WHERE family_id = ? AND seq > ?
        ORDER BY seq ASC
        LIMIT ?
    `, familyID, cursor, limit+1)
    
    entries := []Entry{}
    for rows.Next() {
        // scan...
        entries = append(entries, entry)
    }
    
    hasMore := len(entries) > int(limit)
    if hasMore {
        entries = entries[:limit]
    }
    
    newCursor := cursor
    if len(entries) > 0 {
        newCursor = entries[len(entries)-1].Seq
    }
    
    return entries, newCursor, hasMore, nil
}
```

---

## Migration Path

1. Add `seq` column to `families` and `entries` tables
2. Backfill: `UPDATE entries SET seq = rowid WHERE seq = 0`
3. Update `families.seq` to max entry seq per family
4. Deploy server with new sync protocol
5. Update client to use cursor-based sync
6. Client detects old format, resets cursor to 0 for full re-sync

---

## Open Questions

1. **Config sync** — config uses a separate mechanism
4. **Presence** — not required

---

## Summary

| Aspect | Approach |
|--------|----------|
| Ordering | Server-assigned monotonic `seq` per family |
| Sync boundary | Client cursor = highest received `seq` |
| Initial sync | Paginated fetch from cursor=0 |
| Delta sync | Fetch where `seq > cursor` |
| Offline entries | `seq: null` locally, ack assigns seq |
| Deletes | Soft delete, same sync mechanism |
| Conflicts | Last-writer-wins (server assigns seq on receipt) |
| Trust model | Server stamps `seq`, ignores client timestamps for ordering |
