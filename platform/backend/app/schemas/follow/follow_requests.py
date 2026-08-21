"""Follow 도메인 요청 DTO.

API 입력 Pydantic 모델 — 형식 검증 외 비즈니스 규칙 금지.

현재 Follow API 는 path 파라미터로 user_id 만 받아서 별도 Body 요청 없음.
향후 batch follow / unfollow 같이 Body 가 생기면 여기에 추가.
"""
# (현재 비어있음 — Body 요청 없음. 패턴 일관성 위해 파일 존재)
