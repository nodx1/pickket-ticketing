#!/usr/bin/env python3
"""Pickket DB 복원 스크립트 — S3 다운로드 → 복호화 → gunzip → pg_restore.

사용법:
    python restore.py --backup-id 20260304_030000     # 특정 백업 복원
    python restore.py --latest                         # 최신 백업 복원
    python restore.py --latest --dry-run              # 실제 복원 없이 검증만

환경변수: backup.py와 동일
"""

import argparse
import gzip
import logging
import os
import subprocess
import sys
import tempfile
from pathlib import Path
from urllib.parse import urlparse

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("pickket.restore")

# ── 환경 변수 로드 ─────────────────────────────────────────────────────

_env_path = Path(__file__).resolve().parent.parent / ".env"
if _env_path.exists():
    for line in _env_path.read_text().splitlines():
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, _, v = line.partition("=")
            os.environ.setdefault(k.strip(), v.strip().strip("'\""))

DATABASE_URL_SYNC = os.environ.get("DATABASE_URL_SYNC", "")
BACKUP_S3_BUCKET = os.environ.get("BACKUP_S3_BUCKET", "")
BACKUP_S3_PREFIX = os.environ.get("BACKUP_S3_PREFIX", "backups/")
BACKUP_ENCRYPTION_KEY = os.environ.get("BACKUP_ENCRYPTION_KEY", "")
AWS_REGION = os.environ.get("AWS_DEFAULT_REGION", "ap-northeast-2")
BACKUP_LOCAL_DIR = os.environ.get("BACKUP_LOCAL_DIR", "/tmp/pickket-backups")
UNSUPPORTED_SQL_PREFIXES = (
    "SET transaction_timeout =",
    "SELECT pg_catalog.set_config('transaction_timeout'",
)


def _parse_db_url(url: str) -> dict:
    parsed = urlparse(url)
    return {
        "host": parsed.hostname or "localhost",
        "port": str(parsed.port or 5432),
        "dbname": (parsed.path or "/dev").lstrip("/"),
        "user": parsed.username or "user",
        "password": parsed.password or "",
    }


def _get_s3_client():
    try:
        import boto3
    except ImportError:
        logger.error("boto3가 설치되지 않았습니다. pip install boto3")
        sys.exit(1)
    return boto3.client("s3", region_name=AWS_REGION)


def _decrypt_data(data: bytes) -> bytes:
    if not BACKUP_ENCRYPTION_KEY:
        return data
    try:
        from cryptography.fernet import Fernet
    except ImportError:
        logger.error("cryptography 패키지가 필요합니다.")
        sys.exit(1)
    f = Fernet(BACKUP_ENCRYPTION_KEY.encode())
    return f.decrypt(data)


def _find_latest_backup_key() -> str | None:
    """S3에서 최신 백업 키 찾기."""
    if not BACKUP_S3_BUCKET:
        # 로컬 폴백
        local_dir = Path(BACKUP_LOCAL_DIR)
        if not local_dir.exists():
            return None
        files = sorted(local_dir.glob("*.sql.gz.enc"), reverse=True)
        return str(files[0]) if files else None

    s3 = _get_s3_client()
    response = s3.list_objects_v2(
        Bucket=BACKUP_S3_BUCKET,
        Prefix=BACKUP_S3_PREFIX,
    )
    objects = response.get("Contents", [])
    if not objects:
        return None
    objects.sort(key=lambda x: x["LastModified"], reverse=True)
    return objects[0]["Key"]


def _download_backup(key_or_path: str) -> bytes:
    """백업 파일 다운로드."""
    if not BACKUP_S3_BUCKET:
        # 로컬 파일
        p = Path(key_or_path)
        if not p.exists():
            logger.error("로컬 백업 파일 없음: %s", key_or_path)
            sys.exit(1)
        return p.read_bytes()

    s3 = _get_s3_client()
    logger.info("S3 다운로드 중 — s3://%s/%s", BACKUP_S3_BUCKET, key_or_path)
    response = s3.get_object(Bucket=BACKUP_S3_BUCKET, Key=key_or_path)
    return response["Body"].read()


def _is_custom_dump(raw_dump: bytes) -> bool:
    return raw_dump.startswith(b"PGDMP")


def _sanitize_restore_sql(raw_sql: bytes) -> bytes:
    filtered: list[bytes] = []
    for line in raw_sql.splitlines(keepends=True):
        stripped = line.decode("utf-8", errors="ignore").strip()
        if any(stripped.startswith(prefix) for prefix in UNSUPPORTED_SQL_PREFIXES):
            continue
        filtered.append(line)
    return b"".join(filtered)


def do_restore(backup_id: str | None, latest: bool, dry_run: bool):
    """백업 복원 실행."""
    if not DATABASE_URL_SYNC:
        logger.error("DATABASE_URL_SYNC가 설정되지 않았습니다.")
        sys.exit(1)

    # 1) 백업 찾기
    if latest:
        key = _find_latest_backup_key()
        if not key:
            logger.error("백업을 찾을 수 없습니다.")
            sys.exit(1)
        logger.info("최신 백업: %s", key)
    else:
        if not BACKUP_S3_BUCKET:
            local_dir = Path(BACKUP_LOCAL_DIR)
            key = str(local_dir / f"{backup_id}.sql.gz.enc")
        else:
            key = f"{BACKUP_S3_PREFIX}{backup_id}.sql.gz.enc"

    # 2) 다운로드
    encrypted_data = _download_backup(key)
    logger.info("다운로드 완료 — %d bytes", len(encrypted_data))

    # 3) 복호화
    logger.info("복호화 중...")
    compressed = _decrypt_data(encrypted_data)
    logger.info("복호화 완료 — %d bytes", len(compressed))

    # 4) gunzip
    logger.info("압축 해제 중...")
    raw_dump = gzip.decompress(compressed)
    logger.info("압축 해제 완료 — %d bytes", len(raw_dump))

    if dry_run:
        logger.info("[DRY-RUN] 백업 파일 검증 완료. 실제 복원은 수행하지 않습니다.")
        logger.info("  크기: %.2f MB", len(raw_dump) / (1024 * 1024))
        return

    # 5) Restore
    db_info = _parse_db_url(DATABASE_URL_SYNC)
    logger.warning(
        "복원 시작 — 대상 DB: %s@%s:%s/%s",
        db_info["user"],
        db_info["host"],
        db_info["port"],
        db_info["dbname"],
    )

    env = os.environ.copy()
    env["PGPASSWORD"] = db_info["password"]

    # 임시 파일에 덤프 저장
    with tempfile.NamedTemporaryFile(suffix=".dump", delete=False) as tmp:
        tmp.write(raw_dump)
        tmp_path = tmp.name

    try:
        with tempfile.NamedTemporaryFile(suffix=".sql", delete=False) as sql_tmp:
            rendered_sql_path = sql_tmp.name

        try:
            if _is_custom_dump(raw_dump):
                logger.info("pg_restore 렌더링 실행 중...")
                render_cmd = [
                    "pg_restore",
                    "--clean",
                    "--if-exists",
                    "--no-owner",
                    "--no-acl",
                    "-f",
                    rendered_sql_path,
                    tmp_path,
                ]
                render_result = subprocess.run(
                    render_cmd,
                    capture_output=True,
                    env=env,
                    timeout=1200,
                )
                if render_result.returncode != 0:
                    stderr = render_result.stderr.decode(errors="replace")
                    logger.error("pg_restore 렌더링 오류:\n%s", stderr)
                    sys.exit(1)
                rendered_sql = Path(rendered_sql_path).read_bytes()
            else:
                logger.info("plain SQL 백업 감지 — 직접 복원 준비")
                rendered_sql = raw_dump

            sanitized_sql = _sanitize_restore_sql(rendered_sql)
            Path(rendered_sql_path).write_bytes(sanitized_sql)

            logger.info("psql 복원 실행 중...")
            restore_cmd = [
                "psql",
                "-h",
                db_info["host"],
                "-p",
                db_info["port"],
                "-U",
                db_info["user"],
                "-d",
                db_info["dbname"],
                "-v",
                "ON_ERROR_STOP=1",
                "-f",
                rendered_sql_path,
            ]
            restore_result = subprocess.run(
                restore_cmd,
                capture_output=True,
                env=env,
                timeout=1200,
            )
            if restore_result.returncode != 0:
                stderr = restore_result.stderr.decode(errors="replace")
                logger.error("psql 복원 오류:\n%s", stderr)
                sys.exit(1)
        finally:
            if os.path.exists(rendered_sql_path):
                os.unlink(rendered_sql_path)
    finally:
        os.unlink(tmp_path)

    logger.info("복원 완료!")


def main():
    parser = argparse.ArgumentParser(description="Pickket DB 복원")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--backup-id", help="복원할 백업 ID (예: 20260304_030000)")
    group.add_argument("--latest", action="store_true", help="최신 백업 복원")
    parser.add_argument("--dry-run", action="store_true", help="실제 복원 없이 검증만")

    args = parser.parse_args()
    do_restore(args.backup_id, args.latest, args.dry_run)


if __name__ == "__main__":
    main()
