import os


def normalize_path(absolute_path: str, project_root: str) -> str:
    """절대경로 → 프로젝트 루트 기준 상대경로로 정규화.
    팀원마다 로컬 경로가 달라도 같은 파일로 인식하기 위해 필요.
    """
    if not absolute_path:
        return absolute_path
    try:
        rel = os.path.relpath(absolute_path, project_root)
        # 프로젝트 외부 경로(../로 시작)는 절대경로 그대로 유지
        if rel.startswith(".."):
            return absolute_path
        return rel
    except ValueError:
        # Windows에서 다른 드라이브 등 예외 상황
        return absolute_path


def denormalize_path(relative_path: str, project_root: str) -> str:
    """상대경로 → 절대경로로 복원."""
    if os.path.isabs(relative_path):
        return relative_path
    return os.path.join(project_root, relative_path)


def is_project_file(path: str, project_root: str) -> bool:
    """경로가 프로젝트 내부 파일인지 확인."""
    try:
        rel = os.path.relpath(path, project_root)
        return not rel.startswith("..")
    except ValueError:
        return False
