package config

import (
	"os"
	"strings"
)

type Config struct {
	Port              string
	RedisClusterNodes []string
	RedisPassword     string
	JWTSecretKey      string
	AllowedOrigins    []string
	SNSRegion         string
	SNSTopicPurchase  string
	SNSTopicSeatHold  string
	SNSTopicAdmission string
	Environment       string
	BackendHealthURL  string
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

func Load() *Config {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8030"
	}

	env := os.Getenv("ENVIRONMENT")
	if env == "" {
		env = "development"
	}

	snsRegion := os.Getenv("SNS_REGION")
	if snsRegion == "" {
		snsRegion = "ap-northeast-2"
	}

	var nodes []string
	raw := os.Getenv("REDIS_CLUSTER_NODES")
	if raw != "" {
		for _, n := range strings.Split(raw, ",") {
			trimmed := strings.TrimSpace(n)
			if trimmed != "" {
				nodes = append(nodes, trimmed)
			}
		}
	}
	if len(nodes) == 0 {
		nodes = []string{"localhost:6381"}
	}

	allowedOrigins := parseOrigins(os.Getenv("ALLOWED_ORIGINS"))
	if len(allowedOrigins) == 0 {
		allowedOrigins = []string{
			"https://pickket.kr",
			"https://www.pickket.kr",
			"https://go.pickket.kr",
			"https://admin.pickket.kr",
		}
	}

	return &Config{
		Port:              port,
		RedisClusterNodes: nodes,
		RedisPassword:     os.Getenv("REDIS_PASSWORD"),
		JWTSecretKey:      os.Getenv("JWT_SECRET_KEY"),
		AllowedOrigins:    allowedOrigins,
		SNSRegion:         snsRegion,
		SNSTopicPurchase:  os.Getenv("SNS_TOPIC_PURCHASE"),
		SNSTopicSeatHold:  os.Getenv("SNS_TOPIC_SEAT_HOLD"),
		SNSTopicAdmission: os.Getenv("SNS_TOPIC_ADMISSION"),
		Environment:       env,
		BackendHealthURL:  os.Getenv("BACKEND_HEALTH_URL"),
	}
}
