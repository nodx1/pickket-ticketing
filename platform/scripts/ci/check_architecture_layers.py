#!/usr/bin/env python3
"""레이어 우선 아키텍처 계층 위반 검사.

docs/architecture/backend/ARCHITECTURE.md §3 의 단방향 의존 규칙을 강제한다.
CI 에서 실행하여 새 코드가 계층을 깨지 않도록 게이트한다.

검사 대상: **도메인 서브폴더 안의 파일만** (`api/v1/<domain>/*_routes.py` 등).
구 평면 파일(`api/v1/notifications.py` 등 직속)은 마이그레이션 중이므로 면제.

규칙:
  R1. *_routes.py — sqlalchemy import 금지 (repository 경유 강제)
  R2. *_routes.py — 다른 도메인의 repositories/, models/ 직접 import 금지
  R3. *_service.py — sqlalchemy ORM 쿼리 함수 import 금지 (select, update, delete, insert, func)
  R4. *_service.py — fastapi.HTTPException raise 금지 (도메인 예외만 사용)
  R5. *_repo.py — 다른 도메인 models 직접 import 금지 (자기 도메인 모델만)
  R6. models/<x>.py — services/, repositories/, api/ import 금지 (역방향 의존)

사용:
    python3 scripts/ci/check_architecture_layers.py
    종료 코드 0 = 통과, 1 = 위반 발견
"""
from __future__ import annotations

import ast
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[2]
BACKEND_APP = REPO_ROOT / "backend" / "app"

API_V1_ROOT = BACKEND_APP / "api" / "v1"
SERVICES_ROOT = BACKEND_APP / "services"
REPOSITORIES_ROOT = BACKEND_APP / "repositories"
MODELS_ROOT = BACKEND_APP / "models"


class LayerViolation(Exception):
    def __init__(self, file: Path, line: int, rule: str, detail: str):
        self.file = file
        self.line = line
        self.rule = rule
        self.detail = detail

    def __str__(self) -> str:
        try:
            rel = self.file.relative_to(REPO_ROOT)
        except ValueError:
            rel = self.file
        return f"  {rel}:{self.line}  [{self.rule}]  {self.detail}"


def _imports(tree: ast.AST) -> list[tuple[int, str]]:
    """파일에서 (lineno, fully-qualified module path) 쌍 수집."""
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            for alias in node.names:
                found.append((node.lineno, alias.name))
        elif isinstance(node, ast.ImportFrom):
            module = node.module or ""
            for alias in node.names:
                full = f"{module}.{alias.name}" if module else alias.name
                found.append((node.lineno, full))
    return found


def _raises(tree: ast.AST) -> list[tuple[int, str]]:
    """raise 표현식의 호출 대상 이름 수집."""
    found: list[tuple[int, str]] = []
    for node in ast.walk(tree):
        if isinstance(node, ast.Raise) and node.exc is not None:
            target = node.exc
            if isinstance(target, ast.Call):
                target = target.func
            if isinstance(target, ast.Name):
                found.append((node.lineno, target.id))
            elif isinstance(target, ast.Attribute):
                found.append((node.lineno, target.attr))
    return found


def _domain_of(path: Path, root: Path) -> str | None:
    """파일이 속한 도메인 이름. root 바로 아래 첫 폴더."""
    try:
        rel = path.relative_to(root)
    except ValueError:
        return None
    parts = rel.parts
    # parts[0] = 도메인 폴더 이름, parts[1] = 파일명
    if len(parts) < 2:
        return None
    return parts[0]


def check_routes(path: Path, tree: ast.AST, domain: str) -> list[LayerViolation]:
    """R1 + R2: Controller 계층 검사."""
    violations: list[LayerViolation] = []
    for lineno, mod in _imports(tree):
        # R1: SQLAlchemy 직접 import 금지
        if mod.startswith("sqlalchemy"):
            # AsyncSession 타입 힌트는 허용
            if mod == "sqlalchemy.ext.asyncio.AsyncSession":
                continue
            violations.append(
                LayerViolation(
                    path, lineno, "R1",
                    f"*_routes.py 는 SQLAlchemy 를 직접 import 할 수 없음 (`{mod}`). "
                    f"repository 경유로 옮길 것.",
                )
            )
        # R2: 다른 도메인의 repositories/models 직접 import 금지
        if mod.startswith("app.repositories.") or mod.startswith("app.models."):
            parts = mod.split(".")
            # app.repositories.<domain>.<file> 또는 app.models.<file>
            kind = parts[1]  # "repositories" or "models"
            other = parts[2] if len(parts) > 2 else ""
            if kind == "repositories" and other and other != domain:
                violations.append(
                    LayerViolation(
                        path, lineno, "R2",
                        f"다른 도메인의 repository 직접 import 금지 (`{mod}`). "
                        f"`app.services.{other}` 경유.",
                    )
                )
            # models 는 도메인 무관 (Phase 1 시점에 평면 유지 — 같이 사용 가능)
    return violations


def check_service(path: Path, tree: ast.AST, domain: str) -> list[LayerViolation]:
    """R3 + R4: Service 계층 검사."""
    violations: list[LayerViolation] = []
    banned_orm = {"select", "update", "delete", "insert", "func"}
    for lineno, mod in _imports(tree):
        # R3: ORM 쿼리 함수 import 금지
        if mod.startswith("sqlalchemy."):
            tail = mod.split(".")[-1]
            if tail in banned_orm:
                violations.append(
                    LayerViolation(
                        path, lineno, "R3",
                        f"*_service.py 는 ORM 쿼리 함수 import 금지 (`{mod}`). "
                        f"repository 에 새 메서드 추가.",
                    )
                )
        # 다른 도메인 repository 직접 import 금지
        if mod.startswith("app.repositories."):
            parts = mod.split(".")
            other = parts[2] if len(parts) > 2 else ""
            if other and other != domain:
                violations.append(
                    LayerViolation(
                        path, lineno, "R2",
                        f"다른 도메인 repository 직접 import 금지 (`{mod}`). "
                        f"`app.services.{other}` 경유.",
                    )
                )
    # R4: HTTPException raise 금지
    for lineno, name in _raises(tree):
        if name == "HTTPException":
            violations.append(
                LayerViolation(
                    path, lineno, "R4",
                    "*_service.py 에서 HTTPException raise 금지. "
                    "도메인 예외 정의 후 routes 에서 HTTP 변환.",
                )
            )
    return violations


def check_repo(path: Path, tree: ast.AST, domain: str) -> list[LayerViolation]:
    """R5: Repository 계층 검사 (다른 도메인 모델 사용 제한)."""
    violations: list[LayerViolation] = []
    # 임시 — Phase 1 단계에서는 다른 도메인 모델 lazy import 허용 (notification → bid/order 등)
    # Phase 4/5 EventBus 전환 후에 엄격화. 현재는 검사 OFF.
    return violations


def check_model(path: Path, tree: ast.AST, _domain: str | None = None) -> list[LayerViolation]:
    """R6: Entity 가 상위 계층 import 금지."""
    violations: list[LayerViolation] = []
    for lineno, mod in _imports(tree):
        if mod.startswith("app.services.") or mod.startswith("app.repositories.") \
                or mod.startswith("app.api."):
            violations.append(
                LayerViolation(
                    path, lineno, "R6",
                    f"models 는 services/repositories/api import 금지 (`{mod}`).",
                )
            )
    return violations


def _parse(path: Path) -> ast.AST | None:
    try:
        return ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    except SyntaxError as exc:
        print(f"파싱 실패: {path}: {exc}", file=sys.stderr)
        return None


def main() -> int:
    violations: list[LayerViolation] = []

    # api/v1/<domain>/*_routes.py
    if API_V1_ROOT.exists():
        for path in API_V1_ROOT.rglob("*_routes.py"):
            domain = _domain_of(path, API_V1_ROOT)
            if not domain:
                continue  # 도메인 폴더 밖 (구 평면 파일) — 면제
            tree = _parse(path)
            if tree is None:
                return 2
            violations.extend(check_routes(path, tree, domain))

    # services/<domain>/*_service.py
    if SERVICES_ROOT.exists():
        for path in SERVICES_ROOT.rglob("*_service.py"):
            domain = _domain_of(path, SERVICES_ROOT)
            if not domain:
                continue
            tree = _parse(path)
            if tree is None:
                return 2
            violations.extend(check_service(path, tree, domain))

    # repositories/<domain>/*_repo.py
    if REPOSITORIES_ROOT.exists():
        for path in REPOSITORIES_ROOT.rglob("*_repo.py"):
            domain = _domain_of(path, REPOSITORIES_ROOT)
            if not domain:
                continue
            tree = _parse(path)
            if tree is None:
                return 2
            violations.extend(check_repo(path, tree, domain))

    # models/*.py (평면, R6 만)
    if MODELS_ROOT.exists():
        for path in MODELS_ROOT.glob("*.py"):
            if path.name in ("__init__.py", "types.py", "base.py"):
                continue
            tree = _parse(path)
            if tree is None:
                return 2
            violations.extend(check_model(path, tree))

    if not violations:
        print("✓ 아키텍처 계층 검사 통과 — 도메인 서브폴더 위반 없음.")
        return 0

    print(f"✗ 아키텍처 계층 위반 {len(violations)} 건 발견:\n")
    for v in violations:
        print(v)
    print(
        "\n규칙 상세: docs/architecture/backend/ARCHITECTURE.md §3\n"
        "수정 가이드: 위반 라인의 import/raise 를 해당 계층으로 이동."
    )
    return 1


if __name__ == "__main__":
    sys.exit(main())
