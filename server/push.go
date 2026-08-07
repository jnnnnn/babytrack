package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/SherClockHolmes/webpush-go"
)

type PushSubscription struct {
	FamilyID  string `json:"family_id"`
	Token     string `json:"token"`
	Endpoint  string `json:"endpoint"`
	P256DH    string `json:"p256dh"`
	Auth      string `json:"auth"`
	CreatedAt int64  `json:"created_at"`
}

func (db *DB) SavePushSubscription(sub *PushSubscription) error {
	sub.CreatedAt = time.Now().UnixMilli()
	_, err := db.Exec(`
		INSERT INTO push_subscriptions (family_id, token, endpoint, p256dh, auth, created_at)
		VALUES (?, ?, ?, ?, ?, ?)
		ON CONFLICT(endpoint) DO UPDATE SET
			family_id = excluded.family_id,
			token = excluded.token,
			p256dh = excluded.p256dh,
			auth = excluded.auth
	`, sub.FamilyID, sub.Token, sub.Endpoint, sub.P256DH, sub.Auth, sub.CreatedAt)
	return err
}

func (db *DB) DeletePushSubscription(familyID, token string) error {
	_, err := db.Exec("DELETE FROM push_subscriptions WHERE family_id = ? AND token = ?", familyID, token)
	return err
}

func (db *DB) GetPushSubscriptions(familyID, excludeToken string) ([]PushSubscription, error) {
	rows, err := db.Query(
		"SELECT family_id, token, endpoint, p256dh, auth, COALESCE(created_at, 0) FROM push_subscriptions WHERE family_id = ?",
		familyID,
	)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var subs []PushSubscription
	for rows.Next() {
		var s PushSubscription
		if err := rows.Scan(&s.FamilyID, &s.Token, &s.Endpoint, &s.P256DH, &s.Auth, &s.CreatedAt); err != nil {
			continue
		}
		if s.Token != excludeToken {
			subs = append(subs, s)
		}
	}
	return subs, nil
}

type pushManager struct {
	vapidPrivKey string // base64 DER-encoded ECDSA P-256 private key
	vapidPubKey  string // base64 URL-safe uncompressed public key (65 bytes)
}

func newPushManager(envPrivKey, envPubKey string) (*pushManager, error) {
	if envPrivKey != "" && envPubKey != "" {
		return &pushManager{
			vapidPrivKey: envPrivKey,
			vapidPubKey:  envPubKey,
		}, nil
	}

	privKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return nil, err
	}

	derBytes, err := x509.MarshalECPrivateKey(privKey)
	if err != nil {
		return nil, err
	}
	vapidPrivKey := base64.RawURLEncoding.EncodeToString(derBytes)

	pubKeyBytes := elliptic.Marshal(elliptic.P256(), privKey.PublicKey.X, privKey.PublicKey.Y)
	vapidPubKey := base64.RawURLEncoding.EncodeToString(pubKeyBytes)

	slog.Warn("VAPID keys not set - generated new pair. Store these as env vars:",
		"VAPID_PRIVATE_KEY", vapidPrivKey,
		"VAPID_PUBLIC_KEY", vapidPubKey)

	return &pushManager{
		vapidPrivKey: vapidPrivKey,
		vapidPubKey:  vapidPubKey,
	}, nil
}

func (pm *pushManager) publicKey() string {
	return pm.vapidPubKey
}

func (pm *pushManager) sendPushNotification(sub *PushSubscription, title, body string) error {
	resp, err := webpush.SendNotification(
		[]byte(`{"title":"`+title+`","body":"`+body+`","icon":"/icon-192.png"}`),
		&webpush.Subscription{
			Endpoint: sub.Endpoint,
			Keys: webpush.Keys{
				Auth:   sub.Auth,
				P256dh: sub.P256DH,
			},
		},
		&webpush.Options{
			Subscriber:      "mailto:system@babytrack.app",
			VAPIDPrivateKey: pm.vapidPrivKey,
			TTL:             3600,
		},
	)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		slog.Warn("push notification rejected", "status", resp.StatusCode)
	}
	return nil
}

type notifyMap map[string]bool

func parseNotifyConfig(configJSON string) notifyMap {
	nc := make(notifyMap)
	if configJSON == "" {
		return nc
	}
	var groups []struct {
		Category string `json:"category"`
		Buttons  []struct {
			Value  string `json:"value"`
			Notify bool   `json:"notify"`
		} `json:"buttons"`
	}
	if err := json.Unmarshal([]byte(configJSON), &groups); err != nil {
		return nc
	}
	for _, group := range groups {
		for _, btn := range group.Buttons {
			if btn.Notify {
				nc[btn.Value] = true
			}
		}
	}
	return nc
}
