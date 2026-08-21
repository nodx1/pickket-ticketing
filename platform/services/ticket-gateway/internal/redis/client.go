package redis

import (
	"context"
	"crypto/tls"
	"os"
	"strings"
	"time"

	"github.com/pickket/ticket-gateway/internal/config"
	goredis "github.com/redis/go-redis/v9"
)

type Client struct {
	rdb       goredis.UniversalClient
	isCluster bool
}

func NewClient(cfg *config.Config) (*Client, error) {
	var rdb goredis.UniversalClient
	isCluster := len(cfg.RedisClusterNodes) > 1

	// Enable TLS for non-development environments (ElastiCache transit encryption)
	var tlsCfg *tls.Config
	if env := os.Getenv("ENVIRONMENT"); env != "" && env != "development" {
		tlsCfg = &tls.Config{MinVersion: tls.VersionTLS12}
	}

	// Treat whitespace-only or "none" as no password (ElastiCache without AUTH)
	password := strings.TrimSpace(cfg.RedisPassword)
	if password == "none" {
		password = ""
	}

	if isCluster {
		rdb = goredis.NewClusterClient(&goredis.ClusterOptions{
			Addrs:        cfg.RedisClusterNodes,
			Password:     password,
			TLSConfig:    tlsCfg,
			DialTimeout:  5 * time.Second,
			ReadTimeout:  3 * time.Second,
			WriteTimeout: 3 * time.Second,
			PoolSize:     100,
			MinIdleConns: 10,
		})
	} else {
		rdb = goredis.NewClient(&goredis.Options{
			Addr:         cfg.RedisClusterNodes[0],
			Password:     password,
			TLSConfig:    tlsCfg,
			DB:           0,
			DialTimeout:  5 * time.Second,
			ReadTimeout:  3 * time.Second,
			WriteTimeout: 3 * time.Second,
			PoolSize:     100,
			MinIdleConns: 10,
		})
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := rdb.Ping(ctx).Err(); err != nil {
		return nil, err
	}

	return &Client{rdb: rdb, isCluster: isCluster}, nil
}

func (c *Client) Underlying() goredis.UniversalClient {
	return c.rdb
}

func (c *Client) IsCluster() bool {
	return c.isCluster
}

func (c *Client) Close() error {
	return c.rdb.Close()
}

func (c *Client) Ping(ctx context.Context) error {
	return c.rdb.Ping(ctx).Err()
}
