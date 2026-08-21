import os
import yaml
from pathlib import Path
from dataclasses import dataclass, field
from typing import Literal


@dataclass
class StorageConfig:
    backend: Literal["sqlite", "redis"] = "sqlite"
    sqlite_path: str = ".mcp-dev.db"
    redis_db: int = 2


@dataclass
class TelegramConfig:
    enabled: bool = False
    bot_token: str = ""
    chat_id: str = ""


@dataclass
class SlackConfig:
    enabled: bool = False
    webhook_url: str = ""


@dataclass
class DiscordConfig:
    enabled: bool = False
    webhook_url: str = ""


@dataclass
class WebhookConfig:
    enabled: bool = False
    url: str = ""


@dataclass
class NotificationsConfig:
    telegram: TelegramConfig = field(default_factory=TelegramConfig)
    slack: SlackConfig = field(default_factory=SlackConfig)
    discord: DiscordConfig = field(default_factory=DiscordConfig)
    webhook: WebhookConfig = field(default_factory=WebhookConfig)


@dataclass
class GithubConfig:
    enabled: bool = False
    repo: str = ""
    webhook_secret: str = ""


@dataclass
class TeamMember:
    name: str


@dataclass
class AppConfig:
    project: str = "my-project"
    project_root: str = ""
    team: list[TeamMember] = field(default_factory=list)
    storage: StorageConfig = field(default_factory=StorageConfig)
    notifications: NotificationsConfig = field(default_factory=NotificationsConfig)
    github: GithubConfig = field(default_factory=GithubConfig)
    lock_mode: Literal["soft", "strict"] = "soft"
    event_log_ttl_hours: int = 48
    lock_ttl_hours: int = 2

    # 서버 설정
    port: int = 8022
    mcp_auth_token: str = ""
    admin_key: str = ""


def _load_yml(path: str) -> dict:
    with open(path) as f:
        return yaml.safe_load(f) or {}


def load_config() -> AppConfig:
    cfg = AppConfig()

    # 환경변수에서 yml 경로 찾기 (프로젝트 루트 기준)
    yml_path = os.environ.get("MCP_TEAM_CONFIG", "mcp-team.yml")
    if not os.path.isabs(yml_path):
        # 현재 디렉토리 또는 프로젝트 루트에서 탐색
        for candidate in [yml_path, f"../../{yml_path}", f"../../../{yml_path}"]:
            if os.path.exists(candidate):
                yml_path = candidate
                break

    if os.path.exists(yml_path):
        data = _load_yml(yml_path)

        cfg.project = data.get("project", cfg.project)
        cfg.project_root = data.get("project_root", "")
        cfg.lock_mode = data.get("lock_mode", cfg.lock_mode)
        cfg.event_log_ttl_hours = data.get("event_log_ttl_hours", cfg.event_log_ttl_hours)
        cfg.lock_ttl_hours = data.get("lock_ttl_hours", cfg.lock_ttl_hours)

        if "team" in data:
            cfg.team = [TeamMember(name=m["name"]) for m in data["team"]]

        if "storage" in data:
            s = data["storage"]
            cfg.storage.backend = s.get("backend", cfg.storage.backend)
            cfg.storage.sqlite_path = s.get("sqlite_path", cfg.storage.sqlite_path)
            cfg.storage.redis_db = s.get("redis_db", cfg.storage.redis_db)

        if "notifications" in data:
            n = data["notifications"]
            if "telegram" in n:
                cfg.notifications.telegram.enabled = n["telegram"].get("enabled", False)
            if "slack" in n:
                cfg.notifications.slack.enabled = n["slack"].get("enabled", False)
            if "discord" in n:
                cfg.notifications.discord.enabled = n["discord"].get("enabled", False)
            if "webhook" in n:
                cfg.notifications.webhook.enabled = n["webhook"].get("enabled", False)

        if "github" in data:
            g = data["github"]
            cfg.github.enabled = g.get("enabled", False)
            cfg.github.repo = g.get("repo", "")

    # 환경변수로 오버라이드 (실제 시크릿 값)
    cfg.mcp_auth_token = os.environ.get("MCP_AUTH_TOKEN", "")
    cfg.admin_key = os.environ.get("MCP_ADMIN_KEY", "")
    cfg.port = int(os.environ.get("PORT", cfg.port))

    # Storage 백엔드 env var 오버라이드
    if os.environ.get("STORAGE_BACKEND"):
        cfg.storage.backend = os.environ["STORAGE_BACKEND"]
    if os.environ.get("REDIS_DB"):
        cfg.storage.redis_db = int(os.environ["REDIS_DB"])

    if not cfg.project_root:
        cfg.project_root = os.environ.get("MCP_PROJECT_ROOT", str(Path.cwd()))

    # Telegram
    cfg.notifications.telegram.bot_token = os.environ.get("TELEGRAM_BOT_TOKEN", "")
    cfg.notifications.telegram.chat_id = os.environ.get("TELEGRAM_CHAT_ID", "")
    if cfg.notifications.telegram.bot_token and cfg.notifications.telegram.chat_id:
        cfg.notifications.telegram.enabled = True

    # Slack
    cfg.notifications.slack.webhook_url = os.environ.get("SLACK_WEBHOOK_URL", "")
    if cfg.notifications.slack.webhook_url:
        cfg.notifications.slack.enabled = True

    # Discord
    cfg.notifications.discord.webhook_url = os.environ.get("DISCORD_WEBHOOK_URL", "")
    if cfg.notifications.discord.webhook_url:
        cfg.notifications.discord.enabled = True

    # Custom webhook
    cfg.notifications.webhook.url = os.environ.get("CUSTOM_WEBHOOK_URL", "")
    if cfg.notifications.webhook.url:
        cfg.notifications.webhook.enabled = True

    # GitHub
    cfg.github.webhook_secret = os.environ.get("GITHUB_WEBHOOK_SECRET", "")

    # Lock mode override
    cfg.lock_mode = os.environ.get("MCP_LOCK_MODE", cfg.lock_mode)

    return cfg


# 싱글톤
_config: AppConfig | None = None


def get_config() -> AppConfig:
    global _config
    if _config is None:
        _config = load_config()
    return _config
