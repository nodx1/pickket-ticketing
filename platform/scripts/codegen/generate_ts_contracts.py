"""Generate TypeScript contract enums from backend Python enums.

SSOT flow:
  backend/app/models/* (SQLAlchemy enums)
    → scripts/codegen/generate_ts_contracts.py
    → packages/lib/src/contracts/generated/*.ts

Parses the Python source via `ast` so we don't need to import the backend app
(which would require SECRET_KEY and other runtime settings).

Run manually with:
  python scripts/codegen/generate_ts_contracts.py

Run as part of the pnpm build pipeline and in CI to guard against drift.
"""

from __future__ import annotations

import ast
import re
import shutil
import subprocess
import sys
from collections import Counter
from dataclasses import dataclass
from pathlib import Path

PROJECT_ROOT = Path(__file__).resolve().parents[2]
OUTPUT_DIR = PROJECT_ROOT / "packages" / "lib" / "src" / "contracts" / "generated"


@dataclass
class EnumSpec:
    ts_filename: str
    ts_const_name: str
    ts_type_name: str
    source_path: Path
    description: str
    # Extraction strategy: either a PyEnum-style class, or a CHECK-constraint string.
    class_name: str | None = None
    # For CHECK-constraint extraction: regex with one capture group containing the
    # comma-separated quoted value list, e.g. `category IN ('a','b','c')`.
    check_constraint_column: str | None = None


SPECS: list[EnumSpec] = [
    EnumSpec(
        ts_filename="event-status.ts",
        ts_const_name="V2_EVENT_STATUSES_GENERATED",
        ts_type_name="V2EventStatusGenerated",
        source_path=PROJECT_ROOT / "backend/app/models/event.py",
        class_name="EventStatus",
        description="Event lifecycle states. SSOT: backend/app/models/event.py::EventStatus",
    ),
    EnumSpec(
        ts_filename="order-status.ts",
        ts_const_name="V2_ORDER_STATUSES_GENERATED",
        ts_type_name="V2OrderStatusGenerated",
        source_path=PROJECT_ROOT / "backend/app/models/order.py",
        class_name="OrderStatus",
        description="Order lifecycle states. SSOT: backend/app/models/order.py::OrderStatus",
    ),
    EnumSpec(
        ts_filename="ticket-status.ts",
        ts_const_name="V2_TICKET_STATUSES_GENERATED",
        ts_type_name="V2TicketStatusGenerated",
        source_path=PROJECT_ROOT / "backend/app/models/ticket.py",
        class_name="TicketStatus",
        description="Ticket lifecycle states. SSOT: backend/app/models/ticket.py::TicketStatus",
    ),
    # Category has no Python enum class — its canonical value set lives in the
    # `ck_events_category_valid` CHECK constraint in event.py. Parse that string.
    EnumSpec(
        ts_filename="category.ts",
        ts_const_name="V2_CATEGORIES_GENERATED",
        ts_type_name="V2CategoryGenerated",
        source_path=PROJECT_ROOT / "backend/app/models/event.py",
        check_constraint_column="category",
        description=(
            "Event categories (consumer search). SSOT: backend/app/models/event.py "
            "CHECK constraint `ck_events_category_valid`"
        ),
    ),
    # NOTE: SaleMode codegen is intentionally NOT included. There is no single
    # canonical Python enum: engine/talkfile_engine/sale_modes.py::SaleMode only
    # defines 3 values (fixed_fcfs, point_lottery, fanclub_presale) and omits
    # `queue`, while DOMAIN_MODEL_STANDARD mandates 4. Codegen is DEFERRED until a
    # backend SaleMode enum (incl. `queue`) is established as SSOT.
]


def _discover_enum_specs() -> list[EnumSpec]:
    """app/models 의 모든 `(str, *Enum)` 클래스를 자동 발견해 EnumSpec 생성.

    명시 SPECS에 이미 있는 class 는 제외(중복 방지). 같은 kebab 파일명이 충돌하면
    모듈명을 prefix 로 붙여 회피(예: ticket.py::TicketStatus vs cs_ticket.py::TicketStatus).
    미래에 추가되는 enum 도 자동 등록되어 3-product enum drift 를 영구 차단한다.
    """
    models_dir = PROJECT_ROOT / "backend" / "app" / "models"
    explicit = {s.class_name for s in SPECS if s.class_name}
    found: list[tuple[str, str, Path]] = []  # (module_stem, class_name, path)
    seen_cls: set[str] = set()
    for py in sorted(models_dir.glob("*.py")):
        if py.name == "__init__.py":
            continue
        try:
            tree = ast.parse(py.read_text(encoding="utf-8"))
        except SyntaxError:
            continue
        for node in tree.body:
            if not isinstance(node, ast.ClassDef):
                continue
            bases = [
                b.id if isinstance(b, ast.Name)
                else b.attr if isinstance(b, ast.Attribute) else ""
                for b in node.bases
            ]
            if "str" not in bases or not any("Enum" in b for b in bases):
                continue
            if node.name in explicit or node.name in seen_cls:
                continue
            # str 멤버를 가진 enum만 (빈/비문자 enum 제외)
            if not any(
                isinstance(s, ast.Assign)
                and isinstance(s.value, ast.Constant)
                and isinstance(s.value.value, str)
                for s in node.body
            ):
                continue
            seen_cls.add(node.name)
            found.append((py.stem, node.name, py))

    def _kebab(n: str) -> str:
        return re.sub(r"(?<!^)(?=[A-Z])", "-", n).lower()

    def _snake(n: str) -> str:
        return re.sub(r"(?<!^)(?=[A-Z])", "_", n).upper()

    kebab_counts = Counter(_kebab(c) for _, c, _ in found)
    specs: list[EnumSpec] = []
    for stem, cls, py in found:
        kb, sn = _kebab(cls), _snake(cls)
        if kebab_counts[kb] > 1:  # 충돌 → 모듈명 prefix
            kb = f"{stem.replace('_', '-')}-{kb}"
            sn = f"{stem.upper()}_{sn}"
        specs.append(
            EnumSpec(
                ts_filename=f"{kb}.ts",
                ts_const_name=f"V2_{sn}_GENERATED",
                ts_type_name=f"V2{cls}Generated",
                source_path=py,
                class_name=cls,
                description=f"{cls}. SSOT: backend/app/models/{py.name}::{cls}",
            )
        )
    return specs


def _extract_enum_values(source_path: Path, class_name: str) -> list[str]:
    """Return the string values of `class_name` (assumed str, PyEnum) from source_path."""
    tree = ast.parse(source_path.read_text(encoding="utf-8"))
    for node in ast.walk(tree):
        if isinstance(node, ast.ClassDef) and node.name == class_name:
            values: list[str] = []
            for stmt in node.body:
                # Pattern: `NAME = "value"`
                if (
                    isinstance(stmt, ast.Assign)
                    and len(stmt.targets) == 1
                    and isinstance(stmt.targets[0], ast.Name)
                    and isinstance(stmt.value, ast.Constant)
                    and isinstance(stmt.value.value, str)
                ):
                    values.append(stmt.value.value)
            if not values:
                raise RuntimeError(f"{class_name} in {source_path} has no string members")
            return values
    raise RuntimeError(f"Class {class_name} not found in {source_path}")


def _extract_check_constraint_values(source_path: Path, column: str) -> list[str]:
    """Extract the quoted value list from a `<column> IN ('a','b',...)` CHECK string."""
    source = source_path.read_text(encoding="utf-8")
    # Match e.g.  category IN ('concert','musical',...)   (whitespace/newline tolerant)
    pattern = rf"{re.escape(column)}\s+IN\s*\(([^)]*)\)"
    match = re.search(pattern, source, flags=re.IGNORECASE)
    if not match:
        raise RuntimeError(
            f"No `{column} IN (...)` CHECK constraint found in {source_path}"
        )
    values = re.findall(r"'([^']*)'", match.group(1))
    if not values:
        raise RuntimeError(
            f"`{column} IN (...)` constraint in {source_path} contained no values"
        )
    return values


def _resolve_values(spec: EnumSpec) -> list[str]:
    if spec.class_name is not None:
        return _extract_enum_values(spec.source_path, spec.class_name)
    if spec.check_constraint_column is not None:
        return _extract_check_constraint_values(spec.source_path, spec.check_constraint_column)
    raise RuntimeError(f"EnumSpec {spec.ts_filename} has no extraction strategy")


def _render_ts(spec: EnumSpec, values: list[str]) -> str:
    lines = [
        "// AUTO-GENERATED by scripts/codegen/generate_ts_contracts.py — DO NOT EDIT",
        f"// {spec.description}",
        "",
        f"export const {spec.ts_const_name} = [",
    ]
    for v in values:
        lines.append(f'  "{v}",')
    lines.extend(
        [
            "] as const;",
            "",
            f"export type {spec.ts_type_name} = (typeof {spec.ts_const_name})[number];",
            "",
        ]
    )
    return "\n".join(lines)


def main() -> int:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

    all_specs = SPECS + _discover_enum_specs()

    for spec in all_specs:
        values = _resolve_values(spec)
        out_path = OUTPUT_DIR / spec.ts_filename
        rendered = _render_ts(spec, values)
        out_path.write_text(rendered, encoding="utf-8")
        source_ref = spec.class_name or f"CHECK({spec.check_constraint_column})"
        print(
            f"[codegen] {out_path.relative_to(PROJECT_ROOT)} "
            f"← {spec.source_path.relative_to(PROJECT_ROOT)}::{source_ref} "
            f"({len(values)} values)"
        )

    index_path = OUTPUT_DIR / "index.ts"
    index_path.write_text(
        "\n".join(
            ["// AUTO-GENERATED — DO NOT EDIT"]
            + [f'export * from "./{s.ts_filename.removesuffix(".ts")}";' for s in all_specs]
            + [""]
        ),
        encoding="utf-8",
    )
    print(f"[codegen] {index_path.relative_to(PROJECT_ROOT)} (barrel)")

    _format_with_prettier()
    return 0


def _format_with_prettier() -> None:
    """Run Prettier on the generated dir so committed output matches the repo formatter.

    Without this the codegen-freshness gate in check-contract-drift.sh would flag
    formatting-only diffs (e.g. long type aliases that Prettier wraps at 80 cols).
    Best-effort: if no prettier binary is found (e.g. offline minimal env), skip.
    """
    target = str(OUTPUT_DIR.relative_to(PROJECT_ROOT)) + "/**/*.ts"
    candidates: list[list[str]] = []
    if shutil.which("pnpm"):
        candidates.append(["pnpm", "exec", "prettier", "--write", target])
    if shutil.which("npx"):
        candidates.append(["npx", "--no-install", "prettier", "--write", target])
    for cmd in candidates:
        try:
            result = subprocess.run(
                cmd, cwd=PROJECT_ROOT, capture_output=True, text=True, timeout=120
            )
        except Exception:  # noqa: BLE001 — best-effort formatting
            continue
        if result.returncode == 0:
            print(f"[codegen] prettier formatted generated/ ({cmd[0]})")
            return
    print("[codegen] WARN: prettier not available — generated files left unformatted")


if __name__ == "__main__":
    sys.exit(main())
