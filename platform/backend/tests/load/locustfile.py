"""Pickket API Load Test with Locust.

1000명 동시 접속 시뮬레이션으로 API 성능을 측정한다.

시나리오:
  - AnonymousUser (60%): 미인증 공개 API 호출
  - AuthenticatedUser (40%): 로그인 후 인증 API 호출 (그 중 일부 결제 시나리오)

실행:
  cd backend
  .venv/bin/locust -f tests/load/locustfile.py --headless -u 1000 -r 50 -t 60s
"""

from __future__ import annotations

import logging
import random

import gevent
from locust import HttpUser, TaskSet, between, events, task

logger = logging.getLogger(__name__)

# ---------------------------------------------------------------------------
# 설정
# ---------------------------------------------------------------------------

# 테스트 유저 범위 (testuser0001 ~ testuser1000)
TEST_USER_COUNT = 1000
TEST_USER_PASSWORD = "PickketTest2026!"
TEST_USER_EMAIL_FMT = "testuser{num:04d}@seedtest.pickket.kr"

API_PREFIX = "/api/v1"


# ---------------------------------------------------------------------------
# 공유 상태: 이벤트 ID 풀
# ---------------------------------------------------------------------------


class SharedState:
    """테스트 시작 시 공개 API에서 가져온 이벤트 ID 목록을 공유."""

    event_ids: list[str] = []
    _fetched: bool = False

    @classmethod
    def fetch_event_ids(cls, client) -> None:
        """이벤트 목록에서 ID를 미리 가져온다. 한 번만 실행."""
        if cls._fetched:
            return
        cls._fetched = True

        # 1) /api/v1/events/ 에서 이벤트 목록 가져오기
        try:
            resp = client.get(
                f"{API_PREFIX}/events/",
                name="[setup] GET /events/ (fetch IDs)",
                timeout=10,
            )
            if resp.status_code == 200:
                data = resp.json()
                # EventListResponse: {"events": [...], "total": N}
                events_list = data.get("events", data) if isinstance(data, dict) else data
                for evt in events_list:
                    eid = evt.get("id")
                    if eid:
                        cls.event_ids.append(eid)
        except Exception as exc:
            logger.warning("이벤트 목록 조회 실패: %s", exc)

        # 2) 부족하면 featured / trending 에서도 보충
        if len(cls.event_ids) < 5:
            for endpoint in ("featured", "trending", "opening-soon"):
                try:
                    resp = client.get(
                        f"{API_PREFIX}/events/{endpoint}",
                        name=f"[setup] GET /events/{endpoint}",
                        timeout=10,
                    )
                    if resp.status_code == 200:
                        for evt in resp.json():
                            eid = evt.get("id")
                            if eid and eid not in cls.event_ids:
                                cls.event_ids.append(eid)
                except Exception:
                    pass

        # 중복 제거
        cls.event_ids = list(set(cls.event_ids))
        logger.info("부하 테스트용 이벤트 %d개 확보", len(cls.event_ids))

    @classmethod
    def random_event_id(cls) -> str | None:
        if not cls.event_ids:
            return None
        return random.choice(cls.event_ids)


# ---------------------------------------------------------------------------
# 미인증 유저 시나리오 (60%)
# ---------------------------------------------------------------------------


class AnonymousTasks(TaskSet):
    """공개 API만 호출하는 미인증 유저 시나리오."""

    def on_start(self) -> None:
        SharedState.fetch_event_ids(self.client)

    @task(5)
    def list_events(self) -> None:
        """GET /api/v1/events/ -- 이벤트 목록."""
        skip = random.choice([0, 20, 40])
        with self.client.get(
            f"{API_PREFIX}/events/",
            params={"skip": skip, "limit": 20},
            name="GET /events/ (list)",
            catch_response=True,
        ) as resp:
            if resp.status_code != 200:
                resp.failure(f"status={resp.status_code}")

    @task(3)
    def event_detail(self) -> None:
        """GET /api/v1/events/{id} -- 이벤트 상세."""
        eid = SharedState.random_event_id()
        if not eid:
            return
        with self.client.get(
            f"{API_PREFIX}/events/{eid}",
            name="GET /events/{id} (detail)",
            catch_response=True,
        ) as resp:
            if resp.status_code not in (200, 404):
                resp.failure(f"status={resp.status_code}")

    @task(2)
    def event_categories(self) -> None:
        """GET /api/v1/events/categories -- 카테고리 목록."""
        with self.client.get(
            f"{API_PREFIX}/events/categories",
            name="GET /events/categories",
            catch_response=True,
        ) as resp:
            if resp.status_code != 200:
                resp.failure(f"status={resp.status_code}")

    @task(2)
    def search_events(self) -> None:
        """GET /api/v1/events/search?q=... -- 이벤트 검색."""
        queries = ["콘서트", "뮤지컬", "스포츠", "축제", "전시", "클래식"]
        q = random.choice(queries)
        with self.client.get(
            f"{API_PREFIX}/events/search",
            params={"q": q, "limit": 10},
            name="GET /events/search",
            catch_response=True,
        ) as resp:
            if resp.status_code != 200:
                resp.failure(f"status={resp.status_code}")

    @task(2)
    def featured_events(self) -> None:
        """GET /api/v1/events/featured -- 추천 이벤트."""
        with self.client.get(
            f"{API_PREFIX}/events/featured",
            name="GET /events/featured",
            catch_response=True,
        ) as resp:
            if resp.status_code != 200:
                resp.failure(f"status={resp.status_code}")

    @task(2)
    def trending_events(self) -> None:
        """GET /api/v1/events/trending -- 인기 이벤트."""
        with self.client.get(
            f"{API_PREFIX}/events/trending",
            name="GET /events/trending",
            catch_response=True,
        ) as resp:
            if resp.status_code != 200:
                resp.failure(f"status={resp.status_code}")

    @task(1)
    def event_ranking(self) -> None:
        """GET /api/v1/events/ranking -- 랭킹."""
        with self.client.get(
            f"{API_PREFIX}/events/ranking",
            params={"period": "realtime"},
            name="GET /events/ranking",
            catch_response=True,
        ) as resp:
            if resp.status_code != 200:
                resp.failure(f"status={resp.status_code}")

    @task(1)
    def opening_soon(self) -> None:
        """GET /api/v1/events/opening-soon -- 오픈 예정."""
        with self.client.get(
            f"{API_PREFIX}/events/opening-soon",
            name="GET /events/opening-soon",
            catch_response=True,
        ) as resp:
            if resp.status_code != 200:
                resp.failure(f"status={resp.status_code}")

    @task(1)
    def event_transparency(self) -> None:
        """GET /api/v1/events/{id}/transparency -- 투명성 보고서."""
        eid = SharedState.random_event_id()
        if not eid:
            return
        with self.client.get(
            f"{API_PREFIX}/events/{eid}/transparency",
            name="GET /events/{id}/transparency",
            catch_response=True,
        ) as resp:
            # 404도 허용 (이벤트에 보고서가 없을 수 있음)
            if resp.status_code not in (200, 404):
                resp.failure(f"status={resp.status_code}")

    @task(1)
    def event_similar(self) -> None:
        """GET /api/v1/events/{id}/similar -- 유사 이벤트."""
        eid = SharedState.random_event_id()
        if not eid:
            return
        with self.client.get(
            f"{API_PREFIX}/events/{eid}/similar",
            name="GET /events/{id}/similar",
            catch_response=True,
        ) as resp:
            if resp.status_code not in (200, 404):
                resp.failure(f"status={resp.status_code}")

    @task(1)
    def record_view(self) -> None:
        """POST /api/v1/events/{id}/view -- 조회수 기록."""
        eid = SharedState.random_event_id()
        if not eid:
            return
        with self.client.post(
            f"{API_PREFIX}/events/{eid}/view",
            name="POST /events/{id}/view",
            catch_response=True,
        ) as resp:
            if resp.status_code not in (200, 404):
                resp.failure(f"status={resp.status_code}")


# ---------------------------------------------------------------------------
# 인증 유저 시나리오 (40%)
# ---------------------------------------------------------------------------


class AuthenticatedTasks(TaskSet):
    """로그인 후 인증 API를 호출하는 유저 시나리오."""

    token: str | None = None
    user_num: int = 0

    def on_start(self) -> None:
        """랜덤 testuser로 로그인하여 Bearer 토큰을 저장한다."""
        # 로그인 요청을 분산하여 rate limiter 충돌 방지
        gevent.sleep(random.uniform(0, 30))
        SharedState.fetch_event_ids(self.client)
        self.user_num = random.randint(1, TEST_USER_COUNT)
        email = TEST_USER_EMAIL_FMT.format(num=self.user_num)

        try:
            resp = self.client.post(
                f"{API_PREFIX}/auth/login",
                json={"email": email, "password": TEST_USER_PASSWORD},
                name="POST /auth/login",
                timeout=10,
            )
            if resp.status_code == 200:
                data = resp.json()
                self.token = data.get("access_token")
                if self.token:
                    logger.debug("로그인 성공: %s", email)
                else:
                    logger.warning("로그인 응답에 access_token 없음: %s", email)
            else:
                logger.warning(
                    "로그인 실패 (%s): status=%d body=%s",
                    email,
                    resp.status_code,
                    resp.text[:200],
                )
        except Exception as exc:
            logger.warning("로그인 예외 (%s): %s", email, exc)

    def _auth_headers(self) -> dict[str, str]:
        if self.token:
            return {"Authorization": f"Bearer {self.token}"}
        return {}

    def _auth_get(self, path: str, name: str, **kwargs) -> None:
        """인증 헤더가 포함된 GET 요청. 토큰 없으면 스킵."""
        if not self.token:
            return
        with self.client.get(
            path,
            headers=self._auth_headers(),
            name=name,
            catch_response=True,
            **kwargs,
        ) as resp:
            if resp.status_code == 401:
                resp.failure("Unauthorized (토큰 만료?)")
            elif resp.status_code not in (200, 201, 404):
                resp.failure(f"status={resp.status_code}")

    # ── 프로필 ────────────────────────────────────────────────

    @task(3)
    def get_profile(self) -> None:
        """GET /api/v1/users/me -- 프로필 조회."""
        self._auth_get(f"{API_PREFIX}/users/me", "GET /users/me")

    # ── 즐겨찾기 ──────────────────────────────────────────────

    @task(2)
    def list_favorites(self) -> None:
        """GET /api/v1/events/favorites -- 즐겨찾기 목록."""
        self._auth_get(f"{API_PREFIX}/events/favorites", "GET /events/favorites")

    # ── 주문 ──────────────────────────────────────────────────

    @task(3)
    def my_orders(self) -> None:
        """GET /api/v1/orders/my -- 내 주문 목록."""
        self._auth_get(f"{API_PREFIX}/orders/my", "GET /orders/my")

    # ── 알림 ──────────────────────────────────────────────────

    @task(2)
    def notifications(self) -> None:
        """GET /api/v1/notifications/ -- 알림 목록."""
        self._auth_get(f"{API_PREFIX}/notifications/", "GET /notifications/")

    @task(1)
    def unread_count(self) -> None:
        """GET /api/v1/notifications/unread-count -- 미읽은 알림 수."""
        self._auth_get(
            f"{API_PREFIX}/notifications/unread-count",
            "GET /notifications/unread-count",
        )

    # ── 좋아요 토글 ──────────────────────────────────────────

    @task(1)
    def toggle_favorite(self) -> None:
        """POST /api/v1/events/{id}/favorite -- 좋아요 토글."""
        if not self.token:
            return
        eid = SharedState.random_event_id()
        if not eid:
            return
        with self.client.post(
            f"{API_PREFIX}/events/{eid}/favorite",
            headers=self._auth_headers(),
            name="POST /events/{id}/favorite",
            catch_response=True,
        ) as resp:
            if resp.status_code not in (200, 201, 404):
                resp.failure(f"status={resp.status_code}")

    # ── 추천 이벤트 (인증 필요) ──────────────────────────────

    @task(1)
    def recommended_events(self) -> None:
        """GET /api/v1/events/recommended -- 개인화 추천."""
        self._auth_get(f"{API_PREFIX}/events/recommended", "GET /events/recommended")

    # ── 공개 API도 섞어서 호출 ────────────────────────────────

    @task(3)
    def browse_events(self) -> None:
        """GET /api/v1/events/ -- 인증 유저도 이벤트 목록 조회."""
        with self.client.get(
            f"{API_PREFIX}/events/",
            params={"skip": 0, "limit": 20},
            name="GET /events/ (list)",
            catch_response=True,
        ) as resp:
            if resp.status_code != 200:
                resp.failure(f"status={resp.status_code}")

    @task(2)
    def browse_detail(self) -> None:
        """GET /api/v1/events/{id} -- 인증 유저도 이벤트 상세 조회."""
        eid = SharedState.random_event_id()
        if not eid:
            return
        with self.client.get(
            f"{API_PREFIX}/events/{eid}",
            name="GET /events/{id} (detail)",
            catch_response=True,
        ) as resp:
            if resp.status_code not in (200, 404):
                resp.failure(f"status={resp.status_code}")

    # ── 결제 시나리오 (전체 인증 유저 중 ~5% 비율) ───────────

    @task(1)
    def attempt_order_receipt(self) -> None:
        """GET /api/v1/orders/my/refunds -- 환불 내역 조회 (성능 측정용).

        실제 주문 생성은 부작용이 크므로, 읽기 위주로 결제 관련 엔드포인트를 측정.
        """
        self._auth_get(f"{API_PREFIX}/orders/my/refunds", "GET /orders/my/refunds")


# ---------------------------------------------------------------------------
# 유저 클래스 정의
# ---------------------------------------------------------------------------


class AnonymousUser(HttpUser):
    """미인증 유저 (60% 비중)."""

    tasks = [AnonymousTasks]
    wait_time = between(1, 3)
    weight = 6  # 60%


class AuthenticatedUser(HttpUser):
    """인증 유저 (40% 비중)."""

    tasks = [AuthenticatedTasks]
    wait_time = between(1, 3)
    weight = 4  # 40%


# ---------------------------------------------------------------------------
# 이벤트 훅: 테스트 시작/종료 시 요약 출력
# ---------------------------------------------------------------------------


@events.test_start.add_listener
def on_test_start(environment, **kwargs):
    logger.info("=" * 60)
    logger.info("Pickket 부하 테스트 시작")
    logger.info("  Target: %s", environment.host)
    logger.info(
        "  Users : %s",
        environment.parsed_options.num_users if environment.parsed_options else "N/A",
    )
    logger.info("=" * 60)


@events.test_stop.add_listener
def on_test_stop(environment, **kwargs):
    logger.info("=" * 60)
    logger.info("Pickket 부하 테스트 종료")
    stats = environment.stats
    logger.info("  총 요청 수   : %d", stats.total.num_requests)
    logger.info("  총 실패 수   : %d", stats.total.num_failures)
    fail_ratio = (
        stats.total.num_failures / stats.total.num_requests * 100
        if stats.total.num_requests > 0
        else 0
    )
    logger.info("  실패율       : %.2f%%", fail_ratio)
    logger.info("  평균 응답시간: %.0fms", stats.total.avg_response_time)
    logger.info("  중위 응답시간: %dms", stats.total.median_response_time or 0)
    logger.info("  95%% 응답시간: %dms", stats.total.get_response_time_percentile(0.95) or 0)
    logger.info("  99%% 응답시간: %dms", stats.total.get_response_time_percentile(0.99) or 0)
    logger.info("  RPS          : %.1f", stats.total.total_rps)
    logger.info("=" * 60)
