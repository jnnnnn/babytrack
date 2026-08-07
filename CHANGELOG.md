# Changelog

## Unreleased

### Added
- 7-day sleep chart on Graphs tab with dark mode support
- Current time indicator line ("now") on sleep chart
- Sleep chart anchors to the selected report date
- `verify.py` (cross-platform Python verifier replacing bash script)
- `.npmrc` enforcing pnpm as package manager
- PWA: web app manifest, service worker with offline cache, installable on phones
- Self-signed HTTPS cert generation (`TLS=true`) for local phone testing
- App icons (192px, 512px)
- Service worker globals to ESLint config
- Push notifications via Web Push (VAPID) with per-button notify toggle in config modal
- Service worker push event handler with notification click-to-focus
- VAPID key auto-generation on first run
- `push_subscriptions` table for storing browser push endpoints

### Changed
- Switched from `mattn/go-sqlite3` (CGO) to `modernc.org/sqlite` (pure Go)
- Doubled sleep chart canvas height (220px → 440px)
- Grid lines softened in dark mode
- Sync: server-push pagination eliminates round trips for large datasets
- Sync: `init` message no longer sends entries (handled by `sync_request` instead)

### Fixed
- Sleep chart canvas rendered at 0×0 when Graphs tab was not initially active
- Playwright `webServer` command now works on Windows
