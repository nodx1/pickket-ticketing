"""OAuth2 social login providers (Kakao / Google / Naver).

Each provider implements the standard OAuth2 authorization-code flow:
1. Generate authorization redirect URL
2. Exchange authorization code for access token
3. Fetch user info from provider API
"""

from abc import ABC, abstractmethod
from dataclasses import dataclass
from urllib.parse import urlencode

import httpx

from app.core.config import settings
from app.core.http_client import traced_headers


@dataclass
class OAuthUserInfo:
    """Normalized user info from any OAuth provider."""

    provider: str
    oauth_id: str
    email: str | None
    name: str | None
    avatar_url: str | None = None


class BaseOAuthProvider(ABC):
    """Abstract base class for OAuth2 providers."""

    @property
    @abstractmethod
    def provider_name(self) -> str: ...

    @property
    @abstractmethod
    def authorize_url(self) -> str: ...

    @property
    @abstractmethod
    def token_url(self) -> str: ...

    @property
    @abstractmethod
    def user_info_url(self) -> str: ...

    @property
    @abstractmethod
    def client_id(self) -> str: ...

    @property
    @abstractmethod
    def client_secret(self) -> str: ...

    @property
    @abstractmethod
    def scopes(self) -> list[str]: ...

    @property
    def redirect_uri(self) -> str:
        return (
            f"{settings.OAUTH_REDIRECT_BASE_URL}/auth/oauth/callback?provider={self.provider_name}"
        )

    def get_authorization_url(self, state: str | None = None) -> str:
        """Generate the OAuth2 authorization redirect URL."""
        params = {
            "client_id": self.client_id,
            "redirect_uri": self.redirect_uri,
            "response_type": "code",
        }
        if self.scopes:
            params["scope"] = " ".join(self.scopes)
        if state:
            params["state"] = state
        return f"{self.authorize_url}?{urlencode(params)}"

    async def exchange_code(self, code: str) -> dict:
        """Exchange authorization code for access token."""
        data = {
            "grant_type": "authorization_code",
            "client_id": self.client_id,
            "client_secret": self.client_secret,
            "redirect_uri": self.redirect_uri,
            "code": code,
        }
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.post(
                self.token_url,
                data=data,
                headers=traced_headers({"Accept": "application/json"}),
            )
            resp.raise_for_status()
            return resp.json()

    @abstractmethod
    async def get_user_info(self, access_token: str) -> OAuthUserInfo:
        """Fetch and normalize user info from the provider."""
        ...


class KakaoOAuthProvider(BaseOAuthProvider):
    """Kakao OAuth2 provider."""

    @property
    def provider_name(self) -> str:
        return "kakao"

    @property
    def authorize_url(self) -> str:
        return "https://kauth.kakao.com/oauth/authorize"

    @property
    def token_url(self) -> str:
        return "https://kauth.kakao.com/oauth/token"

    @property
    def user_info_url(self) -> str:
        return "https://kapi.kakao.com/v2/user/me"

    @property
    def client_id(self) -> str:
        return settings.KAKAO_CLIENT_ID

    @property
    def client_secret(self) -> str:
        return settings.KAKAO_CLIENT_SECRET

    @property
    def scopes(self) -> list[str]:
        return ["profile_nickname", "account_email"]

    async def get_user_info(self, access_token: str) -> OAuthUserInfo:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                self.user_info_url,
                headers=traced_headers({"Authorization": f"Bearer {access_token}"}),
            )
            resp.raise_for_status()
            data = resp.json()

        kakao_account = data.get("kakao_account", {})
        profile = kakao_account.get("profile", {})
        return OAuthUserInfo(
            provider="kakao",
            oauth_id=str(data["id"]),
            email=kakao_account.get("email"),
            name=profile.get("nickname"),
            avatar_url=profile.get("profile_image_url"),
        )


class GoogleOAuthProvider(BaseOAuthProvider):
    """Google OAuth2 provider."""

    @property
    def provider_name(self) -> str:
        return "google"

    @property
    def authorize_url(self) -> str:
        return "https://accounts.google.com/o/oauth2/v2/auth"

    @property
    def token_url(self) -> str:
        return "https://oauth2.googleapis.com/token"

    @property
    def user_info_url(self) -> str:
        return "https://www.googleapis.com/oauth2/v2/userinfo"

    @property
    def client_id(self) -> str:
        return settings.GOOGLE_CLIENT_ID

    @property
    def client_secret(self) -> str:
        return settings.GOOGLE_CLIENT_SECRET

    @property
    def scopes(self) -> list[str]:
        return ["openid", "email", "profile"]

    async def get_user_info(self, access_token: str) -> OAuthUserInfo:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                self.user_info_url,
                headers=traced_headers({"Authorization": f"Bearer {access_token}"}),
            )
            resp.raise_for_status()
            data = resp.json()

        return OAuthUserInfo(
            provider="google",
            oauth_id=str(data["id"]),
            email=data.get("email"),
            name=data.get("name"),
            avatar_url=data.get("picture"),
        )


class NaverOAuthProvider(BaseOAuthProvider):
    """Naver OAuth2 provider."""

    @property
    def provider_name(self) -> str:
        return "naver"

    @property
    def authorize_url(self) -> str:
        return "https://nid.naver.com/oauth2.0/authorize"

    @property
    def token_url(self) -> str:
        return "https://nid.naver.com/oauth2.0/token"

    @property
    def user_info_url(self) -> str:
        return "https://openapi.naver.com/v1/nid/me"

    @property
    def client_id(self) -> str:
        return settings.NAVER_CLIENT_ID

    @property
    def client_secret(self) -> str:
        return settings.NAVER_CLIENT_SECRET

    @property
    def scopes(self) -> list[str]:
        return []

    async def get_user_info(self, access_token: str) -> OAuthUserInfo:
        async with httpx.AsyncClient(timeout=10.0) as client:
            resp = await client.get(
                self.user_info_url,
                headers=traced_headers({"Authorization": f"Bearer {access_token}"}),
            )
            resp.raise_for_status()
            data = resp.json()

        response = data.get("response", {})
        return OAuthUserInfo(
            provider="naver",
            oauth_id=str(response.get("id", "")),
            email=response.get("email"),
            name=response.get("name") or response.get("nickname"),
            avatar_url=response.get("profile_image"),
        )


_PROVIDERS: dict[str, type[BaseOAuthProvider]] = {
    "kakao": KakaoOAuthProvider,
    "google": GoogleOAuthProvider,
    "naver": NaverOAuthProvider,
}


def get_oauth_provider(name: str) -> BaseOAuthProvider:
    """Factory function to get an OAuth provider by name.

    Args:
        name: Provider name (kakao, google, naver).

    Returns:
        An instantiated OAuth provider.

    Raises:
        ValueError: If the provider name is not recognized.
    """
    provider_cls = _PROVIDERS.get(name.lower())
    if not provider_cls:
        raise ValueError(f"Unsupported OAuth provider: {name}")
    return provider_cls()
