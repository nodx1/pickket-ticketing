"""과업 증빙용 실환경 시나리오 — 실제 PostgreSQL(TimescaleDB) + Redis + 실행 중인 API 서버.

SQLite 단위 테스트가 닿지 않는 부분을 실제로 돌려 본다:
  · Redis 분산 락: 한 사용자의 동시 응모 30건 → 1건만 성공, AP 1회만 차감
  · 계정 복제 차단: 같은 기기 지문 3번째 계정 거부
  · Slash: 제재 계정 AP 소각 + 추첨 제외
  · 가중치 정책 고정 → 응모 Merkle 루트(추첨 전) → 추첨 → 결과 루트 → 검증 API
  · 공정성 증명서: PG 시퀀스 발급번호, Ed25519 서명, PDF
  · append-only: 증명서·Merkle·제재·시계열 테이블 UPDATE/DELETE/TRUNCATE 거부
  · TimescaleDB: hypertable 기록과 1분 연속 집계

실행 (백엔드 디렉터리, 서버가 :8021 에 떠 있어야 함):
    .venv/bin/python scripts/verify/e2e_fairness_pg.py [--out ../../docs/deliverables/evidence]
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
import time
import uuid
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
from sqlalchemy import select, text

sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from talkfile_engine.weight_policy import PRESETS

from app.core.database import async_session
from app.models.event import Event
from app.models.point import PointTransactionType, PointType
from app.models.user import User
from app.services.fairness_service import FairnessService
from app.services.point_service import PointService
from app.services.sanction_service import SanctionService

API = "http://127.0.0.1:8021/api/v1"
RUN = datetime.now(UTC).strftime("%m%d%H%M%S")
PASSWORD = "Gwasup1!verify"
results: list[dict] = []


def check(name: str, ok: bool, detail: str = "") -> bool:
    results.append({"check": name, "ok": bool(ok), "detail": detail})
    print(("✅ " if ok else "❌ ") + name + (f"  — {detail}" if detail else ""))
    return ok


async def register(c: httpx.AsyncClient, email: str, name: str) -> str:
    r = await c.post(f"{API}/auth/register", json={"email": email, "password": PASSWORD, "name": name})
    r.raise_for_status()
    c.cookies.clear()
    return r.json()["access_token"]


def h(token: str, **extra) -> dict:
    return {"Authorization": f"Bearer {token}", **extra}


async def user_id(email: str) -> uuid.UUID:
    async with async_session() as s:
        return (await s.execute(select(User.id).where(User.email == email))).scalar_one()


async def grant(email: str, amount: int) -> None:
    async with async_session() as s:
        uid = (await s.execute(select(User.id).where(User.email == email))).scalar_one()
        await PointService(s).earn(
            user_id=uid, point_type=PointType.FAN, amount=amount, tx_type=PointTransactionType.ADMIN_ADJUST, description="e2e"
        )
        await s.commit()


async def main(out_dir: Path) -> int:
    started = time.time()
    async with httpx.AsyncClient(timeout=60) as c:
        # ── 준비: 주최사·이벤트·등급 ──
        org_email = f"gw_org_{RUN}@verify.pickket.kr"
        org = await register(c, org_email, "검증주최사")
        async with async_session() as s:
            u = (await s.execute(select(User).where(User.email == org_email))).scalar_one()
            u.is_organizer = True
            await s.commit()
        now = datetime.now(UTC)
        ev = await c.post(
            f"{API}/events/",
            headers=h(org),
            json={
                "title": f"과업 검증 콘서트 {RUN}",
                "description": "가중치 추첨·공정성 증명서 실환경 검증",
                "venue": "검증 아레나",
                "event_date": (now + timedelta(days=30)).isoformat(),
                "bidding_opens_at": (now - timedelta(hours=1)).isoformat(),
                "bidding_closes_at": (now + timedelta(hours=24)).isoformat(),
                "total_seats": 100,
                "min_price": 10.0,
                "max_price": 500.0,
                "category": "CONCERT",
            },
        )
        ev.raise_for_status()
        event_id = ev.json()["id"]
        async with async_session() as s:
            e = await s.get(Event, uuid.UUID(event_id))
            e.status = "bidding_open"
            await s.commit()
        tier = await c.post(
            f"{API}/events/{event_id}/tiers",
            headers=h(org),
            json={"name": "R석", "capacity": 5, "base_price": 99000.0, "sale_mode": "point_lottery", "face_price": 99000.0},
        )
        tier.raise_for_status()
        tier_id = tier.json()["id"]
        async with async_session() as s:
            from app.models.phase_config import PhaseConfig

            s.add(
                PhaseConfig(
                    event_id=uuid.UUID(event_id),
                    phase="lottery",
                    starts_at=now - timedelta(hours=1),
                    ends_at=now + timedelta(hours=12),
                    status="active",
                    config={},
                )
            )
            await FairnessService(s).save_policy(uuid.UUID(event_id), None, PRESETS["fan_first"].to_dict(), preset="fan_first", actor="e2e")
            await s.commit()
        check("준비: 주최사·이벤트·추첨 등급·가중치 정책(fan_first)", True, f"event={event_id}")

        apply_url = f"{API}/events/{event_id}/tiers/{tier_id}/lottery/apply"

        # ── Redis 분산 락: 같은 사용자 동시 응모 30건 ──
        racer_email = f"gw_racer_{RUN}@verify.pickket.kr"
        racer = await register(c, racer_email, "동시응모")
        await grant(racer_email, 1000)
        rid = await user_id(racer_email)
        async with async_session() as s:
            before = await PointService(s).get_balance(rid, PointType.FAN)
        rs = await asyncio.gather(
            *[c.post(apply_url, headers=h(racer), json={"group_size": 1, "invested_ap": 500}) for _ in range(30)]
        )
        codes = [r.status_code for r in rs]
        async with async_session() as s:
            n_entries = await s.scalar(text("SELECT count(*) FROM lottery_entries WHERE user_id = :u"), {"u": rid})
            invests = (
                await s.execute(
                    text("SELECT amount FROM point_transactions WHERE user_id = :u AND tx_type = 'invest_lottery'"), {"u": rid}
                )
            ).scalars().all()
            after = await PointService(s).get_balance(rid, PointType.FAN)
        check(
            "Redis 분산 락: 동시 응모 30건 → 1건만 접수, AP 1회 차감",
            codes.count(201) == 1 and n_entries == 1 and list(invests) == [-500],
            f"응답={ {k: codes.count(k) for k in set(codes)} }, 응모행={n_entries}, AP 차감 기록={list(invests)}, 잔액 {before}→{after}(퀘스트 보상 포함)",
        )

        # ── 일반 응모자 ──
        tokens = {}
        for i in range(12):
            email = f"gw_fan{i}_{RUN}@verify.pickket.kr"
            tokens[email] = await register(c, email, f"응모자{i}")
            ap = [0, 300, 1000, 2000][i % 4]
            if ap:
                await grant(email, ap)
            r = await c.post(apply_url, headers=h(tokens[email], **{"x-device-fingerprint": f"fp-{RUN}-{i}"}), json={"group_size": 1, "invested_ap": ap})
            assert r.status_code == 201, r.text

        # ── 계정 복제: 같은 기기 3번째 계정 ──
        shared = {"x-device-fingerprint": f"fp-shared-{RUN}"}
        clone_codes = []
        for i in range(3):
            email = f"gw_clone{i}_{RUN}@verify.pickket.kr"
            t = await register(c, email, f"복제{i}")
            clone_codes.append((await c.post(apply_url, headers=h(t, **shared), json={"group_size": 1, "invested_ap": 0})).status_code)
        check("계정 복제 차단: 같은 기기 3번째 계정 거부", clone_codes == [201, 201, 400], f"{clone_codes}")

        # ── Slash ──
        bad_email = "gw_fan1_" + RUN + "@verify.pickket.kr"
        bad = await user_id(bad_email)
        async with async_session() as s:
            sanction = await SanctionService(s).impose(bad, "macro_bot", event_id=uuid.UUID(event_id), actor="e2e", evidence={"score": 92})
            await s.commit()
            burned = sanction.ap_burned
        check("Slash: 매크로 의심 계정 AP 소각·자격 박탈", True, f"소각 AP={burned}")

        # ── 추첨 ──
        # 응모 마감(추첨은 마감 후에만 가능)
        async with async_session() as s:
            await s.execute(
                text("UPDATE phase_configs SET ends_at = now() - interval '1 second' WHERE event_id = :e AND phase = 'lottery'"),
                {"e": event_id},
            )
            await s.commit()
        status = (await c.get(f"{API}/events/{event_id}/tiers/{tier_id}/lottery/status")).json()
        pool_id = status["id"]
        d = await c.post(f"{API}/events/{event_id}/tiers/{tier_id}/lottery/draw", headers=h(org))
        check("추첨 실행", d.status_code == 200, d.text[:120])
        verify = (await c.get(f"{API}/lottery/pools/{pool_id}/verify")).json()
        check("commit-reveal 검증 API is_valid", verify.get("is_valid") is True, json.dumps(verify.get("checks"), ensure_ascii=False))

        roots = (await c.get(f"{API}/fairness/pools/{pool_id}/roots")).json()["roots"]
        check("공개 Merkle 루트 조회(응모·결과)", set(roots) == {"entries", "results"}, f"entries={roots['entries']['root'][:16]}…")
        async with async_session() as s:
            drawn_at = await s.scalar(text("SELECT drawn_at FROM lottery_pools WHERE id = :p"), {"p": pool_id})
            entries_at = await s.scalar(text("SELECT built_at FROM lottery_merkle_roots WHERE pool_id = :p AND kind='entries'"), {"p": pool_id})
            excluded = await s.scalar(
                text("SELECT count(*) FROM lottery_merkle_leaves WHERE pool_id=:p AND kind='results' AND payload->>'result'='excluded'"),
                {"p": pool_id},
            )
        check("응모 Merkle 루트가 추첨보다 먼저 확정", entries_at < drawn_at, f"루트 {entries_at.isoformat()} < 추첨 {drawn_at.isoformat()}")
        check("결과 트리에 제재 제외 1건 기록", excluded == 1, f"excluded={excluded}")

        proof = (await c.get(f"{API}/fairness/pools/{pool_id}/my-proof", headers=h(tokens[f'gw_fan0_{RUN}@verify.pickket.kr']))).json()
        check("응모자 본인 포함 증명(응모·결과 트리)", proof["entries"]["verified"] and proof["results"]["verified"], f"index={proof['entries']['index']}")

        # ── 증명서 ──
        async with async_session() as s:
            cert = await FairnessService(s).issue_certificate(uuid.UUID(pool_id), issued_by="e2e")
            cert_no = cert.cert_no
            await s.commit()
        view = (await c.get(f"{API}/fairness/certificates/{cert_no}")).json()
        check("공정성 증명서 발급·서명·루트 대조", view["checks"]["all_valid"], f"{cert_no} {json.dumps(view['checks'], ensure_ascii=False)}")
        pdf = await c.get(f"{API}/fairness/certificates/{cert_no}/pdf")
        out_dir.mkdir(parents=True, exist_ok=True)
        (out_dir / f"certificate-{cert_no}.pdf").write_bytes(pdf.content)
        (out_dir / f"certificate-{cert_no}.json").write_text(json.dumps(view, ensure_ascii=False, indent=2))
        check("증명서 PDF", pdf.status_code == 200 and pdf.content[:4] == b"%PDF", f"{len(pdf.content):,} bytes")

        # ── append-only ──
        probes = {
            "fairness_certificates": f"UPDATE fairness_certificates SET issued_by='x' WHERE cert_no='{cert_no}'",
            "lottery_merkle_leaves": f"DELETE FROM lottery_merkle_leaves WHERE pool_id='{pool_id}'",
            "lottery_merkle_roots": f"UPDATE lottery_merkle_roots SET root=repeat('0',64) WHERE pool_id='{pool_id}'",
            "account_sanctions": f"DELETE FROM account_sanctions WHERE user_id='{bad}'",
            "ts_lottery_events": f"DELETE FROM ts_lottery_events WHERE event_id='{event_id}'",
            "lottery_pool_policies (TRUNCATE)": "TRUNCATE lottery_pool_policies",
        }
        for table, sql in probes.items():
            try:
                async with async_session() as s:
                    await s.execute(text(sql))
                    await s.commit()
                check(f"append-only 거부: {table}", False, "변경이 허용됨")
            except Exception as exc:  # noqa: BLE001
                check(f"append-only 거부: {table}", "append-only" in str(exc), str(exc).splitlines()[0][:100])

        # ── TimescaleDB ──
        async with async_session() as s:
            mode = await s.scalar(text("SELECT ts_storage_mode()"))
            kinds = dict(
                (await s.execute(text("SELECT kind, count(*) FROM ts_lottery_events WHERE event_id=:e GROUP BY kind"), {"e": event_id})).all()
            )
            hyper = await s.scalar(
                text("SELECT count(*) FROM timescaledb_information.hypertables WHERE hypertable_name LIKE 'ts_%'")
            ) if mode == "timescaledb" else 0
            agg = (await s.execute(text("SELECT kind, sum(n) FROM ts_lottery_1m WHERE event_id=:e GROUP BY kind"), {"e": event_id})).all()
        check("TimescaleDB 시계열 기록(apply·close·draw·slash)", {"apply", "close", "draw", "slash"} <= set(kinds), f"mode={mode}, hypertables={hyper}, {kinds}")
        check("1분 연속 집계(ts_lottery_1m) 조회", len(agg) > 0, f"{dict(agg)}")

    ok = all(r["ok"] for r in results)
    summary = {
        "run": RUN,
        "ran_at": datetime.now(UTC).isoformat(),
        "seconds": round(time.time() - started, 1),
        "event_id": event_id,
        "pool_id": pool_id,
        "certificate": cert_no,
        "passed": sum(r["ok"] for r in results),
        "failed": sum(not r["ok"] for r in results),
        "checks": results,
    }
    (out_dir / f"e2e-pg-{RUN}.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2))
    print(f"\n{'전체 통과' if ok else '실패 있음'} — {summary['passed']}/{len(results)}  결과: {out_dir}/e2e-pg-{RUN}.json")
    return 0 if ok else 1


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", default=str(Path(__file__).resolve().parents[4] / "docs" / "gwasup" / "evidence"))
    args = parser.parse_args()
    sys.exit(asyncio.run(main(Path(args.out))))
