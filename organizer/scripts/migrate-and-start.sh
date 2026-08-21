#!/usr/bin/env bash
# Local/dev convenience only. Production uses the separate migration task and
# starts the app with start.sh (or `node server.js`) directly.
set -euo pipefail

node_modules/.bin/tsx scripts/migrate.ts
exec node server.js
