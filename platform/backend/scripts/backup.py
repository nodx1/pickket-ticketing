#!/usr/bin/env python3
"""Pickket 자동 백업 스크립트 — pg_dump → gzip → AES-256 암호화 → S3 업로드.

사용법:
    python backup.py --backup           # 백업 생성 및 S3 업로드
    python backup.py --list             # S3 백업 목록 조회
    python backup.py --cleanup          # 30일 보존 정책 적용 (오래된 백업 삭제)

환경변수:
    DATABASE_URL_SYNC   — PostgreSQL 연결 URL
    BACKUP_S3_BUCKET    — S3 버킷 이름
    BACKUP_S3_PREFIX    — S3 키 접두사 (기본: backups/)
    BACKUP_ENCRYPTION_KEY — Fernet 암호화 키 (비어있으면 SSE-S3 사용)
    AWS_ACCESS_KEY_ID   — AWS 자격증명
    AWS_SECRET_ACCESS_KEY — AWS 자격증명
    AWS_DEFAULT_REGION  — AWS 리전 (기본: ap-northeast-2)
"""

import argparse
import gzip
import io
import logging
import os
import subprocess
import sys
from datetime import datetime, timezone, timedelta
from pathlib import Path
from urllib.parse import urlparse

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
logger = logging.getLogger("pickket.backup")

# ── 환경 변수 로드 ─────────────────────────────────────────────────────

# .env 파일 로드 시도
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
RETENTION_DAYS = int(os.environ.get("BACKUP_RETENTION_DAYS", "30"))
BACKUP_LOCAL_DIR = os.environ.get("BACKUP_LOCAL_DIR", "/tmp/pickket-backups")


def _parse_db_url(url: str) -> dict:
    """PostgreSQL URL을 파싱하여 연결 정보 반환."""
    parsed = urlparse(url)
    return {
        "host": parsed.hostname or "localhost",
        "port": str(parsed.port or 5432),
        "dbname": (parsed.path or "/dev").lstrip("/"),
        "user": parsed.username or "user",
        "password": parsed.password or "",
    }


def _get_s3_client():
    """boto3 S3 클라이언트 생성."""
    try:
        import boto3
    except ImportError:
        logger.error("boto3가 설치되지 않았습니다. pip install boto3")
        sys.exit(1)
    return boto3.client("s3", region_name=AWS_REGION)


def _encrypt_data(data: bytes) -> bytes:
    """Fernet (AES-256) 암호화. 키가 없으면 원본 반환 (SSE-S3 사용 시)."""
    if not BACKUP_ENCRYPTION_KEY:
        return data
    try:
        from cryptography.fernet import Fernet
    except ImportError:
        logger.warning("cryptography 패키지 없음 — 암호화 건너뜀 (SSE-S3 권장)")
        return data
    f = Fernet(BACKUP_ENCRYPTION_KEY.encode())
    return f.encrypt(data)


def _decrypt_data(data: bytes) -> bytes:
    """Fernet 복호화. 키가 없으면 원본 반환."""
    if not BACKUP_ENCRYPTION_KEY:
        return data
    from cryptography.fernet import Fernet

    f = Fernet(BACKUP_ENCRYPTION_KEY.encode())
    return f.decrypt(data)


def _generate_backup_id() -> str:
    """타임스탬프 기반 백업 ID 생성."""
    return datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")


def do_backup() -> str:
    """pg_dump → gzip → 암호화 → S3 업로드. 백업 ID 반환."""
    if not DATABASE_URL_SYNC:
        logger.error("DATABASE_URL_SYNC가 설정되지 않았습니다.")
        sys.exit(1)

    db_info = _parse_db_url(DATABASE_URL_SYNC)
    backup_id = _generate_backup_id()
    s3_key = f"{BACKUP_S3_PREFIX}{backup_id}.sql.gz.enc"

    logger.info("백업 시작 — ID: %s, DB: %s", backup_id, db_info["dbname"])

    # 1) pg_dump 실행
    env = os.environ.copy()
    env["PGPASSWORD"] = db_info["password"]

    cmd = [
        "pg_dump",
        "-h",
        db_info["host"],
        "-p",
        db_info["port"],
        "-U",
        db_info["user"],
        "-d",
        db_info["dbname"],
        "--format=custom",
        "--compress=0",  # 직접 gzip 처리
        "--no-owner",
        "--no-acl",
    ]

    logger.info("pg_dump 실행 중...")
    try:
        result = subprocess.run(cmd, capture_output=True, env=env, timeout=600)
    except FileNotFoundError:
        logger.error("pg_dump 명령을 찾을 수 없습니다. PostgreSQL 클라이언트를 설치하세요.")
        sys.exit(1)
    except subprocess.TimeoutExpired:
        logger.error("pg_dump 타임아웃 (10분)")
        sys.exit(1)

    if result.returncode != 0:
        logger.error("pg_dump 실패: %s", result.stderr.decode(errors="replace"))
        sys.exit(1)

    raw_dump = result.stdout
    logger.info("pg_dump 완료 — %d bytes", len(raw_dump))

    # 2) gzip 압축
    logger.info("gzip 압축 중...")
    buf = io.BytesIO()
    with gzip.GzipFile(fileobj=buf, mode="wb", compresslevel=6) as gz:
        gz.write(raw_dump)
    compressed = buf.getvalue()
    ratio = len(compressed) / max(len(raw_dump), 1) * 100
    logger.info("압축 완료 — %d bytes (%.1f%%)", len(compressed), ratio)

    # 3) 암호화
    logger.info("암호화 중...")
    encrypted = _encrypt_data(compressed)
    logger.info("암호화 완료 — %d bytes", len(encrypted))

    # 무결성 체크섬 생성 (검증 태스크에서 사용)
    import hashlib
    encrypted_sha256 = hashlib.sha256(encrypted).hexdigest()

    # 4) S3 업로드
    if not BACKUP_S3_BUCKET:
        # 로컬 폴백 — S3 없이 로컬 저장
        local_dir = Path(BACKUP_LOCAL_DIR)
        local_dir.mkdir(exist_ok=True)
        local_path = local_dir / f"{backup_id}.sql.gz.enc"
        local_path.write_bytes(encrypted)
        logger.info("로컬 저장 완료 — %s", local_path)
    else:
        logger.info("S3 업로드 중 — s3://%s/%s", BACKUP_S3_BUCKET, s3_key)
        s3 = _get_s3_client()
        extra_args = {}
        if not BACKUP_ENCRYPTION_KEY:
            # 클라이언트 측 암호화 미사용 시 SSE-S3 적용
            extra_args["ServerSideEncryption"] = "AES256"

        # S3 Object Lock — 랜섬웨어 대비 불변 백업 (YES24 2025)
        object_lock_days = int(os.environ.get("BACKUP_OBJECT_LOCK_DAYS", "30"))
        if object_lock_days > 0:
            retain_until = datetime.now(timezone.utc) + timedelta(days=object_lock_days)
            extra_args["ObjectLockMode"] = "GOVERNANCE"
            extra_args["ObjectLockRetainUntilDate"] = retain_until

        s3.put_object(
            Bucket=BACKUP_S3_BUCKET,
            Key=s3_key,
            Body=encrypted,
            Metadata={
                "backup-id": backup_id,
                "database": db_info["dbname"],
                "encrypted": "fernet" if BACKUP_ENCRYPTION_KEY else "sse-s3",
                "sha256": encrypted_sha256,
            },
            **extra_args,
        )
        lock_msg = f" (Object Lock: {object_lock_days}d GOVERNANCE)" if object_lock_days > 0 else ""
        logger.info("S3 업로드 완료%s", lock_msg)

    logger.info("백업 완료 — ID: %s", backup_id)
    return backup_id


def do_list():
    """S3 백업 목록 조회."""
    if not BACKUP_S3_BUCKET:
        # 로컬 폴백
        local_dir = Path(BACKUP_LOCAL_DIR)
        if not local_dir.exists():
            logger.info("로컬 백업 디렉토리 없음")
            return
        files = sorted(local_dir.glob("*.sql.gz.enc"), reverse=True)
        logger.info("로컬 백업 %d건:", len(files))
        for f in files:
            size_mb = f.stat().st_size / (1024 * 1024)
            logger.info("  %s  (%.2f MB)", f.name, size_mb)
        return

    s3 = _get_s3_client()
    response = s3.list_objects_v2(
        Bucket=BACKUP_S3_BUCKET,
        Prefix=BACKUP_S3_PREFIX,
    )
    objects = response.get("Contents", [])
    if not objects:
        logger.info("백업 없음")
        return

    objects.sort(key=lambda x: x["LastModified"], reverse=True)
    logger.info("S3 백업 %d건:", len(objects))
    for obj in objects:
        size_mb = obj["Size"] / (1024 * 1024)
        modified = obj["LastModified"].strftime("%Y-%m-%d %H:%M:%S UTC")
        logger.info("  %s  (%.2f MB, %s)", obj["Key"], size_mb, modified)


def do_cleanup():
    """보존 정책 적용 — RETENTION_DAYS일 이전 백업 삭제."""
    cutoff = datetime.now(timezone.utc) - timedelta(days=RETENTION_DAYS)
    logger.info("정리 시작 — %d일 보존 정책 (기준: %s)", RETENTION_DAYS, cutoff.isoformat())

    if not BACKUP_S3_BUCKET:
        # 로컬 폴백
        local_dir = Path(BACKUP_LOCAL_DIR)
        if not local_dir.exists():
            return
        deleted = 0
        for f in local_dir.glob("*.sql.gz.enc"):
            mtime = datetime.fromtimestamp(f.stat().st_mtime, tz=timezone.utc)
            if mtime < cutoff:
                f.unlink()
                deleted += 1
                logger.info("  삭제: %s", f.name)
        logger.info("로컬 정리 완료 — %d건 삭제", deleted)
        return

    s3 = _get_s3_client()
    response = s3.list_objects_v2(
        Bucket=BACKUP_S3_BUCKET,
        Prefix=BACKUP_S3_PREFIX,
    )
    objects = response.get("Contents", [])
    deleted = 0
    for obj in objects:
        if obj["LastModified"].replace(tzinfo=timezone.utc) < cutoff:
            try:
                s3.delete_object(Bucket=BACKUP_S3_BUCKET, Key=obj["Key"])
                deleted += 1
                logger.info("  삭제: %s", obj["Key"])
            except Exception as e:
                logger.warning("  삭제 실패 (Object Lock?): %s — %s", obj["Key"], e)

    logger.info("S3 정리 완료 — %d건 삭제", deleted)


def main():
    parser = argparse.ArgumentParser(description="Pickket DB 백업 관리")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--backup", action="store_true", help="백업 생성 및 업로드")
    group.add_argument("--list", action="store_true", help="백업 목록 조회")
    group.add_argument("--cleanup", action="store_true", help="보존 정책 적용 (오래된 백업 삭제)")

    args = parser.parse_args()

    if args.backup:
        do_backup()
    elif args.list:
        do_list()
    elif args.cleanup:
        do_cleanup()


if __name__ == "__main__":
    main()
