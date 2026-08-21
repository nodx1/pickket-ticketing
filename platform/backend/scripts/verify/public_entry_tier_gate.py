"""공개 진입점 가드 실증 — 무료 초대권 발권을 실제로 막는가.

## 무엇이 뚫려 있었나 (2026-08-02)

    ① GET /api/v1/events/{id}/tiers    숨김 초대권(0원·정원 100만) 노출
    ② POST /api/v1/guests/orders       인증 없음 → _do_create_order
    ③ 채널 게이트                       "여기선 채널 무관하게 통과" (주석이 자백)
    ④ 티어 조회                         visibility·is_active 검사 없음
    ⑤ net_total <= 0                    → CONFIRMED + 티켓 ACTIVE + payment_method='free'

티어 ID 만 알면 익명으로 무료 티켓이 발권됐다.

## 🔴 이 스크립트가 지키는 가장 중요한 것

**go 의 `{self}` 주문이 여전히 통과해야 한다.** `_do_create_order` 는 공개 게스트
엔드포인트와 go 내부 경로가 **공유**한다. 게이트를 함수 전체에 걸면 KLPGA 실판매가
멈춘다. 그래서 `source == "guest_public"` 일 때만 건다.

`source` 는 위조 불가다 — `GuestOrderCreateRequest` 에 그 필드가 없고 `guests.py` 가
하드코딩하며, 내부 라우터는 `Depends(_internal_auth)` 뒤에 있다.

## 실행

    .venv/bin/python scripts/verify/public_entry_tier_gate.py
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


def main() -> int:
    import inspect

    from app.api.v1 import internal_commerce as ic
    from app.api.v1 import tiers as tiers_api
    from app.services import purchase_service as ps

    ok = True

    def check(name: str, cond: bool, detail: str = "") -> None:
        nonlocal ok
        print(f"{'✅ PASS' if cond else '🔴 FAIL'}  {name}{('  — ' + detail) if detail else ''}")
        if not cond:
            ok = False

    core = inspect.getsource(ic._do_create_order)

    # ① 채널 게이트가 공개 진입점 조건 아래에만 있는가
    check(
        "채널 게이트 존재",
        "EVENT_NOT_PUBLICLY_SALEABLE" in core,
        "공개 진입점에서 marketplace 아닌 행사를 차단",
    )
    # 🔴 **문자열 위치 비교는 주석에 속는다** (2026-08-02, 적대 검증이 잡음).
    #    처음엔 `core.index('guest_public') < core.index('EVENT_NOT_...')` 로 썼는데,
    #    `guest_public` 최초 등장이 **내가 쓴 주석**(49번째 줄)이라 실제 조건(63번째 줄)을
    #    지워도 검사가 통과했다. 그 뮤테이션은 go 주문을 403 으로 죽이는데(=실판매 정지)
    #    가드는 초록이었다.
    #    ⟹ AST 로 **실행되는 조건문**만 본다. 주석·문자열은 AST 에 남지 않는다.
    import ast as _ast
    import textwrap as _tw

    _tree = _ast.parse(_tw.dedent(core))
    _guarded = False
    for node in _ast.walk(_tree):
        if not isinstance(node, _ast.If):
            continue
        cond = _ast.dump(node.test)
        if "guest_public" not in cond:
            continue
        body = _ast.dump(_ast.Module(body=node.body, type_ignores=[]))
        if "EVENT_NOT_PUBLICLY_SALEABLE" in body:
            _guarded = True
            break
    check(
        "🔴 게이트가 guest_public 조건 **아래**에 있다 (AST) — go({self}) 회귀 방지",
        _guarded,
        "조건 없이 걸면 go 의 self 주문이 죽는다. 문자열 검색은 주석에 속는다",
    )

    # ② 티어 visibility 가드
    check(
        "공개 진입점 티어 visibility 가드",
        core.count("guest_public") >= 2 and "visibility" in core,
    )

    # ③ 공개 티어 API 필터
    lst = inspect.getsource(tiers_api.list_tiers)
    check(
        "공개 티어 API 가 hidden 제외",
        'SeatTier.visibility == "public"' in lst and "is_active.is_(True)" in lst,
    )

    # ④ PurchaseService 두 경로 모두
    fcfs = inspect.getsource(ps.PurchaseService.purchase_fcfs)
    fan = inspect.getsource(ps.PurchaseService.purchase_fanclub)
    check("PurchaseService.purchase_fcfs visibility 가드", "visibility" in fcfs)
    check("PurchaseService.purchase_fanclub visibility 가드", "visibility" in fan)

    # ⑤ source 위조 불가 — 공개 요청 스키마에 source 가 없어야 한다
    from app.api.v1.guests import GuestOrderCreateRequest

    check(
        "🔴 공개 요청 스키마에 source 없음 — 위조 불가",
        "source" not in GuestOrderCreateRequest.model_fields,
        f"필드: {sorted(GuestOrderCreateRequest.model_fields)}",
    )

    # ⑥ guests.py 가 source 를 하드코딩하는가
    guests_src = Path("app/api/v1/guests.py").read_text(encoding="utf-8")
    check(
        "guests.py 가 source='guest_public' 하드코딩",
        'source="guest_public"' in guests_src,
    )

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
