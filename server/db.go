package main

import (
	"database/sql"
	"time"

	"golang.org/x/crypto/bcrypt"

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

// Types

type Admin struct {
	ID           string `json:"id"`
	Username     string `json:"username"`
	PasswordHash string `json:"-"`
	CreatedAt    int64  `json:"created_at"`
}

type Family struct {
	ID        string `json:"id"`
	Name      string `json:"name"`
	Notes     string `json:"notes"`
	CreatedAt int64  `json:"created_at"`
	Archived  bool   `json:"archived"`
}

type AccessLink struct {
	Token     string `json:"token"`
	FamilyID  string `json:"family_id"`
	Label     string `json:"label"`
	ExpiresAt *int64 `json:"expires_at"`
	CreatedAt int64  `json:"created_at"`
}

type Entry struct {
	ID        string `json:"id"`
	FamilyID  string `json:"family_id"`
	Ts        int64  `json:"ts"`
	Type      string `json:"type"`
	Value     string `json:"value"`
	Deleted   bool   `json:"deleted"`
	UpdatedAt int64  `json:"updated_at"`
}

// Admin methods

func (db *DB) EnsureAdmin(username, password string) error {
	var exists bool
	err := db.QueryRow("SELECT 1 FROM admins WHERE username = ?", username).Scan(&exists)
	if err == nil {
		return nil // already exists
	}

	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcrypt.DefaultCost)
	if err != nil {
		return err
	}

	id := generateToken(8)
	_, err = db.Exec(
		"INSERT INTO admins (id, username, password_hash, created_at) VALUES (?, ?, ?, ?)",
		id, username, string(hash), time.Now().UnixMilli(),
	)
	return err
}

func (db *DB) GetAdminByUsername(username string) (*Admin, error) {
	var a Admin
	err := db.QueryRow(
		"SELECT id, username, password_hash, created_at FROM admins WHERE username = ?",
		username,
	).Scan(&a.ID, &a.Username, &a.PasswordHash, &a.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &a, nil
}

func (db *DB) CreateAdminSession(adminID string, duration time.Duration) (string, error) {
	token := generateToken(32)
	expiresAt := time.Now().Add(duration).UnixMilli()
	_, err := db.Exec(
		"INSERT INTO admin_sessions (token, admin_id, expires_at) VALUES (?, ?, ?)",
		token, adminID, expiresAt,
	)
	return token, err
}

func (db *DB) ValidateAdminSession(token string) (string, error) {
	var adminID string
	var expiresAt int64
	err := db.QueryRow(
		"SELECT admin_id, expires_at FROM admin_sessions WHERE token = ?",
		token,
	).Scan(&adminID, &expiresAt)
	if err != nil {
		return "", err
	}
	if time.Now().UnixMilli() > expiresAt {
		db.DeleteAdminSession(token)
		return "", sql.ErrNoRows
	}
	return adminID, nil
}

func (db *DB) DeleteAdminSession(token string) error {
	_, err := db.Exec("DELETE FROM admin_sessions WHERE token = ?", token)
	return err
}

// Family methods

func (db *DB) ListFamilies(includeArchived bool) ([]Family, error) {
	query := "SELECT id, name, notes, created_at, archived FROM families"
	if !includeArchived {
		query += " WHERE archived = 0"
	}
	query += " ORDER BY created_at DESC"

	rows, err := db.Query(query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var families []Family
	for rows.Next() {
		var f Family
		var notes sql.NullString
		if err := rows.Scan(&f.ID, &f.Name, &notes, &f.CreatedAt, &f.Archived); err != nil {
			return nil, err
		}
		f.Notes = notes.String
		families = append(families, f)
	}
	return families, rows.Err()
}

func (db *DB) CreateFamily(name, notes string) (*Family, error) {
	id := generateToken(4) // 8 hex chars
	now := time.Now().UnixMilli()
	_, err := db.Exec(
		"INSERT INTO families (id, name, notes, created_at, archived) VALUES (?, ?, ?, ?, 0)",
		id, name, notes, now,
	)
	if err != nil {
		return nil, err
	}
	return &Family{ID: id, Name: name, Notes: notes, CreatedAt: now, Archived: false}, nil
}

func (db *DB) GetFamily(id string) (*Family, error) {
	var f Family
	var notes sql.NullString
	err := db.QueryRow(
		"SELECT id, name, notes, created_at, archived FROM families WHERE id = ?",
		id,
	).Scan(&f.ID, &f.Name, &notes, &f.CreatedAt, &f.Archived)
	if err != nil {
		return nil, err
	}
	f.Notes = notes.String
	return &f, nil
}

func (db *DB) UpdateFamily(id string, name, notes *string, archived *bool) error {
	if name != nil {
		if _, err := db.Exec("UPDATE families SET name = ? WHERE id = ?", *name, id); err != nil {
			return err
		}
	}
	if notes != nil {
		if _, err := db.Exec("UPDATE families SET notes = ? WHERE id = ?", *notes, id); err != nil {
			return err
		}
	}
	if archived != nil {
		a := 0
		if *archived {
			a = 1
		}
		if _, err := db.Exec("UPDATE families SET archived = ? WHERE id = ?", a, id); err != nil {
			return err
		}
	}
	return nil
}

// Access link methods

func (db *DB) ListAccessLinks(familyID string) ([]AccessLink, error) {
	rows, err := db.Query(
		"SELECT token, family_id, label, expires_at, created_at FROM access_links WHERE family_id = ? ORDER BY created_at DESC",
		familyID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var links []AccessLink
	for rows.Next() {
		var l AccessLink
		var label sql.NullString
		var expiresAt sql.NullInt64
		if err := rows.Scan(&l.Token, &l.FamilyID, &label, &expiresAt, &l.CreatedAt); err != nil {
			return nil, err
		}
		l.Label = label.String
		if expiresAt.Valid {
			l.ExpiresAt = &expiresAt.Int64
		}
		links = append(links, l)
	}
	return links, rows.Err()
}

func (db *DB) CreateAccessLink(familyID, label string, expiresAt *int64) (*AccessLink, error) {
	token := generateToken(16) // 32 hex chars
	now := time.Now().UnixMilli()
	_, err := db.Exec(
		"INSERT INTO access_links (token, family_id, label, expires_at, created_at) VALUES (?, ?, ?, ?, ?)",
		token, familyID, label, expiresAt, now,
	)
	if err != nil {
		return nil, err
	}
	return &AccessLink{Token: token, FamilyID: familyID, Label: label, ExpiresAt: expiresAt, CreatedAt: now}, nil
}

func (db *DB) ValidateAccessLink(token string) (*AccessLink, error) {
	var l AccessLink
	var label sql.NullString
	var expiresAt sql.NullInt64
	err := db.QueryRow(
		"SELECT token, family_id, label, expires_at, created_at FROM access_links WHERE token = ?",
		token,
	).Scan(&l.Token, &l.FamilyID, &label, &expiresAt, &l.CreatedAt)
	if err != nil {
		return nil, err
	}
	l.Label = label.String
	if expiresAt.Valid {
		if time.Now().UnixMilli() > expiresAt.Int64 {
			return nil, sql.ErrNoRows // expired
		}
		l.ExpiresAt = &expiresAt.Int64
	}
	return &l, nil
}

func (db *DB) DeleteAccessLink(token string) error {
	_, err := db.Exec("DELETE FROM access_links WHERE token = ?", token)
	return err
}

// Entry methods

func (db *DB) GetEntries(familyID string, sinceUpdatedAt int64) ([]Entry, error) {
	rows, err := db.Query(
		`SELECT id, family_id, ts, type, value, deleted, updated_at 
		 FROM entries 
		 WHERE family_id = ? AND updated_at > ? 
		 ORDER BY updated_at ASC`,
		familyID, sinceUpdatedAt,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var entries []Entry
	for rows.Next() {
		var e Entry
		if err := rows.Scan(&e.ID, &e.FamilyID, &e.Ts, &e.Type, &e.Value, &e.Deleted, &e.UpdatedAt); err != nil {
			return nil, err
		}
		entries = append(entries, e)
	}
	return entries, rows.Err()
}

func (db *DB) UpsertEntry(e *Entry) error {
	e.UpdatedAt = time.Now().UnixMilli()
	_, err := db.Exec(
		`INSERT INTO entries (id, family_id, ts, type, value, deleted, updated_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   ts = excluded.ts,
		   type = excluded.type,
		   value = excluded.value,
		   deleted = excluded.deleted,
		   updated_at = excluded.updated_at`,
		e.ID, e.FamilyID, e.Ts, e.Type, e.Value, e.Deleted, e.UpdatedAt,
	)
	return err
}

func (db *DB) DeleteEntry(familyID, id string) error {
	now := time.Now().UnixMilli()
	_, err := db.Exec(
		"UPDATE entries SET deleted = 1, updated_at = ? WHERE id = ? AND family_id = ?",
		now, id, familyID,
	)
	return err
}

// Config methods

func (db *DB) GetConfig(familyID string) (string, error) {
	var data string
	err := db.QueryRow("SELECT data FROM configs WHERE family_id = ?", familyID).Scan(&data)
	if err == sql.ErrNoRows {
		return "{}", nil
	}
	return data, err
}

func (db *DB) SaveConfig(familyID, data string) error {
	now := time.Now().UnixMilli()
	_, err := db.Exec(
		`INSERT INTO configs (family_id, data, updated_at)
		 VALUES (?, ?, ?)
		 ON CONFLICT(family_id) DO UPDATE SET
		   data = excluded.data,
		   updated_at = excluded.updated_at`,
		familyID, data, now,
	)
	return err
}
