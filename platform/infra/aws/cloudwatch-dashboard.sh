#!/usr/bin/env bash
# Create CloudWatch console dashboard for Pickket production monitoring
set -euo pipefail

REGION="ap-northeast-2"
CLUSTER="pickket"
NAMESPACE="Pickket/Application"

cat > /tmp/pickket-dashboard.json << 'DASHBOARD_EOF'
{
  "widgets": [
    {
      "type": "text",
      "x": 0, "y": 0, "width": 24, "height": 1,
      "properties": { "markdown": "# Pickket Production Dashboard" }
    },
    {
      "type": "metric",
      "x": 0, "y": 1, "width": 8, "height": 6,
      "properties": {
        "title": "HTTP Request Rate (RPS)",
        "metrics": [
          [ "Pickket/Application", "http_requests_total", { "stat": "Sum", "period": 60, "label": "Requests/min" } ]
        ],
        "view": "timeSeries",
        "region": "ap-northeast-2",
        "period": 60
      }
    },
    {
      "type": "metric",
      "x": 8, "y": 1, "width": 8, "height": 6,
      "properties": {
        "title": "HTTP Latency (p50/p95/p99)",
        "metrics": [
          [ "Pickket/Application", "http_request_duration_seconds", { "stat": "p50", "label": "p50" } ],
          [ "...", { "stat": "p95", "label": "p95" } ],
          [ "...", { "stat": "p99", "label": "p99" } ]
        ],
        "view": "timeSeries",
        "region": "ap-northeast-2",
        "period": 60
      }
    },
    {
      "type": "metric",
      "x": 16, "y": 1, "width": 8, "height": 6,
      "properties": {
        "title": "5xx Error Rate",
        "metrics": [
          [ "Pickket/Application", "http_requests_total", "status", "5xx", { "stat": "Sum", "period": 60, "label": "5xx errors" } ]
        ],
        "view": "timeSeries",
        "region": "ap-northeast-2",
        "period": 60,
        "yAxis": { "left": { "min": 0 } }
      }
    },
    {
      "type": "metric",
      "x": 0, "y": 7, "width": 8, "height": 6,
      "properties": {
        "title": "Active HTTP Requests",
        "metrics": [
          [ "Pickket/Application", "http_active_requests", { "stat": "Average", "label": "Active" } ]
        ],
        "view": "timeSeries",
        "region": "ap-northeast-2",
        "period": 60
      }
    },
    {
      "type": "metric",
      "x": 8, "y": 7, "width": 8, "height": 6,
      "properties": {
        "title": "DB Query Latency",
        "metrics": [
          [ "Pickket/Application", "db_query_duration_seconds", { "stat": "p50", "label": "p50" } ],
          [ "...", { "stat": "p95", "label": "p95" } ],
          [ "...", { "stat": "p99", "label": "p99" } ]
        ],
        "view": "timeSeries",
        "region": "ap-northeast-2",
        "period": 60
      }
    },
    {
      "type": "metric",
      "x": 16, "y": 7, "width": 8, "height": 6,
      "properties": {
        "title": "Cache Hit/Miss Rate",
        "metrics": [
          [ "Pickket/Application", "cache_hits_total", { "stat": "Sum", "period": 60, "label": "Hits" } ],
          [ "Pickket/Application", "cache_misses_total", { "stat": "Sum", "period": 60, "label": "Misses" } ]
        ],
        "view": "timeSeries",
        "region": "ap-northeast-2",
        "period": 60
      }
    },
    {
      "type": "metric",
      "x": 0, "y": 13, "width": 8, "height": 6,
      "properties": {
        "title": "Celery Task Duration",
        "metrics": [
          [ "Pickket/Application", "celery_task_duration_seconds", { "stat": "p50", "label": "p50" } ],
          [ "...", { "stat": "p95", "label": "p95" } ]
        ],
        "view": "timeSeries",
        "region": "ap-northeast-2",
        "period": 60
      }
    },
    {
      "type": "metric",
      "x": 8, "y": 13, "width": 8, "height": 6,
      "properties": {
        "title": "Celery Tasks (Success/Failure)",
        "metrics": [
          [ "Pickket/Application", "celery_tasks_total", "status", "success", { "stat": "Sum", "period": 60, "label": "Success" } ],
          [ "Pickket/Application", "celery_tasks_total", "status", "failure", { "stat": "Sum", "period": 60, "label": "Failure" } ]
        ],
        "view": "timeSeries",
        "region": "ap-northeast-2",
        "period": 60
      }
    },
    {
      "type": "metric",
      "x": 16, "y": 13, "width": 8, "height": 6,
      "properties": {
        "title": "Business: Tickets & Payments",
        "metrics": [
          [ "Pickket/Application", "pickket_tickets_sold_total", { "stat": "Sum", "period": 300, "label": "Tickets Sold" } ],
          [ "Pickket/Application", "pickket_payments_total", { "stat": "Sum", "period": 300, "label": "Payments" } ]
        ],
        "view": "timeSeries",
        "region": "ap-northeast-2",
        "period": 300
      }
    },
    {
      "type": "metric",
      "x": 0, "y": 19, "width": 12, "height": 6,
      "properties": {
        "title": "ECS CPU Utilization by Service",
        "metrics": [
          [ "AWS/ECS", "CPUUtilization", "ClusterName", "pickket", "ServiceName", "pickket-prod-backend", { "label": "backend" } ],
          [ "...", "pickket-prod-ticket-gateway", { "label": "ticket-gw" } ],
          [ "...", "pickket-prod-consumer", { "label": "consumer" } ],
          [ "...", "pickket-prod-celery-worker", { "label": "celery" } ]
        ],
        "view": "timeSeries",
        "region": "ap-northeast-2",
        "period": 300,
        "stat": "Average"
      }
    },
    {
      "type": "metric",
      "x": 12, "y": 19, "width": 12, "height": 6,
      "properties": {
        "title": "ECS Memory Utilization by Service",
        "metrics": [
          [ "AWS/ECS", "MemoryUtilization", "ClusterName", "pickket", "ServiceName", "pickket-prod-backend", { "label": "backend" } ],
          [ "...", "pickket-prod-ticket-gateway", { "label": "ticket-gw" } ],
          [ "...", "pickket-prod-consumer", { "label": "consumer" } ],
          [ "...", "pickket-prod-celery-worker", { "label": "celery" } ]
        ],
        "view": "timeSeries",
        "region": "ap-northeast-2",
        "period": 300,
        "stat": "Average"
      }
    },
    {
      "type": "metric",
      "x": 0, "y": 25, "width": 12, "height": 6,
      "properties": {
        "title": "Aurora DB Connections",
        "metrics": [
          [ "AWS/RDS", "DatabaseConnections", "DBClusterIdentifier", "pickket-aurora-v2", { "label": "Connections" } ]
        ],
        "view": "timeSeries",
        "region": "ap-northeast-2",
        "period": 60,
        "stat": "Average"
      }
    },
    {
      "type": "metric",
      "x": 12, "y": 25, "width": 12, "height": 6,
      "properties": {
        "title": "SQS Queue Depth (Order Processing)",
        "metrics": [
          [ "AWS/SQS", "ApproximateNumberOfMessagesVisible", "QueueName", "pickket-v2-order-processing", { "label": "Visible" } ],
          [ "AWS/SQS", "ApproximateNumberOfMessagesNotVisible", "QueueName", "pickket-v2-order-processing", { "label": "In-Flight" } ]
        ],
        "view": "timeSeries",
        "region": "ap-northeast-2",
        "period": 60,
        "stat": "Average"
      }
    }
  ]
}
DASHBOARD_EOF

echo "=== Creating CloudWatch Dashboard ==="
aws cloudwatch put-dashboard \
  --dashboard-name "Pickket-Production" \
  --dashboard-body "file:///tmp/pickket-dashboard.json" \
  --region "$REGION"

echo "Dashboard created: https://ap-northeast-2.console.aws.amazon.com/cloudwatch/home?region=ap-northeast-2#dashboards:name=Pickket-Production"
echo ""
echo "=== Done ==="
