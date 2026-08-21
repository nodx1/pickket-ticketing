##
## Build stage
##
FROM golang:1.22-alpine AS builder

RUN apk add --no-cache git ca-certificates

WORKDIR /app

# Copy dependency manifests first for better layer caching
COPY services/realtime-hub/go.mod services/realtime-hub/go.sum ./

# Download dependencies (go.sum is committed, no tidy needed)
RUN go mod download

# Copy remaining source
COPY services/realtime-hub/ .

# Build
RUN CGO_ENABLED=0 GOOS=linux GOARCH=amd64 go build \
    -ldflags="-w -s" \
    -o /realtime-hub \
    ./cmd/server/main.go

##
## Runtime stage
##
FROM alpine:3.19

RUN apk add --no-cache ca-certificates tzdata \
    && cp /usr/share/zoneinfo/Asia/Seoul /etc/localtime \
    && echo "Asia/Seoul" > /etc/timezone

RUN addgroup -S app && adduser -S app -G app
USER app

COPY --from=builder /realtime-hub /realtime-hub

EXPOSE 8031

ENTRYPOINT ["/realtime-hub"]
