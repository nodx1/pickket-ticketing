"""API 계약 골든 파일 테스트.

도메인 모듈러 리팩토링(docs/architecture/backend/ARCHITECTURE.md) 중
**라우터 prefix·요청·응답 스키마가 의도치 않게 변경되는 사고**를 막는 안전망.

원리:
    1. FastAPI 의 openapi() 로 전체 OpenAPI 스펙 생성
    2. CRITICAL_ENDPOINTS 에 명시한 엔드포인트만 추출 — go/mobile 이 의존하는 경로
    3. __snapshots__/api_contract.json 에 저장된 골든 파일과 비교
    4. 다르면 테스트 실패. 의도된 변경이면:
       - PR 에 변경 영향(go/mobile 영향도) 명시
       - PYTHON_REGEN_API_CONTRACT=1 .venv/bin/pytest backend/tests/integration/test_api_contract.py
         로 골든 파일 재생성 후 함께 커밋

CLAUDE.md 의 "go 가 의존하는 엔드포인트 Breaking Change 금지" 규칙을 자동 강제.
"""
from __future__ import annotations

import json
import os
from pathlib import Path

import pytest

from app.main import app

SNAPSHOT_DIR = Path(__file__).parent / "__snapshots__"
SNAPSHOT_PATH = SNAPSHOT_DIR / "api_contract.json"

# go/mobile 이 의존하는 엔드포인트 (CLAUDE.md §"go가 의존하는 엔드포인트")
# (method, path) 형식. path 는 OpenAPI 의 경로 (FastAPI 의 prefix 포함된 형태).
# 실제 등록된 라우트와 정확히 매칭되어야 하므로 trailing slash 등 형식 일치 필수.
CRITICAL_ENDPOINTS: list[tuple[str, str]] = [
    # 인증 (consumer/admin/mobile 공통 진입점)
    ("post", "/api/v1/auth/login"),
    ("post", "/api/v1/auth/register"),
    ("post", "/api/v1/auth/verify-token"),
    ("post", "/api/v1/auth/refresh"),
    # 이벤트 — 핵심 조회 경로 (검색/노출/상세)
    ("get", "/api/v1/events/"),
    ("get", "/api/v1/events/search"),
    ("get", "/api/v1/events/featured"),
    ("get", "/api/v1/events/categories"),
    ("get", "/api/v1/events/ranking"),
    # 주문/결제 — go 정산이 의존
    ("get", "/api/v1/orders/my"),
    ("get", "/api/v1/orders/{order_id}"),
    ("get", "/api/v1/orders/{order_id}/status"),
    ("post", "/api/v1/orders/{order_id}/capture"),
    ("post", "/api/v1/orders/{order_id}/cancel"),
    ("post", "/api/v1/orders/{order_id}/refund"),
    ("post", "/api/v1/orders/{order_id}/payment/prepare"),
    # 티켓 — consumer/현장 입장 의존
    ("get", "/api/v1/tickets/my"),
    ("get", "/api/v1/tickets/{ticket_id}"),
    ("get", "/api/v1/tickets/{ticket_id}/qr"),
    ("post", "/api/v1/tickets/validate-qr"),
]


def _extract_contract(spec: dict) -> dict:
    """OpenAPI 스펙에서 CRITICAL_ENDPOINTS 만 골라 정렬된 dict 반환.

    response model schema 의 `$ref` 는 그대로 두고, 실제 정의된 schemas 도 함께 포함.
    이러면 모델 필드 변경 시 (예: EventResponse 에 새 필드 추가) 도 감지됨.
    """
    paths = spec.get("paths", {})
    contract: dict = {"endpoints": {}, "schemas": {}}
    used_refs: set[str] = set()

    def collect_refs(node) -> None:
        if isinstance(node, dict):
            ref = node.get("$ref")
            if isinstance(ref, str) and ref.startswith("#/components/schemas/"):
                used_refs.add(ref.split("/")[-1])
            for v in node.values():
                collect_refs(v)
        elif isinstance(node, list):
            for v in node:
                collect_refs(v)

    for method, path in CRITICAL_ENDPOINTS:
        ops = paths.get(path)
        if not ops:
            # 라우트가 사라졌다 — 무조건 실패하도록 sentinel 기록
            contract["endpoints"][f"{method.upper()} {path}"] = "<MISSING>"
            continue
        op = ops.get(method)
        if not op:
            contract["endpoints"][f"{method.upper()} {path}"] = "<MISSING>"
            continue
        slim = {
            "parameters": op.get("parameters", []),
            "requestBody": op.get("requestBody"),
            "responses": op.get("responses"),
        }
        contract["endpoints"][f"{method.upper()} {path}"] = slim
        collect_refs(slim)

    # 추적된 schema 들을 한 번 더 펼쳐서 nested ref 까지 수집
    all_schemas = spec.get("components", {}).get("schemas", {})
    queue = list(used_refs)
    while queue:
        name = queue.pop()
        if name in contract["schemas"]:
            continue
        schema = all_schemas.get(name)
        if schema is None:
            continue
        contract["schemas"][name] = schema
        before = set(used_refs)
        collect_refs(schema)
        queue.extend(used_refs - before)

    # 정렬된 JSON 으로 직렬화 — diff 안정성
    return json.loads(json.dumps(contract, sort_keys=True))


def test_api_contract_unchanged() -> None:
    """핵심 API 계약이 골든 파일과 일치하는지 검사."""
    spec = app.openapi()
    current = _extract_contract(spec)

    # 골든 파일 재생성 모드
    if os.environ.get("PYTHON_REGEN_API_CONTRACT") == "1":
        SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
        SNAPSHOT_PATH.write_text(
            json.dumps(current, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        pytest.skip("API contract snapshot regenerated.")

    if not SNAPSHOT_PATH.exists():
        SNAPSHOT_DIR.mkdir(parents=True, exist_ok=True)
        SNAPSHOT_PATH.write_text(
            json.dumps(current, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        pytest.skip(
            f"API contract snapshot 초기 생성 완료: {SNAPSHOT_PATH}\n"
            f"커밋 후 다음 PR 부터 변경 감지가 활성화됩니다."
        )

    expected = json.loads(SNAPSHOT_PATH.read_text(encoding="utf-8"))

    assert current == expected, (
        "API 계약이 변경되었습니다.\n"
        "  - 의도된 변경이면: PR 설명에 go/mobile 영향도 명시 후\n"
        "    `PYTHON_REGEN_API_CONTRACT=1 pytest backend/tests/integration/test_api_contract.py`\n"
        "    로 골든 파일을 재생성하고 함께 커밋하세요.\n"
        "  - 의도되지 않았다면: 변경된 라우터/스키마를 원복하세요.\n"
        "  골든 파일: backend/tests/integration/__snapshots__/api_contract.json"
    )


def test_critical_endpoints_exist() -> None:
    """OpenAPI 스펙에 핵심 엔드포인트가 모두 존재하는지 검사 (route 누락 사고 방지)."""
    spec = app.openapi()
    paths = spec.get("paths", {})

    missing: list[str] = []
    for method, path in CRITICAL_ENDPOINTS:
        ops = paths.get(path)
        if not ops or method not in ops:
            missing.append(f"{method.upper()} {path}")

    assert not missing, (
        "다음 핵심 엔드포인트가 OpenAPI 스펙에 없습니다 (go/mobile breakage 위험):\n  - "
        + "\n  - ".join(missing)
    )
