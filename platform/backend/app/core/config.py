from pydantic import field_validator, model_validator
from pydantic_settings import BaseSettings


class Settings(BaseSettings):
    PROJECT_NAME: str = "Pickket"
    VERSION: str = "0.1.0"
    API_V1_PREFIX: str = "/api/v1"

    # Database
    DATABASE_URL: str = "postgresql+asyncpg://user:pass@localhost:5432/dev"
    DATABASE_URL_SYNC: str = "postgresql://user:pass@localhost:5432/dev"
    DATABASE_READ_URL: str = ""
    # 10K VU load-test 기준 (2026-04-06 튜닝):
    # pool_size=10, max_overflow=15 → per worker write(10+15)=25, read(10+10)=20
    # 10 tasks × 5 workers × 45 = 2,250 max (RDS Proxy가 멀티플렉싱)
    # Aurora Serverless v2 max 8 ACU → ~2,500 max_connections (여유 확보)
    # pool_recycle 600s: idle 커넥션 빠른 회수로 커넥션 누적 방지
    DB_POOL_SIZE: int = 10
    DB_MAX_OVERFLOW: int = 15
    DB_READ_POOL_SIZE: int = 10
    DB_READ_MAX_OVERFLOW: int = 10
    DB_SYNC_POOL_SIZE: int = 2
    DB_SYNC_MAX_OVERFLOW: int = 5
    DB_POOL_RECYCLE_SECONDS: int = 600
    DB_POOL_TIMEOUT_SECONDS: int = 30
    DB_POOL_USE_LIFO: bool = True
    DB_CONNECT_TIMEOUT_SECONDS: int = 10
    DB_STATEMENT_TIMEOUT_MS: int = 12000
    DB_LOCK_TIMEOUT_MS: int = 5000
    DB_IDLE_IN_TXN_TIMEOUT_MS: int = 10000
    DB_APPLICATION_NAME: str = "pickket-backend"
    # PgBouncer transaction-mode: disable prepared statements
    DB_PGBOUNCER_MODE: bool = False
    DB_REQUIRE_SSL: bool = False
    DB_SSL_ROOT_CERT: str = ""

    # Redis
    REDIS_URL: str = "redis://localhost:6379/0"
    REDIS_CLUSTER_MODE: bool = False
    REDIS_CLUSTER_NODES: str = ""  # comma-separated host:port pairs
    REDIS_TLS_INSECURE_SKIP_VERIFY: bool = False
    REDIS_TLS_CA_CERT_PATH: str = ""

    # TOTP SafeTix (feature flag — enable after TOTP seed migration)
    TOTP_ENABLED: bool = False
    TOTP_ENCRYPTION_KEY: str = ""  # Fernet key for TOTP seed encryption
    PII_ENCRYPTION_KEY: str = ""  # Fernet key for phone/date_of_birth encryption
    PII_ENCRYPTION_KEY_PREVIOUS: str = ""  # 이전 Fernet key (키 로테이션 시 복호화 폴백)
    # GDPR / PIPA grace window between account-deletion request and
    # permanent anonymization. Used by gdpr_service + Celery cleanup task.
    PII_RETENTION_DAYS: int = 30

    # Celery
    CELERY_BROKER_URL: str = "redis://localhost:6379/0"
    CELERY_RESULT_BACKEND: str = "redis://localhost:6379/1"

    # JWT
    SECRET_KEY: str
    # AUDIT 2026-04-20 §25 P0: SECRET_KEY 공유 폭발 반경 축소.
    # JWT/QR/RESET 서명 도메인을 분리한다. 각 필드 미설정 시 SECRET_KEY로 폴백하여
    # 기존 배포와의 호환성을 유지하되, production 환경에서는 distinct 값을 강제한다.
    JWT_SECRET: str = ""  # access/refresh JWT 서명 전용
    QR_HMAC_SECRET: str = ""  # 티켓 TOTP QR HMAC 전용
    RESET_TOKEN_SECRET: str = ""  # 비밀번호 리셋 토큰 전용
    ALGORITHM: str = "HS256"
    ACCESS_TOKEN_EXPIRE_MINUTES: int = 5
    REFRESH_TOKEN_EXPIRE_DAYS: int = 7
    JWT_ISSUER: str = "pickket-api"
    JWT_AUDIENCE: str = "pickket-clients"
    JWT_LEEWAY_SECONDS: int = 5

    # Admin MFA (TOTP)
    ADMIN_MFA_REQUIRED: bool = False  # 프로덕션 .env에서 True 설정 (개발/테스트: False)
    ADMIN_SESSION_TIMEOUT_MINUTES: int = 30  # 관리자 비활동 세션 타임아웃

    # Auth cookies
    ACCESS_COOKIE_NAME: str = "pickket_access"
    REFRESH_COOKIE_NAME: str = "pickket_refresh"
    REFRESH_COOKIE_SECURE: bool = False  # production: true
    REFRESH_COOKIE_SAMESITE: str = "lax"  # ADR-006 (개정 2026-04-09): Lax + Origin/Referer 화이트리스트 + Content-Type JSON 강제 (이메일/알림톡 링크 UX 보존)
    REFRESH_COOKIE_PATH: str = "/"
    REFRESH_COOKIE_DOMAIN: str = ""

    # Check-in security
    CHECKIN_QR_MAX_AGE_SECONDS: int = 5
    CHECKIN_REPLAY_TTL_SECONDS: int = 30
    CHECKIN_REQUIRE_QR: bool = True

    # Engine
    DEFAULT_BATCH_WINDOW_HOURS: int = 48
    MAX_BID_QUANTITY: int = 4
    # Payment
    # 신규 주문의 기본 PG. 기존 주문은 orders.pg_provider 로 라우팅되므로 소급 영향 없다(G6).
    # 🔴 기본값 "toss" → "nicepay" (2026-07-28 대표 결정: 구형/정규 나이스로만 간다).
    #    prod 3개 앱 어디에도 PAYMENT_PROVIDER env 가 없어서, 기본값이 그대로 실동작 값이었다.
    PAYMENT_PROVIDER: str = "nicepay"  # "nicepay" | "toss"(dormant) | "portone"(레거시)
    PAYMENT_DEFAULT_CURRENCY: str = "KRW"
    PAYMENT_EXPIRY_MINUTES: int = 15
    POINT_EARN_RATE_PURCHASE: float = 0.01  # 구매 확정 시 결제액 대비 AP 적립률 (WP07, MASTER N2)
    # Phase별 결제 기한 (float 허용: 테스트 모드에서 분 단위 단축 가능, 예: 0.033 = 2min)
    # go 가 phase-transition webhook payload.config 로 보내는 값이 우선, env 는 fallback.
    LOTTERY_PAYMENT_HOURS: float = 72.0
    WAITLIST_PROMOTION_PAYMENT_HOURS: float = 24.0
    PAYMENT_SUCCESS_URL: str = "http://localhost:3000/payment/success"
    PAYMENT_FAIL_URL: str = "http://localhost:3000/payment/fail"
    PAYMENT_WEBHOOK_WINDOW_SECONDS: int = 300
    PAYMENT_MANUAL_API_ENABLED: bool = True
    PURCHASE_LOCK_TTL_SECONDS: int = 60
    PLATFORM_FEE_RATE: float = 0.05

    # PortOne
    PORTONE_API_BASE_URL: str = "https://api.portone.io"
    PORTONE_API_SECRET: str = ""
    PORTONE_STORE_ID: str = ""
    PORTONE_CHANNEL_KEY: str = ""
    PORTONE_WEBHOOK_SECRET: str = ""
    PORTONE_MOCK_MODE: bool = True
    PORTONE_WEBHOOK_REQUIRE_TIMESTAMP: bool = True
    WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS: int = 60  # 1-min replay window
    PORTONE_WEBHOOK_IPS: str = ""  # Comma-separated IP allowlist, e.g. "52.78.5.241,52.78.100.19"

    # TossPayments (PAYMENT_PROVIDER="toss")
    TOSS_API_BASE_URL: str = "https://api.tosspayments.com/v1"
    TOSS_SECRET_KEY: str = ""  # live_sk_* / test_sk_* (서버 전용). 미설정 시 mock.
    TOSS_MOCK_MODE: bool = True  # 실 PG 미연동(개발/테스트). 프로덕션 필수 false.
    TOSS_WEBHOOK_ALLOWED_IPS: str = ""  # 선택 IP 허용목록. 토스 웹훅은 HMAC 없음 → 조회 재검증.

    # NICEPAY 구형/정규 API (PAYMENT_PROVIDER="nicepay")
    # 정본 스펙: docs/payments/NICEPAY-LEGACY-VERIFIED-SPEC.md (MID/MerchantKey·EUC-KR·SHA256).
    # ⚠️ MerchantKey 는 v2(서버)에만. 결제창엔 MID 만 노출된다(clientKey/secretKey 폐기).
    # NICEPAY_API_BASE_URL 은 취소/조회/채번 호스트(webapi.nicepay.co.kr)의 SSRF 검증 앵커로만
    # 사용된다 — 승인은 인증응답 NextAppURL(dc1/dc2) 로 매번 수신·재검증(게이트웨이 내부).
    NICEPAY_API_BASE_URL: str = "https://webapi.nicepay.co.kr"  # SSRF 검증 앵커(webapi 계열).
    NICE_MID: str = ""  # 나이스 상점 MID. 결제창·서명·전문 공통. 미설정 시 mock.
    NICE_MERCHANT_KEY: str = ""  # 서버 전용(SignData 계산). 미설정 시 mock. 절대 노출 금지.
    NICEPAY_MOCK_MODE: bool = True  # 실 PG 미연동(개발/테스트). 프로덕션 필수 false.
    # 🔴 부분취소(PartialCancelCode=1) 허용 여부. **기본 False = 차단**.
    #
    # 나이스 구형은 부분취소 시 **원거래와 다른 새 TID** 를 응답한다
    # (`[NICEPAY] 결제취소-1.0.2.pdf` §8.1 "부분취소/환불의 경우 … 새로운 TID 가 생성",
    #  §12.1.1 "결과 TID가 원거래 TID와 다른 거래 아이디로 생성").
    # 그런데 `nicepay_gateway.void_authorization` 은 응답 TID 가 요청 TID 와 **같아야만**
    # 통과하고, 응답 서명도 **요청 TID 로** 계산한다(이중 결함).
    #
    # 그 예외는 나이스 취소가 **이미 성립한 뒤**에 터진다 ⟹ 고객 돈은 환불됐는데
    # 원장은 미환불·티켓은 살아 있음. 재시도하면 "기취소" 로 계속 실패한다. **복구 불가.**
    #
    # 그래서 전문을 보내기 **전에** 막는다(네트워크 호출 0). 되돌릴 수 없는 사고가
    # 눈에 보이는 거절로 바뀐다. 정식 수정(응답 TID 수용 + 응답 TID 로 서명 검증) 후
    # 이 값을 true 로 열어 원복한다.
    NICEPAY_ALLOW_PARTIAL_CANCEL: bool = False
    # 나이스가 인증결과를 form POST 할 v2 return 엔드포인트(절대 URL).
    # 구형 결제창 payForm 의 ReturnURL 은 **consumer 성공페이지가 아니라 v2 return**
    # 이어야 나이스→v2 승인 흐름이 성립한다(예: https://api.pickket.kr/api/v1/payments/nice/return).
    # consumer 성공페이지 착지는 MallReserved(=success_url)에 실어 v2 return 핸들러가
    # 승인 후 화이트리스트 302 redirect 한다. 미설정("")이면 dev 폴백으로 success_url 사용.
    # 프로덕션(nicepay)에선 validate_secrets 가 필수로 강제한다.
    NICEPAY_RETURN_URL: str = ""
    # 웹훅 인바운드 IP 화이트리스트.
    # 🔴 2026-07-31 정정: 종전 기본값 121.133.126.86/.87 은 **공식 문서 어디에도 없는 IP**
    #    였다(사내 나이스 PDF 15종 전수 grep 0건). 공식 결제데이터통보 송신 IP 는
    #    `[NICEPAY] 결제통보-1.3.4.pdf` §2.1 방화벽 설정표의 아래 3개다.
    #    안 맞으면 403(payment_webhook) 이고 나이스는 재전송 후 관리자 메일로 실패 통지한다.
    #    ⚠️ 이 값은 기동 가드(validate_secrets) **밖**이라 틀려도 기동 실패로 안 잡힌다.
    NICEPAY_WEBHOOK_ALLOWED_IPS: str = "121.133.126.10,121.133.126.11,211.33.136.39"
    # returnUrl 후 302 redirect 목적지(mallReserved origin 별 화이트리스트, open-redirect 차단).
    #   go(organizer): 이벤트-비의존 go 랜딩 라우트(orderId 로 이벤트 해석) — Phase 2b 신설.
    #   consumer: 위 PAYMENT_SUCCESS_URL / PAYMENT_FAIL_URL 재사용.
    #   미지(unknown) origin: consumer(안전기본) fail 로.
    # ⚠️ mallReserved 는 사용자 경유 값이지만 redirect 는 **config 매핑 URL 로만** — 사용자 입력
    #    URL 을 그대로 redirect 하지 않는다(G1/open-redirect 방어).
    # 미설정("") 이면 go redirect 도 consumer 기본(PAYMENT_SUCCESS_URL/FAIL_URL)으로 폴백한다
    # (consumer 전용 배포·전환기 하위호환). go 결제창 배포 시 실제 go 랜딩 URL 주입.
    NICEPAY_GO_SUCCESS_URL: str = ""
    NICEPAY_GO_FAIL_URL: str = ""

    # Inter-service webhook (v2 ↔ go) — ADR-010, WEBHOOK_STANDARD
    GO_WEBHOOK_SECRET: str = ""  # HMAC-SHA256 secret, shared with go (AWS SM: pickket-{env}/go-webhook-secret)
    # S-1 무중단 로테이션: 이전 GO_WEBHOOK_SECRET (서명 검증 폴백 전용, pii.py PREVIOUS 패턴).
    # 키 교체 시 신 키로 flip 후에도 구 키 서명 요청을 검증 통과시켜 go↔v2 동시 flip 불필요.
    GO_WEBHOOK_SECRET_PREVIOUS: str = ""
    # S-1 보안경계: 내부 서비스 토큰(읽기/통계 GET 인증) — **반드시 GO_WEBHOOK_SECRET 과 다른 값**.
    # 이전엔 토큰==서명시크릿(GO_WEBHOOK_SECRET)이라 평문 헤더 전송 시 HMAC 시크릿이 함께 유출됐다.
    # 미설정(전환기)이면 GO_WEBHOOK_SECRET 으로 폴백하나, production 검증에서 분리를 강제한다.
    INTERNAL_SERVICE_TOKEN: str = ""
    GO_INTERNAL_BASE_URL: str = ""  # e.g. https://go.pickket.kr (outbound v2→go webhooks target)
    GO_WEBHOOK_TIMEOUT_SECONDS: float = 5.0  # HTTP timeout for outbound v2→go calls
    STRICT_WEBHOOK_HEADERS: bool = False  # False = 완화 모드 (2종 헤더도 수락, 경고 로그). True = 4종 필수
    WEBHOOK_REPLAY_TTL_SECONDS: int = 604800  # 7 days — delivery_id dedup window
    # /internal/* 커머스 write 인증: False=추가형(서명 OR 토큰 수락, 전환기), True=HMAC 서명 필수.
    # 컷오버 윈도우에 go 가 서명 배포 완료 후 True 로 flip(1세션 통보).
    INTERNAL_COMMERCE_REQUIRE_HMAC: bool = False
    # 테스트 인증 우회: True(dev/test only) + 헤더 X-Pickket-Test-Bypass:1 → 로그인 레이트리밋
    # + 계정잠금 스킵(비밀번호 검증은 유지). **prod 절대 False**(기본 False) → 헤더 무시(보안영향 0).
    # 통합 E2E(Playwright)가 v2 계정잠금에 막히는 문제 해소(go PLAYWRIGHT_TEST 우회와 대칭).
    AUTH_TEST_BYPASS_ENABLED: bool = False

    # Stripe (international payments)
    STRIPE_SECRET_KEY: str = ""
    STRIPE_PUBLISHABLE_KEY: str = ""
    STRIPE_WEBHOOK_SECRET: str = ""

    # Identity verification
    IDENTITY_PROVIDER: str = "stub"  # "pass" | "portone" | "none" | "stub"

    # Domain-related settings (prefer these over hardcoded values)
    CDN_BASE_URL: str = "https://cdn.pickket.kr"
    EMAIL_FROM_ADDRESS: str = "support@pickket.kr"
    WITHDRAWN_EMAIL_DOMAIN: str = "withdrawn.pickket.kr"
    OAUTH_FALLBACK_DOMAIN: str = "oauth.pickket.kr"

    # SNS Topic ARNs (Event Bus)
    SNS_ORDER_TOPIC_ARN: str = ""
    SNS_PAYMENT_TOPIC_ARN: str = ""
    SNS_TICKET_TOPIC_ARN: str = ""
    SNS_SEAT_TOPIC_ARN: str = ""
    SNS_QUEUE_TOPIC_ARN: str = ""
    AWS_REGION: str = "ap-northeast-2"

    # SQS Queue URLs
    SQS_ORDER_PROCESSING_URL: str = ""
    SQS_PAYMENT_PROCESSING_URL: str = ""
    SQS_SEAT_SYNC_URL: str = ""
    SQS_TICKET_NOTIFICATIONS_URL: str = ""

    # Email
    EMAIL_PROVIDER: str = "stub"  # "ses" | "sendgrid" | "stub"
    AWS_SES_REGION: str = "ap-northeast-2"
    AWS_SES_FROM: str = "support@pickket.kr"  # legacy — prefer EMAIL_FROM_ADDRESS
    SENDGRID_API_KEY: str = ""
    SENDGRID_FROM: str = "support@pickket.kr"  # legacy — prefer EMAIL_FROM_ADDRESS
    # 게스트 매직링크가 가리킬 consumer(소비자) 앱 base URL. 재방문 링크는
    # {CONSUMER_URL}/ko/guests/orders/{order_id}?token=<raw> 형식. prod 는 https://www.pickket.kr.
    CONSUMER_URL: str = "http://localhost:3020"

    # File uploads (S3-compatible)
    UPLOAD_PROVIDER: str = "stub"  # "s3" | "stub"
    S3_BUCKET: str = ""
    S3_REGION: str = "ap-northeast-2"
    S3_ACCESS_KEY: str = ""
    S3_SECRET_KEY: str = ""
    S3_ENDPOINT_URL: str = ""  # For R2/MinIO
    S3_PUBLIC_URL: str = ""  # CDN URL

    # SMS
    SMS_PROVIDER: str = "stub"  # "ncp" | "twilio" | "none" | "stub"
    NCP_SMS_SERVICE_ID: str = ""
    NCP_SMS_ACCESS_KEY: str = ""
    NCP_SMS_SECRET_KEY: str = ""
    NCP_SMS_FROM_NUMBER: str = ""
    TWILIO_ACCOUNT_SID: str = ""
    TWILIO_AUTH_TOKEN: str = ""
    TWILIO_FROM_NUMBER: str = ""

    # OAuth2 Social Login
    KAKAO_CLIENT_ID: str = ""
    KAKAO_CLIENT_SECRET: str = ""
    GOOGLE_CLIENT_ID: str = ""
    GOOGLE_CLIENT_SECRET: str = ""
    NAVER_CLIENT_ID: str = ""
    NAVER_CLIENT_SECRET: str = ""
    OAUTH_REDIRECT_BASE_URL: str = "http://localhost:3020"

    # Resale
    RESALE_DEFAULT_MAX_MARKUP_PCT: float = 0.0
    RESALE_PLATFORM_FEE_RATE: float = 0.10  # 차익의 10%
    RESALE_ARTIST_ROYALTY_RATE: float = 0.50  # 차익의 50%
    RESALE_SELLER_PREMIUM_RATE: float = 0.40  # 차익의 40%
    RESALE_ZERO_FEE_BELOW_FACE: bool = True
    RESALE_ABSOLUTE_PRICE_CEILING: float = 1_000_000
    RESALE_MAX_BUY_ORDERS_PER_USER_EVENT: int = 4

    # Bot detection
    BOT_DETECTION_KEY: str = ""

    # Chatbot (P1-4: 2-Tier chatbot)
    CHATBOT_LLM_API_URL: str = ""  # 비어있으면 Tier 0(FAQ)만 동작
    CHATBOT_LLM_API_KEY: str = ""
    CHATBOT_LLM_MODEL: str = "gpt-4o-mini"
    CHATBOT_MAX_TOKENS: int = 2000
    # 대화 이력 Redis TTL(초). 멀티워커 안전·세션 바인딩 저장소의 만료 시간.
    CHATBOT_CONVERSATION_TTL: int = 3600

    # Billing key encryption
    BILLING_KEY_ENCRYPTION_KEY: str = ""  # Fernet key for encrypting billing keys at rest
    BILLING_KEY_ENCRYPTION_KEY_PREVIOUS: str = ""  # 이전 Fernet key (키 로테이션 시 복호화 폴백)

    # AI Agent Delegation (P2-1)
    DELEGATION_TOKEN_MAX_LIFETIME_DAYS: int = 30

    # Kill switches
    RESALE_ENABLED: bool = False  # 1차 런칭 제외 (v2 이후 활성화)
    FANCLUB_PRESALE_ENABLED: bool = True
    QUEUE_ENABLED: bool = True
    FEATURE_FACE_VALUE_WAITLIST: bool = False  # P3 액면가 대기 — 약관 확정 후 활성화
    NEW_PAYMENT_FLOW_ENABLED: bool = True
    ASYNC_PURCHASE_ENABLED: bool = False  # 비동기 구매 큐 (Celery 워커 처리)
    # T1-2(F1): go fcfs 판매단계 close → v2 event.status=BIDDING_CLOSED 전파.
    # 기본 OFF — 배포 시 dormant(현행 무전이 유지), 관제 관측 후 flag ON 으로 활성.
    PHASE_TRANSITION_FCFS_CLOSED: bool = False
    # 레벨2 영역C: 조직자 메시징 SoT 를 v2 로 전환하는 원자 스위치.
    #   False(기본) = go 가 트랜잭션 알림·조직자 인앱 알림 소유(현행 무변, v2 트리거 dormant).
    #   True        = v2 internal_commerce 판정지점이 직접 dispatch/OrganizerNotification 생성.
    # ⚠️ 이중발송 방지: 이 flag ON 과 go 크론/트리거 OFF 는 **동시 원자 전환**(컷오버)이어야 한다.
    #    go 코드 제거 전까지 둘 중 하나만 켠다(둘 다 켜면 이중발송, 둘 다 끄면 무발송).
    ORGANIZER_MESSAGING_V2_ENABLED: bool = False

    # ── 조직자 메시징 provider (NCP) — W5-PROVIDER ────────────────────────────
    # env 이름은 go organizer 와 **동일**하다(같은 NCP 자격증명·발신설정을 공유하므로
    # CapRover 에 이미 세팅된 값을 그대로 쓴다). 값은 코드/로그/픽스처에 절대 남기지 않는다.
    #   "disabled"(기본) = 항상 스텁. **키를 넣어도 발송되지 않는다.**
    #   "auto"           = 인증키가 있으면 실발송, 없으면 미배선 스텁(명시적 실패).
    #   "ncp"            = 실발송 강제(키 없으면 error 로그 + 스텁 → 발송 failed 로 표면화).
    # 🔴 기본이 disabled 인 이유: 이 값이 "auto" 면 **NCP 키를 env 에 넣는 행위 자체가
    #    실발송 개시**가 된다(리마인더 beat 가 매일 00:00 KST 무조건 발화 → 대상 전원에게
    #    과금 발송). 키 주입(준비)과 발송 개시(결정)는 분리한다 — 개시는 이 값의 flip 이다.
    ORGANIZER_MESSAGING_PROVIDER: str = "disabled"
    NCP_ACCESS_KEY: str = ""  # NCP IAM 서브계정 인증키(공통)
    NCP_SECRET_KEY: str = ""  # NCP IAM 서브계정 비밀키(공통)
    SENS_ALIMTALK_SERVICE_ID: str = ""  # SENS 알림톡 서비스 ID
    SENS_ALIMTALK_CHANNEL_ID: str = ""  # 카카오 채널(@채널 = plusFriendId)
    SENS_SMS_SERVICE_ID: str = ""  # SENS SMS 서비스 ID
    SENS_SMS_FROM: str = ""  # 콘솔 등록 발신번호
    MAILER_SENDER_ADDRESS: str = ""  # 도메인 인증 완료된 발신주소
    MAILER_SENDER_NAME: str = "PICKKET"
    # sandbox/리허설용 host 오버라이드 — 운영은 공식 host 기본값 유지.
    NCP_SENS_HOST: str = "https://sens.apigw.ntruss.com"
    NCP_MAILER_HOST: str = "https://mail.apigw.ntruss.com"
    NCP_API_TIMEOUT_MS: int = 10000

    # Queue
    QUEUE_MAX_ACTIVE_USERS: int = 100

    # Networking / proxy trust
    TRUSTED_PROXY_CIDRS: str = "127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12"
    METRICS_ALLOWED_CIDRS: str = "127.0.0.1/32,::1/128,10.0.0.0/8,172.16.0.0/12,192.168.0.0/16"
    OPS_HEALTH_TOKEN: str = ""

    # Web Push (VAPID)
    VAPID_PUBLIC_KEY: str = ""
    VAPID_PRIVATE_KEY: str = ""
    VAPID_CONTACT_EMAIL: str = "support@pickket.kr"

    # SSE
    SSE_KEEPALIVE_SECONDS: int = 30

    # CORS
    CORS_ORIGINS: str = "http://localhost:3000"

    # Security surface controls
    ENABLE_API_DOCS: bool = False
    ENABLE_METRICS_ENDPOINT: bool = False

    # E2E test mode (relaxes rate limits for automated tests)
    E2E_TEST_MODE: bool = False

    # Bcrypt
    BCRYPT_ROUNDS: int = 12  # OWASP 2025 권장 12+

    # Account lockout & CAPTCHA (인터파크 2023 크리덴셜 스터핑 대비)
    ACCOUNT_LOCKOUT_THRESHOLD: int = 5  # 연속 실패 횟수
    ACCOUNT_LOCKOUT_DURATION_MINUTES: int = 15  # 잠금 기간 (지수 백오프)
    CAPTCHA_SECRET_KEY: str = ""  # Cloudflare Turnstile secret
    CAPTCHA_SITE_KEY: str = ""  # Cloudflare Turnstile site key

    # SECRET_KEY rotation (쿠팡 2025 / Ticketmaster 2024 대비)
    SECRET_KEY_PREVIOUS: str = ""  # 이전 키 (로테이션 시 검증 전용)

    # GeoIP anomaly detection (인터파크 2023 대비)
    GEOIP_ENABLED: bool = False
    GEOIP_DB_PATH: str = ""  # MaxMind GeoLite2 DB 경로

    # Settlement health monitoring (위메프/티몬 2024 대비)
    SETTLEMENT_ALERT_THRESHOLD_KRW: int = 10_000_000
    SETTLEMENT_OVERDUE_DAYS: int = 7

    # Backup
    BACKUP_S3_BUCKET: str = ""
    BACKUP_S3_PREFIX: str = "backups/"
    BACKUP_ENCRYPTION_KEY: str = ""
    BACKUP_RETENTION_DAYS: int = 30
    AUDIT_LOG_RETENTION_DAYS: int = 365

    # OpenTelemetry
    OTEL_ENABLED: bool = False
    OTEL_SERVICE_NAME: str = "pickket-api"
    OTEL_EXPORTER_ENDPOINT: str = ""

    # Alerting (Telegram)
    TELEGRAM_BOT_TOKEN: str = ""  # Telegram Bot API 토큰
    TELEGRAM_CHAT_ID: str = ""  # 기본 채팅방 ID (fallback)
    TELEGRAM_CHAT_CRITICAL: str = ""  # critical 알림 채팅방
    TELEGRAM_CHAT_WARNING: str = ""  # warning 알림 채팅방
    TELEGRAM_CHAT_INFO: str = ""  # info 알림 채팅방
    # 레거시 호환 (기존 코드에서 참조하는 경우)
    ALERTING_WEBHOOK_URL: str = ""
    SLACK_ALERT_WEBHOOK_URL: str = ""
    DLQ_ALERT_THRESHOLD: int = 1  # DLQ 메시�� 수가 이 값 이상이면 알림 발송

    # Event Open Orchestrator — 이벤트 오픈 자동 스케일링 + Waiting Room
    ECS_CLUSTER_NAME: str = ""  # e.g. "pickket-stg" or "pickket"
    ECS_SERVICE_NAME: str = ""  # e.g. "pickket-stg-backend"
    ECS_PREWARM_TASK_COUNT: int = 20  # 오픈 전 스케일업 목표
    ECS_NORMAL_MIN_TASKS: int = 2  # 평상시 최소 태스크 수
    ECS_PREWARM_MINUTES_BEFORE: int = 5  # 오픈 몇 분 전 스케일업
    ECS_SCALEDOWN_MINUTES_AFTER: int = 30  # 오픈 후 몇 분 뒤 복원
    CF_API_TOKEN: str = ""  # Cloudflare API token
    CF_ZONE_ID: str = ""  # Cloudflare zone ID (pickket.kr)
    CF_WAITING_ROOM_ID: str = ""  # Waiting Room ID

    # Environment
    ENVIRONMENT: str = "development"
    LOG_LEVEL: str = "INFO"
    SENTRY_DSN: str = ""
    SENTRY_ENVIRONMENT: str = ""
    SENTRY_TRACES_SAMPLE_RATE: float = 0.1

    @field_validator("ENVIRONMENT", mode="before")
    @classmethod
    def normalize_environment(cls, value):
        env = str(value or "development").strip().lower()
        aliases = {
            "prod": "production",
            "live": "production",
            "stage": "staging",
            "stg": "staging",
            "v2": "staging",
            "dev": "development",
            "local": "development",
            "testing": "test",
        }
        return aliases.get(env, env)

    @staticmethod
    def _require_nicepay_base_url_safe(base_url: str) -> None:
        """SSRF(Low#4): 나이스 API base URL 이 https + *.nicepay.co.kr 인지 검증.

        production 에서만 호출한다. secretKey(Basic 인증)가 실려 나가는 승인/취소
        요청이 임의 호스트로 향하지 않도록, scheme=https 이고 host 가
        ``nicepay.co.kr`` 또는 그 서브도메인일 때만 통과시킨다.
        """
        from urllib.parse import urlparse

        parsed = urlparse((base_url or "").strip())
        if parsed.scheme != "https":
            raise ValueError(
                "NICEPAY_API_BASE_URL must use https in production "
                f"(got scheme={parsed.scheme!r})"
            )
        host = (parsed.hostname or "").lower()
        if not (host == "nicepay.co.kr" or host.endswith(".nicepay.co.kr")):
            raise ValueError(
                "NICEPAY_API_BASE_URL host must be nicepay.co.kr (or subdomain) "
                f"in production (got host={host!r}) — SSRF 방지"
            )

    @model_validator(mode="after")
    def validate_secrets(self):
        allowed_jwt_algorithms = {"HS256", "HS384", "HS512"}
        if self.ALGORITHM not in allowed_jwt_algorithms:
            raise ValueError(f"ALGORITHM must be one of {sorted(allowed_jwt_algorithms)}")

        # AUDIT §25 P0: 비프로덕션 환경에서 도메인 시크릿 미설정 시 SECRET_KEY로 폴백.
        # Pydantic post-init 단계에서 수행 (model_validator after).
        _shared_fallback_fields: list[str] = []
        if not self.JWT_SECRET:
            self.JWT_SECRET = self.SECRET_KEY
            _shared_fallback_fields.append("JWT_SECRET")
        if not self.QR_HMAC_SECRET:
            self.QR_HMAC_SECRET = self.SECRET_KEY
            _shared_fallback_fields.append("QR_HMAC_SECRET")
        if not self.RESET_TOKEN_SECRET:
            self.RESET_TOKEN_SECRET = self.SECRET_KEY
            _shared_fallback_fields.append("RESET_TOKEN_SECRET")
        if _shared_fallback_fields and self.ENVIRONMENT not in ("test",):
            import warnings
            warnings.warn(
                f"SECURITY: {', '.join(_shared_fallback_fields)} defaulting to SECRET_KEY. "
                f"Set distinct values for each to reduce blast radius. "
                f"Production will reject shared keys.",
                stacklevel=2,
            )

        if self.DB_POOL_SIZE <= 0:
            raise ValueError("DB_POOL_SIZE must be positive")
        if self.DB_MAX_OVERFLOW < 0:
            raise ValueError("DB_MAX_OVERFLOW must be >= 0")
        if self.DB_READ_POOL_SIZE <= 0:
            raise ValueError("DB_READ_POOL_SIZE must be positive")
        if self.DB_READ_MAX_OVERFLOW < 0:
            raise ValueError("DB_READ_MAX_OVERFLOW must be >= 0")
        if self.DB_POOL_RECYCLE_SECONDS <= 0:
            raise ValueError("DB_POOL_RECYCLE_SECONDS must be positive")
        if self.DB_POOL_TIMEOUT_SECONDS <= 0:
            raise ValueError("DB_POOL_TIMEOUT_SECONDS must be positive")
        if self.DB_CONNECT_TIMEOUT_SECONDS <= 0:
            raise ValueError("DB_CONNECT_TIMEOUT_SECONDS must be positive")
        if self.DB_STATEMENT_TIMEOUT_MS <= 0:
            raise ValueError("DB_STATEMENT_TIMEOUT_MS must be positive")
        if self.DB_LOCK_TIMEOUT_MS <= 0:
            raise ValueError("DB_LOCK_TIMEOUT_MS must be positive")
        if self.DB_IDLE_IN_TXN_TIMEOUT_MS <= 0:
            raise ValueError("DB_IDLE_IN_TXN_TIMEOUT_MS must be positive")
        if self.AUDIT_LOG_RETENTION_DAYS <= 0:
            raise ValueError("AUDIT_LOG_RETENTION_DAYS must be positive")

        if self.CHECKIN_QR_MAX_AGE_SECONDS <= 0:
            raise ValueError("CHECKIN_QR_MAX_AGE_SECONDS must be positive")
        if self.CHECKIN_REPLAY_TTL_SECONDS < self.CHECKIN_QR_MAX_AGE_SECONDS:
            raise ValueError("CHECKIN_REPLAY_TTL_SECONDS must be >= CHECKIN_QR_MAX_AGE_SECONDS")

        if self.ENVIRONMENT == "production":
            if not self.SECRET_KEY or len(self.SECRET_KEY) < 32:
                raise ValueError("SECRET_KEY must be at least 32 characters in production")

            # AUDIT §25 P0: 도메인별 시크릿 분리 강제 (프로덕션에서만).
            # dev/staging 에서는 SECRET_KEY 폴백 허용.
            for field_name in ("JWT_SECRET", "QR_HMAC_SECRET", "RESET_TOKEN_SECRET"):
                value = getattr(self, field_name, "")
                if not value or len(value) < 32:
                    raise ValueError(
                        f"{field_name} must be set and at least 32 characters in production"
                    )
                if value == self.SECRET_KEY:
                    raise ValueError(
                        f"{field_name} must be distinct from SECRET_KEY in production"
                    )
            # 세 도메인 시크릿이 서로 달라야 함
            distinct = {self.JWT_SECRET, self.QR_HMAC_SECRET, self.RESET_TOKEN_SECRET}
            if len(distinct) != 3:
                raise ValueError(
                    "JWT_SECRET, QR_HMAC_SECRET, RESET_TOKEN_SECRET must all be distinct in production"
                )

            if not self.PII_ENCRYPTION_KEY:
                raise ValueError("PII_ENCRYPTION_KEY is required in production")
            # M-1: 빌링키(카드 결제 권한 토큰)는 반드시 암호화 저장 — 미설정 시
            # 평문 폴백이 조용히 일어나지 않도록 기동 자체를 거부한다.
            if not self.BILLING_KEY_ENCRYPTION_KEY:
                raise ValueError("BILLING_KEY_ENCRYPTION_KEY is required in production")
            if self.DATABASE_URL.startswith("postgresql") and not self.DB_REQUIRE_SSL:
                raise ValueError("DB_REQUIRE_SSL must be true in production")
            if self.REDIS_URL.startswith("rediss://") and self.REDIS_TLS_INSECURE_SKIP_VERIFY:
                raise ValueError(
                    "REDIS_TLS_INSECURE_SKIP_VERIFY must be false in production"
                )
            # PG provider 별 프로덕션 검증.
            # SECURITY: raw 비교(``== "nicepay"``)를 쓰면 ``"NICEPAY"``/``" nicepay"``
            # 가 여기(프로덕션 가드)와 팩토리(get_payment_gateway)에서 서로 다르게
            # 판정돼, 가드가 통과시킨 값이 실제로는 다른 게이트웨이로 라우팅될 수 있다.
            # 팩토리와 **동일한 normalize_provider** 로 정규화 후 비교한다.
            from app.services.payment_gateway import normalize_provider
            payment_provider = normalize_provider(self.PAYMENT_PROVIDER)
            if payment_provider == "toss":
                if not self.TOSS_SECRET_KEY:
                    raise ValueError("TOSS_SECRET_KEY is required in production")
                if self.TOSS_MOCK_MODE:
                    raise ValueError("TOSS_MOCK_MODE must be false in production")
            elif payment_provider == "nicepay":
                # G10: nicepay 가 else(PortOne 강제)로 떨어지지 않게 명시 분기.
                # 구형/정규 API — MID/MerchantKey 필수(clientKey/secretKey 폐기).
                if not self.NICE_MERCHANT_KEY:
                    raise ValueError("NICE_MERCHANT_KEY is required in production")
                if not self.NICE_MID:
                    raise ValueError("NICE_MID is required in production")
                if self.NICEPAY_MOCK_MODE:
                    raise ValueError("NICEPAY_MOCK_MODE must be false in production")
                # 구형 결제창 ReturnURL(나이스→v2 인증결과 POST 목적지) 필수.
                # 미설정이면 승인 흐름이 성립하지 않으므로 프로덕션에서 강제한다.
                if not self.NICEPAY_RETURN_URL:
                    raise ValueError("NICEPAY_RETURN_URL is required in production")
                if not self.NICEPAY_RETURN_URL.startswith("https://"):
                    raise ValueError("NICEPAY_RETURN_URL must use https:// in production")
                # go 착지 URL — staging 블록과 동일 근거로 필수(질의 #11).
                # origin=go 를 판정해놓고 consumer 로 보내는 폴백을 제거했으므로,
                # 미설정이면 payment_webhook 이 예외를 던진다. 기동 시점에 막는 게 낫다.
                if not self.NICEPAY_GO_SUCCESS_URL:
                    raise ValueError("NICEPAY_GO_SUCCESS_URL is required in production")
                if not self.NICEPAY_GO_FAIL_URL:
                    raise ValueError("NICEPAY_GO_FAIL_URL is required in production")
                # SSRF(Low#4): 프로덕션에선 나이스 API base 가 https + nicepay.co.kr
                # 도메인이어야 한다. 오염된 env 로 취소/조회/채번 요청이 임의 호스트로
                # 나가면 MerchantKey 파생 SignData·거래정보가 유출·리다이렉트될 수 있다.
                self._require_nicepay_base_url_safe(self.NICEPAY_API_BASE_URL)
            else:
                if not self.PORTONE_API_SECRET:
                    raise ValueError("PORTONE_API_SECRET is required in production")
                if self.PORTONE_MOCK_MODE:
                    raise ValueError("PORTONE_MOCK_MODE must be false in production")
                if not self.PORTONE_WEBHOOK_SECRET:
                    raise ValueError("PORTONE_WEBHOOK_SECRET is required in production")
                if not self.PORTONE_WEBHOOK_REQUIRE_TIMESTAMP:
                    raise ValueError("PORTONE_WEBHOOK_REQUIRE_TIMESTAMP must be true in production")
            if self.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS <= 0 or self.WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS > 600:
                raise ValueError("WEBHOOK_TIMESTAMP_TOLERANCE_SECONDS must be between 1 and 600 in production")
            # S-1: go↔v2 inter-service webhook 시크릿은 production 필수.
            if not self.GO_WEBHOOK_SECRET:
                raise ValueError("GO_WEBHOOK_SECRET is required in production")
            # S-5(#24): 내부 커머스 write 는 production 에서 HMAC(타임스탬프·논스·서명) 필수.
            # 토큰 폴백(타임스탬프·논스 없는 인증)이 프로덕션에서 살아 있으면 안 된다.
            if not self.INTERNAL_COMMERCE_REQUIRE_HMAC:
                raise ValueError(
                    "INTERNAL_COMMERCE_REQUIRE_HMAC must be true in production "
                    "(토큰 폴백 인증 차단 — HMAC 서명 필수)"
                )
            # S-1(#23): 평문으로 전송되는 내부 서비스 토큰이 HMAC 서명 시크릿과
            # 동일하면 헤더 로그 1건만으로 GO_WEBHOOK_SECRET 이 유출된다. 분리 강제.
            if not self.INTERNAL_SERVICE_TOKEN:
                raise ValueError(
                    "INTERNAL_SERVICE_TOKEN is required in production "
                    "(서명 시크릿 GO_WEBHOOK_SECRET 과 분리된 평문 서비스 토큰)"
                )
            if self.INTERNAL_SERVICE_TOKEN == self.GO_WEBHOOK_SECRET:
                raise ValueError(
                    "INTERNAL_SERVICE_TOKEN must be distinct from GO_WEBHOOK_SECRET in production "
                    "(평문 토큰 == HMAC 서명 시크릿 금지)"
                )
            if len(self.INTERNAL_SERVICE_TOKEN) < 32:
                raise ValueError("INTERNAL_SERVICE_TOKEN must be at least 32 characters in production")
            if self.PAYMENT_MANUAL_API_ENABLED:
                raise ValueError("PAYMENT_MANUAL_API_ENABLED must be false in production")
            if not self.REFRESH_COOKIE_SECURE:
                raise ValueError("REFRESH_COOKIE_SECURE must be true in production")
            if self.REFRESH_COOKIE_PATH != "/":
                raise ValueError("REFRESH_COOKIE_PATH must be '/' in production")
            # ADR-006 (개정 2026-04-09): Domain=.pickket.kr 필수 (consumer↔api 쿠키 공유).
            # __Host- 프리픽스는 Domain 속성과 양립 불가하므로 제거.
            if self.REFRESH_COOKIE_DOMAIN != ".pickket.kr":
                raise ValueError("REFRESH_COOKIE_DOMAIN must be '.pickket.kr' in production (ADR-006)")
            if self.REFRESH_COOKIE_SAMESITE.lower() not in ("lax",):
                raise ValueError("REFRESH_COOKIE_SAMESITE must be 'lax' in production (ADR-006)")
            cors_origins = self.cors_origins_list
            if not cors_origins:
                raise ValueError("CORS_ORIGINS must not be empty in production")
            if any(origin == "*" for origin in cors_origins):
                raise ValueError("CORS_ORIGINS cannot contain '*' in production")
            if any(not origin.startswith("https://") for origin in cors_origins):
                raise ValueError("CORS_ORIGINS must use https:// in production")
            # Payment URLs must use HTTPS in production
            if not self.PAYMENT_SUCCESS_URL.startswith("https://"):
                raise ValueError("PAYMENT_SUCCESS_URL must use https:// in production")
            if not self.PAYMENT_FAIL_URL.startswith("https://"):
                raise ValueError("PAYMENT_FAIL_URL must use https:// in production")
            # 나이스 go redirect URL 은 **설정된 경우에만** https 필수(미설정 시 consumer 폴백).
            if self.NICEPAY_GO_SUCCESS_URL and not self.NICEPAY_GO_SUCCESS_URL.startswith("https://"):
                raise ValueError("NICEPAY_GO_SUCCESS_URL must use https:// in production")
            if self.NICEPAY_GO_FAIL_URL and not self.NICEPAY_GO_FAIL_URL.startswith("https://"):
                raise ValueError("NICEPAY_GO_FAIL_URL must use https:// in production")
            # External providers must not be stub in production
            if self.IDENTITY_PROVIDER == "stub":
                raise ValueError(
                    "IDENTITY_PROVIDER cannot be 'stub' in production. "
                    "Use 'none' to explicitly disable or 'pass'/'portone' to enable."
                )
            if self.EMAIL_PROVIDER == "stub":
                raise ValueError("EMAIL_PROVIDER cannot be 'stub' in production")
            if self.SMS_PROVIDER == "stub":
                raise ValueError(
                    "SMS_PROVIDER cannot be 'stub' in production. "
                    "Use 'none' to disable or 'ncp'/'twilio' to enable."
                )
            if not self.ADMIN_MFA_REQUIRED:
                raise ValueError("ADMIN_MFA_REQUIRED must be true in production (YES24 대비)")
            if self.BCRYPT_ROUNDS < 12:
                raise ValueError("BCRYPT_ROUNDS must be >= 12 in production (OWASP 2025)")
            if self.UPLOAD_PROVIDER == "stub":
                raise ValueError("UPLOAD_PROVIDER cannot be 'stub' in production")
            if self.UPLOAD_PROVIDER == "s3" and not self.S3_BUCKET:
                raise ValueError("S3_BUCKET is required when UPLOAD_PROVIDER is 's3'")
            if self.UPLOAD_PROVIDER == "s3" and not self.S3_SECRET_KEY:
                raise ValueError("S3_SECRET_KEY required for production with S3 upload provider")
            # Reject overly broad proxy trust in production (full /8 or /12 blocks)
            import ipaddress
            for cidr in self.TRUSTED_PROXY_CIDRS.split(","):
                cidr = cidr.strip()
                if not cidr:
                    continue
                try:
                    net = ipaddress.ip_network(cidr, strict=False)
                    if net.prefixlen < 16 and not net.is_loopback:
                        raise ValueError(
                            f"TRUSTED_PROXY_CIDRS contains overly broad range '{cidr}' "
                            f"(/{net.prefixlen}). Use /16 or narrower in production "
                            f"to prevent X-Forwarded-For spoofing."
                        )
                except ValueError:
                    raise
            if not self.SENTRY_DSN:
                import warnings
                warnings.warn("SENTRY_DSN not configured for production", stacklevel=2)

        # ── C-2 + H-5: Staging environment validation (production parity) ──
        if self.ENVIRONMENT == "staging":
            if not self.SECRET_KEY or len(self.SECRET_KEY) < 32:
                raise ValueError("SECRET_KEY must be at least 32 characters in staging")
            if not self.GO_WEBHOOK_SECRET:
                raise ValueError("GO_WEBHOOK_SECRET is required in staging")
            if not self.PORTONE_WEBHOOK_SECRET and not self.PORTONE_MOCK_MODE:
                raise ValueError(
                    "PORTONE_WEBHOOK_SECRET is required in staging when PORTONE_MOCK_MODE is disabled"
                )
            if not self.PII_ENCRYPTION_KEY:
                raise ValueError("PII_ENCRYPTION_KEY is required in staging")
            # M-1: 빌링키 평문 폴백을 staging에서도 차단 (production parity).
            # 미설정 시 _encrypt_billing_key가 non-production 경로로 평문 저장하므로
            # staging에서 PORTONE_MOCK_MODE=false로 실 빌링키를 평문화하는 것을 막는다.
            if not self.BILLING_KEY_ENCRYPTION_KEY:
                raise ValueError("BILLING_KEY_ENCRYPTION_KEY is required in staging")

            # A3: 나이스 활성(PAYMENT_PROVIDER=nicepay) 시 staging 가드(production parity).
            # ⚠️ 현 prod 는 ENVIRONMENT=staging 으로 운영된다 — staging 블록에 나이스 가드가
            # 없으면 나이스를 켤 때 실키 없이 mock 으로 조용히 실결제하거나 무가드로
            # 기동돼 돈사고가 난다. provider 를 팩토리와 동일 규칙으로 정규화(대소문자·공백
            # 흡수)해, nicepay 일 때만 실키필수·MOCK해제·ReturnURL(https) 를 강제한다.
            # PAYMENT_PROVIDER≠nicepay(현 toss 운영)면 미강제 → toss 무영향.
            from app.services.payment_gateway import normalize_provider
            if normalize_provider(self.PAYMENT_PROVIDER) == "nicepay":
                if not self.NICE_MERCHANT_KEY:
                    raise ValueError(
                        "NICE_MERCHANT_KEY is required in staging when PAYMENT_PROVIDER=nicepay"
                    )
                if not self.NICE_MID:
                    raise ValueError(
                        "NICE_MID is required in staging when PAYMENT_PROVIDER=nicepay"
                    )
                if self.NICEPAY_MOCK_MODE:
                    raise ValueError(
                        "NICEPAY_MOCK_MODE must be false in staging when PAYMENT_PROVIDER=nicepay "
                        "(무가드 실결제·조용한 mock 방지)"
                    )
                if not self.NICEPAY_RETURN_URL:
                    raise ValueError(
                        "NICEPAY_RETURN_URL is required in staging when PAYMENT_PROVIDER=nicepay"
                    )
                if not self.NICEPAY_RETURN_URL.startswith("https://"):
                    raise ValueError(
                        "NICEPAY_RETURN_URL must use https:// in staging when PAYMENT_PROVIDER=nicepay"
                    )
                # 🔴 go 착지 URL 도 **NICE 키 4종과 같은 등급의 필수값**이다 (질의 #11).
                #    없으면 payment_webhook 이 go 주문을 consumer 로 착지시켰다 —
                #    KLPGA 처럼 sale_channels={self} 인 행사는 consumer 에 노출조차 안 되므로
                #    구매자가 **자기 티켓을 볼 수 없는 사이트**에 떨어진다. 그 페이지는 200 이라
                #    장애로 보이지도 않고 **고객이 알려줘야 안다.**
                #    기동 실패는 배포 즉시 드러나므로 그쪽이 훨씬 싸다 — 그래서 필수로 올린다.
                #    (같은 유형이 오늘만 세 번 나왔다: 크론 빈 토큰→조용한 401,
                #     PAYMENT_PROVIDER 미설정→기본값이 실동작값, 그리고 이 착지 폴백.)
                if not self.NICEPAY_GO_SUCCESS_URL:
                    raise ValueError(
                        "NICEPAY_GO_SUCCESS_URL is required in staging when PAYMENT_PROVIDER=nicepay"
                        " (미설정 시 go 주문이 consumer 로 착지 — self 채널 행사는 티켓을 못 찾는다)"
                    )
                if not self.NICEPAY_GO_FAIL_URL:
                    raise ValueError(
                        "NICEPAY_GO_FAIL_URL is required in staging when PAYMENT_PROVIDER=nicepay"
                        " (미설정 시 go 주문이 consumer 로 착지 — self 채널 행사는 티켓을 못 찾는다)"
                    )
                # SSRF(Low#4): 취소/조회/채번 호스트가 nicepay.co.kr 계열인지 강제.
                self._require_nicepay_base_url_safe(self.NICEPAY_API_BASE_URL)

        return self

    @property
    def cors_origins_list(self) -> list[str]:
        """CORS_ORIGINS 를 list 로 파싱 — 콤마구분 문자열과 JSON 배열 표기 모두 지원.

        과거 .env 가 `["https://a","https://b"]`(JSON) 인데 코드가 `.split(",")` 만 해서
        `["https://a"` 같은 깨진 토큰이 생겨 ADR-006 Origin 화이트리스트가 정상 origin 을
        거부했다(브라우저 로그인 CORS 400). 두 표기 모두 안전하게 처리한다.
        """
        raw = (self.CORS_ORIGINS or "").strip()
        if raw.startswith("["):
            try:
                import json

                parsed = json.loads(raw)
                if isinstance(parsed, list):
                    return [str(o).strip().rstrip("/") for o in parsed if str(o).strip()]
            except Exception:
                pass
        return [o.strip().rstrip("/") for o in raw.split(",") if o.strip()]

    @property
    def internal_service_token(self) -> str:
        """평문 내부 서비스 토큰(읽기/통계 GET 인증).

        S-1(#23): HMAC 서명 시크릿(GO_WEBHOOK_SECRET)과 분리된 토큰을 우선 사용한다.
        전환기에 INTERNAL_SERVICE_TOKEN 미설정이면 GO_WEBHOOK_SECRET 으로 폴백하나,
        production 검증(validate)은 분리를 강제하므로 이 폴백은 dev/staging 에만 해당.
        """
        return (self.INTERNAL_SERVICE_TOKEN or self.GO_WEBHOOK_SECRET or "").strip()

    model_config = {"env_file": ".env", "env_file_encoding": "utf-8", "extra": "ignore"}


settings = Settings()
