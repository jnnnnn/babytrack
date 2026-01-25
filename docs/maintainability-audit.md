# Maintainability Audit

**Date**: 2026-01-25  
**Status**: Complete  
**Bead**: battleships-vfc

## Executive Summary

The codebase is reasonably maintainable for a small team / solo dev project. Key strengths:
- Clean separation (Go backend + vanilla JS frontend)
- Good test coverage (67% Go, E2E for critical paths)
- Documentation exists for core concepts

Areas needing attention:
- Code duplication in HTTP handlers (high)
- No frontend test coverage (high)
- 2200-line monolithic JS file (medium)
- Inconsistent error handling (medium)

## Code Structure

### Backend (Go)

| File | Lines | Purpose | Issues |
|------|-------|---------|--------|
| db.go | 576 | Data layer | Long but coherent |
| admin.go | 378 | HTTP handlers | Repetitive JSON/error patterns |
| ws.go | 349 | WebSocket hub | Clean, focused |
| log.go | 167 | Logging + middleware | Has duplicate `requestID` ≈ `generateToken` |
| main.go | 95 | Entrypoint + routes | Clean |

**Total**: ~1,565 lines (excl. tests)

### Frontend (JS)

| File | Lines | Purpose | Issues |
|------|-------|---------|--------|
| babytrack.js | 2,215 | Main app | **Monolithic**, needs splitting |
| sync-client.js | 405 | WebSocket client | Clean, well-documented |

### Tests

| File | Lines | Coverage |
|------|-------|----------|
| Go tests | 1,425 | 67.4% |
| E2E tests | 211 | Critical paths |

## Issues Found

### 1. Code Duplication (High Priority)

**1a. Token generation duplicated**

Two nearly identical functions:
- `generateToken(n int)` in admin.go — hex-encoded random bytes
- `requestID()` in log.go — same thing, fixed at 8 bytes

**Recommendation**: Consolidate into one function in a `util.go` or reuse `generateToken`.

**1b. HTTP response patterns repeated**

Every handler has:
```go
w.Header().Set("Content-Type", "application/json")
json.NewEncoder(w).Encode(data)
```

And error handling:
```go
http.Error(w, "internal error", http.StatusInternalServerError)
```

Found **8 occurrences** of "internal error" and **10 occurrences** of Content-Type setting.

**Recommendation**: Add helper functions:
```go
func jsonResponse(w http.ResponseWriter, status int, data any) {
    w.Header().Set("Content-Type", "application/json")
    w.WriteHeader(status)
    json.NewEncoder(w).Encode(data)
}

func serverError(w http.ResponseWriter, err error) {
    slog.Error("request failed", "error", err)
    http.Error(w, "internal error", http.StatusInternalServerError)
}
```

### 2. Monolithic Frontend (Medium Priority)

`babytrack.js` at 2,215 lines is too large. Functions span:
- Database (IndexedDB)
- UI rendering (button states, reports)
- Time calculations
- Error forwarding
- Configuration
- Sync logic

**Recommendation**: Split into modules:
- `db.js` — IndexedDB operations (~200 lines)
- `ui.js` — DOM manipulation, rendering (~600 lines)
- `time.js` — date/time utilities (~100 lines)
- `report.js` — daily report logic (~400 lines)
- `app.js` — main orchestration (~500 lines)

Use native ES modules: `<script type="module" src="app.js">`.

### 3. No Frontend Unit Tests (High Priority)

Frontend has zero unit tests. Critical business logic includes:
- Sleep duration calculations
- Day boundary handling
- Entry merging during sync
- Config parsing

**Recommendation**: Add Vitest or Jest for:
- Time calculation functions (pure, easy to test)
- Entry filtering logic
- Report generation

### 4. Inconsistent Error Handling (Medium)

Backend handlers silently ignore some errors:
```go
entries, _ := s.db.GetEntries(c.familyID, 0)  // ws.go:151
config, _ := s.db.GetConfig(c.familyID)        // ws.go:152
```

**Recommendation**: At minimum, log errors; consider sending error message to client.

### 5. Missing Godoc Comments (Low)

Exported types (`Entry`, `Family`, `Hub`) lack documentation. Makes API surface unclear for new contributors.

**Recommendation**: Add package-level and type-level comments.

### 6. No Linter Configured (Low)

`verify` script has `golangci-lint` commented out.

**Recommendation**: Enable with sensible config (errcheck, staticcheck, gosimple at minimum).

## Test Coverage Gaps

Current: **67.4%**

Uncovered areas (from `./verify --uncovered`):
- Error paths in HTTP handlers (auth failures, DB errors)
- Some WebSocket edge cases
- Admin summary handler timezone logic

**Recommendation**: Target 80% for core business logic. Accept lower coverage for error paths if they're logged.

## Documentation Status

| Doc | Status | Notes |
|-----|--------|-------|
| AGENTS.md | ✅ Good | Clear workflow |
| docs/backend.md | ✅ Good | Architecture, data model |
| docs/sync-protocol.md | ✅ Good | Wire protocol |
| docs/testing.md | ✅ Good | Test strategy |
| roadmap.md | ❌ Missing | Mentioned in AGENTS.md but doesn't exist |

## Recommendations Summary

| Priority | Issue | Effort | Impact |
|----------|-------|--------|--------|
| High | Add JSON/error helpers | 1h | Reduces boilerplate, prevents bugs |
| High | Add frontend tests | 4h | Catch regressions |
| Medium | Split babytrack.js | 3h | Easier navigation, smaller diffs |
| Medium | Log ignored errors | 30m | Better debugging |
| Low | Consolidate token gen | 15m | Cleaner |
| Low | Enable golangci-lint | 1h | Catch issues early |
| Low | Add Godoc comments | 1h | Onboarding |

## Action Items

1. [x] Create `server/http.go` with `jsonResponse()` and `serverError()` helpers
2. [x] Refactor admin.go handlers to use helpers
3. [x] Consolidate `requestID()` into `generateToken()`
4. [ ] Split babytrack.js into ES modules
5. [ ] Add Vitest for frontend unit tests
6. [ ] Enable golangci-lint in verify script
7. [ ] Create roadmap.md

## Metrics

- **Cyclomatic complexity**: Acceptable (no function > 15)
- **File sizes**: Backend good, frontend needs work
- **Dependency count**: Minimal (gorilla/websocket, bcrypt, sqlite3)
- **Build time**: Fast (<5s tests)
