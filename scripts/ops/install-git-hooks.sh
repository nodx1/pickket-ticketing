#!/usr/bin/env bash
# git hooks 설치 — main push 차단 등
set -euo pipefail
REPO="/home/oem/Development/active/pickket-v3"
cp "$REPO/scripts/ops/git-hooks/pre-push" "$REPO/.git/hooks/pre-push"
chmod +x "$REPO/.git/hooks/pre-push"
echo "pre-push hook 설치 완료 (main 직접 push 차단)."
