#!/usr/bin/env bash
set -euo pipefail

# -----------------------------------------------------------------------------
# Verify/apply required status checks for DAST jobs on protected branches.
#
# Usage:
#   ./scripts/security/branch_protection_dast.sh verify
#   ./scripts/security/branch_protection_dast.sh apply
#
# Env:
#   REPO=owner/repo          (default: current gh repo)
#   BRANCHES=main,develop    (default: main)
# -----------------------------------------------------------------------------

MODE="${1:-verify}"
if [[ "$MODE" != "verify" && "$MODE" != "apply" ]]; then
  echo "Usage: $0 [verify|apply]" >&2
  exit 2
fi

if ! command -v gh >/dev/null 2>&1; then
  echo "[ERROR] gh CLI is required." >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "[ERROR] jq is required." >&2
  exit 1
fi

REPO="${REPO:-${GITHUB_REPOSITORY:-}}"
if [[ -z "$REPO" ]]; then
  REPO="$(gh repo view --json nameWithOwner -q .nameWithOwner)"
fi

BRANCHES="${BRANCHES:-main}"
IFS=',' read -r -a BRANCH_LIST <<< "$BRANCHES"

REQUIRED_CHECKS=(
  "Runtime DAST (Backend)"
  "Runtime DAST (Admin)"
)

overall=0

for branch in "${BRANCH_LIST[@]}"; do
  branch="$(echo "$branch" | xargs)"
  if [[ -z "$branch" ]]; then
    continue
  fi

  echo "[INFO] Checking branch protection: ${REPO}:${branch}"
  if ! protection_json="$(gh api "repos/${REPO}/branches/${branch}/protection" 2>/dev/null)"; then
    echo "[ERROR] Branch protection not found or insufficient permission: ${branch}" >&2
    overall=1
    continue
  fi

  strict="$(jq -r '.required_status_checks.strict // false' <<<"$protection_json")"
  mapfile -t existing_checks < <(
    jq -r '.required_status_checks.contexts[]? // .required_status_checks.checks[]?.context' <<<"$protection_json" | sort -u
  )

  missing=()
  for required in "${REQUIRED_CHECKS[@]}"; do
    found=0
    for current in "${existing_checks[@]}"; do
      if [[ "$current" == "$required" ]]; then
        found=1
        break
      fi
    done
    if [[ "$found" -eq 0 ]]; then
      missing+=("$required")
    fi
  done

  if [[ "${#missing[@]}" -eq 0 ]]; then
    echo "[OK] All DAST checks already required on ${branch}"
    continue
  fi

  if [[ "$MODE" == "verify" ]]; then
    echo "[WARN] Missing required checks on ${branch}: ${missing[*]}"
    overall=1
    continue
  fi

  mapfile -t merged_checks < <(
    printf '%s\n' "${existing_checks[@]}" "${REQUIRED_CHECKS[@]}" | sed '/^$/d' | sort -u
  )
  args=(--method PATCH "repos/${REPO}/branches/${branch}/protection/required_status_checks" -f "strict=${strict}")
  for check in "${merged_checks[@]}"; do
    args+=(-f "contexts[]=${check}")
  done

  gh api "${args[@]}" >/dev/null
  echo "[APPLY] Updated required checks on ${branch}"
done

if [[ "$overall" -ne 0 ]]; then
  exit "$overall"
fi

echo "[DONE] Branch protection DAST check policy is satisfied."
