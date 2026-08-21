# pickket.go

한국형 이벤트 티켓팅 SaaS 플랫폼.

## 스택

- Next.js 16 + React 19 + TypeScript
- Tailwind CSS v4 + shadcn/ui
- PostgreSQL (pg 드라이버)
- Zustand

## 시작하기

```bash
npm install
npm run dev          # localhost:3003
```

## 주요 기능

- 이벤트 생성/관리 + 퍼블릭 판매 페이지
- 결제 (토스/카카오/네이버) + 멱등성 보장
- 주문/참석자 상태 머신
- QR 체크인 + 모바일 티켓
- 플랫폼 수수료 + 정산 시스템
- 티켓/영수증 PDF + CSV 내보내기
- 알림 센터 (실시간 벨)
- 프로모코드 + 대기열 + 좌석배치
- 어필리에이트 + 웹훅
- 시스템 어드민

## 문서

- [개발 문서](docs/DEVELOPMENT.md)
- [고도화 마스터플랜](docs/ENHANCEMENT-MASTERPLAN.md)
- [플랫폼 아키텍처](docs/PLATFORM-ARCHITECTURE.md)
- [테스트 가이드](docs/TESTING.md)
