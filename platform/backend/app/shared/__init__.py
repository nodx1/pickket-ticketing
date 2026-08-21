"""도메인 간 공유 모듈.

여러 도메인이 공통으로 사용하는 DTO·타입·베이스 클래스를 모은다.
한 도메인 전용 코드는 절대 여기에 두지 말 것 — 해당 domains/<x>/ 에 둔다.

수록 대상:
    - schemas.py: Pagination, ErrorResponse, IdempotencyKey 등 공통 DTO
    - service.py: BaseService — 트랜잭션·propagations 표준화
    - repository.py: BaseRepository — 공통 CRUD 패턴
    - types.py: UUID alias, Money, datetime helpers
    - enums.py: 공유 enum (Currency, Locale)
"""
