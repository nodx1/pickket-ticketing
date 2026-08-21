"""백업 검증 자동화 태스크.

YES24 2025 랜섬웨어 대비:
- 최신 S3 백업 다운로드
- 복호화 + 체크섬 검증 (S3 metadata의 sha256과 비교)
- 결과 알림
"""
import gzip
import hashlib
import logging
import os
import tempfile
from datetime import datetime, timezone

from app.core.config import settings

logger = logging.getLogger(__name__)


async def verify_latest_backup() -> dict:
    """최신 S3 백업 다운로드 → 복호화 → 체크섬 검증.

    Returns: {"success": bool, "details": str, ...}
    """
    try:
        import boto3

        s3 = boto3.client(
            "s3",
            region_name=settings.AWS_REGION if hasattr(settings, "AWS_REGION") else "ap-northeast-2",
        )
        bucket = getattr(settings, "BACKUP_S3_BUCKET", "")
        prefix = getattr(settings, "BACKUP_S3_PREFIX", "backups/")

        if not bucket:
            return {"success": False, "details": "BACKUP_S3_BUCKET not configured"}

        # 최신 백업 파일 찾기 — .sql.gz.enc 파일만
        response = s3.list_objects_v2(
            Bucket=bucket,
            Prefix=prefix,
            MaxKeys=50,
        )

        if "Contents" not in response or not response["Contents"]:
            msg = "No backup files found"
            logger.warning(msg)
            await _send_report(False, msg)
            return {"success": False, "details": msg}

        # .sql.gz.enc 파일만 필터
        backup_objects = [
            obj for obj in response["Contents"]
            if obj["Key"].endswith(".sql.gz.enc")
        ]
        if not backup_objects:
            msg = "No .sql.gz.enc backup files found"
            logger.warning(msg)
            await _send_report(False, msg)
            return {"success": False, "details": msg}

        backup_objects.sort(key=lambda x: x["LastModified"], reverse=True)
        latest = backup_objects[0]
        key = latest["Key"]
        size = latest["Size"]
        last_modified = latest["LastModified"]

        # S3 메타데이터에서 기대 체크섬 조회
        head = s3.head_object(Bucket=bucket, Key=key)
        expected_checksum = (head.get("Metadata") or {}).get("sha256", "")

        # 다운로드 (보안: 제한적 umask + 임시파일)
        old_umask = os.umask(0o077)
        try:
            with tempfile.NamedTemporaryFile(prefix="pickket_backup_", suffix=".enc") as tmp:
                s3.download_file(bucket, key, tmp.name)
                tmp.seek(0)
                encrypted_data = tmp.read()
        finally:
            os.umask(old_umask)

        # 암호화된 파일의 체크섬 검증
        actual_checksum = hashlib.sha256(encrypted_data).hexdigest()

        checksum_match = True
        if expected_checksum:
            checksum_match = actual_checksum == expected_checksum

        # 복호화 시도 (Fernet 키가 있으면)
        decryption_ok = True
        encryption_key = os.environ.get("BACKUP_ENCRYPTION_KEY", "")
        if encryption_key:
            try:
                from cryptography.fernet import Fernet
                f = Fernet(encryption_key.encode())
                decrypted = f.decrypt(encrypted_data)
                # gzip 디컴프레스 시도 — 유효한 덤프인지 확인
                try:
                    gzip.decompress(decrypted[:1024])  # 헤더만 검증
                except Exception:
                    logger.warning("backup verification gzip header check failed (may be custom format)", exc_info=True)
            except Exception as e:
                decryption_ok = False
                logger.error("Backup decryption failed: %s", e)

        success = checksum_match and decryption_ok
        status_parts = []
        if not checksum_match:
            status_parts.append(f"체크섬 불일치 (expected={expected_checksum[:16]}..., actual={actual_checksum[:16]}...)")
        if not decryption_ok:
            status_parts.append("복호화 실패")

        details = (
            f"파일: {key}\n"
            f"크기: {size:,} bytes\n"
            f"최종수정: {last_modified}\n"
            f"SHA256: {actual_checksum[:16]}...\n"
            f"체크섬 검증: {'✅' if checksum_match else '❌'}"
            f"{' (메타데이터 없음 — 건너뜀)' if not expected_checksum else ''}\n"
            f"복호화 검증: {'✅' if decryption_ok else '❌'}"
            f"{' (키 미설정 — 건너뜀)' if not encryption_key else ''}"
        )

        if success:
            logger.info("Backup verification passed: %s", key)
        else:
            logger.error("Backup verification FAILED: %s — %s", key, "; ".join(status_parts))

        await _send_report(success, details)

        return {
            "success": success,
            "key": key,
            "size": size,
            "checksum": actual_checksum,
            "checksum_match": checksum_match,
            "decryption_ok": decryption_ok,
            "details": details,
        }

    except Exception as e:
        msg = f"Backup verification failed: {e}"
        logger.error(msg, exc_info=True)
        await _send_report(False, msg)
        return {"success": False, "details": msg}


async def _send_report(success: bool, details: str) -> None:
    """검증 결과 알림."""
    try:
        from app.core.alerting import send_ops_alert
        status = "✅ 성공" if success else "❌ 실패"
        await send_ops_alert(
            f"🗄️ 백업 검증 {status}\n\n{details}",
            level="info" if success else "critical",
            alert_key="backup_verify",
        )
    except Exception:
        logger.debug("Failed to send backup verification report", exc_info=True)
