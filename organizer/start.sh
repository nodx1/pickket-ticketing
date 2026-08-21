#!/usr/bin/env bash
# Production application entrypoint. Schema migration is a separate ECS one-off
# task and must never block replica readiness.
set -euo pipefail

exec node server.js
