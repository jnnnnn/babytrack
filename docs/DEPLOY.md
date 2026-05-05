# Deploying BabyTrack

## Environment Variables

| Variable      | Default        | Purpose                              |
|---------------|----------------|--------------------------------------|
| `PORT`        | `8080`         | HTTP listen port                     |
| `DB_PATH`     | `babytrack.db` | SQLite database file path            |
| `ADMIN_USER`  | *(required)*   | Admin username, created on first run |
| `ADMIN_PASS`  | *(required)*   | Admin password (bcrypt-hashed)       |
| `LOG_LEVEL`   | `info`         | `debug` for verbose logs             |
| `LOG_FORMAT`  | `json`         | `text` for human-readable logs       |

The admin user is bootstrapped once: if `ADMIN_USER` and `ADMIN_PASS` are set on startup and the admin doesn't exist, it's created automatically. On subsequent restarts, these vars are unused.

## Docker

```bash
cd server
docker build -t babytrackd .
```

The image is ~17MB (Alpine + Go binary + static files). Run it with a persistent volume:

```bash
docker run -d \
  --name babytrack \
  -p 8080:8080 \
  -v /srv/babytrack:/data \
  -e ADMIN_USER=admin \
  -e ADMIN_PASS=your-secure-password \
  babytrackd
```

The database lives at `/data/babytrack.db` inside the container. Mount a host directory to persist it.

## Fly.io

The project includes a `fly.toml` (in `server/`). To deploy:

```bash
# One-time setup
fly launch --path server

# On subsequent deploys
cd server
fly deploy --ha=false
```

The Fly config uses a persistent volume (`jonobabytrack_data`) mounted at `/data`, a `shared-cpu-1x` VM with 256MB RAM, and auto-stop/start to save costs. Set secrets:

```bash
fly secrets set ADMIN_USER=admin ADMIN_PASS=your-secure-password
```

## VPS (generic)

Build from source (requires Go 1.25+ and a C compiler for SQLite):

```bash
cd server
CGO_ENABLED=1 go build -o babytrackd .
```

Place the binary and `static/` directory together, then run. Example systemd unit:

```ini
[Unit]
Description=BabyTrack
After=network.target

[Service]
Type=simple
User=babytrack
WorkingDirectory=/opt/babytrack
Environment=PORT=8080
Environment=DB_PATH=/var/lib/babytrack/babytrack.db
Environment=ADMIN_USER=admin
Environment=ADMIN_PASS=your-secure-password
ExecStart=/opt/babytrack/babytrackd
Restart=always

[Install]
WantedBy=multi-user.target
```

Put it behind nginx or Caddy if you need TLS:

```nginx
server {
    listen 443 ssl;
    server_name babytrack.example.com;

    ssl_certificate     /etc/letsencrypt/live/babytrack.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/babytrack.example.com/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:8080;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_read_timeout 86400s;
    }
}
```

The `Upgrade` / `Connection` headers are required for WebSocket support.

## Backups

The entire database is a single SQLite file. Back it up by copying:

```bash
cp /var/lib/babytrack/babytrack.db /backups/babytrack-$(date +%Y%m%d).db
```

This is safe while the server is running (SQLite WAL mode). Add a cron job:

```
0 3 * * * cp /var/lib/babytrack/babytrack.db /backups/babytrack-$(date +\%Y\%m\%d).db
```

To query the database directly:

```bash
sqlite3 /var/lib/babytrack/babytrack.db "SELECT * FROM families;"
```
