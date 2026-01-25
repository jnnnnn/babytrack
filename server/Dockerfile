# Build stage
FROM golang:1.25.6-alpine AS builder

RUN apk add --no-cache gcc musl-dev

WORKDIR /app

# Copy go mod files
COPY go.mod go.sum ./
RUN go mod download

# Copy source
COPY *.go ./

# Build with CGO for SQLite
RUN CGO_ENABLED=1 GOOS=linux go build -o babytrackd .

# Runtime stage
FROM alpine

RUN apk add --no-cache ca-certificates sqlite tzdata

WORKDIR /app

# Copy binary from builder
COPY --from=builder /app/babytrackd .

# Copy static files
COPY static/ ./static/

# Create data directory
RUN mkdir -p /data

EXPOSE 8080

ENV PORT=8080
ENV DB_PATH=/data/babytrack.db

CMD ["./babytrackd"]
