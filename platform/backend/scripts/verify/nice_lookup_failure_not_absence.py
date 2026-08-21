"""F17·I6 실증 — 조회 실패를 "거래 없음" 으로 읽지 않는가.

## 왜 위험한가

PG 조회가 타임아웃·503 을 냈을 때 그것을 "결제가 없다" 로 읽으면 **방향이 반대로**
틀린다 — 있는 돈을 없다고 판정한다. 그 결과:

    정방향 대사   멀쩡한 결제를 MISSING_IN_PG 로 기록 → 운영자가 없는 사고를 쫓는다
    역방향 대사   "결제 미실행(정상)" 으로 통과 → 실제 결제된 건이 조용히 지나간다
    고아 스캐너   승인된 청구를 "청구 안 나감" 으로 보류/종결

게이트웨이는 이미 둘을 구분한다(404·거래없음 → None / 그 외 → raise).
그 구분을 `except Exception: return None` 이 뭉개고 있었다.

## 실행

    .venv/bin/python scripts/verify/nice_lookup_failure_not_absence.py
"""
from __future__ import annotations

import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))


def main() -> int:
    from app.tasks.reconciliation import _fetch_payment_by_order_sync, _LookupFailed

    ok = True

    class _Gw:
        """조회가 어떻게 끝나는지만 흉내내는 최소 게이트웨이."""

        def __init__(self, mode: str) -> None:
            self.mode = mode

        async def fetch_payment_by_order_id(self, order_id, *, transaction_id=None):
            if self.mode == "timeout":
                raise TimeoutError("read timeout")
            if self.mode == "http503":
                raise RuntimeError("HTTPStatusError: 503")
            if self.mode == "absent":
                return None  # 게이트웨이가 404·거래없음으로 판정한 것
            # ⚠️ Moid 도 넣는다 — 응답이 자기 신원을 밝히지 않으면 거부하는 것이
            #    맞다(코덱스 F18). 이 픽스처가 낡아 정상 케이스가 거부됐었다.
            return {"TID": transaction_id, "Moid": order_id, "Amt": "10000", "Status": "0"}

        def parse_webhook_event(self, body):
            if self.mode == "unparseable":
                raise ValueError("정규화 실패")

            class _E:
                amount = 10000.0
                status = "paid"

            return _E()

    cases = [
        # mode,          기대 종류,        설명
        ("timeout", _LookupFailed, "타임아웃은 '모르겠다' 다"),
        ("http503", _LookupFailed, "5xx 는 '모르겠다' 다"),
        ("unparseable", _LookupFailed, "응답을 못 읽은 것은 '거래 없음' 이 아니다"),
        ("absent", type(None), "404·거래없음은 '없다' 라는 사실이다"),
        ("paid", dict, "정상 조회는 dict"),
    ]

    for mode, expected, desc in cases:
        with patch(
            "app.services.payment_gateway.get_payment_gateway", return_value=_Gw(mode)
        ):
            got = _fetch_payment_by_order_sync(
                provider="nicepay", order_id="ord_X", transaction_id="TID_X"
            )
        actual = type(got)
        if expected is dict:
            good = isinstance(got, dict)
        elif expected is type(None):
            good = got is None
        else:
            good = isinstance(got, _LookupFailed)
        if good:
            print(f"✅ PASS  {mode:<12} → {actual.__name__:<14} {desc}")
        else:
            print(f"🔴 FAIL  {mode:<12} → {actual.__name__:<14} {desc}")
            ok = False

    # 🔴 truthiness 로 새는지 — 실수로 `if pg_result:` 를 쓰면 "결제 있음" 으로 읽힌다.
    if bool(_LookupFailed("x")):
        print("🔴 FAIL  _LookupFailed 가 truthy 다 — `if pg_result:` 에서 결제 있음으로 읽힌다")
        ok = False
    else:
        print("✅ PASS  _LookupFailed 는 falsy — truthiness 오독 방지")

    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
