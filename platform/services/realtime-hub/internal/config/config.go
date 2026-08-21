package config

import (
	"os"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	Port              string
	RedisClusterNodes string
	RedisPassword     string
	JWTSecretKey      string
	AllowedOrigins    []string
	MaxConnections    int
	WriteBufferSize   int
	ReadBufferSize    int
	PongWait          time.Duration
	PingPeriod        time.Duration
	WriteWait         time.Duration
}

func Load() *Config {
	cfg := &Config{
		Port:              envOrDefault("PORT", "8031"),
		RedisClusterNodes: envOrDefault("REDIS_CLUSTER_NODES", "localhost:6381"),
		RedisPassword:     envOrDefault("REDIS_PASSWORD", ""),
		JWTSecretKey:      envOrDefault("JWT_SECRET_KEY", ""),
		AllowedOrigins:    parseOrigins(envOrDefault("ALLOWED_ORIGINS", "https://pickket.kr,https://www.pickket.kr,https://go.pickket.kr,https://admin.pickket.kr")),
		MaxConnections:    envIntOrDefault("MAX_CONNECTIONS", 200000),
		WriteBufferSize:   envIntOrDefault("WRITE_BUFFER_SIZE", 1024),
		ReadBufferSize:    envIntOrDefault("READ_BUFFER_SIZE", 1024),
		PongWait:          time.Duration(envIntOrDefault("PONG_WAIT_SECONDS", 60)) * time.Second,
		PingPeriod:        time.Duration(envIntOrDefault("PING_PERIOD_SECONDS", 54)) * time.Second,
		WriteWait:         time.Duration(envIntOrDefault("WRITE_WAIT_SECONDS", 10)) * time.Second,
	}
	return cfg
}

func parseOrigins(raw string) []string {
	var origins []string
	for _, o := range strings.Split(raw, ",") {
		trimmed := strings.TrimSpace(o)
		if trimmed != "" {
			origins = append(origins, trimmed)
		}
	}
	return origins
}

func envOrDefault(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func envIntOrDefault(key string, fallback int) int {
	v := os.Getenv(key)
	if v == "" {
		return fallback
	}
	n, err := strconv.Atoi(v)
	if err != nil {
		return fallback
	}
	return n
}
