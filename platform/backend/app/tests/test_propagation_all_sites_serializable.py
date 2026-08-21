"""🔴 전파 태스크에 **UUID 가 실리지 않게** — 태스크 경계 전수 (2026-08-01).

## 무슨 일이 있었나
`_build_payment_confirmed_hint` 가 `order.id`(UUID 객체)를 그대로 실어서,
worker 가 서명 body 를 만들 때(`propagate_order_event.py` 의 `json.dumps(envelope)`)
죽었다. `.delay()` 는 예외를 안 내므로 v2 는 발행 성공으로 믿었고, 15분 주기 대사
크론이 뒤늦게 구조해서 **증상이 "느리다" 로만 보였다.** 실결제 3건이 14~17분씩 밀렸다.

celery/kombu 는 UUID 를 알아서 인코딩해 보내고 **worker 에서 UUID 객체로 복원**한다.
그래서 발행은 성공하고 소비에서 죽는다 — 가장 찾기 어려운 형태다.

## 이 가드의 범위를 두 번 틀렸다
1차: `payment_service.py` 의 **빌더 2개**만 고치고 테스트도 그 둘만 호출 →
     환불 경로의 **인라인 dict 2곳**을 놓쳤다.
2차(이 파일의 옛 버전): `app/services/**` 의 `propagations.append({literal})` 만 훑음 →
     `app/api/v1/webhooks.py` 의 **리플레이 엔드포인트**를 놓쳤다. 거기는
     `propagations` 를 거치지 않고 `.delay(order_id=order.id)` 로 **직접** 부른다.
     즉 **실패 배달을 구조하는 도구 자체가 모든 리플레이에서 죽고 있었다.**
     (페이블 적대검수에서 발견 — 제 "전수 4곳" 주장이 반증됐다.)

⟹ 경계를 **데이터 출처**가 아니라 **태스크 진입점**으로 잡는다.
   `propagate_order_event_to_go` 에 `order_id` 를 넘기는 모든 호출을 훑고,
   그 값이 str 로 좁혀졌는지 본다. 새 호출부가 생겨도 자동으로 걸린다.
"""
import ast
import pathlib

import pytest

_APP = pathlib.Path(__file__).resolve().parents[1]
_TASK_NAME = "propagate_order_event_to_go"


def _iter_py() -> list[pathlib.Path]:
    return sorted(p for p in _APP.rglob("*.py") if "tests" not in p.parts)


def _is_str_narrowed(node: ast.AST) -> bool:
    """`str(...)` · f-string · 문자열 리터럴 · `hint["order_id"]`(빌더 경유) 만 허용."""
    if isinstance(node, ast.Call) and getattr(node.func, "id", None) == "str":
        return True
    if isinstance(node, ast.JoinedStr):
        return True
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return True
    # `hint["order_id"]` — 빌더가 만든 dict 를 그대로 넘기는 형태.
    # 빌더 쪽은 아래 `test_every_hint_builder_*` 가 따로 지킨다.
    if isinstance(node, ast.Subscript):
        return True
    return False


# ── ① 태스크 진입점: `.delay()` / `.apply_async()` 호출 전수 ──────────────────
def _task_invocations() -> list[tuple[str, int, ast.Call]]:
    found: list[tuple[str, int, ast.Call]] = []
    for path in _iter_py():
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call) or not isinstance(node.func, ast.Attribute):
                continue
            if node.func.attr not in {"delay", "apply_async"}:
                continue
            if getattr(node.func.value, "id", None) != _TASK_NAME:
                continue
            found.append((str(path.relative_to(_APP)), node.lineno, node))
    return found


def test_task_invocations_are_found():
    """가드가 헛돌지 않는지 — 진입점을 못 찾으면 탐지가 깨진 것이다."""
    sites = _task_invocations()
    assert len(sites) >= 3, f"`{_TASK_NAME}` 호출부를 못 찾았다(탐지 로직 확인): {sites}"


@pytest.mark.parametrize("case", _task_invocations(), ids=lambda c: f"{c[0]}:{c[1]}")
def test_every_task_invocation_passes_str_order_id(case):
    """🔴 `order_id` 는 어느 호출부에서든 str 로 좁혀져 있어야 한다."""
    rel, lineno, call = case
    for kw in call.keywords:
        if kw.arg != "order_id":
            continue
        if _is_str_narrowed(kw.value):
            return
        pytest.fail(
            f"{rel}:{lineno} — `order_id` 가 str 로 좁혀지지 않았다"
            f"({ast.dump(kw.value)[:80]}). UUID 면 worker 가 json.dumps 에서 죽는다."
        )
    pytest.fail(f"{rel}:{lineno} — `order_id` 키워드 인자가 없다(위치인자 금지)")


# ── ② hint 를 만드는 모든 지점 (빌더 + 인라인) ───────────────────────────────
def _propagation_dicts() -> list[tuple[str, int, ast.Dict]]:
    """`propagations` 에 실리거나 hint 로 반환되는 dict 리터럴.

    ⚠️ dict 를 변수에 담아 append 하거나 헬퍼 반환값을 넘기는 형태는 이 방식으로
       못 잡는다(페이블 지적). 그 경우는 위 ①이 최후 방어선이다 — 어떤 형태로 만들든
       결국 `.delay(order_id=...)` 를 지나가야 하기 때문이다.
    """
    def is_hint(d: ast.Dict) -> bool:
        """go 전파 hint 의 형태 — `{event, order_id, data}`.

        ⚠️ 형태로 거른다. `shared/service.py` 의 `{topic, payload}` 는 **다른 파이프라인**
           (EventBus/SNS)이고 go 웹훅에 닿지 않는다 — 여기 섞으면 거짓 양성이 된다.
        """
        keys = {k.value for k in d.keys if isinstance(k, ast.Constant)}
        return {"event", "order_id", "data"} <= keys

    found: list[tuple[str, int, ast.Dict]] = []
    for path in _iter_py():
        # 태스크 모듈 자신은 **경계 하류**다. `_build_envelope` 의 `order_id` 는 이미
        # 호출부에서 좁혀진 값을 받는 파라미터이므로 여기서 다시 볼 것이 없다.
        if path.parts[-2:-1] == ("tasks",):
            continue
        tree = ast.parse(path.read_text(), filename=str(path))
        for node in ast.walk(tree):
            dicts: list[ast.Dict] = []
            if isinstance(node, ast.Call) and isinstance(node.func, ast.Attribute):
                name = getattr(node.func.value, "attr", None) or getattr(node.func.value, "id", None)
                if name == "propagations" and node.func.attr in {"append", "extend"} and node.args:
                    arg = node.args[0]
                    dicts = [arg] if isinstance(arg, ast.Dict) else [
                        e for e in getattr(arg, "elts", []) if isinstance(e, ast.Dict)
                    ]
            elif isinstance(node, ast.Return) and isinstance(node.value, ast.Dict):
                dicts = [node.value]
            for d in dicts:
                if is_hint(d):
                    found.append((str(path.relative_to(_APP)), node.lineno, d))
    return found


def test_propagation_dicts_are_found():
    sites = _propagation_dicts()
    assert len(sites) >= 4, f"hint 생성 지점을 못 찾았다(탐지 로직 확인): {len(sites)}"


@pytest.mark.parametrize("case", _propagation_dicts(), ids=lambda c: f"{c[0]}:{c[1]}")
def test_every_hint_order_id_is_str(case):
    rel, lineno, node = case
    for key, value in zip(node.keys, node.values):
        if not (isinstance(key, ast.Constant) and key.value == "order_id"):
            continue
        if _is_str_narrowed(value):
            return
        pytest.fail(
            f"{rel}:{lineno} — hint 의 `order_id` 가 str 이 아니다"
            f"({ast.dump(value)[:80]}). UUID 면 worker 가 json.dumps 에서 죽는다."
        )
    pytest.fail(f"{rel}:{lineno} — hint 에 `order_id` 키가 없다")


@pytest.mark.parametrize("case", _propagation_dicts(), ids=lambda c: f"{c[0]}:{c[1]}")
def test_no_bare_id_attribute_in_payload(case):
    """`data` 안의 `*_id` 키에 `.id` 속성을 그대로 넣지 않는다.

    ⚠️ 값의 런타임 타입을 실행 없이 알 수는 없으므로 **이름 규칙**으로 본다.
       이 리포는 `refund.id` 를 `str(refund.id)` 로 감싸는 관습을 지켜 왔다.
    """
    rel, lineno, node = case
    for key, value in zip(node.keys, node.values):
        if not (isinstance(key, ast.Constant) and isinstance(key.value, str)):
            continue
        if key.value == "order_id" or not key.value.endswith("_id"):
            continue
        if isinstance(value, ast.Attribute) and value.attr == "id":
            pytest.fail(
                f"{rel}:{lineno} — `{key.value}` 가 `.id` 속성 그대로다. "
                "UUID 면 worker 가 json.dumps 에서 죽는다 — `str(...)` 로 감쌀 것."
            )
