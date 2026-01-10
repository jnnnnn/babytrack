package main

import (
	"database/sql"

	_ "github.com/mattn/go-sqlite3"
)

type DB struct {
	*sql.DB
}

func NewDB(path string) (*DB, error) {
	db, err := sql.Open("sqlite3", path+"?_journal=WAL&_busy_timeout=5000")
	if err != nil {
		return nil, err
	}

	if err := db.Ping(); err != nil {
		return nil, err
	}

	if err := migrate(db); err != nil {
		return nil, err
	}

	return &DB{db}, nil
}

func migrate(db *sql.DB) error {
	_, err := db.Exec(`
		CREATE TABLE IF NOT EXISTS schema_version (
			version INTEGER PRIMARY KEY
		);
	`)
	if err != nil {
		return err
	}

	var version int
	err = db.QueryRow("SELECT COALESCE(MAX(version), 0) FROM schema_version").Scan(&version)
	if err != nil {
		return err
	}

	migrations := []string{
		// v1: initial schema
		`CREATE TABLE admins (
			id TEXT PRIMARY KEY,
			username TEXT UNIQUE NOT NULL,
			password_hash TEXT NOT NULL,
			created_at INTEGER NOT NULL
		);

		CREATE TABLE families (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			notes TEXT,
			created_at INTEGER NOT NULL,
			archived INTEGER DEFAULT 0
		);

		CREATE TABLE access_links (
			token TEXT PRIMARY KEY,
			family_id TEXT NOT NULL REFERENCES families(id),
			label TEXT,
			expires_at INTEGER,
			created_at INTEGER NOT NULL
		);

		CREATE TABLE admin_sessions (
			token TEXT PRIMARY KEY,
			admin_id TEXT NOT NULL REFERENCES admins(id),
			expires_at INTEGER NOT NULL
		);

		CREATE TABLE entries (
			id TEXT PRIMARY KEY,
			family_id TEXT NOT NULL REFERENCES families(id),
			ts INTEGER NOT NULL,
			type TEXT NOT NULL,
			value TEXT NOT NULL,
			deleted INTEGER DEFAULT 0,
			updated_at INTEGER NOT NULL
		);

		CREATE TABLE configs (
			family_id TEXT PRIMARY KEY REFERENCES families(id),
			data TEXT NOT NULL,
			updated_at INTEGER NOT NULL
		);

		CREATE INDEX idx_entries_family ON entries(family_id);
		CREATE INDEX idx_entries_updated ON entries(family_id, updated_at);
		CREATE INDEX idx_entries_ts ON entries(family_id, ts);`,
	}

	for i, m := range migrations {
		v := i + 1
		if v <= version {
			continue
		}

		if _, err := db.Exec(m); err != nil {
			return err
		}

		if _, err := db.Exec("INSERT INTO schema_version (version) VALUES (?)", v); err != nil {
			return err
		}
	}

	return nil
}
