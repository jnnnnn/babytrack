# Changelog

## Unreleased

### Added
- 7-day sleep chart on Graphs tab with dark mode support
- Current time indicator line ("now") on sleep chart
- Sleep chart anchors to the selected report date
- `verify.py` (cross-platform Python verifier replacing bash script)
- `.npmrc` enforcing pnpm as package manager

### Changed
- Switched from `mattn/go-sqlite3` (CGO) to `modernc.org/sqlite` (pure Go)
- Doubled sleep chart canvas height (220px → 440px)
- Grid lines softened in dark mode

### Fixed
- Sleep chart canvas rendered at 0×0 when Graphs tab was not initially active
- Playwright `webServer` command now works on Windows
