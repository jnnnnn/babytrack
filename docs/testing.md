# Testing Strategy

## Principles

1. **Fast feedback** - Tests run in <5s locally
2. **No external dependencies** - SQLite in-memory, no network
3. **Test behavior, not implementation** - Focus on API contracts
4. **Confidence for deploy** - Pass = safe to ship

## Test Pyramid

```
        ╱╲
       ╱  ╲       E2E (few)
      ╱────╲      Browser tests, full stack
     ╱      ╲
    ╱────────╲    Integration (some)
   ╱          ╲   HTTP handlers, WebSocket, DB queries
  ╱────────────╲
 ╱              ╲ Unit (many)
╱────────────────╲ Pure functions, business logic
```

## Layers

### Unit Tests

**What**: Pure functions, no I/O
**How**: Standard Go `testing` package
**Coverage target**: 80%+ for business logic

```go
// summary_test.go
func TestCalculateSleepMinutes(t *testing.T) {
    entries := []Entry{
        {Ts: 1000, Type: "sleep", Value: "sleeping"},
        {Ts: 2000, Type: "sleep", Value: "awake"},
    }
    got := calculateSleepMinutes(entries, dayStart, dayEnd)
    want := 16 // (2000-1000)/1000/60
    if got != want {
        t.Errorf("got %d, want %d", got, want)
    }
}
```

**Test files**:
- `summary_test.go` - Hourly/daily calculations
- `auth_test.go` - Token generation, validation
- `merge_test.go` - Conflict resolution logic

### Integration Tests

**What**: Handler → DB round trips
**How**: In-memory SQLite, `httptest.Server`
**Focus**: API contracts, auth flows

```go
// admin_test.go
func TestAdminLogin(t *testing.T) {
    db := setupTestDB(t)
    srv := httptest.NewServer(NewRouter(db))
    defer srv.Close()

    // Wrong password
    resp := post(srv.URL+"/admin/login", `{"username":"jane","password":"wrong"}`)
    assertStatus(t, resp, 401)

    // Correct password
    resp = post(srv.URL+"/admin/login", `{"username":"jane","password":"correct"}`)
    assertStatus(t, resp, 200)
    assertHasCookie(t, resp, "admin_session")
}
```

**Test files**:
- `admin_test.go` - Admin CRUD, auth
- `client_test.go` - Token access, app redirect
- `db_test.go` - Queries, migrations

### WebSocket Tests

**What**: Connection lifecycle, message broadcast
**How**: `gorilla/websocket` client in tests

```go
// ws_test.go
func TestWebSocketBroadcast(t *testing.T) {
    db := setupTestDB(t)
    srv := httptest.NewServer(NewRouter(db))
    familyID := createTestFamily(t, db)
    token := createTestLink(t, db, familyID)

    // Connect two clients
    ws1 := dialWS(t, srv, token)
    ws2 := dialWS(t, srv, token)

    // Client 1 sends entry
    ws1.WriteJSON(Message{Type: "entry", Action: "add", Entry: testEntry})

    // Client 2 receives broadcast
    var msg Message
    ws2.ReadJSON(&msg)
    assertEqual(t, msg.Type, "entry")
    assertEqual(t, msg.Entry.ID, testEntry.ID)
}

func TestWebSocketAuthRequired(t *testing.T) {
    srv := httptest.NewServer(NewRouter(setupTestDB(t)))
    _, resp, err := websocket.DefaultDialer.Dial(wsURL(srv, "invalid"), nil)
    assertStatus(t, resp, 401)
}
```

**Scenarios**:
- Auth required for upgrade
- Broadcast to same family only
- Disconnect/reconnect handling
- Concurrent writes

### E2E Tests (Optional)

**What**: Browser → server → browser
**How**: Playwright or similar
**When**: Pre-release smoke tests only

```
- Admin logs in
- Creates client
- Generates link
- Opens link in incognito
- Logs event
- Admin sees event in dashboard
```

Not blocking for MVP - manual testing sufficient initially.

## Test Helpers

```go
// testutil.go

// In-memory DB with schema
func setupTestDB(t *testing.T) *DB {
    t.Helper()
    db, err := NewDB(":memory:")
    if err != nil {
        t.Fatal(err)
    }
    t.Cleanup(func() { db.Close() })
    return db
}

// Create admin with known password
func createTestAdmin(t *testing.T, db *DB) {
    t.Helper()
    db.CreateAdmin("jane", "testpass123")
}

// Create family and return ID
func createTestFamily(t *testing.T, db *DB) string {
    t.Helper()
    id, _ := db.CreateFamily("Test Baby", "")
    return id
}

// HTTP client with cookie jar
func newTestClient() *http.Client {
    jar, _ := cookiejar.New(nil)
    return &http.Client{Jar: jar}
}
```

## Running Tests

```bash
# All tests
go test ./...

# With coverage
go test -cover ./...

# Specific package
go test ./server -v

# Race detector (slow, use sparingly)
go test -race ./...
```

## What We Don't Test

- SQLite internals (trust the library)
- Third-party WebSocket framing
- CSS/HTML rendering
- fly.io infrastructure

## Test Data

Use deterministic data, not random:
- Fixed timestamps: `1704067200000` (2024-01-01 00:00:00 UTC)
- Fixed UUIDs: `test-entry-001`, `test-entry-002`
- Fixed tokens: `test-token-abc123...`

Avoid `time.Now()` in tests - inject time or use fixed values.

## Debugging Failures

```go
// Add to failing test
t.Logf("entries: %+v", entries)
t.Logf("response: %s", body)

// Run single test with verbose
go test -v -run TestCalculateSleepMinutes ./server
```

## Coverage Goals

| Package | Target |
|---------|--------|
| `summary` | 90% |
| `auth` | 80% |
| `db` | 70% |
| `ws` | 60% |
| `handlers` | 50% |

Focus coverage on business logic, not boilerplate.
